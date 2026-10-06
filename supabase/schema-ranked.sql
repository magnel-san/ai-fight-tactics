-- AI Fight Tactics:ランクマッチ(プレイヤー名・登録モンスター・自動トーナメントの結果)用のスキーマ
-- schema.sql を実行したあとに、Supabase の SQL Editor でこのファイルの内容を実行する。
--
-- しくみ
--   ・プレイヤーは匿名ログインのユーザーごとに1人。名前を登録する(players)。
--   ・ランクマッチに出すモンスターは1人1体。登録し直すたびに新しい版を追加する(ranked_entries、追記のみ)。
--     トーナメントは開始時刻より前の最新の版で戦うので、あとから登録し直しても過去の試合は再現できる。
--   ・トーナメントの日程・組み合わせ・試合の結果は、決定論的なシミュレーションで誰が計算しても同じになる。
--     試合を計算したブラウザが結果を報告し(ranked_reports)、いちばん多く報告された結果を正式な結果とする(ranked_results)。
--   ・記録とレートはモンスターごと(owner + monster)。出場するモンスターを替えても、前のモンスターの記録は残る。
--   ・ランダムマッチ(種目の画面):サーバーがまだ戦っていない相手を選び(start_random_match)、同じ2体は1回だけ戦う。
--     結果の報告と正式な結果のしくみはトーナメントと同じ(random_reports / random_results)。レートはトーナメントとは別。

-- プレイヤー
create table if not exists public.players (
  id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists players_name_unique on public.players (lower(btrim(name)));

alter table public.players enable row level security;
drop policy if exists "players are readable" on public.players;
create policy "players are readable" on public.players for select using (true);
drop policy if exists "players insert self" on public.players;
create policy "players insert self" on public.players for insert to authenticated with check (id = auth.uid());
drop policy if exists "players update self" on public.players;
create policy "players update self" on public.players for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop trigger if exists touch_players on public.players;
create trigger touch_players before update on public.players
  for each row execute function public.touch_updated_at();

-- ランクマッチの登録モンスター(版ごとに1行。追記のみ)
create table if not exists public.ranked_entries (
  id bigint generated always as identity primary key,
  owner uuid not null default auth.uid() references public.players (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  data jsonb not null check (
    pg_column_size(data) < 32768
    and data ? 'version' and data ? 'blueprint' and data ? 'brains'
    and (data ->> 'version')::int between 1 and 99
    and jsonb_typeof(data -> 'blueprint' -> 'blocks') = 'array'
    and jsonb_array_length(data -> 'blueprint' -> 'blocks') between 1 and 24
    and data -> 'brains' -> 'motor' is not null
    and data -> 'brains' -> 'decision' is not null
  ),
  created_at timestamptz not null default now()
);
create index if not exists ranked_entries_owner_idx on public.ranked_entries (owner, created_at desc);
-- モンスターの識別子(各ブラウザのキャラの id)。同じモンスターの版は同じ値になる
alter table public.ranked_entries add column if not exists monster text not null default '' check (char_length(monster) <= 64);
-- true = トーナメントへの出場登録、false = ランダムマッチ用の控え(トーナメントには出ない)
alter table public.ranked_entries add column if not exists tournament boolean not null default true;

alter table public.ranked_entries enable row level security;
drop policy if exists "entries are readable" on public.ranked_entries;
create policy "entries are readable" on public.ranked_entries for select using (true);
drop policy if exists "entries insert own" on public.ranked_entries;
create policy "entries insert own" on public.ranked_entries for insert to authenticated with check (owner = auth.uid());

-- 登録は1時間に20回まで(荒らし対策)
create or replace function public.limit_ranked_entries() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.ranked_entries where owner = new.owner and created_at > now() - interval '1 hour') >= 20 then
    raise exception '登録は1時間に20回までです';
  end if;
  new.created_at = now();
  return new;
end $$;
drop trigger if exists limit_ranked_entries on public.ranked_entries;
create trigger limit_ranked_entries before insert on public.ranked_entries
  for each row execute function public.limit_ranked_entries();

-- 試合の結果の報告(試合を計算したブラウザが報告する。1人1試合1回)
create table if not exists public.ranked_reports (
  tournament bigint not null,
  match smallint not null check (match between 0 and 63),
  reporter uuid not null default auth.uid() references auth.users (id) on delete cascade,
  a bigint not null references public.ranked_entries (id) on delete cascade,
  b bigint not null references public.ranked_entries (id) on delete cascade,
  -- 0 = a の勝ち、1 = b の勝ち、null = 引き分け
  winner smallint check (winner in (0, 1)),
  cause text check (cause in ('pushed', 'fell', 'timeout', 'both')),
  created_at timestamptz not null default now(),
  primary key (tournament, match, reporter)
);

alter table public.ranked_reports enable row level security;
drop policy if exists "reports are readable" on public.ranked_reports;
create policy "reports are readable" on public.ranked_reports for select using (true);
-- まだ始まっていないトーナメントの結果は報告できない(1トーナメント = 1800秒)
drop policy if exists "reports insert own" on public.ranked_reports;
create policy "reports insert own" on public.ranked_reports for insert to authenticated
  with check (reporter = auth.uid() and tournament <= floor(extract(epoch from now()) / 1800));

-- 正式な結果:試合ごとに、いちばん多く報告された結果
create or replace view public.ranked_results with (security_invoker = true) as
select distinct on (tournament, match)
  tournament, match, a, b, winner, cause, reports
from (
  select tournament, match, a, b, winner, max(cause) as cause, count(*) as reports
  from public.ranked_reports
  group by tournament, match, a, b, winner
) t
order by tournament, match, reports desc, winner nulls last;

-- ---- ランダムマッチ ----

-- モンスターの識別子(レートの単位)
create or replace function public.monster_key(e public.ranked_entries) returns text
language sql immutable as $$
  select e.owner::text || ':' || coalesce(nullif(e.monster, ''), e.name)
$$;

-- 試合(サーバーが相手を選んで作る。シードは id から決まる)
create table if not exists public.random_matches (
  id bigint generated always as identity primary key,
  challenger uuid not null default auth.uid() references public.players (id) on delete cascade,
  a bigint not null references public.ranked_entries (id) on delete cascade,
  b bigint not null references public.ranked_entries (id) on delete cascade,
  a_monster text not null,
  b_monster text not null,
  created_at timestamptz not null default now()
);
-- 同じ2体は1回だけ戦う
create unique index if not exists random_matches_pair on public.random_matches (least(a_monster, b_monster), greatest(a_monster, b_monster));

alter table public.random_matches enable row level security;
drop policy if exists "random matches are readable" on public.random_matches;
create policy "random matches are readable" on public.random_matches for select using (true);
-- 直接の追加はできない(start_random_match を使う)

-- 自分の登録(版)で、まだ戦っていない相手をランダムに1体選んで試合を作る。相手がいなければ何も返さない
create or replace function public.start_random_match(entry bigint) returns setof public.random_matches
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  mine public.ranked_entries;
  opp public.ranked_entries;
  opp_id bigint;
  my_key text;
  created public.random_matches;
begin
  select * into mine from public.ranked_entries where id = entry and owner = me;
  if not found then
    raise exception '自分の登録ではありません';
  end if;
  if (select count(*) from public.random_matches where challenger = me and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'ランダムマッチは1時間に30回までです';
  end if;
  my_key := public.monster_key(mine);
  -- ほかのプレイヤーの各モンスターの最新の版から、まだ戦っていない相手を選ぶ
  select l.id into opp_id from (
    select distinct on (public.monster_key(e)) e.id, public.monster_key(e) as k
    from public.ranked_entries e
    where e.owner <> me
    order by public.monster_key(e), e.id desc
  ) l
  where not exists (
    select 1 from public.random_matches m
    where least(m.a_monster, m.b_monster) = least(my_key, l.k)
      and greatest(m.a_monster, m.b_monster) = greatest(my_key, l.k)
  )
  order by random()
  limit 1;
  if opp_id is null then
    return;
  end if;
  select * into opp from public.ranked_entries where id = opp_id;
  insert into public.random_matches (challenger, a, b, a_monster, b_monster)
    values (me, mine.id, opp.id, my_key, public.monster_key(opp))
    returning * into created;
  return next created;
end $$;
revoke all on function public.start_random_match(bigint) from public;
grant execute on function public.start_random_match(bigint) to authenticated;

-- 結果の報告(1人1試合1回)
create table if not exists public.random_reports (
  match_id bigint not null references public.random_matches (id) on delete cascade,
  reporter uuid not null default auth.uid() references auth.users (id) on delete cascade,
  winner smallint check (winner in (0, 1)),
  cause text check (cause in ('pushed', 'fell', 'timeout', 'both')),
  created_at timestamptz not null default now(),
  primary key (match_id, reporter)
);

alter table public.random_reports enable row level security;
drop policy if exists "random reports are readable" on public.random_reports;
create policy "random reports are readable" on public.random_reports for select using (true);
drop policy if exists "random reports insert own" on public.random_reports;
create policy "random reports insert own" on public.random_reports for insert to authenticated with check (reporter = auth.uid());

-- 正式な結果:試合ごとに、いちばん多く報告された結果
create or replace view public.random_results with (security_invoker = true) as
select distinct on (match_id)
  match_id, winner, cause, reports
from (
  select match_id, winner, max(cause) as cause, count(*) as reports
  from public.random_reports
  group by match_id, winner
) t
order by match_id, reports desc, winner nulls last;
