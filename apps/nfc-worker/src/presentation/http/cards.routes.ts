import { sessionCookieName } from "@u18/contracts";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { NfcFailure } from "../../domain/errors";
import { isAllowedOrigin, isJsonRequest } from "./origin";
import type { AppBindings } from "./types";

/**
 * カード管理 API（#31）。
 *
 * ## このハンドラが userId を受け取らないこと
 *
 * どのルートも、パスにもボディにも `userId` を取らない。操作者は
 * **セッション Cookie だけ**から決まり、その検証は auth-worker が行う
 * （`application/use-cases/authenticate.ts`）。
 * `userId` を受け取る口を 1 つ作ると、それが「他人のカードを操作する」
 * 入口になる（仕様書 4.2 / docs/architecture.md 5.2）。
 *
 * ## ここで登録される URL は OAuth の `redirect_uri` ではない
 *
 * `PUT /cards/:cardId/target` が受け取るのは NFC カードの遷移先であり、
 * **OIDC の Redirect URI として許可してはならない**（仕様書 10）。
 * この値は所有者がいつでも書き換えられるので、認可コードの宛先に
 * 使えば IdP 公認のオープンリダイレクタになる。auth-worker の
 * `oauth_redirect_uris` とはデータも検証規則も完全に別系統で、
 * `domain/services/target-url.ts` に経緯を書いてある。
 */

const cardIdSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);

const updateTargetSchema = z.object({
  // 長さの上限は Domain 側でも見るが、ここでも切る。
  // 巨大な本文を Domain まで運ばない。
  targetUrl: z.string().min(1).max(2048),
});

const disableSchema = z.object({
  // 自由文を受け取らない。監査ログに任意の文字列を書かせないため。
  reason: z.enum(["lost", "unused"]).default("lost"),
});

const claimSchema = z.object({
  cardId: cardIdSchema,
  claimCode: z.string().min(1).max(64),
});

function statusFor(failure: NfcFailure): 400 | 401 | 404 | 503 {
  switch (failure.kind) {
    case "unauthenticated":
      return 401;
    case "card_not_found":
      // 403 を返さない。403 は「存在するが権限が無い」と読めるので、
      // 他人のカード ID を当てたことが相手に伝わる。
      return 404;
    case "invalid_target_url":
      return 400;
    case "claim_rejected":
      return 400;
    case "identity_unavailable":
      return 503;
  }
}

function bodyFor(failure: NfcFailure): Record<string, string> {
  // 失敗の詳細を返すのは、所有者本人が自分の入力を直せる場合だけ。
  if (failure.kind === "invalid_target_url") {
    return { error: failure.kind, reason: failure.reason };
  }
  // identity_unavailable の `detail` は内部事情なので外へ出さない。
  return { error: failure.kind };
}

export function registerCardRoutes(app: Hono<AppBindings>, basePath: string): void {
  // 親と同じく末尾スラッシュを同一視する（app.ts を参照）。
  const cards = new Hono<AppBindings>({ strict: false });

  /**
   * 状態を変える操作の門番。
   *
   * Origin 検証と Content-Type 検証の**両方**を要求する（origin.ts を参照）。
   * GET には課さない。課すと通常のブラウザ遷移が壊れるうえ、
   * 読み取りは状態を変えないので CSRF の利得が無い。
   */
  cards.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();

    if (!isAllowedOrigin(c)) return c.json({ error: "forbidden" }, 403);
    if (!isJsonRequest(c)) return c.json({ error: "forbidden" }, 403);

    return next();
  });

  /** 自分のカード一覧。 */
  cards.get("/", async (c) => {
    const result = await c
      .get("container")
      .useCases.listMyCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)));
    if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));
    return c.json({ cards: result.value });
  });

  /** カードを自分のアカウントへ紐づける（初回紐づけ・移転の受け取り側）。 */
  cards.post("/claim", async (c) => {
    const parsed = claimSchema.safeParse(await readJson(c.req.raw));
    // 入力の形が不正でも `claim_rejected` に畳む。「形は合っているが
    // コードが違う」と区別できると、コードの形を教えることになる。
    if (!parsed.success) return c.json({ error: "claim_rejected" }, 400);

    const result = await c.get("container").useCases.claimCard.execute({
      sessionToken: getCookie(c, sessionCookieName(c.env.ENVIRONMENT)),
      cardId: parsed.data.cardId,
      // 紙から転記する値なので、大文字と前後の空白だけ吸収する。
      claimCode: parsed.data.claimCode.trim().toLowerCase(),
    });
    if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));
    return c.json(result.value);
  });

  /**
   * 遷移先の変更。Phase 4 の完了条件「カードを書き換えずに遷移先を
   * 変更可能」そのもの。
   */
  cards.put("/:cardId/target", async (c) => {
    const cardId = cardIdSchema.safeParse(c.req.param("cardId"));
    if (!cardId.success) return c.json({ error: "card_not_found" }, 404);

    const parsed = updateTargetSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) {
      return c.json({ error: "invalid_target_url", reason: "not_absolute" }, 400);
    }

    const result = await c.get("container").useCases.updateCardTarget.execute({
      sessionToken: getCookie(c, sessionCookieName(c.env.ENVIRONMENT)),
      cardId: cardId.data,
      targetUrl: parsed.data.targetUrl.trim(),
    });
    if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));
    return c.json(result.value);
  });

  /** 紛失時の無効化。片道の操作（DisableCardUseCase を参照）。 */
  cards.post("/:cardId/disable", async (c) => {
    const cardId = cardIdSchema.safeParse(c.req.param("cardId"));
    if (!cardId.success) return c.json({ error: "card_not_found" }, 404);

    const parsed = disableSchema.safeParse((await readJson(c.req.raw)) ?? {});
    const reason = parsed.success ? parsed.data.reason : "lost";

    const result = await c.get("container").useCases.disableCard.execute({
      sessionToken: getCookie(c, sessionCookieName(c.env.ENVIRONMENT)),
      cardId: cardId.data,
      reason,
    });
    if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));
    return c.json(result.value);
  });

  /**
   * 所有権を手放す（移転の前半）。
   *
   * 応答の `claimCode` は**この 1 回しか返らない**。保存しているのは
   * ハッシュだけで、再発行は release をもう一度行うしかない。
   */
  cards.post("/:cardId/release", async (c) => {
    const cardId = cardIdSchema.safeParse(c.req.param("cardId"));
    if (!cardId.success) return c.json({ error: "card_not_found" }, 404);

    const result = await c.get("container").useCases.releaseCard.execute({
      sessionToken: getCookie(c, sessionCookieName(c.env.ENVIRONMENT)),
      cardId: cardId.data,
    });
    if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));

    // 平文の紐づけコードを含むので、中間キャッシュにも残さない。
    return c.json(result.value, 200, { "Cache-Control": "no-store" });
  });

  app.route(basePath, cards);
}

/**
 * JSON の本文を読む。壊れていれば null。
 *
 * `c.req.json()` は本文が空・不正なときに throw する。ここで throw を
 * 外へ出すと 500 になり、「不正な入力」と「サーバーの不具合」が
 * 区別できなくなる。
 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
