import { loginUrlWithReturnTo, returnToForCurrentRequest, sessionCookieName } from "@u18/contracts";
import { IMMUTABLE_ASSET_CACHE_CONTROL, pageSecurityHeaders } from "@u18/web-ui";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { CARDS_ISLAND_JS } from "./generated/cards-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { CARDS_UI_PATH, CLAIM_CARD_PARAM, CLAIM_UI_PATH } from "../base-path";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "../csrf";
import type { AppBindings } from "../types";
import { CardsPage } from "./cards-page";
import { ClaimPage } from "./claim-page";

/**
 * 紐づけ画面が受け付けるカード ID の形。
 *
 * `cards.routes.ts` の `cardIdSchema` と同じ形。**弾いた場合も
 * 「紐づけられないカード」と同じ画面にすること** —— 「形が不正」と
 * 「そんなカードは無い」を区別すると、カード ID の形を教える。
 * （実際の ID の形と合っていないことと、3 箇所に散っていることは #365。）
 */
const CARD_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * カード一覧の画面（#31 の管理 API に対する UI）。
 *
 * ## なぜ nfc-worker が HTML を返すのか
 *
 * `u18-nfc` の D1 を持つのは nfc-worker だけである（仕様書 2.2 の裏返し）。
 * dashboard-worker から見せようとすると、カードを読むためだけに
 * nfc-worker への Service Binding を増やすことになる。
 *
 * **同じオリジンに載っているので、利用者からは 1 つの画面に見える。**
 * `wrangler.jsonc` の route に `auth.under18.dev/account/nfc/*` があり、
 * `__Host-` のセッション Cookie はこのホストへ送られる（§14.1 決定 1）。
 *
 * ## 未ログインはログイン画面へ送る
 *
 * API（`cards.routes.ts`）は 401 の JSON を返すが、**画面で JSON を
 * 見せても利用者にできることが無い**。`/login` へ送る。
 */
export function registerCardsUiRoutes(app: Hono<AppBindings>, path: string): void {
  /**
   * Kiwa UI のスタイルシート（#332 / #338）。
   *
   * **auth-worker から借りるのをやめた**（#211）。理由は
   * `ui/asset-paths.ts` に書いてある。URL に内容ハッシュが入っているので
   * `immutable` で配信してよい。
   *
   * **手書きの `u18.css` はもう配信していない。** この Worker の画面が
   * 1 枚も読まなくなったので、配信ルートだけが残る形を避けた。
   *
   * この画面が返す HTML は `no-store` のままである（カードの状態は
   * 所有者固有）。ここだけが例外で、**中身は全利用者に同じ CSS で、
   * 個人情報を 1 文字も含まない。**
   */
  app.get(KIWA_STYLESHEET_PATH, (c) =>
    c.body(KIWA_STYLESHEET, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    }),
  );

  /**
   * カード画面のアイランド（#338）。
   *
   * **CSS と同じ扱い。** URL に内容ハッシュが入るので `immutable` で
   * 配信してよい。中身は全利用者に同じスクリプトで、個人情報を 1 文字も
   * 含まない（カード ID は HTML 側の `data-card-id` から読む）。
   */
  app.get(ISLAND_PATH, (c) =>
    c.body(CARDS_ISLAND_JS, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    }),
  );

  app.get(path, pageSecurityHeaders, async (c) => {
    const result = await c
      .get("container")
      .useCases.listMyCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)));

    if (!result.ok) {
      // `unauthenticated` だけをログインへ送る。identity_unavailable を
      // 混ぜると、auth-worker が落ちているときに利用者が延々と
      // ログインし直す羽目になる（ログインも同じ Worker が受けている）。
      if (result.failure.kind === "unauthenticated") {
        // 戻り先を載せる。素の `/login` へ送ると、ログインしたあと
        // 利用者が自分でこの画面まで辿り直すことになる。値の妥当性は
        // auth-worker の `sanitizeReturnTo` が判断する（関門は 1 つ）。
        return c.redirect(loginUrlWithReturnTo(returnToForCurrentRequest(c.req.url)), 302);
      }
      return c.text("しばらくしてからもう一度お試しください。", 503);
    }

    // キャッシュしない。カードの状態は所有者固有で、共有キャッシュに
    // 載ると他人に見える（#125 と同じ理由）。
    c.header("Cache-Control", "no-store");
    return c.html(<CardsPage cards={result.value.cards} isAdmin={result.value.isAdmin} />);
  });

  /**
   * カードをタップした人の着地点（#358）。
   *
   * `go.under18.dev/c/:cardId` が未紐づけのカードについてここへ 302 する
   * （`redirect.routes.ts`）。**カード ID はクエリで受け取る** ——
   * パスに置くと CSRF 拒否のログへ落ちる（`base-path.ts` の
   * `CLAIM_CARD_PARAM` に理由がある）。
   *
   * ## 未ログインはログイン画面へ送る。カードを引く前に
   *
   * **順序が効く。** 先にカードを引いて出し分けると、未認証の相手にも
   * 「この ID は紐づけられる」が見える。`ViewClaimUseCase` がセッションを
   * 先に確かめる形にしてある。
   *
   * 戻り先は `returnToForCurrentRequest` が組み立てる。`/account` 接頭辞の
   * 下にあるので、auth-worker の `sanitizeReturnTo` に**何も足さずに通る。**
   * 登録から戻ってきた人も同じ URL に着地する。
   */
  app.get(CLAIM_UI_PATH, pageSecurityHeaders, async (c) => {
    const cardId = c.req.query(CLAIM_CARD_PARAM) ?? "";

    const result = await c.get("container").useCases.viewClaim.execute({
      sessionToken: getCookie(c, sessionCookieName(c.env.ENVIRONMENT)),
      // **形が不正でも D1 は引く。** `""` がそのまま `findById()` へ渡り、
      // 存在しないカードとして畳まれる。
      //
      // **早期 return を足さないこと。** 形が不正なときだけ D1 を飛ばすと、
      // 「形が不正」と「形は合っているが存在しない」で処理時間が変わる ——
      // `cards.routes.ts` の `CARD_ID_PATTERN` が明示的に避けている形である。
      // ここで正規化しているのは、**変な値をそのまま UseCase へ運ばない**
      // ためだけで、応答を速くするためではない。
      cardId: CARD_ID_PATTERN.test(cardId) ? cardId : "",
    });

    if (!result.ok) {
      if (result.failure.kind === "unauthenticated") {
        return c.redirect(loginUrlWithReturnTo(returnToForCurrentRequest(c.req.url)), 302);
      }
      return c.text("しばらくしてからもう一度お試しください。", 503);
    }

    // **トークンは押せるときだけ用意する。** 畳んだ側で `Set-Cookie` すると、
    // 存在しないカードを叩いた相手にも Cookie が増える。
    const csrfToken = result.value.claimable ? ensureCsrfToken(c) : "";

    c.header("Cache-Control", "no-store");
    return c.html(
      <ClaimPage
        cardId={result.value.claimable ? cardId : null}
        csrfToken={csrfToken}
        isAdmin={result.value.isAdmin}
      />,
    );
  });

  /**
   * 紐づけを実行する（#358）。**この Worker で唯一の form POST。**
   *
   * ## JavaScript を要求しない
   *
   * カードをタップした人が最初に通る経路で、**アカウントがまだ無い人が
   * 通る**。アイランドにすると、JS が落ちている利用者は「タップはできるが
   * 自分のものにはできない」になる（`csrf.ts` の冒頭）。
   *
   * ## 成功したら 303 で一覧へ送る（PRG）
   *
   * 200 で画面を描くと、再読み込みで同じ POST が飛ぶ。2 回目は必ず
   * 失敗するので実害は無いが、**利用者には「失敗した」と見える。**
   *
   * ## 失敗を 1 つに畳む
   *
   * 無効化済み・他人のもの・存在しないを**同じ画面**にする。
   * CSRF で弾いた場合もここへ落ちる —— 理由を画面に書かないのは、
   * 攻撃者に何を直せばよいか教えないためで、理由はログに出る。
   */
  app.post(CLAIM_UI_PATH, pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    const concealed = () => {
      c.header("Cache-Control", "no-store");
      // **`isAdmin` は `false`。** ここは CSRF 拒否でも通るので、
      // **セッションを確かめる前に出ることがある** —— 管理者かどうかを
      // 決める材料が無い。「分からないときは出さない」側に倒す。
      return c.html(<ClaimPage cardId={null} csrfToken="" isAdmin={false} />, 400);
    };

    if (form === null) return concealed();
    if (!isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) return concealed();

    const cardId = form.get("cardId")?.toString() ?? "";
    if (!CARD_ID_PATTERN.test(cardId)) return concealed();

    const result = await c.get("container").useCases.claimCard.execute({
      sessionToken: getCookie(c, sessionCookieName(c.env.ENVIRONMENT)),
      cardId,
    });

    if (!result.ok) {
      if (result.failure.kind === "unauthenticated") {
        // **戻り先は GET の URL にする。** POST の URL へ戻すと、
        // ログイン直後にカード ID を失った画面へ着地する。
        return c.redirect(
          loginUrlWithReturnTo(
            `${CLAIM_UI_PATH}?${CLAIM_CARD_PARAM}=${encodeURIComponent(cardId)}`,
          ),
          302,
        );
      }
      if (result.failure.kind === "identity_unavailable") {
        return c.text("しばらくしてからもう一度お試しください。", 503);
      }
      return concealed();
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(CARDS_UI_PATH, 303);
  });
}
