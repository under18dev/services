import type { AuditLogEntryAdmin, UserRefAdmin } from "@u18/contracts";
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
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import { UserRef } from "./user-ref";

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
 *
 * ## 並べ替え・絞り込み・コピーは `admin-island.ts` が付ける（#470）
 *
 * サーバー側の絞り込み（`/audit/search`、イベント名・利用者 ID・結果）は
 * そのまま残す。**島が足すのはいま画面に出ている分への並べ替えと
 * 文字列絞り込みだけ**——`ui/client/README.md` を参照。IP ハッシュと
 * メタデータはコピーボタンを添える。長い文字列を選択でコピーするより
 * 速い、という後付けの便利さであって、JS が無くても両方そのまま読める。
 */

export type AuditPageProps = {
  readonly csrfToken: string;
  readonly entries: readonly AuditLogEntryAdmin[];
  /**
   * `entries` の `userId` の名前解決（#482、`resolveUserRefs` が束ねる）。
   *
   * **「利用者」列の意味はイベントによって違う。** 利用者を対象とする
   * イベント（`ops.user.suspended` 等）では対象本人、クライアントを
   * 対象とするイベント（`oauth.client.created` 等）では実行した管理者が
   * 入る（`AuditLogEntryAdmin.userId` の JSDoc）。**ここではその違いを
   * 正さない**——`UserRef` は ID を名前に変えるだけで、列の意味づけは
   * 契約側の既存の区別のまま。
   */
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
  readonly nextCursor: string | null;
  readonly event?: string;
  readonly userId?: string;
  readonly outcome?: "success" | "failure";
  readonly error?: string;
};

const EntryRow: FC<{
  readonly entry: AuditLogEntryAdmin;
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
}> = ({ entry, userRefs }) => (
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
      <UserRef id={entry.userId} refs={userRefs} />
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
      {entry.ipHash === null ? (
        <span class={ITEM_META_CLASS}>—</span>
      ) : (
        <div class="flex items-center gap-2">
          <span class={ITEM_RAW_CLASS}>{entry.ipHash}</span>
          <button
            type="button"
            class="shrink-0 text-xs text-foreground underline underline-offset-4"
            data-copy={entry.ipHash}
            hidden
          >
            コピー
          </button>
        </div>
      )}
    </TableCell>
    <TableCell class="whitespace-normal">
      {entry.reason === null && entry.metadata === null ? (
        <span class={ITEM_META_CLASS}>—</span>
      ) : (
        <div class="flex items-start gap-2">
          <div>
            {entry.reason === null ? null : <p class={ITEM_META_CLASS}>{entry.reason}</p>}
            {entry.metadata === null ? null : (
              <pre class={ITEM_RAW_CLASS}>{JSON.stringify(entry.metadata)}</pre>
            )}
          </div>
          {entry.metadata === null ? null : (
            <button
              type="button"
              class="shrink-0 text-xs text-foreground underline underline-offset-4"
              data-copy={JSON.stringify(entry.metadata)}
              hidden
            >
              コピー
            </button>
          )}
        </div>
      )}
    </TableCell>
  </TableRow>
);

export const AuditPage: FC<AuditPageProps> = ({
  csrfToken,
  entries,
  userRefs,
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
    scripts={[ISLAND_PATH]}
  >
    {error === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS} data-notice>
            {error}
          </p>
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
      <CardContent class="flex flex-col gap-3">
        {entries.length === 0 ? (
          <p class={EMPTY_CLASS}>一致する記録はありません。</p>
        ) : (
          <>
            {/*
              **サーバー側の絞り込み（上のフォーム）とは別物。** こちらは
              いま表の上に出ている分だけを見る——`ui/client/README.md` の
              「絞り込み」を参照。
            */}
            <input
              class={INPUT_CLASS}
              type="search"
              data-filter="audit-table"
              placeholder="この一覧から絞り込み"
              aria-label="この一覧から絞り込み"
              hidden
            />
            <Table id="audit-table" data-sortable>
              <TableHeader>
                <TableRow>
                  <TableHead data-sort="date">日時</TableHead>
                  <TableHead data-sort="text">イベント</TableHead>
                  <TableHead>結果</TableHead>
                  <TableHead>利用者</TableHead>
                  <TableHead>Worker</TableHead>
                  <TableHead>IP ハッシュ</TableHead>
                  <TableHead>詳細</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <EntryRow entry={entry} userRefs={userRefs} />
                ))}
              </TableBody>
            </Table>
          </>
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
