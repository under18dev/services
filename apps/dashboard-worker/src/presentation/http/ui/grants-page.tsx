import type { GrantListItem } from "@u18/contracts";
import { scopeLabel } from "@u18/web-ui";
import { Card, CardContent, Separator } from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { ISLAND_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import { EMPTY_ATTR, EMPTY_TEXT_ATTR, ITEM_BODY_ATTR, ITEM_TITLE_ATTR } from "./island-hooks";
import {
  EMPTY_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_TITLE_CLASS,
  LIST_CLASS,
} from "@u18/web-ui/kiwa/island-classes";

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
 *
 * ## クラスはアイランドと共有している
 *
 * 行を消したあとアイランドが同じ形の要素を作り直す。文字列が 2 箇所に
 * あると、**一覧の行だけ見た目が違う**状態が作れる（`island-classes.ts`）。
 */

export type GrantsPageProps = {
  /** 管理の節を出すか（#333）。`AccountShell` が必須にしている。 */
  readonly isAdmin: boolean;
  readonly grants: readonly GrantListItem[];
};

export const GrantsPage: FC<GrantsPageProps> = ({ grants, isAdmin }) => (
  <AccountShell
    isAdmin={isAdmin}
    title="連携アプリ"
    heading="連携アプリ"
    lead="あなたの情報へのアクセスを許可したアプリです。使っていないものは連携を解除してください。"
    current="grants"
    scripts={[ISLAND_PATH]}
    hasRevokeActions
  >
    <Card>
      <CardContent>
        {grants.length === 0 ? (
          /*
            **`Empty` を使わない。** 最後の 1 件を消したあと、アイランドが
            同じ場所に `<p>` を作る（`island-classes.ts` の `EMPTY_CLASS`）。
            サーバーだけ枠付きの `Empty` にすると、**操作の前後で見た目が
            変わる。** 文言を揃えているのと同じ理由で、形も揃える。
          */
          <p class={EMPTY_CLASS} {...{ [EMPTY_ATTR]: "" }}>
            連携を許可したアプリはありません。
          </p>
        ) : (
          <ul class={LIST_CLASS} {...{ [EMPTY_TEXT_ATTR]: "連携を許可したアプリはありません。" }}>
            {grants.map((grant, index) => (
              <li key={grant.clientId} data-grant-client-id={grant.clientId}>
                {/*
                  **区切りは 1 件目の前に置かない。** 件数で分岐させずに
                  済むよう、間に入る側だけが描く。
                */}
                {index > 0 && <Separator class="my-3" />}
                <div class={ITEM_BODY_CLASS} {...{ [ITEM_BODY_ATTR]: "" }}>
                  <div class={ITEM_TITLE_CLASS} {...{ [ITEM_TITLE_ATTR]: "" }}>
                    {grant.clientName}
                  </div>
                  <p class={ITEM_META_CLASS}>許可 {formatDateTime(grant.grantedAt)}</p>
                  {/*
                    同意画面と**同じ文言**を使う（`@u18/web-ui` の `scopeLabel`）。
                    許可したときと取り消すときで言葉が違うと、利用者は
                    「同じものを取り消そうとしている」と確信できない。
                  */}
                  {grant.scopes.length > 0 && (
                    <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-soft">
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
      </CardContent>
    </Card>
  </AccountShell>
);
