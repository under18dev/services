import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH } from "../src/presentation/http/app";

/**
 * `src/index.ts` を workerd に**実際にロードさせて**ディスパッチできることを確かめる。
 *
 * ## なぜ要るか
 *
 * #119 で `src/index.ts` は既定 export 1 行だけの薄い層になった。
 * `api.test.ts` は `createApp()` を直接 import して叩くので、
 * **テストスイート全体で `src/index.ts` を一度も通らない。**
 * エントリが壊れていても誰も気づかない状態になる。
 *
 * ## 何を捕まえるか（実測）
 *
 * 既定 export を `{}` に差し替えて測った:
 *
 * | | 結果 |
 * | --- | --- |
 * | `api.test.ts`（`createApp()` 直呼び、49 件） | **全件通過** |
 * | このファイル（`SELF`） | 落ちる（`Expected default export ... to define a `fetch()` function`） |
 *
 * **既定 export が正しいハンドラであることを見ているのは、ここだけ。**
 *
 * ## 何を捕まえないか（実測）
 *
 * **エントリモジュールの名前付き export は `SELF` でも捕まらない。**
 * `src/index.ts` に `export const TEMP_PROBE = "x"` を足して `SELF.fetch`
 * を通したが、**有り / 無しのどちらも通過した**。workerd が
 * `Incorrect type for map entry` で落ちるのは `wrangler dev` / deploy の
 * ときだけである。**ここを守る手段は現時点で無い**ので、`src/index.ts` の
 * コメントで注意喚起するに留めている。
 *
 * binding の解決失敗（#47 の `no such service is defined`）も、このテスト
 * 固有ではない。**pool 自体が起動できなくなるので全テストが落ちる。**
 * `--passWithNoTests` を外してある（#70）限り、そちらは他のテストでも
 * 気づける。
 */
describe("workerd がこの Worker を起動できる", () => {
  it("未知のパスに 404 を返す（= エントリと binding が解決できている）", async () => {
    // 本文ではなく「応答が返ること」を見ている。起動に失敗していれば
    // ステータス以前に fetch が失敗する。
    const response = await SELF.fetch("http://localhost/no-such-path");

    expect(response.status).toBe(404);
  });

  it("接頭辞付きのパスがルータに届く", async () => {
    // Cookie が無いので 401。404 なら basePath の配線が壊れている。
    const response = await SELF.fetch(`http://localhost${ACCOUNT_BASE_PATH}/api/me`);

    expect(response.status).toBe(401);
  });
});
