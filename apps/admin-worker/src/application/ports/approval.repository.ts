import type { EffectivePermissions } from "../../domain/permissions";

/**
 * 「誰が admin.under18.dev を使ってよいか」を確かめる Port。
 *
 * u18 Identity には何も足さないので、ここで言う「承認されている」は
 * admin-worker 専用の D1（`@u18/admin-db`）の記憶だけを指す。
 */
export interface ApprovalRepository {
  /** `sub` が承認済みか。 */
  isApproved(sub: string): Promise<boolean>;

  /** `sub` が他人を承認してよい「最高権限」を持つか。 */
  isSuperApprover(sub: string): Promise<boolean>;

  /**
   * 権限チェック（#190）に使う、唯一の読み取り口。
   *
   * `isApproved` と別クエリにしてある——ガードは「承認されているか」を
   * 先に確かめ、`/pending` へ分岐したあとに呼ぶ必要が無い経路
   * （`PUBLIC_PATHS` 等）があるため。承認されていなければ `null`。
   */
  getEffectivePermissions(sub: string): Promise<EffectivePermissions | null>;

  /** いま super approver が何人いるか。締め出し防止の判定に使う。 */
  countSuperApprovers(): Promise<number>;
}
