import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  KiwaShell,
  Separator,
} from "@u18/web-ui/kiwa";
import {
  FIELD_CLASS,
  INPUT_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  ITEM_TITLE_CLASS,
  LABEL_CLASS,
  LIST_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import type { ApprovalListRow } from "../../../application/ports/approval.repository";
import { PERMISSION_BITS, type PermissionBitName } from "../../../domain/permissions";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * 承認者・権限の管理（`admin.under18.dev/approvals`、#190）。
 *
 * **ここに来るのは `APPROVAL_GRANT`（または super approver）を持つ人だけ。**
 * `app.tsx` のルートガードが先に確かめている。
 *
 * ## super の内訳は列挙しない
 *
 * super approver は保存されたビットに関わらず全チェックをバイパスする
 * （`domain/permissions.ts`）。ビットのチェックボックスを出すと、
 * 「super なのに一部のビットが外れている」ように見えて誤解を招くので、
 * super の行はビットの編集フォームを出さず「全部（super approver）」と
 * だけ表示する。
 *
 * ## JS を要求しない
 *
 * `clients-page.tsx` と同じ判断。admin-worker にはまだ島が無く、
 * 低頻度の管理操作のために新しく持ち込む見合いが無い。
 */

const PERMISSION_ORDER = Object.keys(PERMISSION_BITS) as readonly PermissionBitName[];

export type ApprovalsPageProps = {
  readonly csrfToken: string;
  readonly approvals: readonly ApprovalListRow[];
  /** いまログインしている人の sub。自分自身の行の操作を言葉で説明するために使う。 */
  readonly viewerSub: string;
  readonly error?: string;
  readonly notice?: string;
};

const ApprovalRow: FC<{
  readonly approval: ApprovalListRow;
  readonly csrfToken: string;
  readonly viewerSub: string;
}> = ({ approval, csrfToken, viewerSub }) => (
  <li class={ITEM_BODY_CLASS}>
    <div class={ITEM_TITLE_CLASS}>
      <span>{approval.sub}</span>
      {approval.isSuperApprover ? <Badge variant="secondary">super approver</Badge> : null}
      {approval.sub === viewerSub ? <Badge variant="outline">自分</Badge> : null}
    </div>
    <p class={ITEM_META_CLASS}>
      承認 {formatDateTime(approval.createdAt.toISOString())}
      {approval.approvedBySub === null ? "" : ` / 承認者: ${approval.approvedBySub}`}
    </p>

    <form method="post" action={`/approvals/${approval.sub}/super`} class={ITEM_BODY_CLASS}>
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
      <input
        type="hidden"
        name="is_super_approver"
        value={approval.isSuperApprover ? "false" : "true"}
      />
      <button type="submit" class="text-sm text-foreground underline underline-offset-4">
        {approval.isSuperApprover ? "super approver を外す" : "super approver にする"}
      </button>
    </form>

    {approval.isSuperApprover ? (
      <p class={ITEM_META_CLASS}>
        super approver は全操作を無条件に行えます。個別の権限ビットは意味を持ちません。
      </p>
    ) : (
      <form method="post" action={`/approvals/${approval.sub}/permissions`} class={ITEM_BODY_CLASS}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <fieldset class={FIELD_CLASS}>
          <span class={LABEL_CLASS}>権限</span>
          {PERMISSION_ORDER.map((name) => (
            <label class={ITEM_RAW_CLASS}>
              <input
                type="checkbox"
                name="bit"
                value={name}
                checked={(approval.permissions & PERMISSION_BITS[name]) !== 0n}
              />{" "}
              {name}
            </label>
          ))}
        </fieldset>
        <div>
          <button type="submit" class="text-sm text-foreground underline underline-offset-4">
            権限を更新する
          </button>
        </div>
      </form>
    )}

    <form method="post" action={`/approvals/${approval.sub}/revoke`}>
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
      <button type="submit" class="text-sm text-destructive underline underline-offset-4">
        承認を剥奪する
      </button>
    </form>
  </li>
);

export const ApprovalsPage: FC<ApprovalsPageProps> = ({
  csrfToken,
  approvals,
  viewerSub,
  error,
  notice,
}) => (
  <KiwaShell
    title="承認者・権限"
    nav={ADMIN_NAV_GROUPS}
    current="approvals"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="承認者・権限"
    lead="admin.under18.dev を使ってよい人と、操作ごとの権限を管理します。"
  >
    {error === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS}>{error}</p>
        </CardContent>
      </Card>
    )}
    {notice === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS}>{notice}</p>
        </CardContent>
      </Card>
    )}

    <Card>
      <CardHeader>
        <CardTitle>新しく承認する</CardTitle>
      </CardHeader>
      <CardContent>
        <p class={ITEM_META_CLASS}>
          ログインを試みた人の sub は、u18 Identity 側のログや本人からの申告で確かめてください
          （承認待ちの一覧はまだありません）。新規の承認は権限 0（最小権限）から始まります。
        </p>
        <form method="post" action="/approvals" class={ITEM_BODY_CLASS}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>sub</span>
            <input class={INPUT_CLASS} type="text" name="sub" required maxlength={128} />
          </label>
          <label class={ITEM_RAW_CLASS}>
            <input type="checkbox" name="is_super_approver" value="true" /> super approver にする
          </label>
          <div>
            <button type="submit" class="text-sm text-foreground underline underline-offset-4">
              承認する
            </button>
          </div>
        </form>
      </CardContent>
    </Card>

    <Separator />

    <Card>
      <CardHeader>
        <CardTitle>承認済み（{approvals.length} 人）</CardTitle>
      </CardHeader>
      <CardContent>
        {approvals.length === 0 ? (
          <p class={ITEM_META_CLASS}>承認されている人が居ません。</p>
        ) : (
          <ul class={LIST_CLASS}>
            {approvals.map((approval) => (
              <ApprovalRow approval={approval} csrfToken={csrfToken} viewerSub={viewerSub} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  </KiwaShell>
);
