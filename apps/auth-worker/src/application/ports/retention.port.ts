import type { RetentionTarget } from "../../domain/services/retention-policy";

export type PurgeRequest = {
  readonly target: RetentionTarget;
  /**
   * この時刻より前に「用済みになった」行を消す。
   *
   * 何をもって用済みとするかはテーブルごとに違う（期限切れ / 失効 / 消費 /
   * 最終送信）。その判定は SQL を書ける Infrastructure に閉じ込める。
   * Application 側はテーブル名と境界時刻しか知らない。
   */
  readonly deadBefore: Date;
  /** 1 回で消す上限。D1 の実行時間上限に当てないための歯止め（#43）。 */
  readonly limit: number;
};

export type PurgeResult = {
  readonly target: RetentionTarget;
  readonly deleted: number;
  /**
   * 上限まで消してなお残っている可能性があるか。
   *
   * `deleted === limit` を呼び出し側で判定させない。「上限に達した」は
   * 次回へ持ち越すという運用判断に直結するので、Port の返り値で明示する。
   */
  readonly reachedLimit: boolean;
};

/**
 * 保持期限を過ぎた行を削除する Port（#43）。
 *
 * テーブルごとに別の Port を切らないのは、掃除の実行経路を 1 本に保つため。
 * 経路が分かれると、片方だけ止まっていても誰も気づけない。
 *
 * **`users` を対象に含めないこと。** アカウントは物理削除せず凍結で表現する
 * （仕様書 14.1 決定 7）。凍結アカウントの保持期間は未決で、#27 / #51 の範囲。
 */
export interface ExpiredRecordPurger {
  purge(request: PurgeRequest): Promise<PurgeResult>;
}
