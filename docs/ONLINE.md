# オンライン対戦の準備(Supabase)

オンライン機能は任意です。設定しなくても、キャラクリエイト・トレーニング・バトル・共有URLはすべて使えます。

## しくみ

- サーバー(Supabase)には **キャラのデータだけ** を置きます。
- 対戦は、対戦相手のキャラをダウンロードして **自分のブラウザの中で** 行います(非同期対戦)。試合結果はサーバーに送りません。
- ログインは匿名ログインです。ブラウザごとに1人のユーザーになり、自分が登録したキャラだけを更新・削除できます。

## 手順

1. [Supabase](https://supabase.com/) でプロジェクトを作る。
2. **Authentication → Sign In / Providers** で **Anonymous Sign-Ins** を有効にする。
3. **SQL Editor** で [`supabase/schema.sql`](../supabase/schema.sql) の内容を実行する。
4. **Project URL** と **Publishable key**(`sb_publishable_` で始まる。古いプロジェクトでは **anon public** キー)を、`.env.local` に書く。`.env.example` は書き換えずにコピーして使う(`.env.example` は GitHub に上がるため)。**Secret key / service_role キーは使わない**。
   ```
   VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```
5. `npm run dev` を起動し直す。公開する場合は、GitHub の **Settings → Secrets and variables → Actions** に同じ2つを登録し、`.github/workflows/pages.yml` の `npm run build` に `env:` で渡す。

## 不正対策

| 対策 | 場所 |
| --- | --- |
| 自分のキャラだけ登録・更新・削除できる(行レベルセキュリティ) | `schema.sql` |
| キャラのデータの大きさ(32KB未満)・形式のバージョン・ブロック数の制限 | `schema.sql` の check 制約 |
| 1人10体まで | `schema.sql` のトリガー |
| ダウンロードしたキャラは、体の検証(コスト・関節数・重なり)と重みの数・値の検証を通ったものだけ使う | `src/core/codec.ts` の `parseCharacter` |
| 試合は自分のブラウザで再計算するので、相手が結果を偽ることはできない | 決定論的コア |

### 未対応(今後の課題)

- ランキングや勝敗の記録は、クライアントが送る結果を信用できないため作っていません。作る場合は、サーバー側(Edge Functions など)でシードと両キャラから試合を再計算して確かめる必要があります。決定論的コアは three・DOM に依存しないので、そのまま Deno でも動かせる見込みです。
- 不適切な名前のフィルターや通報の仕組み。
