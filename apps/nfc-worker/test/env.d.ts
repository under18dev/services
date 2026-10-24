import type { D1Migration } from "@cloudflare/vitest-plugin";

/**
 * テスト実行時にだけ存在するバインディング。
 * vitest.config.ts が Node 側で読み込んだマイグレーションを流し込む。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
