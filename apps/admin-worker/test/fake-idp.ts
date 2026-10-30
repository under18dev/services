import { exportJWK, generateKeyPair, SignJWT } from "jose";

/**
 * テスト用の偽 IdP。ES256 の鍵ペアを実際に作り、本物と同じ形の
 * Discovery / JWKS / ID Token を返す。**本物の HTTP は 1 回も使わない**
 * ——`oidc/discovery.ts` の JSDoc にある通り、Workers のテストは外部
 * ネットワークへ出られないため、`fetch` をポートとして差し替える。
 */
export async function createFakeIdp(issuer: string) {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = "test-key-1";

  const discoveryDoc = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
  };
  const jwks = { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] };

  async function signIdToken(claims: {
    readonly sub: string;
    readonly aud: string;
    readonly nonce: string;
  }): Promise<string> {
    return new SignJWT({ nonce: claims.nonce })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject(claims.sub)
      .setIssuer(issuer)
      .setAudience(claims.aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  /**
   * `sub` を含まない・形の崩れたトークンを本物の鍵で作るための低レベル版。
   * **`signIdToken` と分けてあるのは、「sub 必須」を呼び出し側の型に
   * 強制したうえで、検査のテストだけ縛りを外せるようにするため。**
   */
  async function signRawClaims(claims: Record<string, unknown>): Promise<string> {
    const builder = new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid });
    if (typeof claims.iss === "string") builder.setIssuer(claims.iss);
    if (typeof claims.aud === "string") builder.setAudience(claims.aud);
    return builder.setIssuedAt().setExpirationTime("5m").sign(privateKey);
  }

  /**
   * `code` を叩いたら必ずこの ID Token を返す、という形の最小な
   * フェイク。**本物のコード消費・単回性は確かめない**——ここで見たいのは
   * 「admin-worker がトークン応答をどう扱うか」であって、IdP の実装では
   * ない（それは auth-worker 側のテストが持つ）。
   */
  function fetcherReturning(idToken: string, accessToken = "test-access-token"): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify(discoveryDoc), { status: 200 });
      }
      if (url === discoveryDoc.jwks_uri) {
        return new Response(JSON.stringify(jwks), { status: 200 });
      }
      if (url === discoveryDoc.token_endpoint && init?.method === "POST") {
        return new Response(JSON.stringify({ id_token: idToken, access_token: accessToken }), {
          status: 200,
        });
      }
      throw new Error(`fake-idp: 想定していない fetch: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
  }

  return { discoveryDoc, jwks, signIdToken, signRawClaims, fetcherReturning };
}
