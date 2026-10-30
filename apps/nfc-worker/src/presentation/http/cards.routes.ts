import { sessionCookieName } from "@u18/contracts";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { MAX_ISSUE_COUNT } from "../../application/use-cases/issue-cards.use-case";
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

/** 実際の ID の形とは合っていない。目的は無駄打ちの抑制（#365、`redirect.routes.ts`）。 */
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

/** 発行の入力。上限は UseCase の `MAX_ISSUE_COUNT` と揃える。 */
const issueSchema = z.object({
  count: z.number().int().min(1).max(MAX_ISSUE_COUNT),
  /** ロット名。配布の単位を後から辿るのに使う。 */
  batch: z.string().min(1).max(64).optional(),
});

const claimSchema = z.object({
  cardId: cardIdSchema,
});

function statusFor(failure: NfcFailure): 400 | 401 | 403 | 404 | 503 {
  switch (failure.kind) {
    case "unauthenticated":
      return 401;
    // **403 を使ってよい唯一の経路。** 下の card_not_found が 403 を
    // 避けているのは「他人のカード ID を当てた」ことを漏らさないためで、
    // 発行エンドポイントの存在は秘密ではない（errors.ts の forbidden）。
    case "forbidden":
      return 403;
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

/**
 * カード管理 API を **1 本のチェーンで** 組み立てる（#338）。
 *
 * ## チェーンを切らないこと
 *
 * `hono/client` の `hc<CardsApiType>` は、チェーンの戻り値に積まれた型から
 * パスを作る。`cards.post(...); cards.get(...);` と**文を分けて**書くと
 * **`typeof` には何も積まれず、クライアントは空の型になる。**
 *
 * **空でも補完が出ないだけで型検査は通る。** dashboard-worker の `app.ts` が
 * 同じ警告を書いている —— 「宣言はあるが発動しない」の型版で、このリポジトリで
 * 何度も踏んでいる形である（#88 / #96 / #122 / #164）。
 *
 * 効いていることは `test/client-type.test-d.ts` が固定している。存在しない
 * パスに `@ts-expect-error` を付けてあるので、型が空（= 何でも許す）に戻ると
 * **エラーが出なくなって `@ts-expect-error` 自身が落ちる。**
 *
 * ## 登録の順序は変えていない
 *
 * Hono はルートの登録順が一致判定に効くので、並べ替えると**認可の掛かり方が
 * 静かに変わりうる。** 文をチェーンに繋ぎ替えただけで、順序も、各ハンドラの
 * 中身も 1 行も動かしていない。`test/route-order.test.ts` が
 * `createApp().routes` の並びを丸ごと固定している。
 */
function createCardsApi() {
  // 親と同じく末尾スラッシュを同一視する（app.ts を参照）。
  return (
    new Hono<AppBindings>({ strict: false })
      // 親と同じく末尾スラッシュを同一視する（app.ts を参照）。

      /**
       * 状態を変える操作の門番。
       *
       * Origin 検証と Content-Type 検証の**両方**を要求する（origin.ts を参照）。
       * GET には課さない。課すと通常のブラウザ遷移が壊れるうえ、
       * 読み取りは状態を変えないので CSRF の利得が無い。
       */
      .use("*", async (c, next) => {
        if (c.req.method === "GET" || c.req.method === "HEAD") return next();

        if (!isAllowedOrigin(c)) return c.json({ error: "forbidden" }, 403);
        if (!isJsonRequest(c)) return c.json({ error: "forbidden" }, 403);

        return next();
      })

      /**
       * 運営によるカード発行（#187、仕様書 §10 / §12）。
       *
       * **管理者だけ。** 判定は UseCase の中（`requireAdminUserId`）にあり、
       * ここには無い —— ルートに書くと、経路が増えたときに素通りする形を
       * 作る（#186 の `rpc-parity.test.ts` で確かめた話と同じ）。
       *
       * **#358 以降、応答に秘密は載らない。** 返るのはカード ID だけで、
       * 取りこぼしても一覧から引き直せる。ただし**未紐づけのカードは
       * ID を知っている人がタップすれば、その人のものになる** ——
       * この応答は配布物そのものと同じ扱いにすること。
       */
      .post("/", async (c) => {
        const parsed = issueSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

        const result = await c
          .get("container")
          .useCases.issueCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)), {
            count: parsed.data.count,
            batch: parsed.data.batch ?? null,
          });
        if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));

        return c.json({ cards: result.value }, 201);
      })

      /** 自分のカード一覧。 */
      .get("/", async (c) => {
        const result = await c
          .get("container")
          .useCases.listMyCards.execute(getCookie(c, sessionCookieName(c.env.ENVIRONMENT)));
        if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));
        return c.json({ cards: result.value });
      })

      /**
       * カードを自分のアカウントへ紐づける（#358）。
       *
       * **利用者が通るのはこちらではない。** タップした人が使うのは
       * `GET/POST /account/nfc/claim`（`ui/cards-ui.routes.tsx`）の form で、
       * **JavaScript 無しで通る。** こちらは API として残してある。
       *
       * **2 本あるが、認可は 1 箇所にある** —— どちらも `ClaimCardUseCase` を
       * 呼ぶだけで、セッションの検証も「まだ誰のものでもない」の判定も
       * UseCase と WHERE 句が持っている。`cards-page.tsx` が「書き込み経路を
       * 2 本持たない」と書いているのは**検証を 2 箇所に持つこと**を指していて、
       * ここで重複しているのは本文の読み方だけである。
       */
      .post("/claim", async (c) => {
        const parsed = claimSchema.safeParse(await readJson(c.req.raw));
        // 入力の形が不正でも `claim_rejected` に畳む。「形は合っているが
        // そのカードは紐づけられない」と区別できると、カード ID の形を教える。
        if (!parsed.success) return c.json({ error: "claim_rejected" }, 400);

        const result = await c.get("container").useCases.claimCard.execute({
          sessionToken: getCookie(c, sessionCookieName(c.env.ENVIRONMENT)),
          cardId: parsed.data.cardId,
        });
        if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));
        return c.json(result.value);
      })

      /**
       * 遷移先の変更。Phase 4 の完了条件「カードを書き換えずに遷移先を
       * 変更可能」そのもの。
       */
      .put("/:cardId/target", async (c) => {
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
      })

      /** 紛失時の無効化。片道の操作（DisableCardUseCase を参照）。 */
      .post("/:cardId/disable", async (c) => {
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
      })

      /**
       * 所有権を手放す（移転の前半）。
       *
       * **#358 で「1 回しか返らない文字列」を返さなくなった。** カードは
       * 未紐づけへ戻り、**次にタップした人のものになる** ——
       * 手放すのは相手に渡す直前にすること（`ReleaseCardUseCase`）。
       */
      .post("/:cardId/release", async (c) => {
        const cardId = cardIdSchema.safeParse(c.req.param("cardId"));
        if (!cardId.success) return c.json({ error: "card_not_found" }, 404);

        const result = await c.get("container").useCases.releaseCard.execute({
          sessionToken: getCookie(c, sessionCookieName(c.env.ENVIRONMENT)),
          cardId: cardId.data,
        });
        if (!result.ok) return c.json(bodyFor(result.failure), statusFor(result.failure));

        // 所有者固有の状態なので中間キャッシュに残さない。他の経路にも
        // 同じ理由があるが、`Cache-Control` が経路ごとに書かれたままなのは
        // 脅威モデル §3.7 が未解決として挙げているとおりである。
        return c.json(result.value, 200, { "Cache-Control": "no-store" });
      })
  );
}

/**
 * `hono/client` に渡す型。**`createCardsApi` の戻り値そのもの。**
 *
 * 島は `hc<CardsApiType>(`${origin}${CARDS_BASE_PATH}`)` の形で使う ——
 * この型は接頭辞を含まない（`app.route(basePath, ...)` の `basePath` は
 * 実行時の値で、型には現れない）ので、**接頭辞はクライアント側の base URL
 * に付ける。**
 */
export type CardsApiType = ReturnType<typeof createCardsApi>;

export function registerCardRoutes(app: Hono<AppBindings>, basePath: string): void {
  app.route(basePath, createCardsApi());
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
