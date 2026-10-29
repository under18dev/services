import type { FC } from "hono/jsx";
import type { AppCatalogGroup } from "./app-catalog";
import { isExternalUrl } from "./app-catalog";
import { GRANTS_PATH } from "./asset-paths";
import { DashboardShell } from "./dashboard-shell";

/**
 * u18 Identity で使えるアプリ（`/account/apps`、#308）。
 *
 * ## `/account/grants` との違いを画面でも言う
 *
 * 名前が似ているので、**どちらを見ているのか画面から読めないと混ざる。**
 * こちらは全員に同じものが出るカタログ、あちらは自分が同意した RP の一覧。
 * 下の `lead` と、末尾の `/account/grants` への導線がその区別を担っている。
 *
 * ## JS を 1 行も要求しない
 *
 * 読むだけの画面なので `scripts` を渡していない。取り消しの操作が無いので
 * `hasRevokeActions` も立てない —— 立てると「JS が無いとできないこと」が
 * あると読めてしまう。
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
  readonly groups: readonly AppCatalogGroup[];
};

export const AppsPage: FC<AppsPageProps> = ({ groups }) => (
  <DashboardShell
    title="アプリ"
    heading="u18 Identity で使えるアプリ"
    lead="u18 Identity のアカウントでそのまま使えるアプリの一覧です。あなたがアクセスを許可したアプリは「連携アプリ」で確認できます。"
    current="apps"
  >
    {groups.length === 0 ? (
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
      groups.map((group) => (
        <div key={group.category.key} class="panel" style="margin-bottom:1.25rem">
          <div class="panel-header">
            <h2 class="panel-title">{group.category.label}</h2>
            <p class="panel-desc">{group.category.description}</p>
          </div>
          <div class="panel-body">
            <ul class="list">
              {group.items.map((item) => (
                <li key={item.id}>
                  <div class="item-main">
                    <div class="item-title">
                      <a
                        href={item.url}
                        {...(isExternalUrl(item.url)
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
                        **`connected` が false のときに「未連携」を出さない。**
                        カタログに載っているだけのアプリに未連携と書くと、
                        「連携しそこねている」ように読める。出すのは
                        `listGrants` に実際に行があったときだけ。
                      */}
                      {item.connected && <span class="badge">連携済み</span>}
                    </div>
                    <p class="item-meta">{item.description}</p>
                    {/*
                      **URL を文字列でも出す。** リンクの文字（アプリ名）だけ
                      だと、押す前にどこへ行くのか分からない。カタログは
                      「どこへ行けるか」を見る画面なので、行き先そのものが中身。
                    */}
                    <p class="item-raw">{item.url}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))
    )}

    <div class="panel">
      <div class="panel-header">
        <h2 class="panel-title">連携アプリとの違い</h2>
        <p class="panel-desc">
          この一覧は、u18 Identity に繋がっているアプリの案内です。
          あなたが実際にアクセスを許可したアプリと、その権限の取り消しは
          <a href={GRANTS_PATH}>連携アプリ</a>
          で行えます。
        </p>
      </div>
    </div>
  </DashboardShell>
);
