import { ACCOUNT_HOME_PATH, ACCOUNT_NAV_GROUPS } from "@u18/contracts";
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
  EmptyHeader,
  EmptyTitle,
  KiwaShell,
  Separator,
} from "@u18/web-ui/kiwa";
import { ITEM_META_CLASS } from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import type { AdminCardList, AdminCardView } from "../../../application/ports";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";

/**
 * 運営向けのカード管理画面（`/account/nfc/admin`、#338 Step 3）。
 *
 * ## この画面は「未紐づけカードの鍵束」である
 *
 * **#358 以降、`issued` のカードは ID を知っている人がタップすれば
 * その人のものになる。** 下の `<textarea>` はその ID を URL の形で並べた
 * もので、**配布物そのものと同じ扱いにしなければならない**
 * （`IssueCardsUseCase` / `docs/runbook.md`）。
 *
 * **危ないのは `issued` の行で、それがまさに出さなければならない行である。**
 * この画面の存在理由がその行なので、隠すのではなく**何であるかを書く。**
 *
 * ## 焼く用の一覧には `issued` しか入れない
 *
 * **紐づけ済みのカードを混ぜない。** 混ぜると、**誰かの手元にあるタグを
 * 上書きする**形になり、**焼いたタグからはどちらだったか分からない。**
 * 状態は下の表で全部見えるので、情報としては失われない。
 *
 * `<textarea readonly>` にしてあるのは、**JS 無しで全選択できる**ため。
 * コピーボタンを足すならアイランドにすること（この画面はまだ島を持たない）。
 *
 * ## カード ID を URL に載せない
 *
 * **クエリにもパスにも置かない。** `csrf.ts` の `isValidCsrf` は拒否のログに
 * `pathname` を書き出すので、**カード ID をパスへ置くとログ 1 行が
 * 持ち出しになる**（`base-path.ts` の `CLAIM_CARD_PARAM` に経緯がある）。
 * この画面は GET だけで、ID は**本文にしか出さない。**
 *
 * ## 遷移先 URL をリンクにしない
 *
 * `cards-page.tsx` と同じ理由。利用者が自由に入れた外部 URL なので、
 * `<a href>` にすると**一覧を開いただけで外部へ 1 クリックで飛べる** ——
 * **運営の画面でやると被害が大きい**（運営は全員のカードを見るので、
 * 奪った側が遷移先を変えて運営に踏ませる経路になる）。
 *
 * ## 所有者は userId までしか出ない
 *
 * 表示名もメールアドレスも引かない。理由は `ListAllCardsUseCase` に。
 *
 * ## インラインの `style` を書かない
 *
 * 本番の CSP は `style-src 'self'`。`style="..."` は破棄され、
 * **ローカルでは効いて本番でだけ崩れる**（#320）。
 */

const STATUS_LABEL: Readonly<Record<AdminCardView["status"], string>> = {
  issued: "未紐づけ",
  active: "有効",
  disabled: "無効化済み",
};

/** `cards-page.tsx` と同じ割り当て。**色で良し悪しを言わない。** */
const STATUS_VARIANT: Readonly<Record<AdminCardView["status"], "secondary" | "destructive">> = {
  issued: "secondary",
  active: "secondary",
  disabled: "destructive",
};

/** ISO 8601 を「2026-10-25」まで落とす。時刻まで見せる理由が無い。 */
function toDate(iso: string): string {
  return iso.split("T")[0] ?? iso;
}

const AdminCardRow: FC<{ readonly card: AdminCardView }> = ({ card }) => (
  <div class="flex flex-col gap-1">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-mono text-sm font-medium">{card.cardId}</span>
      <Badge variant={STATUS_VARIANT[card.status]}>{STATUS_LABEL[card.status]}</Badge>
      {card.batch === null ? null : <Badge>{card.batch}</Badge>}
    </div>

    <p class={ITEM_META_CLASS}>
      所有者:{" "}
      {card.ownerUserId === null ? (
        "なし（タップした人のものになります）"
      ) : (
        <span class="font-mono break-all">{card.ownerUserId}</span>
      )}
    </p>

    <p class={ITEM_META_CLASS}>
      遷移先:{" "}
      {card.targetUrl === null ? (
        "未設定"
      ) : (
        // **リンクにしない**（冒頭を参照）。
        <span class="font-mono break-all">{card.targetUrl}</span>
      )}
    </p>

    <p class="text-xs text-foreground-soft">
      {`${toDate(card.issuedAt)} に発行`}
      {card.claimedAt === null ? null : ` ・ ${toDate(card.claimedAt)} に紐づけ`}
      {card.disabledAt === null ? null : ` ・ ${toDate(card.disabledAt)} に無効化`}
    </p>
  </div>
);

export type AdminPageProps = {
  readonly list: AdminCardList;
  /**
   * 焼く用の URL 一覧（`issued` のカードだけ、1 行に 1 本）。
   *
   * **組み立てるのはルート側。** `cardTapUrl()` が要る
   * `SHORT_URL_ORIGIN` は env にあり、**画面コンポーネントに env を
   * 渡すと、ホストを画面が決めることになる**（`base-path.ts`）。
   */
  readonly tapUrls: readonly string[];
};

export const AdminPage: FC<AdminPageProps> = ({ list, tapUrls }) => (
  <KiwaShell
    title="カードの管理"
    nav={ACCOUNT_NAV_GROUPS}
    brandHref={ACCOUNT_HOME_PATH}
    stylesheet={KIWA_STYLESHEET_PATH}
    current="nfc"
    heading="カードの管理"
    lead="発行したカードの一覧と、タグに焼く URL を確認できます。"
  >
    {/*
      **この画面が何であるかを最初に書く。** 下の `<textarea>` は
      配布物そのものと同じ扱いが要る（冒頭を参照）。
      **畳んだり隠したりしない** —— 見えないものには注意が向かない。
    */}
    <Alert>
      <AlertDescription>
        <strong>
          未紐づけのカードは、ID を知っている人がタップすると、その人のものになります。
        </strong>
        下の URL 一覧は配布物そのものと同じ扱いにしてください。画面を人目のある場所で開かない、
        共有しない、スクリーンショットを残さない。
      </AlertDescription>
    </Alert>

    <Card>
      <CardHeader>
        <CardTitle>タグに焼く URL</CardTitle>
        <CardDescription>
          {tapUrls.length === 0
            ? "未紐づけのカードがありません。"
            : `未紐づけ ${tapUrls.length} 枚ぶん。1 行に 1 枚です。`}
          <strong>紐づけ済みのカードは入っていません</strong>
          —— 混ぜると、誰かの手元にあるタグを上書きする形になり、焼いたあとで区別できません。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tapUrls.length === 0 ? (
          <p class={ITEM_META_CLASS}>発行すると、ここに URL が並びます。</p>
        ) : (
          <>
            {/*
              **`readonly` の `<textarea>`。** JS 無しで全選択できる形で、
              コピーボタンを足すならアイランドにする（冒頭）。
              `rows` を固定しているのは、枚数で画面の高さが暴れないため。
            */}
            <textarea
              readonly
              rows={Math.min(tapUrls.length, 12)}
              aria-label="タグに焼く URL の一覧"
              class="w-full rounded-lg border border-border bg-background-subtle p-3 font-mono text-xs break-all"
            >
              {tapUrls.join("\n")}
            </textarea>
            <p class={`${ITEM_META_CLASS} mt-2`}>
              この欄を選択してコピーし、NFC の書き込みアプリへ貼り付けてください。
            </p>
          </>
        )}
      </CardContent>
    </Card>

    {/*
      **打ち切ったことを画面に出す。** 黙って「最初の N 件」を返すと、
      運営は全部を見たつもりで一部を見る（`ListAllCardsUseCase`）。
    */}
    {list.truncated && (
      <Alert>
        <AlertDescription>
          <strong>一覧は上限で打ち切られています。</strong>
          表示しているのは新しいほうから 500 枚で、これより古いカードは出ていません。
          <strong>上の URL 一覧も、表示できた範囲のものだけです。</strong>
        </AlertDescription>
      </Alert>
    )}

    {list.cards.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>発行されたカードはありません。</EmptyTitle>
        </EmptyHeader>
      </Empty>
    ) : (
      <Card>
        <CardHeader>
          <CardTitle>すべてのカード</CardTitle>
          <CardDescription>{list.cards.length} 枚。発行の新しい順です。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul class="flex flex-col">
            {list.cards.map((card, index) => (
              <li key={card.cardId}>
                {/* **区切りは 1 件目の前に置かない**（`cards-page.tsx` と同じ）。 */}
                {index > 0 && <Separator class="my-3" />}
                <AdminCardRow card={card} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    )}

    {/*
      **「できないこと」を黙って出さない**（`cards-page.tsx` の同じ節）。
      できるようになった分はここから外すこと。
    */}
    <Card>
      <CardHeader>
        <CardTitle>この画面からできないこと</CardTitle>
        <CardDescription>
          カードの発行、他の人のカードの遷移先の変更・無効化・所有者の付け替えは、
          まだこの画面からは行えません。
          <strong>
            発行は <code class="font-mono">POST /account/nfc/cards</code> の API から行えます。
          </strong>
          他の人のカードへの操作は API にもまだありません（いまの API は、どれも自分が
          所有者であるカードにしか効きません）。
        </CardDescription>
      </CardHeader>
    </Card>
  </KiwaShell>
);
