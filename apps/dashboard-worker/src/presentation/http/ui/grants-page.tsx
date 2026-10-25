import type { GrantListItem } from "@u18/contracts";
import { scopeLabel } from "@u18/web-ui";
import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { ACCOUNT_ISLAND_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * 連携を許可したアプリ（`/account/grants`、#18）。
 *
 * ## `logoUrl` を表示しない
 *
 * `GrantListItem` には `logoUrl` が載っているが、**`<img>` にしない。**
 * 画面の CSP は `img-src 'self' data:` で第三者ホストを許していない
 * （`@u18/web-ui` の `page-headers.ts`）。許すと、**この画面を開いた事実が
 * 第三者のサーバーへ伝わる** —— 誰がどのアプリと連携しているかが漏れる。
 * 同意画面でロゴを出していないのと同じ判断。
 *
 * ## `clientName` は第三者が決めた文字列である
 *
 * 登録したアプリの作者が自由に付けられる。u18 の画面に出る以上、
 * 「u18 公式」を騙る名前も入りうる。**エスケープは hono/jsx に任せ、
 * `raw()` を使わないこと。**
 */

export type GrantsPageProps = {
  readonly grants: readonly GrantListItem[];
};

export const GrantsPage: FC<GrantsPageProps> = ({ grants }) => (
  <AccountShell title="連携アプリ" current="grants" scripts={[ACCOUNT_ISLAND_PATH]}>
    <section class="section">
      <h2>連携アプリ</h2>
      <p class="section-lead">
        あなたの情報へのアクセスを許可したアプリです。使っていないものは連携を解除してください。
      </p>
      {grants.length === 0 ? (
        <p class="empty">連携を許可したアプリはありません。</p>
      ) : (
        <ul class="list">
          {grants.map((grant) => (
            <li key={grant.clientId}>
              <div class="item-main">
                <div class="item-title">{grant.clientName}</div>
                <p class="item-meta">許可 {formatDateTime(grant.grantedAt)}</p>
                {/*
                  同意画面と**同じ文言**を使う（`@u18/web-ui` の `scopeLabel`）。
                  許可したときと取り消すときで言葉が違うと、利用者は
                  「同じものを取り消そうとしている」と確信できない。
                */}
                {grant.scopes.length > 0 && (
                  <ul class="scopes">
                    {grant.scopes.map((scope) => (
                      <li key={scope}>{scopeLabel(scope)}</li>
                    ))}
                  </ul>
                )}
              </div>
              {/*
                操作ボタンはアイランドが作る（`ui/client/account-island.tsx`）。
                サーバーはボタンを出さないので、JS が読み込めなければ
                ボタン自体が現れない。
              */}
              <div class="item-actions" data-revoke-kind="grant" data-revoke-id={grant.clientId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  </AccountShell>
);
