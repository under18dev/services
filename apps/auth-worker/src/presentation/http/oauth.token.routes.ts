import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppBindings } from "./types";

/**
 * `POST /oauth/token`（仕様書 5.3 / 7.3 / 9、#16）。
 *
 * 認可コードを Token へ交換する唯一の経路。判断は
 * `ExchangeAuthorizationCodeUseCase` が持ち、ここは HTTP の作法だけを担う。
 *
 * ## クライアント認証の読み取り
 *
 * `client_secret_basic`（Authorization ヘッダ）と `client_secret_post`
 * （本文）の両方を受け付ける。**どちらか一方だけ**を許す。両方に秘密が
 * 載った要求は拒否する（RFC 6749 §2.3.1 が「複数の認証方式を使ってはならない」と
 * 定めている）。受け入れると、どちらが検証されたのかが実装依存になる。
 */
export const oauthTokenRoutes = new Hono<AppBindings>();

/** OAuth 2.0 のエラー応答（RFC 6749 §5.2）。 */
function oauthError(
  c: Context<AppBindings>,
  status: ContentfulStatusCode,
  error: string,
  description: string,
  /** `invalid_client` を 401 で返すときだけ付ける。 */
  withChallenge = false,
): Response {
  if (withChallenge) {
    // RFC 6749 §5.2: Authorization ヘッダで認証を試みたクライアントへ
    // 401 を返すときは `WWW-Authenticate` を付けなければならない。
    c.header("WWW-Authenticate", 'Basic realm="u18-identity"');
  }
  return c.json({ error, error_description: description }, status);
}

/**
 * `Authorization: Basic` からクライアント認証情報を取り出す。
 *
 * RFC 6749 §2.3.1 は `client_id` / `client_secret` を
 * **`application/x-www-form-urlencoded` で符号化してから** base64 せよと
 * 定めている。復号せずに使うと、`+` や `%` を含む秘密を持つクライアントが
 * 認証できない。
 */
function readBasicAuth(header: string | undefined): { id: string; secret: string } | null {
  if (header === undefined) return null;

  const match = /^Basic\s+(\S+)$/i.exec(header);
  if (match === null) return null;

  let decoded: string;
  try {
    decoded = atob(match[1] ?? "");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return null;

  try {
    return {
      id: decodeURIComponent(decoded.slice(0, separator).replaceAll("+", " ")),
      secret: decodeURIComponent(decoded.slice(separator + 1).replaceAll("+", " ")),
    };
  } catch {
    // 不正な %エンコードは認証失敗として扱う。黙って生の文字列へ落とさない。
    return null;
  }
}

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value !== "" ? value : null;
}

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
  const basic = readBasicAuth(c.req.header("Authorization"));
  const bodyClientId = field(form, "client_id");
  const bodySecret = field(form, "client_secret");

  if (basic !== null && bodySecret !== null) {
    // 2 つの認証方式を同時に使っている（RFC 6749 §2.3.1 で禁止）。
    return oauthError(c, 400, "invalid_request", "multiple client authentication methods used");
  }
  if (basic !== null && bodyClientId !== null && bodyClientId !== basic.id) {
    // ヘッダと本文で別の client_id を名乗っている。どちらを信じるかを
    // 実装の都合で決めない。
    return oauthError(c, 400, "invalid_request", "client_id does not match the credentials");
  }

  const clientId = basic?.id ?? bodyClientId;
  if (clientId === null) {
    return oauthError(c, 400, "invalid_request", "client_id is required");
  }

  const container = c.get("container");
  const authenticated = await container.useCases.authenticateOAuthClient.execute({
    clientId,
    clientSecret: basic?.secret ?? bodySecret,
  });

  if (!authenticated.ok) {
    // RFC 6749 §5.2: Authorization ヘッダで認証を試みた場合は 401、
    // それ以外は 400 でもよい。u18 は 401 に揃える——クライアントの
    // 設定ミスを「要求が壊れている」ではなく「認証に失敗した」と
    // 読めるほうが、運用時に原因へ届きやすい。
    return oauthError(c, 401, "invalid_client", "client authentication failed", basic !== null);
  }

  // ---- 交換 ----
  const result = await container.useCases.exchangeAuthorizationCode.execute({
    client: authenticated.value,
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
