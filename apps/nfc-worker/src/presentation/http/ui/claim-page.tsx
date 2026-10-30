import { ACCOUNT_HOME_PATH, ACCOUNT_NAV_GROUPS } from "@u18/contracts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  getButtonClasses,
  KiwaShell,
} from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import { CARDS_UI_PATH, CLAIM_UI_PATH } from "../base-path";
import { CSRF_FIELD_NAME } from "../csrf";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";

/**
 * カードをタップした人が着地する画面（#358）。
 *
 * ## JavaScript が要らない
 *
 * **form POST 1 本で完結する。** この画面はアカウントを持っていない人が
 * ここまで来て登録を済ませ、戻ってきて押す場所なので、**JS の有無で
 * 操作ごと消えてはならない。**（`cards-page.tsx` の遷移先の変更は
 * アイランドのままである —— あちらは効かなくても一覧が読める。）
 *
 * アイランドを読み込まないので `scripts` を渡さない。
 *
 * ## 失敗を 1 つに畳む
 *
 * 「そんなカードは無い」「無効化済み」「もう誰かのもの」を**同じ画面**に
 * する。区別すると、カード ID を総当たりする相手に「その ID は実在する」と
 * 教えることになる。**畳むかどうかの判断はこの画面には無い** ——
 * `domain/services/disclosure.ts` が 1 箇所で決めている。
 *
 * ## カード ID を画面に出すこと
 *
 * **`claimable` のときだけ出す。** 押す前に「どのカードか」が分からないと、
 * 手元のカードと違うものを紐づけても気づけない。畳んだ側には出さない ——
 * 出すと、存在しないカードの ID が反射されて確認の手段になる。
 */

const CLAIM_BUTTON_CLASS = getButtonClasses("default", "default");

export type ClaimPageProps = {
  /** 紐づけられるカード。畳んだ側は null。 */
  readonly cardId: string | null;
  readonly csrfToken: string;
};

export const ClaimPage: FC<ClaimPageProps> = ({ cardId, csrfToken }) => (
  <KiwaShell
    title="カードの登録"
    nav={ACCOUNT_NAV_GROUPS}
    brandHref={ACCOUNT_HOME_PATH}
    stylesheet={KIWA_STYLESHEET_PATH}
    current="nfc"
    heading="カードの登録"
    lead={
      cardId === null
        ? "このカードは登録できませんでした。"
        : "このカードを自分のアカウントに登録します。"
    }
  >
    {cardId === null ? (
      <Card>
        <CardHeader>
          <CardTitle>このカードは利用できません。</CardTitle>
          <CardDescription>
            すでに誰かが登録しているか、利用できない状態になっています。
            自分のカードのはずなのにこの画面が出る場合は、
            <a class="underline" href={CARDS_UI_PATH}>
              カードの一覧
            </a>
            を確認してください。
          </CardDescription>
        </CardHeader>
      </Card>
    ) : (
      <Card>
        <CardHeader>
          <CardTitle>このカードを登録しますか？</CardTitle>
          <CardDescription>
            登録すると、カードをかざしたときの行き先をあなたが決められるようになります。 カードは 1
            人分のアカウントにだけ登録できます。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p class="mb-4 font-mono text-sm break-all">{cardId}</p>

          {/*
            **method="post" の素の form。** `action` を明示するのは、
            クエリ（`?card=...`）を引き継がせないため —— カード ID は
            hidden input で本文に載せる（`base-path.ts` の `CLAIM_CARD_PARAM`
            に、URL へ出す範囲を絞っている理由が書いてある）。
          */}
          <form method="post" action={CLAIM_UI_PATH}>
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <input type="hidden" name="cardId" value={cardId} />
            <button type="submit" class={CLAIM_BUTTON_CLASS}>
              このカードを登録する
            </button>
          </form>
        </CardContent>
      </Card>
    )}
  </KiwaShell>
);
