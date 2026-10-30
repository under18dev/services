import { hc } from "hono/client";
import type { CardsApiType } from "../src/presentation/http/cards.routes";

/**
 * `hono/client` の型が**実際に効いている**ことを型検査で固定する（#338）。
 *
 * dashboard-worker の同名ファイルと同じ形。**チェーンを文で分けて書くと
 * `typeof` に何も積まれず、クライアントは空の型になる** —— 空でも補完が
 * 出ないだけで型検査は通るので、**存在しないパスに `@ts-expect-error` を
 * 付けて固定する。** 型が空（= 何でも許す）に戻ると、そこにエラーが
 * 出なくなり `@ts-expect-error` 自身が「抑制すべきエラーが無い」で落ちる。
 *
 * つまりこのファイルは、`pnpm typecheck` が通ることをもって
 * 「クライアントの型が空でない」ことを示している。vitest では実行しない
 * （`.test-d.ts` は `test/**​/*.test.ts` に当たらない）。
 *
 * **接頭辞はここに現れない。** `app.route(basePath, ...)` の `basePath` は
 * 実行時の値なので、型は `/account/nfc/cards` を含まない。島は base URL の
 * 側に付ける（`client/api-client.ts`）。
 */

const client = hc<CardsApiType>("http://localhost/account/nfc/cards");

// --- 実在するルートは引ける ---
void client.index.$get;
void client.index.$post;
void client.claim.$post;
void client[":cardId"].target.$put;
void client[":cardId"].disable.$post;
void client[":cardId"].release.$post;

// --- 実在しないルートは型エラーになる ---
// @ts-expect-error 存在しないパス。ここでエラーが出なくなったら、
// クライアントの型が空になっている（= ルートのチェーンが切れた）。
void client.nonexistent.$get;

// @ts-expect-error `target` は PUT だけ。POST は無い。
void client[":cardId"].target.$post;
