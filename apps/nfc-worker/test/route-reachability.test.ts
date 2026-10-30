import { describe, expect, it } from "vitest";
import { CARDS_BASE_PATH } from "../src/presentation/http/base-path";
import { CARDS_ISLAND_JS } from "../src/presentation/http/ui/generated/cards-island.bundle";
import { CARD_API_ROUTES } from "./route-inventory";

/**
 * **能力と入口を突き合わせる**（#324 の nfc 版、#338）。
 *
 * ## なぜ nfc にも要るのか
 *
 * dashboard-worker には #324 で入ったが、**あの検査はあちらの中に閉じて
 * いた。** その間 nfc の画面は 5 本の API を 1 本も叩けず、本番の画面が
 * 「`/account/nfc/cards` の API から操作してください」と案内していた ——
 * **#306（パスキーの登録 UI が無かった）と同じ形が、検査の外側で起きて
 * いた。** #211 と同じ家系で、**検査が自分の Worker の内側に閉じている。**
 *
 * ## dashboard 版との違い
 *
 * あちらは `.$delete` までチェーンに含めて照合する。**こちらは
 * メソッドを含めない** —— 島は `$url()` でパスだけを作り、本文は
 * `fetch` で送るからである（`cards.routes.ts` が validator を使わず
 * `c.req.json()` を手で読むので、`$put({ json })` が型に無い。理由は
 * `client/cards-island.ts`）。
 *
 * **その結果、同じパスに 2 つのメソッドがあると区別できない**
 * （`/` の GET と POST）。いまはどちらも島から呼んでいないので実害は
 * 無いが、**片方だけ実装したときに「もう片方も呼ばれている」と読める。**
 * そのときはメソッドまで見る形へ直すこと。
 */

/** `{ method, path }` から、出荷物に現れるはずのチェーンを組み立てる。 */
function chainFor(route: { readonly path: string }): string {
  const segments = route.path
    .replace(CARDS_BASE_PATH, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length === 0) return ".index";
  return segments
    .map((segment) => (segment.startsWith(":") ? `["${segment}"]` : `.${segment}`))
    .join("");
}

const key = (route: { readonly method: string; readonly path: string }): string =>
  `${route.method} ${route.path}`;

/**
 * **アイランドから呼ばれなくて当然の経路と、その理由。**
 *
 * dashboard の `NOT_CALLED_FROM_ISLAND` と同じ形。**新しい API を足すと、
 * 呼ぶ側を書くか、ここに理由を書くまで落ちる。**
 *
 * **4 本が「まだ」である。** 理由を書いて済ませられるのは承知のうえで、
 * 効くのは**判断を省略できなくする**ほうである —— 入口を作るときに
 * **理由の 1 行が差分から消える**のが手がかりになる。
 */
const NOT_CALLED_FROM_ISLAND: Readonly<Record<string, string>> = {
  "GET /account/nfc/cards": "一覧はサーバーが描く。画面は RPC ではなく use-case から直接読む",
  "POST /account/nfc/cards": "カードの発行は運営の操作（管理者のみ）。#338 Step 3",
  "POST /account/nfc/cards/claim": "紐づけ。#338 Step 2",
  "POST /account/nfc/cards/:cardId/disable":
    "無効化。片道の操作なので確認の導線が要る。#338 Step 2",
  "POST /account/nfc/cards/:cardId/release": "手放す。紐づけコードが 1 回しか返らない。#338 Step 2",
};

describe("API の経路に、利用者の入口があること", () => {
  const called = CARD_API_ROUTES.filter((route) => CARDS_ISLAND_JS.includes(chainFor(route)));
  const exempt = CARD_API_ROUTES.filter((route) => key(route) in NOT_CALLED_FROM_ISLAND);

  it("出荷物を実際に走査できている", () => {
    // **この検査が空振りしていないこと自体を先に固定する。** バンドルが
    // 空なら下のテストは「全部が例外」と読んで通ってしまう。
    expect(CARDS_ISLAND_JS.length).toBeGreaterThan(1000);
    expect(called.length).toBeGreaterThan(0);
  });

  it("すべての経路が、呼ばれているか理由を持つ", () => {
    const orphans = CARD_API_ROUTES.filter(
      (route) =>
        !CARDS_ISLAND_JS.includes(chainFor(route)) && !(key(route) in NOT_CALLED_FROM_ISLAND),
    ).map(key);

    expect(
      orphans,
      `${CARD_API_ROUTES.length} 本の経路を見た（呼ばれている: ${called.length} / 理由あり: ${exempt.length}）`,
    ).toEqual([]);
  });

  it("遷移先の変更は、島から呼ばれている", () => {
    // **理由の側に逃がせない 1 本。** #338 が入れたのはこれで、
    // ここが落ちたら島が繋がっていない。
    const target = CARD_API_ROUTES.find((route) => route.path.endsWith("/target"));

    expect(target).toBeDefined();
    expect(target && CARDS_ISLAND_JS.includes(chainFor(target))).toBe(true);
  });

  it("理由の側に、実在しない経路が残っていない", () => {
    // 逆向き。経路を消したのに理由が残ると、**次に同じパスを足した人が
    // 黙って免除される。**
    const known = CARD_API_ROUTES.map(key);
    const ghosts = Object.keys(NOT_CALLED_FROM_ISLAND).filter((name) => !known.includes(name));

    expect(ghosts).toEqual([]);
  });

  it("理由が書いてある", () => {
    const blank = Object.entries(NOT_CALLED_FROM_ISLAND)
      .filter(([, reason]) => reason.trim() === "")
      .map(([name]) => name);

    expect(blank).toEqual([]);
  });
});
