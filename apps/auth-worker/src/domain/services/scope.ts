/**
 * OIDC scope の取り扱い（仕様書 5.1）。
 *
 * MVP が扱うのは openid / profile / email のみ。未知の scope は黙って
 * 無視せず拒否する —— 無視すると、クライアントが得たつもりの権限と
 * 実際に出る claim がずれる。
 */
export const SUPPORTED_SCOPES = ["openid", "profile", "email"] as const;

export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

const SUPPORTED = new Set<string>(SUPPORTED_SCOPES);

export function parseScope(raw: string): string[] {
  return raw.split(/\s+/).filter((s) => s.length > 0);
}

export function formatScope(scopes: readonly string[]): string {
  return [...new Set(scopes)].join(" ");
}

export function isSupportedScope(scope: string): scope is SupportedScope {
  return SUPPORTED.has(scope);
}

/** 要求 scope のうち、サポート外のものを返す。空配列なら全て妥当。 */
export function unsupportedScopes(requested: readonly string[]): string[] {
  return requested.filter((s) => !SUPPORTED.has(s));
}

/** 要求 scope のうち、クライアントに許可されていないものを返す。 */
export function disallowedScopes(
  requested: readonly string[],
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  return requested.filter((s) => !allowedSet.has(s));
}

/** scope に応じて claim を絞る。openid だけなら sub のみ返す。 */
export function filterClaimsByScope(
  claims: Record<string, unknown>,
  scopes: readonly string[],
): Record<string, unknown> {
  const granted = new Set(scopes);
  const result: Record<string, unknown> = { sub: claims["sub"] };

  if (granted.has("profile")) {
    result["preferred_username"] = claims["preferred_username"];
    result["name"] = claims["name"];
    result["updated_at"] = claims["updated_at"];
  }
  if (granted.has("email")) {
    result["email"] = claims["email"];
    result["email_verified"] = claims["email_verified"];
  }
  return result;
}
