import { pageSecurityHeaders } from "@u18/web-ui";
import type { Context, Hono } from "hono";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./csrf";
import { cardTapUrl } from "./nfc-tap-url";
import { NfcPage } from "./ui/nfc-page";
import type { AppBindings } from "./types";

/**
 * NFC カードの管理画面（`admin.under18.dev/nfc`、#382 / #390 決定 16 ③）。
 *
 * **`/account/nfc/admin`（nfc-worker、#377 / #389 / #398）から移した。**
 * 呼び方だけが変わった——セッション Cookie 経由の UseCase ではなく、
 * `NfcAdminDelegatedRPC`（Service Binding）を呼ぶ。
 *
 * ## `actorUserId` は `c.get("session").sub`
 *
 * **検証しない。** セッションガード（`app.ts`）が既に「ログイン済み・
 * 承認リストにある」ことを確かめたあとにしかここへ来ない。
 * `NfcAdminDelegatedRpcContract` の trust boundary の説明を参照。
 *
 * ## JavaScript を要求しない
 *
 * 移行元と同じ理由。**admin-worker にはまだ島が無い**ので、新しく
 * 作らず form POST + PRG で完結させる。
 *
 * ## 枚数の上限はここにも書かない
 *
 * `MAX_ISSUE_COUNT` は nfc-worker 側（`issue-cards.use-case.ts`）が
 * 持っている。ここで同じ値を書き写すと、片方だけ変えられる形を作る
 * ——入力の上限チェックは delegated RPC 側に任せ、ここは「失敗したら
 * 理由を出す」だけにする。
 */

/** 発行の直後に「何枚出したか」を運ぶクエリ名。移行元と同じ理由（ID は運ばない）。 */
const ISSUED_COUNT_PARAM = "issued";

const TARGET_URL_REASON_LABEL: Readonly<Record<string, string>> = {
  not_absolute: "URL は https:// から始まる絶対 URL で入力してください。",
  too_long: "URL が長すぎます。短いものをお使いください。",
  not_https: "https:// の URL だけを設定できます。",
  has_credentials: "URL にユーザー名やパスワードを含めることはできません。",
  non_default_port: "ポート番号付きの URL は設定できません。",
  private_host: "このホスト名は設定できません（内部向けのアドレスです）。",
  blocked_host: "このホスト名は設定できません。",
};

function issuedCountFromQuery(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return null;
  return parsed;
}

export function registerNfcRoutes(app: Hono<AppBindings>): void {
  app.get("/nfc", pageSecurityHeaders, async (c) => {
    const container = c.get("container");
    const result = await container.nfcCards.listAllCards();

    if (!result.ok) {
      return c.text("しばらくしてからもう一度お試しください。", 503);
    }

    const tapUrls = result.value.cards
      .filter((card) => card.status === "issued")
      .map((card) => cardTapUrl(container.env.SHORT_URL_ORIGIN, card.cardId));

    c.header("Cache-Control", "no-store");
    return c.html(
      <NfcPage
        cards={result.value.cards}
        truncated={result.value.truncated}
        tapUrls={tapUrls}
        csrfToken={ensureCsrfToken(c)}
        issuedCount={issuedCountFromQuery(c.req.query(ISSUED_COUNT_PARAM))}
        error={null}
      />,
    );
  });

  app.post("/nfc", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const count = Number(form.get("count")?.toString() ?? "");
    const rawBatch = form.get("batch")?.toString().trim() ?? "";

    const container = c.get("container");
    const result = await container.nfcCards.issueCards({
      actorUserId: session.sub,
      count,
      batch: rawBatch === "" ? null : rawBatch,
    });

    if (!result.ok) {
      return renderNfcPageWithError(c, "枚数は 1〜200 の数で指定してください。");
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(`/nfc?${ISSUED_COUNT_PARAM}=${result.value.cards.length}`, 303);
  });

  app.post("/nfc/:cardId/disable", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const cardId = c.req.param("cardId");

    const container = c.get("container");
    const result = await container.nfcCards.disableCard({ actorUserId: session.sub, cardId });

    if (!result.ok) {
      return renderNfcPageWithError(c, "そのカードは見つかりませんでした。");
    }

    c.header("Cache-Control", "no-store");
    return c.redirect("/nfc", 303);
  });

  app.post("/nfc/:cardId/release", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const cardId = c.req.param("cardId");

    const container = c.get("container");
    const result = await container.nfcCards.releaseCard({ actorUserId: session.sub, cardId });

    if (!result.ok) {
      return renderNfcPageWithError(c, "そのカードは見つかりませんでした。");
    }

    c.header("Cache-Control", "no-store");
    return c.redirect("/nfc", 303);
  });

  /**
   * 無効化されたカードを `active` へ戻す（#427）。**`active` へ戻すだけで、
   * `issued`（手放す、上の `/release`）とはまとめない** —— 「戻したい」と
   * 「渡したい」は運営側の判断が違う場面なので、2 つのボタンを並べる
   * （`nfc-page.tsx` の `CardActions` を参照）。
   */
  app.post("/nfc/:cardId/reinstate", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const cardId = c.req.param("cardId");

    const container = c.get("container");
    const result = await container.nfcCards.reinstateCard({ actorUserId: session.sub, cardId });

    if (!result.ok) {
      return renderNfcPageWithError(c, "そのカードは見つかりませんでした。");
    }

    c.header("Cache-Control", "no-store");
    return c.redirect("/nfc", 303);
  });

  app.post("/nfc/:cardId/target", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return c.text("forbidden", 403);
    }

    const session = c.get("session");
    const cardId = c.req.param("cardId");
    const targetUrl = form.get("targetUrl")?.toString().trim() ?? "";

    const container = c.get("container");
    const result = await container.nfcCards.updateCardTarget({
      actorUserId: session.sub,
      cardId,
      targetUrl,
    });

    if (!result.ok) {
      const message =
        TARGET_URL_REASON_LABEL[result.error.message] ?? "そのカードは見つかりませんでした。";
      return renderNfcPageWithError(c, message);
    }

    c.header("Cache-Control", "no-store");
    return c.redirect("/nfc", 303);
  });
}

/**
 * 操作に失敗したときに画面を描き直す。
 *
 * **303 で戻さない。** PRG は成功した操作のためのもので、失敗をクエリへ
 * 載せると文言を URL から差し替えられる（`issuedCountFromQuery` と
 * 同じ理由）。ここは 400 で描く。
 */
async function renderNfcPageWithError(c: Context<AppBindings>, message: string): Promise<Response> {
  const container = c.get("container");
  const result = await container.nfcCards.listAllCards();

  if (!result.ok) {
    return c.text("しばらくしてからもう一度お試しください。", 503);
  }

  const tapUrls = result.value.cards
    .filter((card) => card.status === "issued")
    .map((card) => cardTapUrl(container.env.SHORT_URL_ORIGIN, card.cardId));

  c.header("Cache-Control", "no-store");
  return c.html(
    <NfcPage
      cards={result.value.cards}
      truncated={result.value.truncated}
      tapUrls={tapUrls}
      csrfToken={ensureCsrfToken(c)}
      issuedCount={null}
      error={message}
    />,
    400,
  );
}
