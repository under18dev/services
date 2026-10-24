import { integer } from "drizzle-orm/sqlite-core";

/**
 * 時刻列の共通定義。
 *
 * `packages/db/src/schema/_shared.ts` とほぼ同じ内容を**意図的に複製**している。
 * 共有しないのは、共有した瞬間に `@u18/nfc-db` が `@u18/db` に依存し、
 * nfc-worker の依存グラフから Identity のテーブル定義が見えるようになるため。
 * docs/architecture.md 1.1 が dashboard-worker について書いているのと同じ理由で、
 * 「使えない binding」だけでなく「見えない型」でも境界を引いておく。
 * 複製されるのは 3 行の列定義だけなので、ずれても壊れる範囲が小さい。
 *
 * 値の表現自体は Identity 側と揃える。D1 は SQLite なので epoch ミリ秒の
 * INTEGER で持ち、Drizzle に Date へ変換させる。
 */
export const timestampMs = (name: string) => integer(name, { mode: "timestamp_ms" });

export const createdAt = () =>
  timestampMs("created_at")
    .notNull()
    .$defaultFn(() => new Date());

export const updatedAt = () =>
  timestampMs("updated_at")
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
