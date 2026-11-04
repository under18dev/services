import type { GrantListItem } from "@u18/contracts";
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Separator,
} from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import type { AppCatalogView } from "./app-catalog";
import { isExternalUrl } from "./app-catalog";
import { AccountShell } from "./account-shell";
import { GRANTS_PATH } from "./asset-paths";

/**
 * 連携したアプリ（`/account/apps`、#308 / #457）。
 *
 * ## 主役が変わった（#457）
 *
 * **もともとはカタログ（運用側が載せたアプリの案内）が主役だった。**
 * 運用者の要望（「連携した OAuth App の URL を一覧したい」）を受けて、
 * **自分が連携したアプリ（`listGrants`）とその `app_url` を主役にし、
 * カタログは下に残す**（実装者判断。カタログは引き続き有用——
 * 連携していない u18 公式アプリを知る唯一の場所）。主役が変わった
 * ことは `heading` / `lead` の文で言い切る——画面と文が食い違う事故を
 * このリポジトリで何度も踏んでいる。
 *
 * ## `/account/grants` との違い
 *
 * **こちらは「どこへ行けるか」、あちらは「何を許可したか」。** scope の
 * 確認や取り消しはこの画面に作り直さない——`GRANTS_PATH` への導線に
 * 任せる（#457 の明示的な指示。同じ操作の入口を 2 つ持つと片方だけ
 * 直る）。
 *
 * ## `app_url` の無いアプリはリンクにしない
 *
 * **押しても何も無いリンクを置かない**（#306）。`oauth_redirect_uris`
 * （コールバック宛先）から黙って導出もしない——コールバック専用の
 * ホスト（`/callback` しか無いなど）はリンク先として意味を持たない。
 * 名前だけを出す。
 *
 * ## 連携済みアプリと、取得できないことは別に扱う
 *
 * `grants` が `null`（`listGrants` が落ちた）と `[]`（連携 0 件）を
 * 同じ見た目にしない。前者は「いま確認できません」、後者は
 * 「まだ連携したアプリはありません」——**カタログは `listGrants` に
 * 依存しない**ので、連携アプリの取得が失敗してもカタログは出す
 * （行き止まりにしない）。
 *
 * ## JS を 1 行も要求しない
 *
 * 読むだけの画面なので `KiwaShell` に `scripts` の口すら無い。
 *
 * ## インラインの `style` を書かない
 *
 * **本番の CSP は `style-src 'self'` で `'unsafe-inline'` を含まない**
 * （`@u18/web-ui` の `page-headers.ts`）。Tailwind のクラスで書く。
 *
 * ## `clientName` / `appUrl` は第三者が決めた文字列である
 *
 * `grants-page.tsx` と同じ注意——登録したアプリの作者が自由に付けられる
 * ので、エスケープは hono/jsx に任せ `raw()` は使わない。
 */

export type AppsPageProps = {
  readonly view: AppCatalogView;
  /** 自分が連携したアプリ（#457）。`null` は「取れなかった」——「0 件」とは別。 */
  readonly grants: readonly GrantListItem[] | null;
};

const ConnectedAppRow: FC<{ readonly grant: GrantListItem; readonly isFirst: boolean }> = ({
  grant,
  isFirst,
}) => (
  <li>
    {/* 区切りは 1 件目の前に置かない（他の一覧と同じ理由）。 */}
    {!isFirst && <Separator class="my-3" />}
    <div class="flex flex-col gap-1">
      <div class="flex flex-wrap items-center gap-2 font-medium">
        {grant.appUrl === null ? (
          <span>{grant.clientName}</span>
        ) : (
          <a
            href={grant.appUrl}
            class="underline-offset-4 hover:underline"
            // app_url は常に別ホストの https URL（`validateAppUrl`）。
            rel="noopener noreferrer"
          >
            {grant.clientName}
          </a>
        )}
      </div>
      {grant.appUrl !== null && (
        <p class="font-mono text-xs break-all text-foreground-soft">{grant.appUrl}</p>
      )}
    </div>
  </li>
);

export const AppsPage: FC<AppsPageProps> = ({ view, grants }) => (
  <AccountShell
    title="アプリ"
    heading="連携したアプリ"
    lead="あなたが連携したアプリと、その行き先をまとめています。許可した権限の確認や連携の取り消しは「連携アプリ」で行えます。"
    current="apps"
  >
    <Card>
      <CardHeader>
        <CardTitle>連携したアプリ</CardTitle>
      </CardHeader>
      <CardContent>
        {grants === null ? (
          // **「取れなかった」を「0 件」と同じ見た目にしない。**
          <Alert>
            <AlertDescription>
              いま連携したアプリを確認できません。しばらく待ってからもう一度お試しください。
            </AlertDescription>
          </Alert>
        ) : grants.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>まだ連携したアプリはありません。</EmptyTitle>
              <EmptyDescription>
                下の「u18 Identity で使えるアプリ」から試してみてください。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul class="flex flex-col">
            {grants.map((grant, index) => (
              <ConnectedAppRow key={grant.clientId} grant={grant} isFirst={index === 0} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>

    <p class="text-sm font-medium text-foreground-muted">u18 Identity で使えるアプリ</p>

    {/*
      **カタログは `listGrants` に依存しない。** 連携アプリの取得が
      失敗しても、ここだけは出せる——この画面で唯一「RPC が失敗しても
      出せる中身がある」部分である（#457 より前からの設計、#306）。
    */}
    {!view.grantsKnown && (
      <Alert>
        <AlertDescription>
          いまアプリとの連携状況を確認できません。「連携済み」の表示が出ていなくても、
          連携が解除されたわけではありません。
        </AlertDescription>
      </Alert>
    )}

    {view.groups.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>まだありません。</EmptyTitle>
          <EmptyDescription>
            u18 Identity のアカウントで使えるアプリを掲載したときに、ここに並びます。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      view.groups.map((group) => (
        <Card key={group.category.key}>
          <CardHeader>
            <CardTitle>{group.category.label}</CardTitle>
            <CardDescription>{group.category.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul class="flex flex-col">
              {group.items.map((item, index) => {
                const external = isExternalUrl(item.url);

                return (
                  <li key={item.id}>
                    {index > 0 && <Separator class="my-3" />}
                    <div class="flex flex-col gap-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <a
                          href={item.url}
                          class="font-medium underline-offset-4 hover:underline"
                          {...(external ? { rel: "noopener noreferrer" } : {})}
                        >
                          {item.name}
                        </a>
                        {item.connected === true && <Badge>連携済み</Badge>}
                      </div>
                      <p class="text-sm/relaxed text-foreground-muted">{item.description}</p>
                      {external && (
                        <p class="font-mono text-xs break-all text-foreground-soft">{item.url}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ))
    )}

    <Card>
      <CardHeader>
        <CardTitle>権限の確認・取り消し</CardTitle>
        <CardDescription>
          許可した権限の確認や、連携の取り消しは
          <a href={GRANTS_PATH} class="text-foreground underline underline-offset-4">
            連携アプリ
          </a>
          で行えます。
        </CardDescription>
      </CardHeader>
    </Card>
  </AccountShell>
);
