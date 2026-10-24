import { Hono } from "hono";
import { SUPPORTED_SCOPES } from "../../domain/services/scope";
import { oauthAuthorizeRoutes } from "./oauth.authorize.routes";
import { oauthTokenRoutes } from "./oauth.token.routes";
import type { AppBindings } from "./types";
import { problem } from "./problem";

/**
 * OIDC の公開 HTTP エンドポイント（仕様書 5.2）。
 *
 * 外部クライアントは Service Binding ではなくここを使う（設計原則 4）。
 *
 * Discovery / JWKS はここに直接置き、量のある `/oauth/authorize`（#15）と
 * `/oauth/token`（#16）は別ファイルへ分けている。前者は「静的に決まる応答」、
 * 後者は「検証の順序が security そのもの」で、1 つのファイルに混ぜると
 * レビューの読み筋が変わる。
 */
export const oauthRoutes = new Hono<AppBindings>();

oauthRoutes.get("/.well-known/openid-configuration", (c) => {
  const issuer = c.env.ISSUER;

  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    revocation_endpoint: `${issuer}/oauth/revoke`,

    // Authorization Code Flow のみ。Implicit / Password Grant は提供しない（仕様書 9）。
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    // 認可応答はクエリでのみ返す。フラグメントを使うのは Implicit / Hybrid で、
    // どちらも提供しない。
    response_modes_supported: ["query"],
    scopes_supported: SUPPORTED_SCOPES,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    // PKCE は S256 必須。plain は公開しない。
    code_challenge_methods_supported: ["S256"],
    // Request Object は受け付けない（#15）。黙って無視するのではなく
    // `request_not_supported` で拒否するので、広告と挙動が一致している。
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "name",
      "preferred_username",
      "email",
      "email_verified",
      "updated_at",
    ],
  });
});

/**
 * ID Token の検証に使う公開鍵（仕様書 5.2 / 5.4）。
 *
 * 正本は `signing_key_metadata`。`active_until` を過ぎて新規署名に使われなくなった
 * 鍵も `retires_at` までは出し続ける。ローテーション直前に発行した ID Token は
 * 旧 kid で署名されており、それを検証する RP がまだ存在するため
 * （docs/runbook.md 4.2 ステップ 5・7）。
 *
 * 秘密鍵はこの経路に一切現れない。`SigningKeyProvider` が返すのは公開フィールドだけを
 * 詰め替えた `PublicSigningJwk` で、`d` を持ちうる型がここまで届かない。
 */
oauthRoutes.get("/.well-known/jwks.json", async (c) => {
  const keys = await c.get("container").services.signingKeys.getPublicJwks();

  if (keys.length === 0) {
    // 空の JWKS を 200 で返さない。RP は 200 を正常な応答としてキャッシュするので、
    // 鍵を登録し直しても max-age の間は「鍵が 1 本も無い」状態を信じ続ける。
    // 5xx なら各 RP のリトライに乗り、復旧が即座に伝わる。
    c.header("Cache-Control", "no-store");
    return problem(c, 503, "jwks_unavailable", "no signing key is published");
  }

  // RP は検証のたびに JWKS を取りに来るわけではないので、短すぎても無駄が多い。
  // 一方で長くすると、鍵を緊急失効したとき（docs/runbook.md 5.1）に失効済みの鍵を
  // 信じ続ける RP が増える。その折衷で 5 分。
  // なお「新しい鍵を先に配って待つ」側の時間は RP 側の TTL に支配されるため、
  // ここを縮めてもローテーション手順の 24 時間待ちは短縮できない。
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ keys });
});

oauthRoutes.route("/", oauthAuthorizeRoutes);
oauthRoutes.route("/", oauthTokenRoutes);

oauthRoutes.on(["GET", "POST"], "/oauth/userinfo", (c) =>
  problem(c, 501, "not_implemented", "userinfo endpoint is implemented in Phase 2"),
);

oauthRoutes.post("/oauth/revoke", (c) =>
  problem(c, 501, "not_implemented", "revocation endpoint is implemented in Phase 2"),
);
