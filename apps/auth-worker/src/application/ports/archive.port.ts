import type { RetentionTarget } from "../../domain/services/retention-policy";

export type ArchiveRequest = {
  readonly target: RetentionTarget;
  /**
   * これから削除する行そのもの。
   *
   * **ここに渡した行だけを消すこと。** 条件で選び直して消すと、選び直す
   * 瞬間に増えた行——退避していない行——まで巻き込む。
   */
  readonly rows: readonly Record<string, unknown>[];
};

export type ArchiveReceipt = {
  /** 書き込み先のオブジェクトキー。構造化ログに出して追跡に使う。 */
  readonly key: string;
  readonly rowCount: number;
  readonly bytes: number;
};

/**
 * 削除する行の退避先（#43 の残件）。
 *
 * ## 失敗は例外で返す
 *
 * **これがこの Port の設計の中心。** `AuditLogger` とは逆に、失敗を
 * 握り潰してはならない。退避が静かに失敗すると「消す前に退避している
 * つもりで、実際は消しているだけ」という状態になり、**壊れていることが
 * 分かるのは監査ログを探しに行った時**——つまり侵害調査の最中になる。
 *
 * 呼び出し側（`ExpiredRecordPurger`）は例外を受けたら削除を中止する。
 * 掃除が止まって行が溜まるほうが、退避できないまま消えるよりよい。
 * 溜まっていることは `retention sweep` の `failed` と件数で見える。
 *
 * ## 書けたことを確認してから返す
 *
 * 「リクエストが例外を投げなかった」では足りない。実装は書き込み後の
 * サイズまで照合してから `ArchiveReceipt` を返すこと。
 */
export interface ArchiveSink {
  put(request: ArchiveRequest): Promise<ArchiveReceipt>;
}
