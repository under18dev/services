import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema/index";

export * as schema from "./schema/index";
export * from "./schema/index";

/**
 * admin-worker 専用 D1 のハンドル型。
 *
 * この型を所有するのは admin-worker だけ。他の Worker はこのパッケージに
 * 依存しない（`packages/nfc-db` の `NfcDatabase` と同じ理由）。
 */
export type AdminDatabase = DrizzleD1Database<typeof schema>;

export function createAdminDatabase(binding: D1Database): AdminDatabase {
  return drizzle(binding, { schema, casing: "snake_case" });
}
