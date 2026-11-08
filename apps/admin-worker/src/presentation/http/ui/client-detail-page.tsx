import type { AuditLogEntryAdmin, OAuthClientSummary, UserRefAdmin } from "@u18/contracts";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  getButtonClasses,
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
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * OAuth クライアント 1 件の詳細（`admin.under18.dev/clients/:clientId`、#473）。
 *
 * **`clients-page.tsx`（一覧）には「1 件だけを確かめる場所」が無かった。**
 * `redirect_uris` も scope も作成日も、一覧の行の中に畳むか出さないかの
 * 二択だった。`#441` で持ち主を持たせたが、その持ち主が誰なのかは
 * 生の ID でしか出なかった（一覧側も同様だったが、#482 で両方とも
 * 名前に変わった）。この画面はその 1 件を、他の行を気にせず確かめる場所。
 *
 * ## タブ（#470 の `data-tabs`、admin-island.ts の `attachTabs`）
 *
 * `<section data-panel="key">` の 4 枚に `<button data-tab="key">` の
 * 選択列を足した（`ui/client/README.md` の見本と同じ markup・
 * クラス）。見出しの文言（概要 / redirect_uri / 監査ログ / 操作）を
 * そのままタブのラベルに使っている——見出しを先に短く整えておいたのは
 * このため。
 *
 * **JS が無ければ 4 枚とも見出し付きで縦に並ぶ**（`attachTabs` は
 * `hidden` を JS 側からしか付けない、README の絶対条件）。
 *
 * ## 選択中タブの強調（指摘: 3b）
 *
 * `c5db342` でこの `data-tab` を足した時点から、選択中かどうかで見た目が
 * 変わる class が無かった——`attachTabs` は `aria-selected` を
 * 付け外しするだけで、それに反応する CSS がどこにも無かった（GDG 側を
 * 含めて確認済み）。`aria-selected:border-primary aria-selected:text-
 * foreground` を静的な class として足し、`[aria-selected="true"]` を
 * Tailwind の variant で踏ませている——`attachTabs` 側は変えていない。
 */

export type ClientDetailPageProps = {
  readonly csrfToken: string;
  readonly client: OAuthClientSummary;
  /**
   * 持ち主と、監査ログの「操作した管理者」の名前解決をまとめた 1 つの
   * `Map`（#471 / #482、`resolveUserRefs` が束ねる）。`UserRef` が出し分ける。
   *
   * **1 つに統合してある。** `sub` でキーが決まるので、持ち主と監査ログの
   * 実行者が同じ人であっても衝突しない——2 つの `Map` を持ち回るより、
   * 呼ぶ側（`renderClientDetailPage`）で 1 つに合わせたほうが、
   * `ClientDetailPage` 側は「名前を引く先はここだけ」で済む。
   */
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
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

const AuditEntries: FC<{
  readonly entries: readonly AuditLogEntryAdmin[] | null;
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
}> = ({ entries, userRefs }) => {
  if (entries === null) {
    return <p class={EMPTY_CLASS}>いま監査ログを取得できません。あとでもう一度開いてください。</p>;
  }

  if (entries.length === 0) {
    return <p class={EMPTY_CLASS}>このクライアントに関係する記録はありません。</p>;
  }

  return (
    <Table id="client-audit-table" data-sortable>
      <TableHeader>
        <TableRow>
          {/* `data-sort` の型は `/audit` 本体と揃える（#488、指摘: 3b）。 */}
          <TableHead data-sort="date">日時</TableHead>
          <TableHead data-sort="text">イベント</TableHead>
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
              「利用者」と書くと対象と取り違える。名前解決は #482。
            */}
            <TableCell class="whitespace-normal">
              <UserRef id={entry.userId} refs={userRefs} />
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
  userRefs,
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
    scripts={[ISLAND_PATH]}
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
      <div
        role="tablist"
        class="flex gap-2 border-b border-border"
        aria-label="クライアントの詳細のタブ"
      >
        <button
          type="button"
          data-tab="overview"
          class="px-3 py-2 text-sm font-medium text-foreground-muted border-b-2 border-transparent -mb-px hover:text-foreground aria-selected:border-primary aria-selected:text-foreground"
        >
          概要
        </button>
        <button
          type="button"
          data-tab="redirect-uris"
          class="px-3 py-2 text-sm font-medium text-foreground-muted border-b-2 border-transparent -mb-px hover:text-foreground aria-selected:border-primary aria-selected:text-foreground"
        >
          redirect_uri
        </button>
        <button
          type="button"
          data-tab="audit"
          class="px-3 py-2 text-sm font-medium text-foreground-muted border-b-2 border-transparent -mb-px hover:text-foreground aria-selected:border-primary aria-selected:text-foreground"
        >
          監査ログ
        </button>
        <button
          type="button"
          data-tab="operations"
          class="px-3 py-2 text-sm font-medium text-foreground-muted border-b-2 border-transparent -mb-px hover:text-foreground aria-selected:border-primary aria-selected:text-foreground"
        >
          操作
        </button>
      </div>
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
                <UserRef id={client.ownerUserId} refs={userRefs} />
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
          <AuditEntries entries={auditEntries} userRefs={userRefs} />
        </CardContent>
      </Card>

      <Card data-panel="operations">
        <CardHeader>
          <CardTitle>操作</CardTitle>
          <CardDescription>
            持ち主・表示用 URL の変更と失効は、この画面で行います。変更は一覧にも反映されます。
          </CardDescription>
        </CardHeader>
        {/*
          3 つのボタンとも `getButtonClasses()` を使う（指摘: 3b、
          services-11 の走査で素の下線テキストのままだったと判明）。

          `失効させる` は `variant="destructive"`（塗り）——`DANGER_
          BUTTON_CLASS`（outline + 文字だけ赤）ではない。分かれ目は
          「押した瞬間に戻れなくなるか」で、`DANGER_BUTTON_CLASS` は
          一覧の各行に 1 つずつ並ぶ破壊的操作向け（`island-classes.ts`
          の「塗ると赤い面が画面を占める」はそちら向けの判断）。ここは
          詳細画面に 1 つだけ出て、確認の段を挟まず 1 クリックで
          失効が確定するので、単独で出る確定操作として塗りを選ぶ
          （指摘: 3b、根拠は vendored `components.css` の
          `.gdg-button-danger`/`.gdg-tone-danger` の 2 段）。
        */}
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
              <button type="submit" class={getButtonClasses("outline", "sm")}>
                持ち主を変更する
              </button>
            </div>
          </form>

          <form method="post" action="/clients/app-url" class={ITEM_BODY_CLASS}>
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <input type="hidden" name="client_id" value={client.clientId} />
            <input type="hidden" name="from" value="detail" />
            <label class={FIELD_CLASS}>
              <span class={LABEL_CLASS}>表示用 URL（空欄で外す。https のみ）</span>
              <input
                class={INPUT_CLASS}
                type="url"
                name="app_url"
                maxlength={2048}
                value={client.appUrl ?? ""}
              />
            </label>
            <div>
              <button type="submit" class={getButtonClasses("outline", "sm")}>
                表示用 URL を変更する
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
              <button type="submit" class={getButtonClasses("destructive", "sm")}>
                失効させる
              </button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </div>
  </KiwaShell>
);
