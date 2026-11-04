/**
 * 承認・権限の変更イベント名（#190）。
 *
 * **Domain に置く理由。** `infrastructure/persistence/approval.sql.ts`
 * （Infrastructure）と `presentation/http/approvals.routes.tsx`
 * （Presentation）の両方がこの名前を必要とするが、Layered Architecture は
 * Infrastructure → Presentation、Presentation → Infrastructure のどちらの
 * 向きの依存も禁じている（`packages/config/eslint.layers.js`）。
 * 両方から見える Domain に置けば、どちらも Domain だけを import すればよい
 * （`approval.sql.ts` はここから re-export し、CLI の `sql.APPROVAL_AUDIT_EVENTS`
 * という既存の参照のされ方は変えない）。
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
  /** 個別の権限ビットを付与した。 */
  permissionGranted: { event: "ops.permission.granted" },
  /** 個別の権限ビットを剥奪した。 */
  permissionRevoked: { event: "ops.permission.revoked" },
} as const satisfies Record<string, { event: string }>;

export type ApprovalAuditEvent =
  (typeof APPROVAL_AUDIT_EVENTS)[keyof typeof APPROVAL_AUDIT_EVENTS]["event"];
