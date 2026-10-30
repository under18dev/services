import { ACCOUNT_HOME_PATH, accountNavFor } from "@u18/contracts";
import {
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
  getButtonClasses,
  KiwaShell,
  Separator,
} from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import type { CardView } from "../../../application/ports";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { ITEM_META_CLASS } from "@u18/web-ui/kiwa/island-classes";
import { TARGET_INPUT_CLASS } from "./island-classes";
import { CARD_ID, TARGET_FORM, TARGET_INPUT, TARGET_SAVE, TARGET_STATUS } from "./island-hooks";

/**
 * 自分のカード一覧（Phase 4 / #31、#338 で Kiwa UI へ）。
 *
 * ## ダッシュボードの 1 枚になった（#338）
 *
 * **以前はサイドバーを持たない 1 枚のカードだった。** 同じオリジンに
 * 載っているのに**ダッシュボードから辿れず**、`/account` の他の画面と
 * 見た目も違っていた。`KiwaShell` を使い、サイドバーの「サービス」に
 * 自分を出すことで、利用者から見て 1 つの画面になる。
 *
 * **並びは `@u18/contracts` の `ACCOUNT_NAV_GROUPS`** で、
 * dashboard-worker が渡すものと同じ配列である。片方にだけ項目を足した
 * 状態が作れない（あちらの冒頭）。
 *
 * ## 一覧は JS 無しで成立する。操作だけが JS を要る
 *
 * カードの一覧・状態・遷移先の表示は**サーバーレンダリングだけ**で出る。
 * アイランドが足すのは遷移先の変更だけで、**JS が無ければその 1 箇所が
 * 効かない**（`<noscript>` がそう言う）。一覧が読めなくなることはない。
 *
 * **操作の入口はサーバーが描く。** 島が作るのではない —— class を
 * サーバー側の HTML にも出しておくと、`kiwa-stylesheet.test.ts` の視界に
 * 入り、**「島だけが使う class」という状態そのものが無くなる**
 * （`ui/island-classes.ts`）。
 *
 * ## 操作はまだ揃っていない
 *
 * API には 5 つの操作（紐づけ・遷移先の変更・無効化・移転・発行）が
 * ある。**この画面から叩けるのは遷移先の変更 1 本**で、残りは
 * Step 2 / Step 3 で入る（#338）。
 *
 * **紐づけはこの画面に来ない**（#358）。カードをタップした人が
 * `/account/nfc/claim` で登録する形になったので、**ここに入口を作ると
 * 2 つ目の経路**になる。一覧に無いのは「まだできない」ではなく
 * 「ここではない」である。
 *
 * **最初に通す 1 本を `target` にしたのは、間違えても戻せるからである。**
 * `disable` は片道、`release` は**戻せるが、手放した瞬間に次にタップした
 * 人のものになる**（#358 で紐づけコードが無くなった）。
 *
 * **「できない」を黙って出さない** —— 下の案内がそれを言っている。
 * **できるようになった分はそこから外すこと。** 全部残すと「できるのに
 * できないと書いてある」、全部消すと「できないのに何も書いていない」になる。
 *
 * **この画面は form POST を持たない。** `cards.routes.ts` が既に
 * JSON + Origin 検証で守られていて、並べると 2 つを同期させ続ける必要が
 * 出るためである。**紐づけ画面（`claim-page.tsx`）だけが例外で**、
 * あちらは JS 無しで通る必要がある（`csrf.ts` の冒頭に理由）。
 *
 * ## インラインの `style` を書かない
 *
 * 本番の CSP は `style-src 'self'` で `'unsafe-inline'` を含まない。
 * `style="..."` はブラウザに破棄されるので、**ローカルでは効いて本番で
 * だけ崩れる**（dashboard が #320 で踏んだ）。`test/cards.ui.test.ts` が
 * 見ている。
 *
 * ## 遷移先 URL をリンクにしない
 *
 * `target_url` は**利用者が自由に入れた外部 URL** である。ここを
 * `<a href>` にすると、一覧を開いただけで外部サイトへ 1 クリックで
 * 飛べる経路になり、**この画面が踏み台になる**（カードを奪った側が
 * 遷移先を変え、所有者に踏ませる）。文字列として見せるに留める。
 */

/**
 * 保存ボタンの class。**ここで畳む**（#338）。
 *
 * `getButtonClasses()` は `cn()` を呼ぶので、**島から import すると
 * `cn` ごとバンドルへ入る**（実測で島が 18.4 -> 36.2 KiB）。
 * サーバー側のこのファイルで文字列にしてしまえば、島には何も増えない。
 */
const SAVE_BUTTON_CLASS = getButtonClasses("default", "sm");

const STATUS_LABEL: Readonly<Record<CardView["status"], string>> = {
  issued: "未紐づけ",
  active: "有効",
  disabled: "無効化済み",
};

/**
 * 状態のバッジの見た目。
 *
 * **`disabled` だけ `destructive` にする。** 無効化は片道の操作で、
 * 一覧の中で見分けが付く必要がある。`issued`（まだ誰のものでもない）と
 * `active` は中立 —— **色で良し悪しを言わない**（design.md の
 * "No colorful UI."）。
 */
const STATUS_VARIANT: Readonly<Record<CardView["status"], "secondary" | "destructive">> = {
  issued: "secondary",
  active: "secondary",
  disabled: "destructive",
};

/** ISO 8601 を「2026-10-25」まで落とす。時刻まで見せる理由が無い。 */
function toDate(iso: string): string {
  return iso.split("T")[0] ?? iso;
}

const CardRow: FC<{ readonly card: CardView }> = ({ card }) => (
  <div class="flex flex-col gap-1">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-mono text-sm font-medium">{card.cardId}</span>
      <Badge variant={STATUS_VARIANT[card.status]}>{STATUS_LABEL[card.status]}</Badge>
    </div>

    <p class="text-sm/relaxed text-foreground-muted">
      遷移先:{" "}
      {card.targetUrl === null ? (
        "未設定"
      ) : (
        // **リンクにしない**（冒頭を参照）。折り返すのは、長い URL が
        // カードの幅を超えて横スクロールを作らないようにするため。
        <span class="font-mono break-all">{card.targetUrl}</span>
      )}
    </p>

    {/*
      **日付の行は、言うことがあるときだけ出す。** 空の行を並べると、
      カードごとに高さが揃うぶん「何も無い」が読みにくくなる。
    */}
    {/*
      **遷移先の変更**（#338）。`active` のカードにだけ出す ——
      `issued` はまだ誰のものでもなく、`disabled` は片道で戻せない。
      出しても必ず失敗する入口を描かない。

      **目印は `data-*`。** 見た目の class で引くと、Tailwind の移行の
      たびに島が黙って効かなくなる（#341）。class 定数は
      `ui/island-classes.ts` で、島と同じものをここでも描いている。
    */}
    {card.status === "active" && (
      <div
        class="mt-2 flex flex-col gap-2"
        {...{ [TARGET_FORM]: "" }}
        {...{ [CARD_ID]: card.cardId }}
      >
        <div class="flex flex-wrap items-center gap-2">
          <input
            type="url"
            class={TARGET_INPUT_CLASS}
            value={card.targetUrl ?? ""}
            placeholder="https://example.com/"
            aria-label={`${card.cardId} の遷移先`}
            {...{ [TARGET_INPUT]: "" }}
          />
          <button type="button" class={SAVE_BUTTON_CLASS} {...{ [TARGET_SAVE]: "" }}>
            保存
          </button>
        </div>
        {/*
          結果を出す行。**最初は空で、島が埋める。** 空の `<p>` を置くのは、
          島が要素を作らずに済むようにするため（作らせると class が
          サーバーの HTML に出ない）。
        */}
        <p class={ITEM_META_CLASS} {...{ [TARGET_STATUS]: "" }}></p>
        <noscript>
          <p class={ITEM_META_CLASS}>
            遷移先の変更には JavaScript が必要です。一覧の表示には要りません。
          </p>
        </noscript>
      </div>
    )}

    {(card.claimedAt !== null || card.transferCount > 0 || card.disabledAt !== null) && (
      <p class="text-xs text-foreground-soft">
        {card.claimedAt === null ? null : `${toDate(card.claimedAt)} に紐づけ`}
        {card.transferCount > 0 ? ` ・ 移転 ${card.transferCount} 回` : null}
        {card.disabledAt === null
          ? null
          : ` ・ ${toDate(card.disabledAt)} に無効化` +
            (card.disabledReason === null ? "" : `（${card.disabledReason}）`)}
      </p>
    )}
  </div>
);

export type CardsPageProps = {
  /**
   * 管理の節を出すか（#333）。**必須にしてある** —— 既定値を置くと、
   * 次に足した画面だけ渡し忘れた状態が作れて、しかも落ちない。
   */
  readonly isAdmin: boolean;
  readonly cards: readonly CardView[];
};

export const CardsPage: FC<CardsPageProps> = ({ cards, isAdmin }) => (
  <KiwaShell
    title="NFC カード"
    nav={accountNavFor(isAdmin)}
    brandHref={ACCOUNT_HOME_PATH}
    // **Worker ごとに違う。** この Worker が自分で配信している CSS
    // （借りない理由は `asset-paths.ts` の #211 の節）。
    stylesheet={KIWA_STYLESHEET_PATH}
    current="nfc"
    heading="NFC カード"
    lead="カードをかざしたときの行き先を、カードを書き換えずに変更できます。"
    // **島はこの画面のためだけのもの。** `KiwaShell` は中身を知らず、
    // 渡されたものを `Layout` へ素通しする（#338）。
    scripts={[ISLAND_PATH]}
  >
    {cards.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>登録されたカードはありません。</EmptyTitle>
          <EmptyDescription>
            カードをスマートフォンでタップすると、登録の画面が開きます。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <Card>
        <CardHeader>
          <CardTitle>あなたのカード</CardTitle>
          <CardDescription>
            {cards.length} 枚。カード ID は、カードの裏面に印字されているものと同じです。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul class="flex flex-col">
            {cards.map((card, index) => (
              <li key={card.cardId}>
                {/*
                  **区切りは 1 件目の前に置かない。** 先頭に出すと
                  `CardHeader` との間に線が 2 本並ぶ。件数で分岐させずに
                  済むよう、間に入る側だけが描く。
                */}
                {index > 0 && <Separator class="my-3" />}
                <CardRow card={card} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    )}

    <Card>
      <CardHeader>
        <CardTitle>この画面からできないこと</CardTitle>
        <CardDescription>
          無効化・人への譲渡・カードの発行は、まだこの画面からは行えません。
          <code class="font-mono">/account/nfc/cards</code> の API から操作してください。
          <strong>遷移先の変更はこの画面からできます</strong>（上の一覧）。
          <strong>新しいカードの登録は、カードをタップすると開く画面から行います。</strong>
        </CardDescription>
      </CardHeader>
    </Card>
  </KiwaShell>
);
