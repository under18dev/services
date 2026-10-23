import { Hono } from "hono";
import { SUPPORTED_SCOPES } from "../../domain/services/scope";
import type { AppBindings } from "./app";
import { problem } from "./problem";

/**
 * OIDC の公開 HTTP エンドポイント（仕様書 5.2）。
 *
 * 外部クライアントは Service Binding ではなくここを使う（設計原則 4）。
 * Phase 2 で実装する。Discovery だけは静的に決まるため先に返せるようにしてある。
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
    scopes_supported: SUPPORTED_SCOPES,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    // PKCE は S256 必須。plain は公開しない。
    code_challenge_methods_supported: ["S256"],
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

oauthRoutes.get("/.well-known/jwks.json", (c) =>
  // Phase 2: signing_key_metadata から公開鍵を読み、ローテーション中の旧鍵も含めて返す。
  problem(c, 501, "not_implemented", "JWKS endpoint is implemented in Phase 2"),
);

oauthRoutes.get("/oauth/authorize", (c) =>
  problem(c, 501, "not_implemented", "authorization endpoint is implemented in Phase 2"),
);

oauthRoutes.post("/oauth/token", (c) =>
  problem(c, 501, "not_implemented", "token endpoint is implemented in Phase 2"),
);

oauthRoutes.on(["GET", "POST"], "/oauth/userinfo", (c) =>
  problem(c, 501, "not_implemented", "userinfo endpoint is implemented in Phase 2"),
);

oauthRoutes.post("/oauth/revoke", (c) =>
  problem(c, 501, "not_implemented", "revocation endpoint is implemented in Phase 2"),
);
