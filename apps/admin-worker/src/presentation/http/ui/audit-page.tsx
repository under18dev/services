import type { AuditLogEntryAdmin } from "@u18/contracts";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  KiwaShell,
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
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * 監査ログの閲覧（`admin.under18.dev/audit`、#375 / #382 / #390 決定 16 ③）。
 *
 * **`/account/admin/audit`（dashboard-worker、#375）から移した。**
 * `users-page.tsx` と同じ形。絞り込みを URL に載せない理由もそちらと同じ。
 *
 * ## `metadata` を生の JSON で出す
 *
 * 整形して項目ごとに並べない。**監査ログの `metadata` はイベントごとに
 * 形が違う**（`ops.user.suspended` は `reason` を持つが `oauth.code.issued`
 * は持たない）。固定の表で組もうとすると、新しいイベントを足すたびに
 * この画面も直すことになる。
 */

export type AuditPageProps = {
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
      **`ipHash` を出す。** dashboard-worker 版と同じ判断——ここは管理者しか
      呼べないので、`SessionListItem` が外している理由（本人以外の IP を
      見せない）が当てはまらない。
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

export const AuditPage: FC<AuditPageProps> = ({
  csrfToken,
  entries,
  nextCursor,
  event,
  userId,
  outcome,
  error,
}) => (
  <KiwaShell
    title="監査ログ"
    nav={ADMIN_NAV_GROUPS}
    current="auditLogs"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="監査ログ"
    lead="u18 で記録されている操作の履歴を調べます。"
    maxWidth="max-w-6xl"
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
        <form method="post" action="/audit/search" class={ITEM_BODY_CLASS}>
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
          <form method="post" action="/audit/search">
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
  </KiwaShell>
);
