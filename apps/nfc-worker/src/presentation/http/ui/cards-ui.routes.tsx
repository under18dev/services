import { loginUrlWithReturnTo, returnToForCurrentRequest, sessionCookieName } from "@u18/contracts";
import { IMMUTABLE_ASSET_CACHE_CONTROL, pageSecurityHeaders } from "@u18/web-ui";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { CARDS_ISLAND_JS } from "./generated/cards-island.bundle";
import { KIWA_STYLESHEET } from "./generated/kiwa-stylesheet";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  ADMIN_UI_PATH,
  CARDS_UI_PATH,
  CLAIM_CARD_PARAM,
  CLAIM_UI_PATH,
  cardTapUrl,
} from "../base-path";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "../csrf";
import { MAX_ISSUE_COUNT } from "../../../application/use-cases/issue-cards.use-case";
import type { AppBindings } from "../types";
import { AdminPage } from "./admin-page";
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
 * 発行の直後に「何枚出したか」を運ぶクエリ名（#382）。
 *
 * **枚数だけ。カード ID は運ばない。** URL に載った ID は CSRF 失敗時の
 * ログへ落ちる（`base-path.ts` の `CLAIM_CARD_PARAM` に経緯がある）。
 * **新しいカードは `issued` なので、戻った先の一覧に必ず入っている。**
 */
const ISSUED_COUNT_PARAM = "issued";

/**
 * クエリの枚数を読む。**数でなければ何も出さない。**
 *
 * **利用者が書き換えられる値である。** そのまま画面へ出すと、
 * 攻撃者が選んだ文字列を管理画面に表示させられる（auth-worker の
 * `LoginView.notice` が同じ理由で固定文言に限っている）。
 * ここでは**整数に落ちるものだけ**を通し、文言はサーバー側で組む。
 */
function issuedCountFromQuery(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ISSUE_COUNT) return null;
  return parsed;
}

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
   * 運営向けのカード管理画面（#338 Step 3）。
   *
   * ## 管理者以外には 404
   *
   * **403 を返さない。** #331 / #333 の判断（「管理画面は管理者以外には
   * 存在しない」）をこの画面にも適用する。403 は「在るが権限が無い」と
   * 読めるので、**管理画面の所在を未管理者へ教える。**
   *
   * **判定はここに書かない。** `ListAllCardsUseCase` の
   * `requireAdminUserId` が持っていて、ここは `forbidden` を 404 に
   * 翻訳するだけである（経路が増えたときに素通りする形を作らないため）。
   *
   * ## 未ログインはログインへ。順序に意味がある
   *
   * `unauthenticated` だけを `/login` へ送る。**`forbidden` を混ぜて
   * ログインへ送らないこと** —— 管理者でない利用者が延々とログインし直す。
   *
   * ## 焼く用の URL はここで組む
   *
   * `cardTapUrl()` が要る `SHORT_URL_ORIGIN` は env にある。
   * **画面コンポーネントへ env を渡さない** —— ホストを画面が決める形に
   * なり、焼いたタグだけが古いまま残る（`base-path.ts`）。
   *
   * **`issued` だけを入れる。** 紐づけ済みを混ぜると、誰かの手元にある
   * タグを上書きする形になる（`admin-page.tsx` の冒頭）。
   */
  app.get(ADMIN_UI_PATH, pageSecurityHeaders, async (c) => {
    const result = await c
      .get("container")
      .useCases.listAllCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)));

    if (!result.ok) {
      if (result.failure.kind === "unauthenticated") {
        return c.redirect(loginUrlWithReturnTo(returnToForCurrentRequest(c.req.url)), 302);
      }
      // **管理者でなければ「無い」。** 本文も 404 のそれに揃える。
      if (result.failure.kind === "forbidden") {
        return c.notFound();
      }
      return c.text("しばらくしてからもう一度お試しください。", 503);
    }

    const tapUrls = result.value.cards
      .filter((card) => card.status === "issued")
      .map((card) => cardTapUrl(c.env.SHORT_URL_ORIGIN, card.cardId));

    // カードの一覧は運営固有ではないが、**未紐づけの ID が本文に入る。**
    // 中間キャッシュに残す理由が無い。
    c.header("Cache-Control", "no-store");
    return c.html(
      <AdminPage
        list={result.value}
        tapUrls={tapUrls}
        // **管理者だと分かってから用意する。** 畳んだ側で `Set-Cookie`
        // すると、非管理者にも Cookie が増える（紐づけ画面と同じ判断）。
        csrfToken={ensureCsrfToken(c)}
        issuedCount={issuedCountFromQuery(c.req.query(ISSUED_COUNT_PARAM))}
        error={null}
      />,
    );
  });

  /**
   * カードを発行する（#382）。**この Worker で 2 本目の form POST。**
   *
   * ## JavaScript を要求しない
   *
   * 1 本目（紐づけ）と同じ理由である —— **JS の有無で出し分けると、
   * JS が落ちている人は発行だけ済んで URL を受け取れない。** 発行は
   * 取り消せないので、その状態がいちばん困る。
   *
   * ## 成功したら 303 で GET へ戻す（PRG）
   *
   * **発行は取り消せない。** 200 で画面を描くと、再読み込みで同じ POST が
   * 飛び、**もう一度発行される。** 紐づけ画面の PRG は「失敗して見える」を
   * 避けるためだったが、こちらは**実害が出る。**
   *
   * **出した ID は運ばない。** 新しいカードは `issued` なので、戻った先の
   * `<textarea>` に**必ず入っている。** クエリに載せるのは枚数だけ ——
   * ID を URL へ置くと CSRF 失敗時のログに落ちる（`base-path.ts`）。
   *
   * ## 管理者判定は UseCase の中
   *
   * `IssueCardsUseCase` の `requireAdminUserId` が持つ。GET と同じく
   * `forbidden` を 404 へ翻訳する —— **管理画面は管理者以外には存在しない。**
   */
  app.post(ADMIN_UI_PATH, pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    // **CSRF で弾いた場合も 404 にしない。** こちらは「在るが今の要求は
    // 通せない」で、相手は既に管理画面を開けている（= 管理者である）。
    // 403 を返して理由は書かない（何を直せばよいか教えない）。
    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const count = Number(form.get("count")?.toString() ?? "");
    const rawBatch = form.get("batch")?.toString().trim() ?? "";

    const result = await c
      .get("container")
      .useCases.issueCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)), {
        count,
        // 空文字は「指定なし」。`""` のまま渡すと、ロット名が空のカードと
        // 指定しなかったカードが区別できなくなる。
        batch: rawBatch === "" ? null : rawBatch,
      });

    if (!result.ok) {
      if (result.failure.kind === "unauthenticated") {
        return c.redirect(loginUrlWithReturnTo(returnToForCurrentRequest(ADMIN_UI_PATH)), 302);
      }
      if (result.failure.kind === "forbidden") return c.notFound();
      if (result.failure.kind === "identity_unavailable") {
        return c.text("しばらくしてからもう一度お試しください。", 503);
      }
      // **入力が通らなかった。** 枚数の範囲は UseCase が持っている
      // （`MAX_ISSUE_COUNT`）ので、ここでは文言だけを出す。
      return renderAdminWithError(c, `枚数は 1〜${MAX_ISSUE_COUNT} の数で指定してください。`);
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(`${ADMIN_UI_PATH}?${ISSUED_COUNT_PARAM}=${result.value.length}`, 303);
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

/**
 * 発行に失敗したときに管理画面を描き直す（#382）。
 *
 * **303 で戻さない。** PRG は成功した操作のためのもので、失敗を
 * クエリへ載せると**文言を URL から差し替えられる**（`issuedCountFromQuery`
 * と同じ理由）。ここは 400 で描く —— 入力が残らないのは痛いが、
 * **枚数は 1 つしか無いので打ち直しは一瞬**である。
 *
 * **ここへ来るのは管理者だけ。** CSRF を通り、`requireAdminUserId` も
 * 通ったうえで入力が弾かれた経路である。
 */
async function renderAdminWithError(c: Context<AppBindings>, message: string): Promise<Response> {
  const result = await c
    .get("container")
    .useCases.listAllCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)));

  if (!result.ok) {
    // 直前まで通っていたものが落ちた。利用者にできることは無い。
    return c.text("しばらくしてからもう一度お試しください。", 503);
  }

  const tapUrls = result.value.cards
    .filter((card) => card.status === "issued")
    .map((card) => cardTapUrl(c.env.SHORT_URL_ORIGIN, card.cardId));

  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminPage
      list={result.value}
      tapUrls={tapUrls}
      csrfToken={ensureCsrfToken(c)}
      issuedCount={null}
      error={message}
    />,
    400,
  );
}
