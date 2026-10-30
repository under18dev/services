import { integer } from "drizzle-orm/sqlite-core";

/**
 * 時刻列の共通定義。
 *
 * `packages/db` / `packages/nfc-db` の同名ファイルと**意図的に複製**して
 * いる。複製されるのは 3 行の列定義だけで、共有すると
 * `@u18/admin-db` が他パッケージへ依存するようになり、依存グラフの上でも
 * 境界が見えなくなる（`packages/nfc-db/src/schema/_shared.ts` と同じ理由）。
 */
export const timestampMs = (name: string) => integer(name, { mode: "timestamp_ms" });

export const createdAt = () =>
  timestampMs("created_at")
    .notNull()
    .$defaultFn(() => new Date());
