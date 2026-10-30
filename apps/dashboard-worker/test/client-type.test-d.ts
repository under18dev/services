import type { Hono } from "hono";
import { hc } from "hono/client";
import type { DashboardAppType } from "../src/presentation/http/app";
import type { ApiRoutePath } from "./route-inventory";

/**
 * `hono/client` の型が**実際に効いている**ことを型検査で固定する。
 *
 * ## なぜ要るのか
 *
 * `hc<typeof app>` はチェーンの戻り値に積まれた型からパスを作る。ルートを
 * `app.get(...); app.get(...);` と**文を分けて**書くと `typeof` に何も
 * 積まれず、**クライアントは空の型になる**。
 *
 * **空でも補完が出ないだけで、型検査は通る。** 「使っているのに効いていない」
 * 形で、このリポジトリで繰り返している「宣言はあるが発動しない」の型版。
 *
 * ## どう固定しているか
 *
 * 存在しないパスに `@ts-expect-error` を付ける。**型が空（= 何でも許す）に
 * 戻ると、そこにエラーが出なくなり `@ts-expect-error` 自身が
 * 「抑制すべきエラーが無い」で落ちる。**
 *
 * つまりこのファイルは、`pnpm typecheck` が通ることをもって
 * 「クライアントの型が空でない」ことを示している。vitest では実行しない
 * （`.test-d.ts` は `test/**​/*.test.ts` に当たらない）。
 */

const client = hc<DashboardAppType>("http://localhost");

// --- 実在するルートは引ける ---
void client.account.api.me.$get;
void client.account.api.me.sessions[":id"].$delete;
void client.account.api.me.grants[":clientId"].$delete;
void client.account.api.me.passkeys[":id"].$delete;
void client.account.health.$get;
void client.account.api.me.$patch;

// **一覧の `$get` はここに並んでいた**（#321 で消した）。
// `GET .../sessions` / `.../passkeys` / `.../grants` は**呼ぶ側が 1 つも
// 無かった**ので経路ごと消してある。画面はサーバー側で RPC から描く。

// **本文の形は `hc` では縛られない**（実測）。`PATCH /api/me` は
// `zValidator` などの validator を通していないので、Hono のスキーマに
// 入力の型が積まれず、`$patch({ json: { 何でも } })` が通る。
// `{ isAdmin: true }` を渡しても型エラーにならないことを確かめたうえで
// ここには書いていない —— 書くと「抑制すべきエラーが無い」で落ちる。
//
// つまり `hc` が守ってくれるのは**パスとメソッドだけ**である。本文の検証は
// 引き続き auth-worker が正本で、dashboard のハンドラは形だけ見ている。

// --- 実在しないルートは型エラーになる ---
// @ts-expect-error 存在しないパス。ここでエラーが出なくなったら、
// クライアントの型が空になっている（= ルートのチェーンが切れた）。
void client.account.api.me.nonexistent.$get;

// @ts-expect-error GET しかないパスに POST は無い。
void client.account.api.me.sessions.$post;

/* ------------------------------------------------------------------ *
 * 一覧との突き合わせ（#188 のレビュー指摘）
 *
 * 上の `@ts-expect-error` が守るのは「ここに列挙した分が消えないこと」
 * だけで、**以後に足すルートがチェーンに乗ることは守れない。** 新しい
 * ルートを文で分けて書いても既存の型は残るので、上は全部通ってしまう。
 *
 * そこで `test/route-inventory.ts` の一覧と**パスの集合そのもの**を
 * 突き合わせる。一覧の更新は実行時の `route-inventory.test.ts` が
 * 強制するので、
 *
 *   - 一覧に足した & チェーンに乗せた  -> 両方通る
 *   - 一覧に足した & チェーンの外に書いた -> **ここが落ちる**
 *   - 一覧に足していない              -> 実行時のほうが落ちる
 *
 * となり、どの書き方でも素通りしない。
 * ------------------------------------------------------------------ */

/**
 * `DashboardAppType` に積まれたパスの union。
 *
 * 比べる相手は `API_ROUTES` だけ（`PAGE_ROUTES` ではない）。画面は
 * チェーンに乗せない決まりなので、**ここに画面が出てきたらそれ自体が誤り**
 * であり、この比較が止める。
 */
type ChainedPath =
  DashboardAppType extends Hono<infer _E, infer S, infer _P> ? keyof S & string : never;

/** 両向きの包含を見る。片側だけだと、増えたときか減ったときのどちらかを見逃す。 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// `false` になったら代入できずに落ちる。**どちらの向きにずれても落ちる。**
export const chainCoversInventory: Equals<ChainedPath, ApiRoutePath> = true;
