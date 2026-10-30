import type { AuditLogEntryAdmin } from "@u18/contracts";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@u18/web-ui/kiwa";
import {
  EMPTY_CLASS,
  FIELD_CLASS,
  INPUT_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  LABEL_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { ADMIN_AUDIT_SEARCH_PATH } from "./asset-paths";
import { CSRF_FIELD_NAME } from "../csrf";
import { formatDateTime } from "./format";

/**
 * 監査ログの閲覧（`/account/admin/audit`、#375 / #382）。**管理者だけ。**
 *
 * `admin-users-page.tsx` と同じ形。**絞り込みを URL に載せない** ——
 * メールアドレスやアドレス帳のような値では無いが（`event` は固定の名前、
 * `userId` は内部 ID）、同じ画面の作りに揃えるほうが読む人に優しい。
 *
 * **最初から表で組む。** `admin-users-page.tsx` は箇条書きから表へ作り直した
 * 経緯があるが、ここでは理由（0 件の見せ方・行ごとの区切り）が最初から
 * 分かっているので、作り直しを経由しない。
 *
 * ## `metadata` を生の JSON で出す
 *
 * 整形して項目ごとに並べない。**監査ログの `metadata` はイベントごとに
 * 形が違う**（`ops.user.suspended` は `reason` を持つが `oauth.code.issued`
 * は持たない）。固定の表で組もうとすると、新しいイベントを足すたびに
 * この画面も直すことになる —— **`auth_log.port.ts` の登録簿と二重管理**
 * になる。
 */

export type AdminAuditPageProps = {
  readonly isAdmin: boolean;
  readonly csrfToken: string;
  readonly entries: readonly AuditLogEntryAdmin[];
  readonly nextCursor: string | null;
  readonly event?: string;
  readonly userId?: string;
  readonly outcome?: "success" | "failure";
  readonly error?: string;
};

const EntryRow: FC<{ readonly entry: AuditLogEntryAdmin }> = ({ entry }) => (
  <TableRow>
    <TableCell>{formatDateTime(entry.createdAt)}</TableCell>
    <TableCell class="whitespace-normal">
      <span class={ITEM_RAW_CLASS}>{entry.event}</span>
    </TableCell>
    <TableCell>
      {entry.outcome === "success" ? (
        <Badge variant="success">成功</Badge>
      ) : (
        <Badge variant="destructive">失敗</Badge>
      )}
    </TableCell>
    <TableCell class="whitespace-normal">
      {entry.userId === null ? (
        <span class={ITEM_META_CLASS}>—</span>
      ) : (
        <span class={ITEM_RAW_CLASS}>{entry.userId}</span>
      )}
    </TableCell>
    <TableCell class="whitespace-normal">
      <span class={ITEM_META_CLASS}>{entry.actor ?? "—"}</span>
    </TableCell>
    {/*
      **`ipHash` を出す。** `SessionListItem` が意図的に外しているのと同じ
      行の値だが、ここは管理者しか呼べないので条件が違う（契約の
      `AuditLogEntryAdmin` の JSDoc）。同じ Worker を調べた複数アカウントを
      結び付ける調査に使う。
    */}
    <TableCell class="whitespace-normal">
      <span class={ITEM_RAW_CLASS}>{entry.ipHash ?? "—"}</span>
    </TableCell>
    <TableCell class="whitespace-normal">
      {entry.reason === null && entry.metadata === null ? (
        <span class={ITEM_META_CLASS}>—</span>
      ) : (
        <>
          {entry.reason === null ? null : <p class={ITEM_META_CLASS}>{entry.reason}</p>}
          {entry.metadata === null ? null : (
            <pre class={ITEM_RAW_CLASS}>{JSON.stringify(entry.metadata)}</pre>
          )}
        </>
      )}
    </TableCell>
  </TableRow>
);

export const AdminAuditPage: FC<AdminAuditPageProps> = ({
  isAdmin,
  csrfToken,
  entries,
  nextCursor,
  event,
  userId,
  outcome,
  error,
}) => (
  <AccountShell
    isAdmin={isAdmin}
    title="監査ログ"
    heading="監査ログ"
    lead="u18 で記録されている操作の履歴を調べます。"
    current="auditLogs"
  >
    {error === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS}>{error}</p>
        </CardContent>
      </Card>
    )}

    <Card>
      <CardHeader>
        <CardTitle>絞り込む</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action={ADMIN_AUDIT_SEARCH_PATH} class={ITEM_BODY_CLASS}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>イベント名（完全一致）</span>
            <input
              class={INPUT_CLASS}
              type="text"
              name="event"
              maxlength={64}
              value={event ?? ""}
              placeholder="例: ops.user.suspended"
              autocomplete="off"
            />
          </label>
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>利用者 ID（完全一致）</span>
            <input
              class={INPUT_CLASS}
              type="text"
              name="user_id"
              maxlength={64}
              value={userId ?? ""}
              autocomplete="off"
            />
          </label>
          <fieldset class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>結果</span>
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="outcome" value="" checked={outcome === undefined} />{" "}
              指定しない
            </label>
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="outcome" value="success" checked={outcome === "success"} />{" "}
              成功のみ
            </label>
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="outcome" value="failure" checked={outcome === "failure"} />{" "}
              失敗のみ
            </label>
          </fieldset>
          <div>
            <button type="submit" class="text-sm text-foreground underline underline-offset-4">
              絞り込む
            </button>
          </div>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>新しい順</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p class={EMPTY_CLASS}>一致する記録はありません。</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日時</TableHead>
                <TableHead>イベント</TableHead>
                <TableHead>結果</TableHead>
                <TableHead>利用者</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>IP ハッシュ</TableHead>
                <TableHead>詳細</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <EntryRow entry={entry} />
              ))}
            </TableBody>
          </Table>
        )}
        {nextCursor === null ? null : (
          <form method="post" action={ADMIN_AUDIT_SEARCH_PATH}>
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <input type="hidden" name="cursor" value={nextCursor} />
            <input type="hidden" name="event" value={event ?? ""} />
            <input type="hidden" name="user_id" value={userId ?? ""} />
            <input type="hidden" name="outcome" value={outcome ?? ""} />
            <button type="submit" class="text-sm text-foreground underline underline-offset-4">
              続きを読む
            </button>
          </form>
        )}
      </CardContent>
    </Card>
  </AccountShell>
);
