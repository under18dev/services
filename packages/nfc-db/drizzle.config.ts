import { defineConfig } from "drizzle-kit";

/**
 * NFC 専用 D1 のマイグレーション生成設定。
 *
 * `packages/db`（Identity）とは **out ディレクトリも D1 も別**にしてある。
 * 同じ `drizzle/` に両方のマイグレーションを混ぜると、`wrangler d1 migrations apply`
 * は「そのディレクトリの全 SQL」を対象の DB へ流すため、NFC 用 DB に
 * `users` / `sessions` / `oauth_tokens` が生え、Identity DB に NFC のテーブルが生える。
 * 分離の意図はスキーマの見た目ではなく**どの Worker がどの行に届くか**なので、
 * マイグレーションの単位で分かれていないと意味がない。
 *
 * `packages/db` と同じく D1 の認証情報は持たせない。本番への適用は
 * デプロイ経路（wrangler）に閉じる。
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
