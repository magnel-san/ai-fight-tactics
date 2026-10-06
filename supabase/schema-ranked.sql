-- AI Fight Tactics:ランクマッチ(プレイヤー名・登録モンスター・自動トーナメントの結果)用のスキーマ
-- schema.sql を実行したあとに、Supabase の SQL Editor でこのファイルの内容を実行する。
--
-- しくみ
--   ・プレイヤーは匿名ログインのユーザーごとに1人。名前を登録する(players)。
--   ・ランクマッチに出すモンスターは1人1体。登録し直すたびに新しい版を追加する(ranked_entries、追記のみ)。
--     トーナメントは開始時刻より前の最新の版で戦うので、あとから登録し直しても過去の試合は再現できる。
--   ・トーナメントの日程・組み合わせ・試合の結果は、決定論的なシミュレーションで誰が計算しても同じになる。
--     試合を計算したブラウザが結果を報告し(ranked_reports)、いちばん多く報告された結果を正式な結果とする(ranked_results)。

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
    and (data ->> 'version')::int between 1 and 3
    and jsonb_typeof(data -> 'blueprint' -> 'blocks') = 'array'
    and jsonb_array_length(data -> 'blueprint' -> 'blocks') between 1 and 24
    and data -> 'brains' -> 'motor' is not null
    and data -> 'brains' -> 'decision' is not null
  ),
  created_at timestamptz not null default now()
);
create index if not exists ranked_entries_owner_idx on public.ranked_entries (owner, created_at desc);

alter table public.ranked_entries enable row level security;
drop policy if exists "entries are readable" on public.ranked_entries;
create policy "entries are readable" on public.ranked_entries for select using (true);
drop policy if exists "entries insert own" on public.ranked_entries;
create policy "entries insert own" on public.ranked_entries for insert to authenticated with check (owner = auth.uid());

-- 登録し直しは1時間に10回まで(荒らし対策)
create or replace function public.limit_ranked_entries() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.ranked_entries where owner = new.owner and created_at > now() - interval '1 hour') >= 10 then
    raise exception '登録し直しは1時間に10回までです';
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
