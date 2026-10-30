import { describe, expect, it } from "vitest";
import { ACCOUNT_ISLAND_JS } from "../src/presentation/http/ui/generated/account-island.bundle";
import { API_ROUTES } from "./route-inventory";

/**
 * **能力と入口を突き合わせる**（#322）。
 *
 * ## なぜ要るのか
 *
 * 2026-10-29 に同じ形の欠陥が 2 件出た。
 *
 * | | 欠けていたもの |
 * | --- | --- |
 * | #306 | パスキーの登録 API はあるのに、**呼ぶ UI がどこにも無かった** |
 * | #312 | `PATCH /api/me` はあるのに、**アイランドが呼んでいなかった** |
 *
 * **どちらも「壊れている」ようには見えない。** ルートは登録され、テストは
 * 通り、型も合う。**利用者から見ると機能が存在しないだけ**である。#306 では
 * 本番の `passkeys` が 0 件であることを全員が「まだ誰も登録していない」と
 * 読んでいたが、実際は**登録できなかった。**
 *
 * `route-inventory.test.ts` は「一覧とルートが一致するか」を見る。
 * `client-type.test-d.ts` は「クライアントの型に乗っているか」を見る。
 * **どちらも『呼ばれているか』は見ていない。**
 *
 * ## 何を見るか
 *
 * **出荷されたバンドルの中身**を見る。ソースを見ると、import されていない
 * モジュールに書かれた呼び出しも「ある」と数えてしまう —— **検査が
 * 空振りする形がちょうどそれ**なので、`esbuild` が畳んだ後の文字列で確かめる。
 *
 * `hono/client` のチェーンはプロパティ名でパスを表すので、
 * `DELETE /account/api/me/sessions/:id` は `.api.me.sessions[":id"].$delete`
 * として出荷物に現れる。**照合に使う文字列は一覧から組み立てる**ので、
 * パスを変えると照合も付いてくる（手で書くと片方だけ直る）。
 *
 * ## 粗い検査である
 *
 * 文字列照合なので、「呼ばれているが押せない場所にある」までは見ない。
 * **それでも 2026-10-29 の 2 件はどちらも捕まる。**
 */

/** `{ method, path }` から、出荷物に現れるはずのチェーンを組み立てる。 */
function chainFor(route: { readonly method: string; readonly path: string }): string {
  const segments = route.path
    .replace(/^\/account/, "")
    .split("/")
    .filter((segment) => segment !== "");
  const chain = segments
    .map((segment) => (segment.startsWith(":") ? `["${segment}"]` : `.${segment}`))
    .join("");
  return `${chain}.$${route.method.toLowerCase()}`;
}

const key = (route: { readonly method: string; readonly path: string }): string =>
  `${route.method} ${route.path}`;

/**
 * **アイランドから呼ばれなくて当然の経路と、その理由。**
 *
 * `NEVER_SWEPT`（`retention-policy.ts`、#301）と同じ形にしてある ——
 * **値は人が読むための理由で、機械が使うのはキーが揃っていることのほう。**
 * 新しい API を足すと、呼ぶ側を書くか、ここに理由を書くまで落ちる。
 *
 * **これで防げるのは「入口を書き忘れること」だけである。** 理由を書いて
 * 済ませることは止められない —— 効くのは**判断を省略できなくする**ほうで、
 * 入口を作るときに**理由の 1 行が差分から消える**のが手がかりになる。
 */
const NOT_CALLED_FROM_ISLAND: Readonly<Record<string, string>> = {
  "GET /account/health": "監視が叩く経路。利用者の入口ではない",
  "GET /account/api/me":
    "デプロイ後のスモークが Cookie 無しで 401 を確かめる経路（deploy.yml）。画面はサーバー側で RPC から描く",
  // **一覧の取得はここに並んでいた。** 呼ぶ側が 1 つも無かったので
  // #321 で消した。理由は `route-inventory.ts` に残してある。
};

describe("API の経路に、利用者の入口があること", () => {
  const called = API_ROUTES.filter((route) => ACCOUNT_ISLAND_JS.includes(chainFor(route)));
  const exempt = API_ROUTES.filter((route) => key(route) in NOT_CALLED_FROM_ISLAND);

  it("出荷物を実際に走査できている", () => {
    // **この検査が空振りしていないこと自体を先に固定する。** バンドルが
    // 空なら下のテストは「全部が例外」と読んで通ってしまう。
    expect(ACCOUNT_ISLAND_JS.length).toBeGreaterThan(1000);
    expect(called.length).toBeGreaterThan(0);
  });

  it("すべての経路が、呼ばれているか理由を持つ", () => {
    const orphans = API_ROUTES.filter(
      (route) =>
        !ACCOUNT_ISLAND_JS.includes(chainFor(route)) && !(key(route) in NOT_CALLED_FROM_ISLAND),
    ).map(key);

    expect(
      orphans,
      `${API_ROUTES.length} 本の経路を見た（呼ばれている: ${called.length} / 理由あり: ${exempt.length}）。入口も理由も無いもの: ${orphans.join(", ") || "なし"}`,
    ).toEqual([]);
  });

  it("理由の側に、実在しない経路が残っていない", () => {
    // 逆向き。経路を消したのに理由が残ると、**次に同じパスを足した人が
    // 黙って免除される。**
    const known = API_ROUTES.map(key);
    const ghosts = Object.keys(NOT_CALLED_FROM_ISLAND).filter((name) => !known.includes(name));

    expect(ghosts).toEqual([]);
  });

  it("理由が書いてある", () => {
    const blank = Object.entries(NOT_CALLED_FROM_ISLAND)
      .filter(([, reason]) => reason.trim() === "")
      .map(([name]) => name);

    expect(blank).toEqual([]);
  });

  it("書き込みの経路は、すべて入口を持つ", () => {
    // **理由で免除されているのは GET だけであること。** 状態を変える経路に
    // 入口が無いのは #306 / #312 そのものなので、こちらは例外を許さない。
    const writes = API_ROUTES.filter((route) => route.method !== "GET");
    const unreachable = writes.filter((route) => !ACCOUNT_ISLAND_JS.includes(chainFor(route)));

    expect(unreachable.map(key), `${writes.length} 本の書き込み経路を見た`).toEqual([]);
  });
});
