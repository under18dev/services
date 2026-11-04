import { isTrustedOrigin } from "@u18/web-ui";
import type { Context } from "hono";
import type { AppBindings } from "./types";

/**
 * 機械向け JSON API の門番（#461、`nfc-worker` の同名ファイルと同じ考え方）。
 *
 * ## form 用の CSRF（`csrf.ts`）とは別に置く理由
 *
 * この Worker で初めての「HTML form を持たない JSON API」である。
 * double-submit トークンは form が要る（hidden に埋める・Cookie と
 * 突き合わせる）ので、`scripts/nfc-burn.py` のような機械向けの経路には
 * 向かない——**単純リクエストで到達できないこと**を壁にする
 * （`isJsonRequest` を参照）。
 *
 * ## `Sec-Fetch-Site` の救済を使わない
 *
 * `isValidCsrf`（`csrf.ts`）は `Origin: null` を `Sec-Fetch-Site:
 * same-origin` で救うが、ここでは渡さない。**この JSON API には対応する
 * HTML form が無い**——`fetch` の POST にブラウザは必ず `Origin` を
 * 付けるので、ここで `Origin` が無いのは正規の経路ではない
 * （`@u18/web-ui` の `isTrustedOrigin` JSDoc 「緩める理由が無いところを
 * 緩めない」と同じ判断、dashboard-worker の JSON API と同じ扱い）。
 *
 * ## 比較する相手を `env.ADMIN_ORIGIN` にしていない
 *
 * `csrf.ts` の `isValidCsrf` と揃え、**リクエスト URL 自身の origin**と
 * 比べる。固定値と比べると、ローカル開発（`http://localhost:8790`）と
 * 本番（`https://admin.under18.dev`）のどちらかで必ず誤判定になる
 * （nfc-worker の `origin.ts` が複数ホストについて書いている理由と同じ）。
 */
export function isAllowedOrigin(c: Context<AppBindings>): boolean {
  return isTrustedOrigin(c.req.header("Origin"), undefined, new URL(c.req.url).origin);
}

/**
 * JSON API であることを要求する。
 *
 * **Origin 検証だけでは足りない。** 理由は nfc-worker の `origin.ts` の
 * 同名関数の JSDoc を参照——クロスオリジンの `<form>` が送れる
 * `Content-Type` は 3 つだけで、どれも `application/json` ではない。
 */
export function isJsonRequest(c: Context<AppBindings>): boolean {
  const contentType = c.req.header("Content-Type");
  if (contentType === undefined) return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * セッションガード（`app.ts`）が、未認証・未承認を JSON で答えるべきかの
 * 判定（#461 レビュー）。
 *
 * ## なぜ要るのか
 *
 * ガードは既定で `/login` / `/pending` への **302** を返す——ブラウザの
 * 画面遷移としては正しいが、`scripts/nfc-burn.py` のような機械が
 * `POST /nfc/cards` を未認証で叩くと、`urllib` が既定で 302 を追い、
 * **`/login` の HTML を 200 で受け取ってしまう。** JSON を期待している
 * 側からは「何が起きたか分からない」失敗になる——運用者は Cookie を
 * 手で用意する手順上、**最初の数回は必ずここを踏む。**
 *
 * **`Content-Type: application/json` だけでなく `Accept: application/json`
 * も見る。** 発行 API（`POST /nfc/cards`）は前者で判定できるが、将来
 * 同じガード配下に GET の JSON API が増えたときは Content-Type が無い
 * （body が無い）ので、どちらか一方で拾えるようにしておく。
 */
export function wantsJsonResponse(c: Context<AppBindings>): boolean {
  if (isJsonRequest(c)) return true;
  const accept = c.req.header("Accept");
  return accept !== undefined && accept.toLowerCase().includes("application/json");
}
