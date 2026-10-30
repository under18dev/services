/**
 * 認可コードをトークンへ交換する（RFC 6749 §4.1.3 / RFC 7636 §4.5）。
 *
 * `fetcher` を注入できる形は `discovery.ts` と同じ理由。
 */

export type TokenResponse = {
  readonly idToken: string;
  /**
   * **1 度だけ検証に使って捨てる値**（d5 の delegated session 設計、#390）。
   * admin-worker はこれを Cookie にも何にも保存しない——`/callback` の中で
   * 「IdentityAdminRPC へ渡して delegated session を 1 本発行してもらう」
   * ためだけに使い、そのスコープを出た時点で参照を持たない。
   */
  readonly accessToken: string;
};

export async function exchangeAuthorizationCode(params: {
  readonly fetcher: typeof fetch;
  readonly tokenEndpoint: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  /** confidential クライアントのみ。public（secret 無し）なら undefined。 */
  readonly clientSecret: string | undefined;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: params.clientId,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (params.clientSecret !== undefined) {
    // **client_secret_basic を使う。** `client_secret_post`（本文に載せる）
    // も IdP は受け付けるが、Basic のほうがログや中間プロキシの本文に
    // 秘密が残りにくい（ヘッダも残りうるが、本文より扱いの規律が強い）。
    headers.Authorization = `Basic ${btoa(`${params.clientId}:${params.clientSecret}`)}`;
  }

  const response = await params.fetcher(params.tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    // **本文は出す。IdP のエラーは `error` / `error_description` の形で、
    // 秘密を含まない**（RFC 6749 §5.2）。ここで握り潰すと、#379 と同じ形で
    // 原因が消える。
    const detail = await response.text().catch(() => "");
    throw new Error(`token 交換に失敗した (HTTP ${response.status}): ${detail}`);
  }

  const json = (await response.json()) as { id_token?: unknown; access_token?: unknown };
  if (typeof json.id_token !== "string" || json.id_token === "") {
    throw new Error("token 応答に id_token が無い");
  }
  if (typeof json.access_token !== "string" || json.access_token === "") {
    throw new Error("token 応答に access_token が無い");
  }
  return { idToken: json.id_token, accessToken: json.access_token };
}
