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
 *
 * **`ApprovalAuditEvent` は型だけ import する。** CLI（`admin-approval.mjs`）
 * はこのファイルを Node から直接 `import()` するが、Node の ESM ローダーは
 * 拡張子無しの相対 import（`../../domain/approval-audit-events`）を `.ts` へ
 * 自動解決しない。型だけの import は型ストリップで消え、実行時に解決を
 * 試みないのでこの問題を起こさない——値（`APPROVAL_AUDIT_EVENTS`）は
 * ここから再輸出せず、CLI は `domain/approval-audit-events.ts` を直接
 * `loadDomain()` で読む（`approval-guard.ts` が同じ理由で
 * `./permissions` の import 自体を無くしたのと同じ考え方）。
 */
import type { ApprovalAuditEvent } from "../../domain/approval-audit-events";

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
  return `select id, sub, is_super_approver, permissions, approved_by_sub, created_at
    from admin_approvals
   where sub = ${subLiteral};`;
}

/** 承認済み全員。「誰が使ってよいか」を一覧する。 */
export function listApprovalsSql(): string {
  return `select id, sub, is_super_approver, permissions, approved_by_sub, created_at
    from admin_approvals
order by created_at asc;`;
}

/**
 * いま super approver が何人いるか（#190、締め出し防止）。
 *
 * `approval-guard.ts` の `checkSuperApproverChange` / `checkApprovalRevocation`
 * に渡す値を、書き込みの**前に**確かめるために使う。
 */
export function countSuperApproversSql(): string {
  return `select count(*) as count from admin_approvals where is_super_approver = 1;`;
}

/**
 * 権限ビットを書き換える（#190）。
 *
 * **ここでは OR も AND NOT もしない。** 呼び出し側（CLI）が
 * `approvalStatusSql` で現在値を読み、`permissions.ts` の BigInt 演算で
 * 新しい値を計算してから、この文で書き戻す——SQL 側で TEXT 列に対する
 * ビット演算はできない（`permissions` 列のコメントを参照）。読み・計算・
 * 書きの 3 ステップがアトミックではない（2 回の `wrangler d1 execute` を
 * 挟む）が、この CLI は低頻度の手動操作なので許容する。
 */
export function setPermissionsSql(sub: string, permissions: string): string {
  return `update admin_approvals set permissions = ${sqlLiteral(permissions)}
    where sub = ${sqlLiteral(sub)}
returning id, permissions;`;
}

export type { ApprovalAuditEvent };

/**
 * 承認・剥奪・権限の変更を監査ログに残す。
 *
 * `admin_approval_events` へ書く。`actor` は実行した人の自由文字列
 * （GitHub のハンドル等）。承認の増減はいまのところこの CLI でしか
 * 起きないので、ブートストラップ（最初の 1 人）も含めて常に値が入る。
 *
 * `detail` は権限ビットの変更にだけ使う。**ビットの記号名**
 * （例: `"NFC_WRITE"`）をそのまま文字列で残す——生の数値だけでは
 * 後から読む人がコードを調べ直さないと意味を復元できず、
 * 「人が読める形で残る」という #190 の受け入れ条件を満たさない。
 */
export function approvalAuditSql(input: {
  readonly event: ApprovalAuditEvent;
  readonly sub: string;
  /** CLI の `--actor`。u18 Identity の sub ではない自由文字列。常に要る（`requireActor`）。 */
  readonly actor: string;
  readonly reason: string;
  /** 権限ビットの記号名。承認そのものの付与・剥奪では省略（null になる）。 */
  readonly detail?: string;
}): string {
  return `insert into admin_approval_events (id, sub, event, actor, reason, detail, created_at)
values (
  'ade_' || lower(hex(randomblob(16))),
  ${sqlLiteral(input.sub)},
  ${sqlLiteral(input.event)},
  ${sqlLiteral(input.actor)},
  ${sqlLiteral(input.reason)},
  ${input.detail === undefined ? "null" : sqlLiteral(input.detail)},
  ${NOW_MS}
);`;
}
