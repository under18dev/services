import type { AuditLogEntryAdmin, OAuthClientSummary, UserRefAdmin } from "@u18/contracts";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
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
  ITEM_TITLE_CLASS,
  LABEL_CLASS,
  LIST_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { UserRef } from "./user-ref";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * OAuth クライアント 1 件の詳細（`admin.under18.dev/clients/:clientId`、#473）。
 *
 * **`clients-page.tsx`（一覧）には「1 件だけを確かめる場所」が無かった。**
 * `redirect_uris` も scope も作成日も、一覧の行の中に畳むか出さないかの
 * 二択で、`#441` で持ち主を持たせてもその持ち主が誰なのかは生の ID でしか
 * 出なかった。この画面はその 1 件を、他の行を気にせず確かめる場所。
 *
 * ## タブは #470 の `data-tabs` に合わせる予定（まだ繋がない）
 *
 * `<section data-panel="key">` を 4 つ並べているが、**`<button data-tab>`
 * の選択用ボタンはまだ置いていない。** タブの見本（2b が用意）が出て
 * いないので、押しても何も起きないボタンを残さないため（JS の無い間は
 * 縦に並ぶだけで成立する）。見出しの文言（概要 / redirect_uri /
 * 監査ログ / 操作）は、そのままタブのラベルになる前提で短くしてある
 * ——繋ぐ段になって文言を変えずに済むように。
 */

export type ClientDetailPageProps = {
  readonly csrfToken: string;
  readonly client: OAuthClientSummary;
  /** 持ち主の名前解決（#471、`resolveUserRefs` が束ねる）。`UserRef` が出し分ける。 */
  readonly ownerRefs: ReadonlyMap<string, UserRefAdmin>;
  /** クライアントに関係する直近の監査ログ。**引けなかったら `null`**（空配列と区別する）。 */
  readonly auditEntries: readonly AuditLogEntryAdmin[] | null;
  readonly error?: string;
  readonly notice?: string;
};

/** コピー用の目印（#470 決定の `data-copy`）。**値はここにしか無い——JS が後から読む。** */
const CopyButton: FC<{ readonly value: string }> = ({ value }) => (
  <button type="button" data-copy={value} hidden>
    コピー
  </button>
);

const AuditEntries: FC<{ readonly entries: readonly AuditLogEntryAdmin[] | null }> = ({
  entries,
}) => {
  if (entries === null) {
    return <p class={EMPTY_CLASS}>いま監査ログを取得できません。あとでもう一度開いてください。</p>;
  }

  if (entries.length === 0) {
    return <p class={EMPTY_CLASS}>このクライアントに関係する記録はありません。</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>日時</TableHead>
          <TableHead>イベント</TableHead>
          <TableHead>結果</TableHead>
          <TableHead>操作した管理者</TableHead>
          <TableHead>詳細</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
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
            {/*
              **`userId` を「操作した管理者」として出す。** クライアント向けの
              監査イベントは対象をクライアントに持ち、`userId` には実行者が
              入る（`delegated-disable-oauth-client.use-case.ts` 等の JSDoc）。
              「利用者」と書くと対象と取り違える。
            */}
            <TableCell class="whitespace-normal">
              <span class={ITEM_META_CLASS}>{entry.userId ?? "—"}</span>
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
        ))}
      </TableBody>
    </Table>
  );
};

export const ClientDetailPage: FC<ClientDetailPageProps> = ({
  csrfToken,
  client,
  ownerRefs,
  auditEntries,
  error,
  notice,
}) => (
  <KiwaShell
    title={`${client.name} の詳細`}
    nav={ADMIN_NAV_GROUPS}
    current="clients"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="クライアントの詳細"
    lead="1 件のクライアントを確かめてから、同じ画面で操作できます。"
    maxWidth="max-w-6xl"
  >
    <div>
      <a href="/clients" class="text-sm text-foreground-muted underline underline-offset-4">
        ← クライアントの一覧へ戻る
      </a>
    </div>

    {error === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS} data-notice>
            {error}
          </p>
        </CardContent>
      </Card>
    )}
    {notice === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS} data-notice>
            {notice}
          </p>
        </CardContent>
      </Card>
    )}

    <div data-tabs>
      <Card data-panel="overview">
        <CardHeader>
          <CardTitle>
            <span class={ITEM_TITLE_CLASS}>
              <span>概要</span>
              {client.isFirstParty ? <Badge variant="secondary">u18 公式</Badge> : null}
              {client.clientType === "public" ? <Badge variant="outline">public</Badge> : null}
              {client.disabledAt === null ? null : <Badge variant="destructive">失効済み</Badge>}
            </span>
          </CardTitle>
          <CardDescription>{client.name}</CardDescription>
        </CardHeader>
        <CardContent class={ITEM_BODY_CLASS}>
          <dl class="grid gap-3 sm:grid-cols-2">
            <div>
              <dt class={LABEL_CLASS}>client_id</dt>
              <dd class={ITEM_RAW_CLASS}>
                {client.clientId} <CopyButton value={client.clientId} />
              </dd>
            </div>
            <div>
              <dt class={LABEL_CLASS}>種別</dt>
              {/*
                **`client_secret` もそのハッシュも出さない。** confidential
                かどうかだけが「秘密を持つか」の答えで、ここで示すのは
                そのブール以上のものではない（issue #473 の制約）。
              */}
              <dd class={ITEM_META_CLASS}>
                {client.clientType === "confidential" ? "confidential（秘密は設定済み）" : "public"}
              </dd>
            </div>
            <div>
              <dt class={LABEL_CLASS}>作成日</dt>
              <dd class={ITEM_META_CLASS}>{formatDateTime(client.createdAt)}</dd>
            </div>
            <div>
              <dt class={LABEL_CLASS}>失効</dt>
              <dd class={ITEM_META_CLASS}>
                {client.disabledAt === null
                  ? "失効していません"
                  : formatDateTime(client.disabledAt)}
              </dd>
            </div>
            <div>
              <dt class={LABEL_CLASS}>持ち主</dt>
              <dd>
                <UserRef id={client.ownerUserId} refs={ownerRefs} />
              </dd>
            </div>
            <div>
              <dt class={LABEL_CLASS}>表示用 URL</dt>
              <dd class="break-all">
                {client.appUrl === null ? (
                  <span class={ITEM_META_CLASS}>—</span>
                ) : (
                  <a
                    href={client.appUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline underline-offset-4"
                  >
                    {client.appUrl}
                  </a>
                )}
              </dd>
            </div>
          </dl>
          <div>
            <p class={LABEL_CLASS}>scope</p>
            <div class="flex flex-wrap gap-2">
              {client.scopes.map((scope) => (
                <Badge variant="outline" key={scope}>
                  {scope}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-panel="redirect-uris">
        <CardHeader>
          <CardTitle>redirect_uri</CardTitle>
          <CardDescription>
            登録したつもりの URI と、実際に登録されている URI のずれを確かめる場所です。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {client.redirectUris.length === 0 ? (
            <p class={EMPTY_CLASS}>登録されている redirect_uri はありません。</p>
          ) : (
            <ul class={LIST_CLASS}>
              {client.redirectUris.map((uri) => (
                <li class={ITEM_RAW_CLASS} key={uri}>
                  {uri} <CopyButton value={uri} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card data-panel="audit">
        <CardHeader>
          <CardTitle>監査ログ</CardTitle>
          <CardDescription>
            {/*
              **「このクライアントの記録」とは言い切らない。** `listAuditLogs`
              に clientId で絞る口が無いため、ここに出るのは OAuth
              クライアント全体の管理操作の直近である（`clients.routes.tsx`
              の `fetchClientAudit` を参照）。絞り込みは別便にする、と
              3b と合意済み。
            */}
            クライアント全体の管理操作のうち、直近のものです（この 1
            件だけへの絞り込みはまだできません）。新しい順です。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AuditEntries entries={auditEntries} />
        </CardContent>
      </Card>

      <Card data-panel="operations">
        <CardHeader>
          <CardTitle>操作</CardTitle>
          <CardDescription>
            一覧（`/clients`）と同じ操作です。ここで変えると一覧にも反映されます。
          </CardDescription>
        </CardHeader>
        <CardContent class={ITEM_BODY_CLASS}>
          <form method="post" action="/clients/owner" class={ITEM_BODY_CLASS}>
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <input type="hidden" name="client_id" value={client.clientId} />
            <input type="hidden" name="from" value="detail" />
            <label class={FIELD_CLASS}>
              <span class={LABEL_CLASS}>持ち主の userId（空欄で外す）</span>
              <input
                class={INPUT_CLASS}
                type="text"
                name="owner_user_id"
                maxlength={64}
                value={client.ownerUserId ?? ""}
              />
            </label>
            <div>
              <button type="submit" class="text-sm text-foreground underline underline-offset-4">
                持ち主を変更する
              </button>
            </div>
          </form>

          {client.isFirstParty ? (
            <p class={ITEM_META_CLASS}>
              u18 公式のクライアントは、この画面からは失効させられません。ログイン画面そのものが
              止まるためです。
            </p>
          ) : client.disabledAt === null ? (
            <form method="post" action="/clients/disable">
              <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
              <input type="hidden" name="client_id" value={client.clientId} />
              <input type="hidden" name="from" value="detail" />
              <button type="submit" class="text-sm text-destructive underline underline-offset-4">
                失効させる
              </button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </div>
  </KiwaShell>
);
