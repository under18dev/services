import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CARDS_BASE_PATH } from "../src/presentation/http/base-path";
import { createApp } from "../src/presentation/http/app";
import { createCardsClient } from "../src/presentation/http/ui/client/api-client";
import { ORIGIN, executionContext, identityWith } from "./helpers";

/**
 * **アイランドが実際に組み立てる URL が、ハンドラに届くこと**（#338）。
 *
 * dashboard-worker の同名ファイルと同じ形。あちらのコメントにあるとおり、
 * 型（`client-type.test-d.ts`）も一覧（`route-inventory.test.ts`）も
 * **`hc` がその型からどんな URL を作るか**は見ていない。
 *
 * ## nfc ではここが特に効く
 *
 * `CardsApiType` は**接頭辞を含まない**（`app.route(basePath, ...)` の
 * `basePath` は実行時の値なので型に現れない）。つまり接頭辞は
 * `createCardsClient()` の base URL 側で付ける —— **型が守ってくれない
 * 唯一の継ぎ目**である。
 *
 * 間違えると `/account/nfc/cards/account/nfc/cards/...` のような URL を
 * 作るが、**型も一覧も通り、ブラウザで 404 になって初めて分かる。**
 */

// **アイランドと同じ関数**を呼ぶ。ここで `hc<CardsApiType>(...)` と
// 書き直すと、検査しているのは「テストの中の組み立て方」になる。
const client = createCardsClient(ORIGIN, CARDS_BASE_PATH);

describe("アイランドが作る URL が、ハンドラに届く", () => {
  it("PUT /:cardId/target が 404 にならない", async () => {
    const url = client[":cardId"].target.$url({ param: { cardId: "demo_card" } });

    // 接頭辞が二重になっていないこと自体も見る。**URL の形が崩れていても、
    // 下の fetch が 404 にならない組み合わせはありうる。**
    expect(url.pathname).toBe(`${CARDS_BASE_PATH}/demo_card/target`);

    const response = await createApp({ identity: identityWith({}) }).fetch(
      new Request(url, {
        method: "PUT",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ targetUrl: "https://example.com/" }),
      }),
      env,
      executionContext(),
    );

    // **401 でよい。** 見たいのは「ハンドラに届いたか」であって、
    // 認可の結果ではない。404 なら届いていない。
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(401);
  });

  it("一覧のパターンと、作られる URL が対応している", () => {
    // `route-inventory.ts` は `/account/nfc/cards/:cardId/target` を持つ。
    // **パターンと実 URL の対応は、そこでも型でも見ていない。**
    const url = client[":cardId"].target.$url({ param: { cardId: "abc_123" } });
    const pattern = `${CARDS_BASE_PATH}/:cardId/target`;

    expect(url.pathname.replace(/\/[^/]+\/target$/, "/:cardId/target")).toBe(pattern);
  });
});
