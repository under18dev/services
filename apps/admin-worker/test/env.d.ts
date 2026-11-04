import type { D1Migration } from "@cloudflare/vitest-plugin";

/**
 * テスト実行時にだけ存在するバインディング。
 * vitest.config.ts が Node 側で読み込んだマイグレーションを流し込む。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_MIGRATIONS: D1Migration[];
      /** `0002_backfill_existing_approvals_permissions.sql` の中身（#190）。 */
      readonly TEST_PERMISSIONS_BACKFILL_SQL: string;
      /** `u18-auth` スタブが実際に返す discovery 応答（#439）。 */
      readonly TEST_AUTH_ORIGIN_DISCOVERY: {
        readonly issuer: string;
        readonly authorization_endpoint: string;
        readonly token_endpoint: string;
        readonly jwks_uri: string;
      };
    }
  }
}

export {};
