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
  ITEM_ACTIONS_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  ITEM_TITLE_CLASS,
  LABEL_CLASS,
  LIST_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { UserRefAdmin } from "@u18/contracts";
import type { FC } from "hono/jsx";
import type { ApprovalListRow } from "../../../application/ports/approval.repository";
import { PERMISSION_BITS, type PermissionBitName } from "../../../domain/permissions";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import { UserRef } from "./user-ref";

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
 *
 * ## 相手を名前で出す（#482）
 *
 * **ここは「誰に管理画面の権限を与えるか」を決める画面である。** 以前は
 * `sub` の生の ID しか出ておらず、与えようとしている相手が誰なのかを
 * 画面の上で確かめられなかった——利用者の凍結もカードの無効化も、
 * ここで渡した権限で行われる。`UserRef` / `resolveUserRefs`（#471）で
 * `sub`（承認済みの本人）と `approvedBySub`（承認者）の両方を解決する。
 *
 * **新規承認の sub 入力欄は直さない。** 入力した時点ではまだ存在を
 * 確かめようがなく（送信して初めて auth-worker 側の実在確認が走る）、
 * 入力中にリアルタイムで名前を引く仕組みは `UserRef`/`resolveUserRefs`
 * の再利用だけでは作れない——JS での逐次問い合わせが要る別の作業に
 * なるため、この issue では見送る（issue #482 の冒頭にも同じ注記）。
 *
 * ## 剥奪は 2 段階確認（#487）
 *
 * 押した瞬間にその人は管理画面へ入れなくなる、ロットの一括無効化等より
 * 重い操作なのに確認が無かった。`revokeConfirmSub` が立っているときだけ
 * 確認カードを出す——**締め出し判定はサーバー側（`approvals.routes.tsx`）
 * がこのカードを出す前に済ませている**ので、ここでは「名前を見せて
 * 確定を待つ」以上のことをしない。
 *
 * ## 権限名の日本語化（#487）
 *
 * 定数名をそのまま出していたのを、日本語の名前と 1 行の説明に差し替えた。
 * **文言は issue #487 のコメントで確定済みのものをそのまま使っている**
 * ——ここで言い回しを変えない。`APPROVAL_GRANT` だけ他の 7 つと節を
 * 分けている（「管理画面の中で何ができるか」ではなく「管理画面を使える
 * 人を増やせる」という実質的な昇格のため、重みが違う）。
 */

const PERMISSION_ORDER = Object.keys(PERMISSION_BITS) as readonly PermissionBitName[];

/**
 * 権限ビットの日本語名と 1 行の説明（issue #487 のコメントで確定）。
 *
 * **定数名も併記する。** `scripts/admin-approval.mjs`（CLI）が同じ名前を
 * 使うため消せない——ただし主役は日本語のほうで、定数は補助。
 */
const PERMISSION_LABELS: Readonly<
  Record<PermissionBitName, { label: string; description: string }>
> = {
  NFC_READ: {
    label: "カードを見る",
    description: "カードの一覧・1 枚の詳細・タップの解析を開けます。",
  },
  NFC_WRITE: {
    label: "カードを操作する",
    description: "発行・無効化・復帰・所有権の剥奪・遷移先の書き換えができます。",
  },
  USER_READ: {
    label: "利用者を見る",
    description: "利用者の一覧・検索・1 人の詳細を開けます。",
  },
  USER_SUSPEND: {
    label: "利用者を止める",
    description: "利用者の凍結・解除と、ログイン中の端末の追い出しができます。",
  },
  CLIENT_READ: {
    label: "アプリを見る",
    description: "OAuth クライアントの一覧・1 件の詳細を開けます。",
  },
  CLIENT_WRITE: {
    label: "アプリを操作する",
    description: "登録・失効・持ち主と表示用 URL の変更ができます。",
  },
  AUDIT_READ: {
    label: "監査ログを読む",
    description: "誰が何をしたかの記録を全件たどれます。",
  },
  APPROVAL_GRANT: {
    label: "権限を配る",
    description:
      "この管理画面を使える人を増やし、その人の権限を決められます。" +
      "渡した相手も同じことができるようになります。",
  },
};

/** `APPROVAL_GRANT` は他の 7 つと並びを分ける（#487）。 */
const REGULAR_PERMISSION_ORDER = PERMISSION_ORDER.filter((name) => name !== "APPROVAL_GRANT");

export type ApprovalsPageProps = {
  readonly csrfToken: string;
  readonly approvals: readonly ApprovalListRow[];
  /** いまログインしている人の sub。自分自身の行の操作を言葉で説明するために使う。 */
  readonly viewerSub: string;
  /** `sub` / `approvedBySub` の名前解決（#482、`resolveUserRefs` が束ねる）。 */
  readonly refs: ReadonlyMap<string, UserRefAdmin>;
  readonly error?: string;
  readonly notice?: string;
  /**
   * 剥奪の 1 段階目（#487）。立っていれば、この sub の確認カードを出す。
   * **締め出し判定はこのカードが出る前にサーバー側で済んでいる**
   * ——ここでは名前を見せて確定を待つだけ。
   */
  readonly revokeConfirmSub?: string;
};

/** 権限 1 つぶんのチェックボックス。日本語名を主役にし、定数名は補助として併記する（#487）。 */
const PermissionCheckbox: FC<{
  readonly name: PermissionBitName;
  readonly checked: boolean;
}> = ({ name, checked }) => (
  <label class={ITEM_RAW_CLASS}>
    <input type="checkbox" name="bit" value={name} checked={checked} />{" "}
    <strong>{PERMISSION_LABELS[name].label}</strong>
    <span class={ITEM_META_CLASS}>
      {" "}
      {PERMISSION_LABELS[name].description}（{name}）
    </span>
  </label>
);

const ApprovalRow: FC<{
  readonly approval: ApprovalListRow;
  readonly csrfToken: string;
  readonly viewerSub: string;
  readonly refs: ReadonlyMap<string, UserRefAdmin>;
}> = ({ approval, csrfToken, viewerSub, refs }) => (
  <li class={ITEM_BODY_CLASS}>
    <div class={ITEM_TITLE_CLASS}>
      <UserRef id={approval.sub} refs={refs} />
      {approval.isSuperApprover ? <Badge variant="secondary">super approver</Badge> : null}
      {approval.sub === viewerSub ? <Badge variant="outline">自分</Badge> : null}
    </div>
    <p class={ITEM_META_CLASS}>
      承認 {formatDateTime(approval.createdAt.toISOString())}
      {approval.approvedBySub === null ? null : (
        <>
          {" "}
          / 承認者: <UserRef id={approval.approvedBySub} refs={refs} />
        </>
      )}
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
          {REGULAR_PERMISSION_ORDER.map((name) => (
            <PermissionCheckbox
              key={name}
              name={name}
              checked={(approval.permissions & PERMISSION_BITS[name]) !== 0n}
            />
          ))}
        </fieldset>
        <Separator />
        {/*
          **`APPROVAL_GRANT` だけ節を分ける（#487）。** 他の 7 つは
          「管理画面の中で何ができるか」だが、これは「管理画面を使える人を
          増やせる」——実質的な昇格で、重みが違う。同じ並びに混ぜない。
          **見出しはラベル（「権限を配る」）と同じ言葉を繰り返さない。**
          節が 1 項目しか持たないので、同じ文字列を 2 回続けて読ませると
          重複でしかなかった（指摘: 3b）。
        */}
        <fieldset class={FIELD_CLASS}>
          <span class={LABEL_CLASS}>ここだけ特に重い（実質的な昇格）</span>
          <PermissionCheckbox
            name="APPROVAL_GRANT"
            checked={(approval.permissions & PERMISSION_BITS.APPROVAL_GRANT) !== 0n}
          />
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
  refs,
  error,
  notice,
  revokeConfirmSub,
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

    {revokeConfirmSub === undefined ? null : (
      <Card>
        <CardHeader>
          <CardTitle>本当に剥奪しますか</CardTitle>
        </CardHeader>
        <CardContent class={ITEM_BODY_CLASS}>
          <p class={ITEM_META_CLASS}>
            <UserRef id={revokeConfirmSub} refs={refs} /> の承認を剥奪します。 この人は
            admin.under18.dev へ入れなくなります。
          </p>
          <div class={ITEM_ACTIONS_CLASS}>
            <form method="post" action={`/approvals/${revokeConfirmSub}/revoke`}>
              <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
              <input type="hidden" name="confirm" value="true" />
              <button type="submit" class="text-sm text-destructive underline underline-offset-4">
                本当に剥奪する
              </button>
            </form>
            <a href="/approvals" class="text-sm text-foreground-muted underline underline-offset-4">
              キャンセル
            </a>
          </div>
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
              <ApprovalRow
                approval={approval}
                csrfToken={csrfToken}
                viewerSub={viewerSub}
                refs={refs}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  </KiwaShell>
);
