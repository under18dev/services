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
}
