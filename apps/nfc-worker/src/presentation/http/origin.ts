import type { Context } from "hono";
import type { AppBindings } from "./types";

/**
 * 状態を変えるリクエストの CSRF 対策（仕様書 9 CSRF）。
 *
 * ## なぜ `ISSUER` ではなくリクエスト URL の origin と比べるのか
 *
 * auth-worker の `isAllowedOrigin()` は `env.ISSUER` と比べている。
 * あちらは 1 つのホストでしか動かないからで、nfc-worker は違う。
 * この Worker は **2 つのホストに載る**（wrangler.jsonc を参照）:
 *
 *  - `go.under18.dev/c/*`            公開の短縮 URL。GET だけ。
 *  - `auth.under18.dev/account/nfc/*` 管理 API。セッション Cookie が要る。
 *
 * 固定値と比べると、どちらか一方で必ず誤判定になる。リクエスト URL の
 * origin と比べれば、管理 API を出しているホストと、そこへ埋め込まれた
 * 画面の origin が一致していることを確かめられる（dashboard-worker と同じ）。
 *
 * なお、管理 API が短縮 URL 側のホストに現れても安全側に倒れる。
 * セッション Cookie は `__Host-` 接頭辞で発行ホストにしか送られないため、
 * `go.under18.dev` へ来たリクエストは Cookie を持たず 401 になる
 * （`packages/contracts/src/session-cookie.ts`）。
 *
 * Origin が無い場合は拒否する（fail-closed）。「無ければ通す」にすると、
 * ヘッダを落とせる経路があった時点で CSRF 対策が SameSite 頼みになる。
 */
export function isAllowedOrigin(c: Context<AppBindings>): boolean {
  const origin = c.req.header("Origin");
  if (origin === undefined) return false;

  const actual = parseOrigin(origin);
  if (actual === null) return false;

  return actual === parseOrigin(c.req.url);
}

/**
 * JSON API であることを要求する。
 *
 * ## Origin 検証があるのに、なぜもう 1 枚要るのか
 *
 * auth-worker の `ui/csrf.ts` が書いている通り、Origin 検証の弱点は
 * 「ヘッダが付かない経路があると fail-closed 側に倒れて正規の利用者が
 * 詰まる」ことと、その裏返しで「ヘッダが付かない経路を許したくなる」ことにある。
 *
 * ここは HTML form を持たない純粋な JSON API なので、auth-worker の
 * double-submit トークンではなく、**単純リクエストで到達できないこと**を
 * 2 枚目の壁にする。クロスオリジンの `<form>` が送れる Content-Type は
 * `application/x-www-form-urlencoded` / `multipart/form-data` / `text/plain`
 * の 3 つだけで、`application/json` を指定した `fetch` は必ず preflight を
 * 伴う。つまりこの要求を満たせる時点で、ブラウザは CORS の許可を
 * 取りに来ている（この Worker は CORS 許可を返さない）。
 *
 * **HTML の form を足すときはこの方式が使えなくなる。** その場合は
 * `apps/auth-worker/src/presentation/http/ui/csrf.ts` の double-submit
 * トークンを持ってくること。
 */
export function isJsonRequest(c: Context<AppBindings>): boolean {
  const contentType = c.req.header("Content-Type");
  if (contentType === undefined) return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}
