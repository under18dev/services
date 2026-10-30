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
 * u18 Identity で使えるアプリ（`/account/apps`、#308）。
 *
 * **ダッシュボードで唯一 Kiwa UI で組んである画面である**（#332 の P0）。
 * 残り 5 枚は手書き CSS の `DashboardShell` のままで、移し替えるのは P1。
 * ここが見本なので、**P1 はこのファイルの形を真似すればよい**ようにして
 * ある。
 *
 * ## `/account/grants` との違いを画面でも言う
 *
 * 名前が似ているので、**どちらを見ているのか画面から読めないと混ざる。**
 * こちらは運用側が載せたアプリの案内、あちらは自分が同意した RP の一覧。
 * 下の `lead` と、末尾の `/account/grants` への導線がその区別を担っている。
 *
 * **「繋がっているアプリ全部」とは言わない。** 載せるかどうかは運用の
 * 判断なので（`app-catalog.ts`）、全件だと言うと嘘になる。
 *
 * ## JS を 1 行も要求しない
 *
 * 読むだけの画面なので `KiwaShell` に `scripts` の口すら無い。
 * Kiwa UI は SSR が既定で、ここで使っている primitives はどれも
 * クライアント JS を持たない。
 *
 * ## インラインの `style` を書かない
 *
 * **本番の CSP は `style-src 'self'` で `'unsafe-inline'` を含まない**
 * （`@u18/web-ui` の `page-headers.ts`）。`style="..."` はブラウザに
 * 破棄されるので、**ローカルでは効いて本番でだけ崩れる**（ホームが
 * これで本番の枠線を密着させた —— #320）。Tailwind のクラスで書く。
 *
 * **クラスを書いても同じ失敗は起こりうる。** `theme.css` に無いトークンを
 * 使うと（`bg-success-soft` など）Tailwind はそのユーティリティを生成
 * しないので、**class は HTML に出るのに CSS が無い。** 見え方は #320 と
 * 同じである。
 *
 * ## 載っている文字列は運用者が書いたものである
 *
 * `grants-page.tsx` の `clientName` と違い、カタログの `name` と
 * `description` は**このリポジトリの中にある**（`app-catalog.ts`）ので、
 * 第三者が決めた文字列ではない。それでもエスケープは hono/jsx に任せ、
 * `raw()` は使わない —— 由来で例外を作ると、カタログを D1 から引くように
 * 変えたときに**ここだけ安全でなくなる。**
 */

export type AppsPageProps = {
  readonly view: AppCatalogView;
};

export const AppsPage: FC<AppsPageProps> = ({ view }) => (
  <AccountShell
    title="アプリ"
    heading="u18 Identity で使えるアプリ"
    lead="u18 Identity のアカウントでそのまま使えるアプリの一覧です。あなたがアクセスを許可したアプリは「連携アプリ」で確認できます。"
    current="apps"
  >
    {/*
      **`listGrants` が落ちても一覧は出す。** バッジは付加情報で、
      本体を道連れにする理由が無い（この画面はダッシュボードで唯一
      「RPC が失敗しても出せる中身がある」画面である）。
      ただし**黙って消さない** —— 連携しているのにしていないように
      見えるので、確認できていないことを言う。
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
      /*
        **枠だけ作って埋まっているように見せない。** いま載せられる
        アプリが無いことは、それ自体が伝えたい状態である（#306）。
      */
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
                    {/*
                      **区切りは 1 件目の前に置かない。** 先頭に出すと
                      `CardHeader` との間に線が 2 本並ぶ。件数で分岐
                      させずに済むよう、間に入る側だけが描く。
                    */}
                    {index > 0 && <Separator class="my-3" />}
                    <div class="flex flex-col gap-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <a
                          href={item.url}
                          class="font-medium underline-offset-4 hover:underline"
                          {...(external
                            ? // 別ホストへ出すリンクには必ず付ける。`noopener` は
                              // 遷移先から `window.opener` でこの画面を触らせない
                              // ため、`noreferrer` は「どの画面から来たか」を
                              // 相手のサーバーへ渡さないため。
                              { rel: "noopener noreferrer" }
                            : {})}
                        >
                          {item.name}
                        </a>
                        {/*
                          **`connected` が true のときだけ出す。** false は
                          「まだ同意していない」、null は「言えない」
                          （RP でない / `listGrants` が取れなかった）。
                          どちらも何も出さない —— 「未連携」と書くと嘘になる。
                        */}
                        {item.connected === true && <Badge>連携済み</Badge>}
                      </div>
                      <p class="text-sm/relaxed text-foreground-muted">{item.description}</p>
                      {/*
                        **URL を文字列で出すのは u18 を出ていくリンクだけ。**
                        押す前にどこへ行くのか分かる必要があるのはそちらで、
                        同一オリジンの行き先はダッシュボードの中に留まる
                        （`href` には同じ値が入っているので、確かめたい人は
                        読める）。内部にも出すと、`/account/nfc` のような
                        パスと `https://...` の全体 URL が同じ見た目で
                        並び、**どれが外部なのかが読めなくなる。**
                      */}
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
        <CardTitle>連携アプリとの違い</CardTitle>
        <CardDescription>
          この一覧は、u18 Identity で使えるアプリとして掲載しているものの案内です。
          あなたが実際にアクセスを許可したアプリと、その権限の取り消しは
          <a href={GRANTS_PATH} class="text-foreground underline underline-offset-4">
            連携アプリ
          </a>
          で行えます。
        </CardDescription>
      </CardHeader>
    </Card>
  </AccountShell>
);
