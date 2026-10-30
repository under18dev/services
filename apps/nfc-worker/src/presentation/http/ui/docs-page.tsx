import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KiwaShell,
  Separator,
} from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import { DOCS_STYLESHEET_PATH } from "./asset-paths";

/**
 * カードを受け取った人向けの案内（#358）。
 *
 * ## 読み手は運営ではない
 *
 * `docs/` 配下の文書（脅威モデル・runbook）は運営が読むもので、**ここだけ
 * 読み手が違う。** ノベルティとして配る相手を想定しているので、
 * **`claim` / `release` / `status` のような実装の語を出さない。**
 * 「登録」「ゆずる」「止める」で書く。
 *
 * **配る側の手順はここに書かない。** カードの発行のしかたを公開ページに
 * 載せると、**叩き方が公開 URL に載る。** 秘密ではないが、探しに来る理由を
 * 作らない。あちらは `docs/` 直下の Markdown にある。
 *
 * ## サイドバーを出さない
 *
 * `KiwaShell` の `current` を渡さない。**ナビの行き先は `/account/...` で、
 * このページは `go.under18.dev` に載っている** —— 相対パスで出すと
 * 同じホストの中を指してしまい、`__Host-` の Cookie が届かないので
 * 永久にログイン画面へ戻る。
 *
 * **アカウント側へのリンクは絶対 URL にする。** 組み立てに使う値は
 * `ACCOUNT_ORIGIN`（`wrangler.jsonc`）で、**本番と開発でホストが違う**
 * ことがそこに書いてある。
 *
 * ## JavaScript を読み込まない
 *
 * 読むだけのページなので `scripts` を渡さない。**カードの登録も
 * JavaScript 無しで通る**（`csrf.ts`）ので、この案内を読んだ人が
 * JS 無しで詰まる箇所は無い。
 */

/**
 * 文書に載せるカード ID の例（#382 の運用者の問い合わせ）。
 *
 * ## 「`:cardId` を焼けばいい」と読まれた
 *
 * 設定する URL を聞かれて、こちらが `go.under18.dev/c/:cardId` と答えていた。
 * **`:cardId` は route の書き方であって、焼く値ではない。** 実際に
 * 「この URL でいいんですよね？」と確認が来ている。
 *
 * **置き換え後の形を見せるほうが速い。** コロンもハイフンも入らないことが、
 * 例を 1 つ見れば分かる。
 *
 * ## 形は本物に合わせてある
 *
 * `nfc_` + 20 文字（`newCardId()` の 100 ビット）。文字集合は Crockford
 * base32 から `i l o u` を除いたもの。**長さを間違えた例を載せると、
 * 今度はその形が広まる** —— 実際 18 文字の例が会話に出ていた。
 */
const EXAMPLE_CARD_ID = "nfc_hdt62b396zy809mmqk3v";
const EXAMPLE_CARD_URL = `https://go.under18.dev/c/${EXAMPLE_CARD_ID}`;

export type DocsPageProps = {
  /** アカウント側のオリジン。本番は `https://auth.under18.dev`。 */
  readonly accountOrigin: string;
};

export const DocsPage: FC<DocsPageProps> = ({ accountOrigin }) => {
  const cardsUrl = `${accountOrigin}/account/nfc`;

  return (
    <KiwaShell
      title="カードの使い方"
      nav={[]}
      brandHref={`${accountOrigin}/account`}
      stylesheet={DOCS_STYLESHEET_PATH}
      heading="カードの使い方"
      lead="スマートフォンでタップすると、好きなページへ飛ばせるカードです。"
    >
      <Card>
        <CardHeader>
          <CardTitle>タップすると何が起きるの？</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm/relaxed">
            カードの持ち主が決めたページが開きます。自分の SNS でも、作ったサイトでも、
            好きな場所にできます。
          </p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            まだ誰のものでもないカードをタップしたときは、登録の画面が開きます。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>カードに入っているもの</CardTitle>
          <CardDescription>こんな形の URL が 1 本だけです。</CardDescription>
        </CardHeader>
        <CardContent>
          <p class="font-mono text-sm break-all">{EXAMPLE_CARD_URL}</p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            うしろの <span class="font-mono">{EXAMPLE_CARD_ID}</span> の部分がカードごとに違います。
            <strong>カードを見分けるための番号</strong>で、 あなたのアカウントとは関係がありません。
          </p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            番号は <span class="font-mono">nfc_</span> のあとに 20 文字続きます。
            数字と小文字だけで、<strong>まぎらわしい i・l・o・u は使っていません</strong>
            （1 と l、0 と o を読み間違えないようにするためです）。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>自分のカードにする</CardTitle>
          <CardDescription>最初の 1 回だけ必要です。</CardDescription>
        </CardHeader>
        <CardContent>
          <ol class="flex list-decimal flex-col gap-2 pl-5 text-sm/relaxed">
            <li>カードをスマートフォンでタップします。</li>
            <li>
              ログインの画面が出たら、ログインします。
              <span class="text-foreground-muted">
                （アカウントを持っていない場合は、その場で作れます。メールアドレスがあれば大丈夫です。）
              </span>
            </li>
            <li>戻ってきた画面で「このカードを登録する」を押します。</li>
          </ol>
          <p class="mt-4 text-sm/relaxed">これで、このカードはあなたのものになります。</p>

          <Separator class="my-4" />

          <p class="text-sm/relaxed text-foreground-muted">
            <strong>早い者勝ちです。</strong>
            まだ誰も登録していないカードは、先にタップして登録した人のものになります。
            もらったカードは、早めに登録しておくのがおすすめです。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>飛び先を変える</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm/relaxed">
            <a class="underline" href={cardsUrl}>
              {cardsUrl}
            </a>
            を開くと、自分のカードの一覧が出ます。飛び先はここでいつでも変えられます。
          </p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            <strong>カード自体を書き換える必要はありません。</strong>
            変えたあと、次にタップした人から新しい飛び先になります。
          </p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            飛び先にできるのは <code class="font-mono">https://</code> で始まるページだけです。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>人にあげる</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm/relaxed">
            一覧の画面で「手放す」と、そのカードは誰のものでもない状態に戻ります。 あとは
            <strong>受け取った人がタップして登録する</strong>だけです。
          </p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            このとき、あなたが設定していた飛び先は消えます。次の持ち主が、
            知らないページを配り続けることにならないようにするためです。
          </p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            <strong>手放すのは、相手にカードを渡す直前にしてください。</strong>
            手放したあとは、そのカードを持っている人なら誰でも登録できます。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>なくした・盗られた</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm/relaxed">
            一覧の画面で<strong>そのカードを止めてください。</strong>
            止めたカードは、タップしてもどこへも飛ばなくなります。
          </p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            止めたあと、<strong>次にタップしたときから効きます。</strong>
            前にタップしたことがある端末でも、飛び先を覚えこんだりはしていないので、
            毎回こちらに確認が来ます。
          </p>
          <p class="mt-3 text-sm/relaxed text-foreground-muted">
            拾った人には、そのカードが止められていることも、誰のものだったかも分かりません。
            <strong>止めたカードは、自分では元に戻せません。</strong>
            戻したいときは運営に連絡してください。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>自分のことが相手に伝わる？</CardTitle>
          <CardDescription>伝わりません。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul class="flex list-disc flex-col gap-2 pl-5 text-sm/relaxed">
            <li>
              カードをタップした人に、<strong>持ち主が誰かは分かりません。</strong>
              見えるのは、あなたが決めた飛び先のページだけです。
            </li>
            <li>
              飛んだ先のサイトにも、<strong>どのカードから来たかを渡していません。</strong>
            </li>
            <li>
              カードに書かれているのは、アカウントとは関係のないランダムな番号です。
              <strong>番号からあなたを辿ることはできません。</strong>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>うまくいかないとき</CardTitle>
        </CardHeader>
        <CardContent>
          <dl class="flex flex-col gap-4 text-sm/relaxed">
            <div>
              <dt class="font-medium">「このカードは利用できません」と出る</dt>
              <dd class="mt-1 text-foreground-muted">
                すでに誰かが登録しているか、止められているカードです。自分のカードのはずなら、
                <a class="underline" href={cardsUrl}>
                  カードの一覧
                </a>
                を確認してください。
              </dd>
            </div>
            <div>
              <dt class="font-medium">タップしても何も起きない</dt>
              <dd class="mt-1 text-foreground-muted">
                スマートフォンの NFC が切れていることがあります。設定から確認してください。
              </dd>
            </div>
            <div>
              <dt class="font-medium">ログインしたのに登録の画面に戻らない</dt>
              <dd class="mt-1 text-foreground-muted">もう一度カードをタップしてください。</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </KiwaShell>
  );
};
