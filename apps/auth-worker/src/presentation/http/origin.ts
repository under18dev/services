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

  // **`Origin: null` を「同一オリジン」の証拠として `Sec-Fetch-Site` で救う。**
  //
  // Fetch 仕様では、referrer policy が参照元を落とすとき**ナビゲーション
  // 要求の `Origin` も `null` になる**。自分のページから出した form 送信が
  // `Origin: null` で届き、`new URL("null")` が投げて拒否される。
  // 本番で JS 無しの form 経路が全滅していた（ログイン・新規登録・ログアウト）。
  //
  // `Referrer-Policy` は `same-origin` に直したが、**それだけに頼らない。**
  // 参照元の扱いは将来また変わりうるし、利用者側の設定でも変わる。
  //
  // `Sec-Fetch-Site` は**禁止ヘッダ名**でスクリプトから書けない。値が
  // `same-origin` なら、ブラウザ自身が「この要求は自分のオリジンから出た」
  // と言っている。クロスサイトの攻撃者が送らせた form は `cross-site` に
  // なるので通らない。**`Origin` が読めたときはそちらを優先する**ので、
  // 判定が緩むのは `null` の場合だけである。
  if (origin === "null" && c.req.header("Sec-Fetch-Site") === "same-origin") return true;

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
