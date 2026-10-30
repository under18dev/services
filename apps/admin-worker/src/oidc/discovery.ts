/**
 * OIDC Discovery / JWKS の取得（RP 側）。
 *
 * ## `fetch` を注入できる形にしてある
 *
 * **Workers のテストからは外部ネットワークへ出られない。** 他の Worker の
 * `IdentityGateway` fake と同じ発想で、`fetch` をポートとして受け取り、
 * テストは本物の HTTP を叩かずに ES256 の鍵ペアで作った応答を注入する。
 *
 * ## Issuer を 2 回確かめる
 *
 * Discovery 応答に含まれる `issuer` が、取得元の URL と一致することを見る。
 * 一致しないものを信じると、どこか別の Issuer の設定を自分の Issuer だと
 * 思い込む経路になる（Discovery のなりすまし）。ID Token 検証時にも
 * `issuer` を再確認するので、ここは早期に落とすための砦。
 */

export type DiscoveryDocument = {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
};

export type Jwks = { readonly keys: readonly unknown[] };

export async function fetchDiscovery(
  fetcher: typeof fetch,
  issuer: string,
): Promise<DiscoveryDocument> {
  const response = await fetcher(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new Error(`discovery の取得に失敗した (HTTP ${response.status})`);
  }
  const doc = (await response.json()) as Partial<DiscoveryDocument>;
  if (
    typeof doc.issuer !== "string" ||
    typeof doc.authorization_endpoint !== "string" ||
    typeof doc.token_endpoint !== "string" ||
    typeof doc.jwks_uri !== "string"
  ) {
    throw new Error("discovery 応答の形が違う");
  }
  if (doc.issuer !== issuer) {
    throw new Error(`discovery の issuer が一致しない: ${doc.issuer} != ${issuer}`);
  }
  return doc as DiscoveryDocument;
}

export async function fetchJwks(fetcher: typeof fetch, jwksUri: string): Promise<Jwks> {
  const response = await fetcher(jwksUri);
  if (!response.ok) {
    throw new Error(`jwks の取得に失敗した (HTTP ${response.status})`);
  }
  const jwks = (await response.json()) as Partial<Jwks>;
  if (!Array.isArray(jwks.keys)) throw new Error("jwks 応答の形が違う");
  return jwks as Jwks;
}
