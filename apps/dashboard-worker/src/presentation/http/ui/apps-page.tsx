import type { FC } from "hono/jsx";
import type { AppCatalogView } from "./app-catalog";
import { isExternalUrl } from "./app-catalog";
import { GRANTS_PATH } from "./asset-paths";
import { DashboardShell } from "./dashboard-shell";

/**
 * u18 Identity で使えるアプリ（`/account/apps`、#308）。
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
 * 読むだけの画面なので `scripts` を渡していない。取り消しの操作が無いので
 * `hasRevokeActions` も立てない —— 立てると「JS が無いとできないこと」が
 * あると読めてしまう。
 *
 * ## インラインの `style` を書かない
 *
 * **本番の CSP は `style-src 'self'` で `'unsafe-inline'` を含まない**
 * （`@u18/web-ui` の `page-headers.ts`）。`style="..."` はブラウザに
 * 破棄されるので、**ローカルでは効いて本番でだけ崩れる**（ホームが
 * これで本番の枠線を密着させた —— #320）。パネルの間隔は `.stack` が
 * 持つ：**間隔は入れ物の持ち物**で、並ぶ側は何も知らない。
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
  <DashboardShell
    title="アプリ"
    heading="u18 Identity で使えるアプリ"
    lead="u18 Identity のアカウントでそのまま使えるアプリの一覧です。あなたがアクセスを許可したアプリは「連携アプリ」で確認できます。"
    current="apps"
  >
    <div class="stack">
      {/*
        **`listGrants` が落ちても一覧は出す。** バッジは付加情報で、
        本体を道連れにする理由が無い（この画面はダッシュボードで唯一
        「RPC が失敗しても出せる中身がある」画面である）。
        ただし**黙って消さない** —— 連携しているのにしていないように
        見えるので、確認できていないことを言う。
      */}
      {!view.grantsKnown && (
        <p class="notice">
          いまアプリとの連携状況を確認できません。「連携済み」の表示が出ていなくても、
          連携が解除されたわけではありません。
        </p>
      )}

      {view.groups.length === 0 ? (
        <div class="panel">
          <div class="panel-body">
            {/*
              **枠だけ作って埋まっているように見せない。** いま載せられる
              アプリが無いことは、それ自体が伝えたい状態である（#306）。
            */}
            <p class="empty">まだありません。</p>
          </div>
        </div>
      ) : (
        view.groups.map((group) => (
          <div key={group.category.key} class="panel">
            <div class="panel-header">
              <h2 class="panel-title">{group.category.label}</h2>
              <p class="panel-desc">{group.category.description}</p>
            </div>
            <div class="panel-body">
              <ul class="list">
                {group.items.map((item) => {
                  const external = isExternalUrl(item.url);

                  return (
                    <li key={item.id}>
                      <div class="item-main">
                        <div class="item-title">
                          <a
                            href={item.url}
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
                          {item.connected === true && <span class="badge">連携済み</span>}
                        </div>
                        <p class="item-meta">{item.description}</p>
                        {/*
                          **URL を文字列で出すのは u18 を出ていくリンクだけ。**
                          押す前にどこへ行くのか分かる必要があるのはそちらで、
                          同一オリジンの行き先はダッシュボードの中に留まる
                          （`href` には同じ値が入っているので、確かめたい人は
                          読める）。内部にも出すと、`/account/nfc` のような
                          パスと `https://...` の全体 URL が同じ見た目で
                          並び、**どれが外部なのかが読めなくなる。**
                        */}
                        {external && <p class="item-raw">{item.url}</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        ))
      )}

      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">連携アプリとの違い</h2>
          <p class="panel-desc">
            この一覧は、u18 Identity で使えるアプリとして掲載しているものの案内です。
            あなたが実際にアクセスを許可したアプリと、その権限の取り消しは
            <a href={GRANTS_PATH}>連携アプリ</a>
            で行えます。
          </p>
        </div>
      </div>
    </div>
  </DashboardShell>
);
