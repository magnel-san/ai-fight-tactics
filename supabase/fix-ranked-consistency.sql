-- AI Fight Tactics:ランクマッチの結果を、どの端末でも同じにする(2026-10-07)
-- schema-ranked.sql を実行したあとに、Supabase の SQL Editor でこのファイルの内容を実行する(何度実行しても大丈夫)。
--
-- 問題:物理や脳を変えた新しい版のページと、古い版のページ(開きっぱなしのタブや、ブラウザに残った古いページ)が
--   同じ試合を違う結果で計算して報告し、多数決の結果が端末やタイミングによって変わっていた。
-- 対策:報告に「計算の版(sim)」をつけ、試合ごとに、いちばん新しい版の報告の中で多数決をとる。
--   トーナメントでは、引き分けのときに勝ち上がった側(advance)も報告して、組み合わせ表の勝ち上がりもサーバーの結果にそろえる。

-- トーナメントの報告
alter table public.ranked_reports add column if not exists sim integer not null default 0;
alter table public.ranked_reports add column if not exists advance smallint check (advance in (0, 1));
-- 新しい版になったら、同じ人がもう一度報告できるように、主キーに版を入れる
alter table public.ranked_reports drop constraint if exists ranked_reports_pkey;
alter table public.ranked_reports add primary key (tournament, match, reporter, sim);

drop view if exists public.ranked_results;
create view public.ranked_results with (security_invoker = true) as
select distinct on (tournament, match)
  tournament, match, a, b, winner, advance, cause, sim, reports
from (
  select tournament, match, a, b, winner, max(advance) as advance, max(cause) as cause, sim, count(*) as reports
  from public.ranked_reports
  group by tournament, match, a, b, winner, sim
) t
order by tournament, match, sim desc, reports desc, winner nulls last;

-- ランダムマッチの報告
alter table public.random_reports add column if not exists sim integer not null default 0;
alter table public.random_reports drop constraint if exists random_reports_pkey;
alter table public.random_reports add primary key (match_id, reporter, sim);

drop view if exists public.random_results;
create view public.random_results with (security_invoker = true) as
select distinct on (match_id)
  match_id, winner, cause, sim, reports
from (
  select match_id, winner, max(cause) as cause, sim, count(*) as reports
  from public.random_reports
  group by match_id, winner, sim
) t
order by match_id, sim desc, reports desc, winner nulls last;
