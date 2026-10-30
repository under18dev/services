import { describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";

/**
 * **登録されるルートの並びを丸ごと固定する**（#338）。
 *
 * ## なぜ順序なのか
 *
 * `route-inventory.test.ts` は**集合**を見ている（一覧と実行時が一致するか）。
 * **順序は見ていない。**
 *
 * ところが Hono はルートの登録順が一致判定に効く。`cards.routes.ts` を
 * 1 本のチェーンへ繋ぎ替えたとき、**並べ替えても集合は変わらない**ので、
 * あちらは緑のままになる。並びが変わると**認可の掛かり方が静かに変わりうる**
 * —— `ALL /account/nfc/cards/*` の門番（Origin / Content-Type）がどの位置に
 * 居るかは、まさに順序の問題である。
 *
 * **この検査は「変わっていないこと」しか言わない。** 意図して順序を変える
 * ときは、ここを一緒に直したうえで**なぜ安全か**を書くこと。黙って並べ替えて
 * ここだけ合わせると、検査が何も守らなくなる。
 */
describe("ルートの登録順", () => {
  /** アセットの URL には内容ハッシュが入る（#211）。16 進 16 文字を伏せる。 */
  const normalize = (path: string): string => path.replace(/\.[0-9a-f]{16}\./g, ".<hash>.");

  it("並びが変わっていない", () => {
    const actual = createApp().routes.map((route) => `${route.method} ${normalize(route.path)}`);

    expect(actual).toEqual([
      // `secureHeaders()` と container の注入（app.ts）。
      "ALL /*",
      "ALL /*",
      "GET /health",
      "GET /c/:cardId",
      // **状態を変える操作の門番。** 下の 5 本より前に居ること自体が守り。
      "ALL /account/nfc/cards/*",
      "POST /account/nfc/cards",
      "GET /account/nfc/cards",
      "POST /account/nfc/cards/claim",
      "PUT /account/nfc/cards/:cardId/target",
      "POST /account/nfc/cards/:cardId/disable",
      "POST /account/nfc/cards/:cardId/release",
      "GET /account/nfc/ui/kiwa.<hash>.css",
      // 遷移先の変更のアイランド（#338）。**画面より前に居る。**
      // 公開アセットなので順序に守りの意味は無いが、変わったら気づく。
      "GET /account/nfc/ui/cards-island.<hash>.js",
      // 画面は 2 回出る（`pageSecurityHeaders` とハンドラ）。
      "GET /account/nfc",
      "GET /account/nfc",
      // 紐づけ画面（#358）。**画面より後ろに居る。** `/account/nfc` と
      // `/account/nfc/claim` は別パスなので順序に守りの意味は無いが、
      // 変わったら気づく。POST はこの Worker で唯一の form 送信。
      "GET /account/nfc/claim",
      "GET /account/nfc/claim",
      "POST /account/nfc/claim",
      "POST /account/nfc/claim",
    ]);
  });

  it("門番が、状態を変える 5 本より前に居る", () => {
    // **上の一覧は「変わっていないこと」しか言わない。** 変えるときに
    // 何を守るべきかを、別に書いておく。
    const paths = createApp().routes.map((route) => `${route.method} ${route.path}`);
    const guard = paths.indexOf("ALL /account/nfc/cards/*");
    const writes = paths
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => /^(POST|PUT|DELETE) \/account\/nfc\/cards/.test(entry));

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(writes.length, "状態を変える経路が見つからない").toBeGreaterThan(0);
    for (const { entry, index } of writes) {
      expect(index, `${entry} が門番より前にある`).toBeGreaterThan(guard);
    }
  });
});
