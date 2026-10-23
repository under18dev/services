import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema/index";

export * as schema from "./schema/index";
export * from "./schema/index";

/**
 * Identity DB のハンドル型。
 *
 * この型を所有するのは auth-worker だけ（仕様書 2.2「Identity の書き込み権限は
 * auth-worker に集約する」）。dashboard-worker はこのパッケージに依存しない。
 */
export type IdentityDatabase = DrizzleD1Database<typeof schema>;

export function createIdentityDatabase(binding: D1Database): IdentityDatabase {
  return drizzle(binding, { schema, casing: "snake_case" });
}
