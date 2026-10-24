import type { D1Migration } from "@cloudflare/vitest-plugin";

/**
 * テスト実行時にだけ存在するバインディング。
 * vitest.config.ts が Node 側で読み込んだマイグレーションを流し込む。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_MIGRATIONS: D1Migration[];
      /** `wrangler.jsonc` の中身。JSONC のままなので `test/jsonc.ts` で読む（#21）。 */
      readonly TEST_WRANGLER_JSONC: string;
      /** `src/` に書かれている監査イベント名（#22）。vitest.config.ts が走査する。 */
      readonly TEST_AUDIT_EVENT_NAMES: string[];
    }
  }
}

export {};

/**
 * `?raw` 付きの import を型で通す。
 *
 * `rate-limit-config.test.ts` が `wrangler.jsonc` を**文字列として**読む。
 * JSON として import すると Vite が JSONC を解釈できずに落ちるので、
 * 生のまま取ってテスト側のパーサ（`test/jsonc.ts`）に渡している。
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
