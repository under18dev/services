import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * 時刻列の共通定義。
 *
 * D1 は SQLite なので、時刻は epoch ミリ秒の INTEGER で持ち、Drizzle に Date へ
 * 変換させる。文字列日時はタイムゾーン解釈と範囲比較で事故が起きやすいため使わない。
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

/**
 * 秘密情報を格納する列。
 *
 * セッショントークン・認可コード・OTP・アクセストークンは「ハッシュだけ」を保存する
 * （仕様書 5.3 / 7.1）。平文を入れないことを呼び出し側に思い出させるための別名。
 */
export const secretHash = (name: string) => text(name).notNull();
