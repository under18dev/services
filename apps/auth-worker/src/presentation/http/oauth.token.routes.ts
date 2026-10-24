import { Hono } from "hono";
import { authenticateClient, field, oauthError } from "./oauth.client-auth";
import type { AppBindings } from "./types";

/**
 * `POST /oauth/token`（仕様書 5.3 / 7.3 / 9、#16）。
 *
 * 認可コードを Token へ交換する唯一の経路。判断は
 * `ExchangeAuthorizationCodeUseCase` が持ち、ここは HTTP の作法だけを担う。
 *
 * クライアント認証の読み取り（`client_secret_basic` / `client_secret_post`）は
 * `oauth.client-auth.ts` に出してある。RFC 7009 §2.1 が `/oauth/revoke` にも
 * **同じ**方式を求めており、同じと書いてある規則を 2 箇所に持つと
 * 片方だけが直る日が来るため（#17）。
 */
export const oauthTokenRoutes = new Hono<AppBindings>();

oauthTokenRoutes.post("/oauth/token", async (c) => {
  // トークン応答は中間キャッシュにもブラウザにも残してはならない
  // （RFC 6749 §5.1）。失敗応答も含めて先に立てておく。
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    // 本文が `application/x-www-form-urlencoded` でない、あるいは壊れている。
    return oauthError(c, 400, "invalid_request", "request body must be form-encoded");
  }

  // ---- grant_type ----
  const grantType = field(form, "grant_type");
  if (grantType !== "authorization_code") {
    // `password` / `implicit` / `refresh_token` は提供しない（仕様書 1.2 / 9）。
    // 未知の値と「提供していない値」を区別しないのは、どちらも
    // 「この AS では使えない」で尽きているため。
    return oauthError(
      c,
      400,
      "unsupported_grant_type",
      "only grant_type=authorization_code is supported",
    );
  }

  // ---- クライアント認証 ----
  const authenticated = await authenticateClient(c, form);
  if (!authenticated.ok) return authenticated.response;

  // ---- 交換 ----
  const result = await c.get("container").useCases.exchangeAuthorizationCode.execute({
    client: authenticated.client,
    code: field(form, "code") ?? "",
    redirectUri: field(form, "redirect_uri"),
    codeVerifier: field(form, "code_verifier"),
    issuer: c.env.ISSUER,
  });

  if (!result.ok) {
    if (result.error.code === "server_error") {
      // 署名鍵の設定不備など。クライアントにも利用者にも直せない。
      return oauthError(c, 500, "server_error", result.error.message);
    }
    // それ以外はすべて `invalid_grant`（UseCase が理由を畳んでいる）。
    return oauthError(c, 400, result.error.code, result.error.message);
  }

  return c.json({
    access_token: result.value.accessToken,
    // 不透明トークンだが、RFC 6750 の Bearer として扱う（決定 14-1 の 5）。
    // `/oauth/userinfo` は `Authorization: Bearer` で受け取る（#17）。
    token_type: "Bearer",
    expires_in: result.value.expiresInSeconds,
    id_token: result.value.idToken,
    // 実際に付与した scope を返す。要求と同じでも省略しない——
    // クライアントが「要求が通った前提」で claim を読むのを防ぐ。
    scope: result.value.scope,
  });
});
