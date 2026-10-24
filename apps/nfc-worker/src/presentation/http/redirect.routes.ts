import type { Hono } from "hono";
import type { AppBindings } from "./types";

/**
 * カード ID として受け付ける形。
 *
 * `@u18/domain` の `newId()` が作る Crockford base32 + 接頭辞の形に合わせる。
 * ここで弾くのは防御というより無駄打ちの抑制 —— 形の違う入力で D1 を
 * 引きに行かない。**弾いた場合も応答は実在しないカードと同じ**にすること。
 * 「形が不正」と「存在しない」を区別すると、総当たりする相手に
 * カード ID の形を教えることになる。
 */
const CARD_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * 見つからない・解決できないカードへの応答。
 *
 * 未発行・未紐づけ・無効化済み・遷移先未設定で**1 バイトも変えない**
 * （仕様書 9 の列挙対策）。本文にカード ID を含めないのも同じ理由で、
 * 含めるとエラー画面がカード ID の反射先になる。
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
   * 遷移先のサイトにカード ID を渡さない。カード ID は所有者を特定する
   * 鍵ではないが、第三者のサイトが集めれば「同じカードから来た訪問者」を
   * 名寄せできる。未成年利用者を想定している以上（仕様書 9 Privacy）、
   * 渡す理由の無い識別子は渡さない。
   */
  app.get("/c/:cardId", async (c) => {
    const cardId = c.req.param("cardId");

    const notFound = () =>
      c.text(NOT_FOUND_BODY, 404, {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });

    if (!CARD_ID_PATTERN.test(cardId)) return notFound();

    const result = await c.get("container").useCases.resolveCard.execute(cardId);
    if (!result.ok) return notFound();

    // UseCase が `https:` を保証しているが、`Location` に載せる直前の
    // ここでも確かめる。この 1 行が最後の砦で、ここを通らない限り
    // `javascript:` や `http:` が Location に入ることはない。
    const target = result.value.targetUrl;
    if (!target.startsWith("https://")) return notFound();

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
