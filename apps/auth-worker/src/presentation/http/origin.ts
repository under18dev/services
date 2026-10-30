import { isTrustedOrigin } from "@u18/web-ui";
import type { Context } from "hono";
import type { AppBindings } from "./types";

/**
 * 状態を変えるリクエストの Origin 検証（仕様書 9 CSRF）。
 *
 * **判定そのものは `@u18/web-ui` の `isTrustedOrigin` にある。** ここは
 * `Context` からヘッダと `ISSUER` を取り出すだけの adapter である。
 * dashboard-worker の form 経路が同じ判定を使うので、**2 つ目の形を
 * 作らないために共有側へ出した**（理由はあちらの JSDoc）。
 *
 * `Origin: null` を `Sec-Fetch-Site` で救う手当て（#226 で本番のログインが
 * 全滅した件）も、比較を厳密一致にしない理由も、共有側に書いてある。
 */
export function isAllowedOrigin(c: Context<AppBindings>): boolean {
  return isTrustedOrigin(c.req.header("Origin"), c.req.header("Sec-Fetch-Site"), c.env.ISSUER);
}
