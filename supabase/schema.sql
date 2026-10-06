-- AI Fight Tactics:オンライン(キャラ登録と非同期対戦)用のスキーマ
-- Supabase のダッシュボードの SQL Editor でこのファイルの内容を実行する。
-- 認証は「匿名ログイン(Anonymous Sign-Ins)」を有効にして使う(Authentication → Providers → Anonymous)。

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- キャラの JSON(src/core/codec.ts の形式)。不正対策として大きさと形を制限する
  data jsonb not null check (
    pg_column_size(data) < 32768
    and data ? 'version' and data ? 'blueprint' and data ? 'brains'
    and (data ->> 'version')::int between 1 and 99
    and jsonb_typeof(data -> 'blueprint' -> 'blocks') = 'array'
    and jsonb_array_length(data -> 'blueprint' -> 'blocks') between 1 and 24
    and data -> 'brains' -> 'motor' is not null
    and data -> 'brains' -> 'decision' is not null
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists characters_owner_idx on public.characters (owner);

alter table public.characters enable row level security;

-- だれでも読める(対戦相手を探すため)
drop policy if exists "characters are readable" on public.characters;
create policy "characters are readable" on public.characters for select using (true);

-- 自分のキャラだけ登録・更新・削除できる
drop policy if exists "owners insert" on public.characters;
create policy "owners insert" on public.characters for insert to authenticated with check (owner = auth.uid());
drop policy if exists "owners update" on public.characters;
create policy "owners update" on public.characters for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "owners delete" on public.characters;
create policy "owners delete" on public.characters for delete to authenticated using (owner = auth.uid());

-- 1人が登録できるキャラは10体まで(荒らし対策)
create or replace function public.limit_characters_per_owner() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.characters where owner = new.owner) >= 10 then
    raise exception '登録できるキャラは10体までです';
  end if;
  return new;
end $$;

drop trigger if exists limit_characters on public.characters;
create trigger limit_characters before insert on public.characters
  for each row execute function public.limit_characters_per_owner();

-- 更新日時
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists touch_characters on public.characters;
create trigger touch_characters before update on public.characters
  for each row execute function public.touch_updated_at();

-- ランダムな対戦相手(自分のキャラは除く)
create or replace function public.random_characters(n int default 8)
returns setof public.characters
language sql stable as $$
  select * from public.characters
  where owner is distinct from auth.uid()
  order by random()
  limit least(greatest(n, 1), 20);
$$;
