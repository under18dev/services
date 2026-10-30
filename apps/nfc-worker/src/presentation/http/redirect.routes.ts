import { isCardId } from "@u18/domain";
import type { Context, Hono } from "hono";
import { isoDateUtc } from "../../domain/services/retention-policy";
import { claimUrl } from "./base-path";
import type { AppBindings } from "./types";

/**
 * カード ID の形の判定は `@u18/domain` の `isCardId()` 1 箇所（#365）。
 *
 * **以前はここに別のリテラル（`/^[a-z0-9_]{1,64}$/`）を持っていた。**
 * `newCardId()` の実際の形（`nfc_` + 20 文字でちょうど 24 文字、文字集合も
 * 狭い）とは合っておらず、しかも `cards.routes.ts` / `cards-ui.routes.tsx`
 * に同じリテラルが散っていた——直す必要が起きても 3 箇所のうち 1, 2 箇所
 * しか直らない形だった。`isCardId()` は `newCardId()` と同じ定数から
 * 組み立てているので、作る側と見る側が離れられない。
 *
 * **ここで弾くのは防御というより無駄打ちの抑制** —— 形の違う入力で D1 を
 * 引きに行かない。**弾いた場合も応答は実在しないカードと同じ**にすること。
 * 「形が不正」と「存在しない」を区別すると、総当たりする相手にカード ID
 * の形を教えることになる——とはいえ `isCardId()` の JSDoc にある通り、
 * その形自体は秘密ではない。
 */

/**
 * 何も言わないときの応答。
 *
 * **未発行・無効化済み・他人のもの・遷移先未設定で 1 バイトも変えない**
 * （仕様書 9 の列挙対策）。本文にカード ID を含めないのも同じ理由で、
 * 含めるとエラー画面がカード ID の反射先になる。
 *
 * **#358 で `issued`（未紐づけ）だけがここから外れた** —— タップした人を
 * 紐づけ画面へ送るためである。**何を区別して何を区別しないかは
 * `domain/services/disclosure.ts` が 1 箇所で決めている。**
 * この定数の役目は「畳んだ先を 1 つにする」ことだけで、
 * **畳むかどうかはここでは決めていない。**
 */
const NOT_FOUND_BODY = "このカードは利用できません。";

export function registerRedirectRoutes(app: Hono<AppBindings>): void {
  /**
   * `https://go.under18.dev/c/<card-id>` の解決（仕様書 10 / #31）。
   *
   * ## 認証しない
   *
   * タグをかざすのは u18 の利用者とは限らない。カードの読み取りと
   * アカウント認証は別の責務（仕様書 10）。この経路はセッション Cookie を
   * 読まないし、Cookie を発行もしない。
   *
   * ## なぜ 302 で、なぜ `no-store` なのか
   *
   * Phase 4 の完了条件は「カードを書き換えずに遷移先を変更可能」。
   * 301（恒久的）を返すと、ブラウザはその対応付けを**無期限にキャッシュする**。
   * 一度 301 を受け取った端末は、所有者が遷移先を変えても、カードを
   * 無効化しても、二度とこの Worker に問い合わせに来ない。
   * 完了条件が端末ごとに破れるうえ、紛失時の無効化が効かなくなる。
   *
   * 302 でも中間キャッシュが握る可能性があるので `no-store` を添える。
   * 「無効化は次のタップから効く」を成立させているのはこの 2 つ。
   *
   * ## `Referrer-Policy: no-referrer`
   *
   * 遷移先のサイトにカード ID を渡さない。**#358 以降、これは名寄せ対策
   * だけではない** —— 未紐づけのカードは ID を知っていれば取れるので、
   * **遷移先に ID を渡すことは、そのカードを渡すことに近い。**
   * 未成年利用者を想定している以上（仕様書 9 Privacy）、渡す理由の無い
   * 識別子は渡さない。
   */
  app.get("/c/:cardId", async (c) => {
    const cardId = c.req.param("cardId");

    const notFound = () =>
      c.text(NOT_FOUND_BODY, 404, {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });

    if (!isCardId(cardId)) return notFound();

    const disclosure = await c.get("container").useCases.resolveCard.execute(cardId);

    // **未紐づけなら紐づけ画面へ送る**（#358）。ここが `issued` を区別する
    // 唯一の場所で、漏れるのは「この ID は実在し、まだ誰のものでもない」の
    // 1 ビットである。`disclosure.ts` にその代償と前提が書いてある。
    if (disclosure.kind === "claimable") {
      // **`no-referrer` をここにも載せる。** 紐づけ画面は自分のオリジンだが、
      // 302 の前に見ていた外部ページの URL を渡す理由が無い。
      // **`no-store` も要る** —— 紐づけが済めば次のタップでは遷移先へ
      // 行くので、この 302 を端末に握らせない。
      return c.body(null, 302, {
        Location: claimUrl(c.env.ACCOUNT_ORIGIN, cardId),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
    }

    if (disclosure.kind !== "resolvable") return notFound();

    // UseCase が `https:` を保証しているが、`Location` に載せる直前の
    // ここでも確かめる。この 1 行が最後の砦で、ここを通らない限り
    // `javascript:` や `http:` が Location に入ることはない。
    const target = disclosure.targetUrl;
    if (!target.startsWith("https://")) return notFound();

    // **タップ回数の記録（#394）。応答を遅らせない。** `resolvable` と
    // 確定したこの 1 行から先でだけ数える——「使用された回数」という
    // 定義に忠実にするため、`claimable` や 404 は数えない。
    // `waitUntil` が取れなければ記録を諦める。この経路はレート制限も
    // 無い（N-5）ので、書き込みを同期させるとリダイレクト自体の遅延・
    // 失敗につながる。
    const waitUntil = waitUntilOf(c);
    if (waitUntil !== undefined) {
      const { cardTaps } = c.get("container").repositories;
      waitUntil(cardTaps.recordTap(cardId, isoDateUtc(new Date())));
    }

    // `c.redirect()` を使わず自分で組み立てるのは、Location と一緒に
    // no-store / no-referrer を必ず載せるため。片方だけ付いた応答を
    // 作れる書き方にしない。
    return c.body(null, 302, {
      Location: target,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
  });
}

/**
 * `executionCtx` を安全に取り出す（auth-worker の `request-context.ts` と
 * 同じ防御）。
 *
 * テストの一部の呼び出し方だと `executionCtx` が存在せず、触ると投げる。
 * 無ければ `undefined` を返し、呼び出し側はタップの記録を諦める——
 * **この経路はリダイレクトを返すことが本分で、記録はその次**である。
 */
function waitUntilOf(c: Context<AppBindings>): ((task: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (task) => ctx.waitUntil(task);
  } catch {
    return undefined;
  }
}
