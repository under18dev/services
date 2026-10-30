/**
 * 認可エンドポイントへの URL を組み立てる（RFC 6749 §4.1.1 / OIDC Core §3.1.2.1）。
 *
 * PKCE（state / nonce / code_challenge）を**全部載せる**。u18 Identity は
 * S256 の PKCE を必須にしている（§14.1 decision 9）ので、無いと認可要求
 * そのものが弾かれる。
 */
export function buildAuthorizationUrl(params: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
