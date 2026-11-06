import type { ApprovalAuditEvent } from "../../domain/approval-audit-events";
import type { EffectivePermissions } from "../../domain/permissions";

export type ApprovalListRow = {
  readonly sub: string;
  readonly isSuperApprover: boolean;
  readonly permissions: bigint;
  readonly approvedBySub: string | null;
  readonly createdAt: Date;
};

/**
 * 承認・権限の変更履歴 1 件（#523）。
 *
 * **`reason` は運ばない。** CLI の既定値（`"manual_grant"` 等）や
 * `"granted_via_ui"` がそのまま入っていることが多く、画面に出すと #516 と
 * 同じ「内部の言葉が漏れる」形になる。運ぶのは `event` / `sub` / `actor` /
 * `detail` だけ。
 */
export type ApprovalAuditEventRow = {
  /** 対象の sub。本物の sub なので `UserRef` で名前に解決してよい。 */
  readonly sub: string;
  /** 例: `"ops.approval.granted"`。 */
  readonly event: string;
  /**
   * 実行者。**CLI の `--actor` にそのまま渡された自由文字列**（sub では
   * ない）。`UserRef` では解決できない——解決しようとして「見つかりません」
   * を出すほうが悪い。そのまま出すこと。
   */
  readonly actor: string;
  /** 権限ビットの変更のときだけ、ビットの記号名（例: `"NFC_WRITE"`）。 */
  readonly detail: string | null;
  readonly createdAt: Date;
};

/**
 * 「誰が admin.under18.dev を使ってよいか」を確かめる Port。
 *
 * u18 Identity には何も足さないので、ここで言う「承認されている」は
 * admin-worker 専用の D1（`@u18/admin-db`）の記憶だけを指す。
 *
 * **書き込みは `/approvals` 画面（#190）から行う。** 以前は
 * `scripts/admin-approval.mjs`（`wrangler d1 execute` 越し）が唯一の
 * 経路だった——CLI は残すが、画面からも同じ操作ができる。
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

  /** `/approvals` 画面の一覧。古い順。 */
  listAll(): Promise<readonly ApprovalListRow[]>;

  /** 1 件の状態。締め出し防止の判定に使う（対象がいま super かどうか）。 */
  getBySub(sub: string): Promise<ApprovalListRow | null>;

  /** 承認する（新規追加、または既存行の `isSuperApprover` を更新する。UPSERT）。 */
  grant(
    sub: string,
    isSuperApprover: boolean,
    approvedBySub: string | null,
  ): Promise<{ readonly isSuperApprover: boolean }>;

  /** 承認を剥奪する（行を削除）。削除した行があれば true。 */
  revoke(sub: string): Promise<boolean>;

  /** 権限ビットを書き換える。対象行があれば true。 */
  setPermissions(sub: string, permissions: bigint): Promise<boolean>;

  /** 承認・権限の変更を監査ログへ残す。 */
  recordAuditEvent(input: {
    readonly event: ApprovalAuditEvent;
    readonly sub: string;
    readonly actor: string;
    readonly reason: string;
    readonly detail?: string;
  }): Promise<void>;

  /** 承認・権限の変更履歴（#523）。新しい順、最大 `limit` 件。 */
  listRecentAuditEvents(limit: number): Promise<readonly ApprovalAuditEventRow[]>;
}
