import type { Context } from "hono";
import type { AppBindings } from "./types";

/**
 * 状態を変えるリクエストの Origin 検証（仕様書 9 CSRF）。
 *
 * 文字列の厳密一致はしない。`ISSUER` は OIDC の `iss` として使う値で、
 * 末尾スラッシュや大文字小文字の揺れが混ざりうる。そのまま比較すると、
 * 設定が 1 文字違うだけで更新系 API が全件 403 になる。
 * URL として解釈して origin 同士を比べる。
 *
 * Origin が無い場合は拒否する（fail-closed）。「無ければ通す」にすると、
 * ヘッダを落とせる経路があった時点で CSRF 対策が SameSite 頼みになる。
 */
export function isAllowedOrigin(c: Context<AppBindings>): boolean {
  const origin = c.req.header("Origin");
  if (origin === undefined) return false;

  const actual = parseOrigin(origin);
  if (actual === null) return false;

  return actual === parseOrigin(c.env.ISSUER);
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}
