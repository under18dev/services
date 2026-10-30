/**
 * 承認リストの付与・剥奪に使う SQL 文（運用者の判断、2026-10-30 夜）。
 *
 * **なぜ Repository のメソッドではなく SQL の文字列なのか。**
 * 付与・剥奪に画面を作らない（最初のうちは。承認する側の画面——「誰が
 * 待っているか」の一覧——がまだ無い）。唯一の実行経路は運用者の手元で
 * 動く `scripts/admin-approval.mjs` で、それは Worker の中ではなく
 * `wrangler d1 execute` 越しに ADMIN_DB を触る。実際に流れる文をここへ
 * 出し、CLI とテストの両方が同じ文字列を使う形にする
 * （`apps/auth-worker/src/infrastructure/persistence/admin-role.sql.ts`
 * と同じ方針）。
 */

/**
 * SQL リテラルへ落とす。
 *
 * 値は運用者の手元から来るが、だからといってそのまま埋めない。
 * `sub` は ID Token から貼られるものだが、**文が壊れるのではなく
 * 意味が変わる**のが SQL 注入である。ここは CLI とテストが共有する
 * 唯一の入口なので、逃がす処理もここに 1 つだけ置く。
 */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const NOW_MS = "unixepoch() * 1000";

/**
 * 承認する（新規追加、または既存行の「最高権限」フラグを更新する）。
 *
 * **UPSERT にしてある。** 新しい `sub` を承認するのと、既に承認済みの
 * `sub` の `is_super_approver` を変える（昇格・降格）のを同じ文にする。
 * 適用された行を `returning` で返すので、呼び出し側は「何が起きたか」を
 * 別の SELECT に頼らず読める。
 */
export function grantApprovalSql(sub: string, isSuperApprover: boolean): string {
  const subLiteral = sqlLiteral(sub);
  return `insert into admin_approvals (id, sub, is_super_approver, approved_by_sub, created_at)
values (
  'adm_' || lower(hex(randomblob(16))),
  ${subLiteral},
  ${isSuperApprover ? 1 : 0},
  null,
  ${NOW_MS}
)
on conflict (sub) do update set is_super_approver = excluded.is_super_approver
returning id, is_super_approver;`;
}

/**
 * 承認を剥奪する。
 *
 * **前提条件を置かない。** 権限を減らす操作は常に通ること——
 * `admin-role.sql.ts` の `revokeAdminSql` と同じ判断。
 */
export function revokeApprovalSql(sub: string): string {
  const subLiteral = sqlLiteral(sub);
  return `delete from admin_approvals where sub = ${subLiteral} returning id;`;
}

/** 1 件の状態を見るための SELECT。判定には使わない（CLI が人に見せるためだけ）。 */
export function approvalStatusSql(sub: string): string {
  const subLiteral = sqlLiteral(sub);
  return `select id, sub, is_super_approver, approved_by_sub, created_at
    from admin_approvals
   where sub = ${subLiteral};`;
}

/** 承認済み全員。「誰が使ってよいか」を一覧する。 */
export function listApprovalsSql(): string {
  return `select id, sub, is_super_approver, approved_by_sub, created_at
    from admin_approvals
order by created_at asc;`;
}

/**
 * 承認・剥奪のイベント名。
 *
 * **プロパティの形で書く。** auth-worker の `ADMIN_ROLE_AUDIT_EVENTS` の
 * コメントにある理由——登録簿の走査が拾うのはこの形で、型の union だけに
 * すると「宣言はあるが検査の視野に入らない」ができる。admin-worker の
 * 監査イベントの登録簿はまだ無いので、いまは**この定数自体が登録簿**で
 * あり、将来そちらを作るときはここから移す。
 */
export const APPROVAL_AUDIT_EVENTS = {
  granted: { event: "ops.approval.granted" },
  revoked: { event: "ops.approval.revoked" },
} as const satisfies Record<string, { event: string }>;

export type ApprovalAuditEvent =
  (typeof APPROVAL_AUDIT_EVENTS)[keyof typeof APPROVAL_AUDIT_EVENTS]["event"];

/**
 * 承認・剥奪を監査ログに残す。
 *
 * `admin_approval_events` へ書く。`actor` は実行した人の自由文字列
 * （GitHub のハンドル等）。承認の増減はいまのところこの CLI でしか
 * 起きないので、ブートストラップ（最初の 1 人）も含めて常に値が入る。
 */
export function approvalAuditSql(input: {
  readonly event: ApprovalAuditEvent;
  readonly sub: string;
  /** CLI の `--actor`。u18 Identity の sub ではない自由文字列。常に要る（`requireActor`）。 */
  readonly actor: string;
  readonly reason: string;
}): string {
  return `insert into admin_approval_events (id, sub, event, actor, reason, created_at)
values (
  'ade_' || lower(hex(randomblob(16))),
  ${sqlLiteral(input.sub)},
  ${sqlLiteral(input.event)},
  ${sqlLiteral(input.actor)},
  ${sqlLiteral(input.reason)},
  ${NOW_MS}
);`;
}
