import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CARDS_UI_PATH, createApp } from "../src/presentation/http/app";
import { CARDS_ISLAND_JS } from "../src/presentation/http/ui/generated/cards-island.bundle";
import {
  ACTION_STATUS,
  ACTIONS_ROW,
  CARD_ID,
  DISABLE_BUTTON,
  RELEASE_BUTTON,
  TARGET_FORM,
  TARGET_INPUT,
  TARGET_SAVE,
  TARGET_STATUS,
} from "../src/presentation/http/ui/island-hooks";
import { ISLAND_PATH } from "../src/presentation/http/ui/asset-paths";
import {
  ORIGIN,
  cookieFor,
  executionContext,
  identityWith,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
} from "./helpers";

/**
 * **サーバーが実際に描いた HTML を、島が引けること**（#338）。
 *
 * ## 定数を共有するだけでは片方しか守れない
 *
 * 目印を `island-hooks.ts` の定数にしたので、**名前の食い違い**は消えた。
 * **だが「サーバーがその要素を描き忘れる」ほうは定数では防げない**
 * （d1 の指摘）。同じ名前を見ていても、出力に無ければ島は何も見つけられず、
 * `querySelector` が `null` を返すだけで**例外も出ない。**
 *
 * エラーは出ず、操作だけが黙って効かなくなる —— `?.` で繋いだ島が
 * 一致しなくなっても静かに死ぬ、という #341 と同じ形である。
 *
 * **だから実際に描いて引く。**
 */

const TARO = "token-taro-0123456789abcdefghijklmn";
const identity = identityWith({ [TARO]: "usr_taro" });

async function html(cookie: string): Promise<string> {
  const response = await createApp({ identity }).fetch(
    new Request(`${ORIGIN}${CARDS_UI_PATH}`, { headers: { Cookie: cookie } }),
    env,
    executionContext(),
  );
  return await response.text();
}

beforeEach(resetDatabase);

describe("島が掴む目印を、サーバーが実際に描いている", () => {
  it("active のカードに 5 つとも出る", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const page = await html(cookieFor(TARO));

    for (const hook of [
      TARGET_FORM,
      CARD_ID,
      TARGET_INPUT,
      TARGET_SAVE,
      TARGET_STATUS,
      // 片道の操作（#382）。**同じ表に足す** —— 別の検査にすると、
      // 片方だけが「島は引くがサーバーが描いていない」に落ちうる。
      ACTIONS_ROW,
      DISABLE_BUTTON,
      RELEASE_BUTTON,
      ACTION_STATUS,
    ]) {
      expect(page, `${hook} が出ていない`).toContain(hook);
    }
    // **カード ID が実際に載っていること。** 属性だけ出て中身が空だと、
    // 島は URL を組み立てられない。
    expect(page).toContain(`${CARD_ID}="${cardId}"`);
  });

  it("島を読み込む <script> が出ている", async () => {
    await seedActiveCard("usr_taro");

    const page = await html(cookieFor(TARO));

    // **配信している URL と同じもの**であること。ハッシュがずれると 404。
    expect(page).toContain(ISLAND_PATH);
    expect(page).toContain("<script");
  });

  it("島が引くセレクタが、出力に実在する", async () => {
    // **両端を突き合わせる。** 島のバンドルに出ている目印の名前が、
    // サーバーの出力にも在ること。片方を改名したらここで落ちる。
    await seedActiveCard("usr_taro");

    const page = await html(cookieFor(TARO));
    const inIsland = [
      TARGET_FORM,
      TARGET_INPUT,
      TARGET_SAVE,
      TARGET_STATUS,
      ACTIONS_ROW,
      DISABLE_BUTTON,
      RELEASE_BUTTON,
      ACTION_STATUS,
    ].filter((hook) => CARDS_ISLAND_JS.includes(hook));

    expect(inIsland.length, "島のバンドルに目印が 1 つも出ていない").toBeGreaterThan(0);
    for (const hook of inIsland) {
      expect(page, `島は ${hook} を引くが、サーバーが描いていない`).toContain(hook);
    }
  });

  it("issued のカードには操作を出さない", async () => {
    // **出しても必ず失敗する入口を描かない。** `issued` はまだ
    // 誰のものでもなく、所有者の一覧には出ない（既存の検査）。
    await seedIssuedCard();

    const page = await html(cookieFor(TARO));

    expect(page).not.toContain(TARGET_FORM);
  });

  it("JS が無いときに、何ができないかを言う", async () => {
    await seedActiveCard("usr_taro");

    const page = await html(cookieFor(TARO));

    expect(page).toContain("<noscript>");
    // **一覧は読めることまで言う。** 「JavaScript が必要です」だけだと、
    // 画面全体が使えないように読める。
    expect(page).toContain("一覧の表示には要りません");
  });
});
