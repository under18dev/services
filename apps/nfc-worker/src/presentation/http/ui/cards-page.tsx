import { Layout } from "@u18/web-ui";
import type { FC } from "hono/jsx";
import type { CardView } from "../../../application/ports";

/**
 * 自分のカード一覧（Phase 4 / #31）。
 *
 * ## サーバーレンダリングだけで成立させる
 *
 * この画面は **JS を 1 行も要求しない**。`<script>` を出さないので
 * `Layout` の `scripts` も渡していない。
 *
 * 表示だけに絞っているのは、書き込み経路を 2 本持たないためである。
 * `cards.routes.ts` は既に JSON + Origin 検証で守られていて、そこへ
 * form POST を並べると **2 つを同期させ続ける必要が出る**。それは本
 * リポジトリが繰り返し踏んでいるバグの形そのものなので、変更操作は
 * アイランドから既存の JSON API を叩く形に寄せる（後続）。
 *
 * ## 既存のクラスだけで組む
 *
 * 新しい CSS クラスを足していない。`.identity` は同意画面で「誰として
 * 操作しているか」を出す枠付きのボックスで、**1 件を枠で囲んで見せる**
 * という形が同じなのでそのまま使う。スタイルシートは別 Worker
 * （auth-worker）が配信しており、**こちらの都合で増やすと 2 箇所を
 * 同期させることになる。**
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

/** ISO 8601 を「2026-10-25」まで落とす。時刻まで見せる理由が無い。 */
function toDate(iso: string): string {
  return iso.split("T")[0] ?? iso;
}

const CardBox: FC<{ readonly card: CardView }> = ({ card }) => (
  <li class="identity">
    <strong>{card.cardId}</strong>
    <span>
      {STATUS_LABEL[card.status]}
      {card.claimedAt === null ? null : ` ・ ${toDate(card.claimedAt)} に紐づけ`}
      {card.transferCount > 0 ? ` ・ 移転 ${card.transferCount} 回` : null}
    </span>
    <span>遷移先: {card.targetUrl === null ? "未設定" : card.targetUrl}</span>
    {card.disabledAt === null ? null : (
      <span>
        {toDate(card.disabledAt)} に無効化
        {card.disabledReason === null ? null : `（${card.disabledReason}）`}
      </span>
    )}
  </li>
);

export type CardsPageProps = {
  readonly cards: readonly CardView[];
};

/**
 * 読み込むスタイルシート。**auth-worker が配信しているものを借りている。**
 *
 * この画面の本番 route は `auth.under18.dev/account/nfc/*` なので、
 * `/ui/u18.css` は同一オリジンの auth-worker（`auth.under18.dev/*`）へ
 * 当たる。借りられるのはそのためで、**`go.under18.dev` 側には当たらない**
 * （あちらはタップのリダイレクトだけで HTML を返さない）。
 *
 * dashboard-worker は同じ理由で借りられる位置にいるが、借りずに自分で
 * 配信している（理由は `packages/web-ui/src/styles.ts`）。この Worker も
 * 同じ形にするなら `/account/nfc/ui/u18.css` を生やすことになる。
 * **いまは借りたままの挙動を変えていない。**
 */
const STYLESHEET_PATH = "/ui/u18.css";

export const CardsPage: FC<CardsPageProps> = ({ cards }) => (
  <Layout title="NFC カード" stylesheet={STYLESHEET_PATH}>
    <h2>NFC カード</h2>

    {cards.length === 0 ? (
      <p class="lead">
        紐づけられたカードはありません。カードに同梱された紐づけコードで登録できます。
      </p>
    ) : (
      // `.scopes` は同意画面で項目を並べるための指定（余白とマーカー抑制）。
      // 「枠付きの項目を縦に並べる」という形が同じなので使い回す。
      <ul class="scopes">
        {cards.map((card) => (
          <CardBox key={card.cardId} card={card} />
        ))}
      </ul>
    )}

    <p class="notice">
      遷移先の変更と無効化は、現在このページからは行えません。
      <code>/account/nfc/cards</code> の API から操作してください。
    </p>
  </Layout>
);
