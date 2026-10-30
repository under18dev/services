import type { GrantListItem } from "@u18/contracts";
import { scopeLabel } from "@u18/web-ui";
import type { FC } from "hono/jsx";
import { DashboardShell } from "./dashboard-shell";
import { ISLAND_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import { EMPTY_ATTR, EMPTY_TEXT_ATTR, ITEM_BODY_ATTR, ITEM_TITLE_ATTR } from "./island-hooks";

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
  <DashboardShell
    title="連携アプリ"
    heading="連携アプリ"
    lead="あなたの情報へのアクセスを許可したアプリです。使っていないものは連携を解除してください。"
    current="grants"
    scripts={[ISLAND_PATH]}
    hasRevokeActions
  >
    <div class="panel">
      <div class="panel-body">
        {grants.length === 0 ? (
          <p class="empty" {...{ [EMPTY_ATTR]: "" }}>
            連携を許可したアプリはありません。
          </p>
        ) : (
          <ul class="list" {...{ [EMPTY_TEXT_ATTR]: "連携を許可したアプリはありません。" }}>
            {grants.map((grant) => (
              <li key={grant.clientId} data-grant-client-id={grant.clientId}>
                <div class="item-main" {...{ [ITEM_BODY_ATTR]: "" }}>
                  <div class="item-title" {...{ [ITEM_TITLE_ATTR]: "" }}>
                    {grant.clientName}
                  </div>
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  </DashboardShell>
);
