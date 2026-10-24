import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema/index";

export * as schema from "./schema/index";
export * from "./schema/index";

/**
 * NFC DB のハンドル型。
 *
 * この型を所有するのは nfc-worker だけ。auth-worker / dashboard-worker は
 * このパッケージに依存しない（仕様書 4.1 の「NFC専用データの所有者」）。
 * 逆に nfc-worker は `@u18/db` に依存しない —— Identity のテーブル定義が
 * 依存グラフの上でも見えないようにしてある。
 */
export type NfcDatabase = DrizzleD1Database<typeof schema>;

export function createNfcDatabase(binding: D1Database): NfcDatabase {
  return drizzle(binding, { schema, casing: "snake_case" });
}
