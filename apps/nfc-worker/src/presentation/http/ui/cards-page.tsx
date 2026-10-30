import { ACCOUNT_HOME_PATH, ACCOUNT_NAV_GROUPS } from "@u18/contracts";
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
  KiwaShell,
  Separator,
} from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import type { CardView } from "../../../application/ports";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";

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
 * ## サーバーレンダリングだけで成立させる
 *
 * この画面は **JS を 1 行も要求しない**。`KiwaShell` は `<script>` を
 * 出さず、ここで使っている primitives もクライアント JS を持たない。
 *
 * ## 操作はまだ無い
 *
 * API には 5 つの操作（紐づけ・遷移先の変更・無効化・移転・発行）が
 * あるが、**この画面からは 1 つも叩けない。** それが #338 の本体で、
 * アイランドから既存の JSON API を叩く形で別途入る。
 *
 * **「できない」を黙って出さない** —— 下の案内がそれを言っている。
 * 書き込み経路を 2 本（form POST と JSON）持たないのは、
 * `cards.routes.ts` が既に JSON + Origin 検証で守られていて、並べると
 * **2 つを同期させ続ける必要が出る**ためである。
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
  readonly cards: readonly CardView[];
};

export const CardsPage: FC<CardsPageProps> = ({ cards }) => (
  <KiwaShell
    title="NFC カード"
    nav={ACCOUNT_NAV_GROUPS}
    brandHref={ACCOUNT_HOME_PATH}
    // **Worker ごとに違う。** この Worker が自分で配信している CSS
    // （借りない理由は `asset-paths.ts` の #211 の節）。
    stylesheet={KIWA_STYLESHEET_PATH}
    current="nfc"
    heading="NFC カード"
    lead="カードをかざしたときの行き先を、カードを書き換えずに変更できます。"
  >
    {cards.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>紐づけられたカードはありません。</EmptyTitle>
          <EmptyDescription>カードに同梱された紐づけコードで登録できます。</EmptyDescription>
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
          遷移先の変更・無効化・移転・新しいカードの紐づけは、まだこの画面からは行えません。
          <code class="font-mono">/account/nfc/cards</code> の API から操作してください。
        </CardDescription>
      </CardHeader>
    </Card>
  </KiwaShell>
);
