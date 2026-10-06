-- AI Fight Tactics:キャラのデータ形式のバージョン制限を直す(2026-10-07)
-- オンライン登録(characters)がデータ形式のバージョン1しか受け付けず、
-- 新しい形式(バージョン3)のキャラを登録すると characters_data_check のエラーになっていた。
-- Supabase の SQL Editor でこのファイルの内容を実行する(何度実行しても大丈夫)。
-- バージョンは今後上がっても止まらないよう 1〜99 にする(中身の検証はゲーム側の parseCharacter で行う)。

alter table public.characters drop constraint if exists characters_data_check;
alter table public.characters add constraint characters_data_check check (
  pg_column_size(data) < 32768
  and data ? 'version' and data ? 'blueprint' and data ? 'brains'
  and (data ->> 'version')::int between 1 and 99
  and jsonb_typeof(data -> 'blueprint' -> 'blocks') = 'array'
  and jsonb_array_length(data -> 'blueprint' -> 'blocks') between 1 and 24
  and data -> 'brains' -> 'motor' is not null
  and data -> 'brains' -> 'decision' is not null
);

-- ランクマッチの登録(ranked_entries)も同じようにする(schema-ranked.sql を実行済みの場合)
do $$
begin
  if to_regclass('public.ranked_entries') is not null then
    alter table public.ranked_entries drop constraint if exists ranked_entries_data_check;
    alter table public.ranked_entries add constraint ranked_entries_data_check check (
      pg_column_size(data) < 32768
      and data ? 'version' and data ? 'blueprint' and data ? 'brains'
      and (data ->> 'version')::int between 1 and 99
      and jsonb_typeof(data -> 'blueprint' -> 'blocks') = 'array'
      and jsonb_array_length(data -> 'blueprint' -> 'blocks') between 1 and 24
      and data -> 'brains' -> 'motor' is not null
      and data -> 'brains' -> 'decision' is not null
    );
  end if;
end $$;
