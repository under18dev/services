import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Workers ランタイム上でテストを走らせる（仕様書 11.2）。
 *
 * マイグレーションの読み込みは **Node 側（この設定ファイル）** で行う。
 * テスト本体は workerd の中で動くので node:fs を使えない。読み込んだ SQL は
 * バインディング経由でテストへ渡し、setup で適用する。
 *
 * `wrangler.jsonc` も同じ理由でここから渡す。`rate-limit-config.test.ts` が
 * `ratelimits` の設定と `RateLimitPolicy` を照合するのに使う（#21）。
 * **文字列のまま渡す** —— JSONC（コメントと末尾カンマ）なので JSON.parse は
 * 通らず、テスト側の `test/jsonc.ts` で読む。
 */
const migrations = await readD1Migrations(join(import.meta.dirname, "../../packages/db/drizzle"));
const wranglerSource = readFileSync(join(import.meta.dirname, "wrangler.jsonc"), "utf8");

/**
 * `src/` に書かれている監査イベント名をすべて集める（#22）。
 *
 * `AUDIT_EVENTS`（登録簿）と実装が離れていないかを
 * `test/audit-events.test.ts` が照合するのに使う。登録簿に足しただけで
 * どこからも発行されない名前や、逆に発行されているのに登録簿に無い名前を
 * 見つけるのが目的。
 *
 * **コメントの中は数えない。** `// 監査ログ（event: "retention.sweep"）に
 * 出している` のような説明が `src/index.ts` にあり、それを実装と
 * 取り違えると照合が緩む。
 *
 * **JSDoc（`*` で始まる行）も除く。** 行コメントだけを除いていたころ、
 * **この走査の仕組みを説明する JSDoc が、この走査に拾われた**（#265 /
 * #270 で 2 回）。説明のために書いた例が「登録簿に無い名前が発行されて
 * いる」と報告される形で、**散文と対象を同じ面で見分けている限り
 * 避けられない。** 2 回落ちたので構造で消す。
 *
 * ソースの走査は Node 側でしかできない（テスト本体は workerd の中で動く）。
 */
function collectAuditEventNames(dir: string): string[] {
  const names: string[] = [];
  // `withFileTypes` で種別まで 1 回の走査で得る。`readdirSync` + `statSync` に
  // 分けると、その隙間に入れ替えられる余地（CodeQL `js/file-system-race`）が
  // 残るうえ、エントリごとに syscall が 1 つ増える。**速いほうが安全でもある**
  // という珍しいケース。
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...collectAuditEventNames(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      // JSDoc / ブロックコメントの継続行。散文なので実装ではない。
      if (/^\s*\*/.test(line)) continue;
      const code = line.split("//")[0] ?? "";
      for (const match of code.matchAll(/event: "([a-z_.]+)"/g)) names.push(match[1]!);
    }
  }
  return names;
}

/**
 * Presentation 層が `isAdmin:` に詰めている右辺を集める（決定 8 / RR-21）。
 *
 * **外へ出す `isAdmin` は、`users` の行ではなく UseCase の結果から来ること。**
 * 旗が立っているかと、このセッションで管理者として振る舞ってよいかは別で、
 * 後者を決めているのは `GetSessionUseCase` 1 か所しかない
 * （`User.actsAsAdminWith`）。Presentation が `user.snapshot()` から
 * 直接詰めると、**そこだけ古い意味の値が外へ出る。**
 *
 * 実際に `getUserProfile` と `updateProfile` の 2 か所がそうなっていた。
 * 型は `boolean` なので入れ替えても何も言われない —— **間違いと正解が
 * 同じ型をしている**ので、型検査の外でしか見つけられない。
 *
 * 走査は Node 側でしかできない（テスト本体は workerd の中で動く）。
 * 照合は `test/admin-session-passkey.test.ts`。
 */
function collectPresentationIsAdminSources(dir: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sources.push(...collectPresentationIsAdminSources(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      // `collectAuditEventNames` と同じ理由で散文を除く。説明のために
      // `isAdmin: props.isAdmin` と書いた JSDoc が違反として出てしまう。
      if (/^\s*\*/.test(line)) continue;
      const code = line.split("//")[0] ?? "";
      for (const match of code.matchAll(/isAdmin:\s*([^,;\n]+)/g)) {
        const expression = match[1]!.trim();
        // 型宣言（`readonly isAdmin: boolean`）は代入ではない。
        if (expression === "boolean") continue;
        sources.push(expression);
      }
    }
  }
  return sources;
}

const presentationIsAdminSources = collectPresentationIsAdminSources(
  join(import.meta.dirname, "src/presentation"),
).sort();

const auditEventNames = [
  ...new Set(collectAuditEventNames(join(import.meta.dirname, "src"))),
].sort();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["IDENTITY_DB"],
        // 監査ログの退避先（#43 の残件）。miniflare がローカルの R2 を用意する。
        r2Buckets: ["ARCHIVE"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_WRANGLER_JSONC: wranglerSource,
          TEST_AUDIT_EVENT_NAMES: auditEventNames,
          TEST_PRESENTATION_IS_ADMIN_SOURCES: presentationIsAdminSources,
          ENVIRONMENT: "development",
          ISSUER: "http://localhost:8787",
          IP_HASH_PEPPER: "test-pepper",
        },
      },
    }),
  ],
  test: {
    // `.tsx` も拾う。JSX を使うテストを `.test.tsx` で置いたときに
    // **1 件も実行されないまま緑になる**のを防ぐ（実際に踏んだ）。
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
