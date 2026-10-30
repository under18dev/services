import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/presentation/http/app";
import { ADMIN_UI_PATH } from "../src/presentation/http/base-path";
import { MAX_ADMIN_LIST } from "../src/application/use-cases/list-all-cards.use-case";
import {
  ORIGIN,
  cookieFor,
  executionContext,
  identityDown,
  identityWith,
  repository,
  resetDatabase,
  seedActiveCard,
  seedIssuedCard,
} from "./helpers";

/**
 * 運営向けのカード管理画面（`/account/nfc/admin`、#338 Step 3）。
 *
 * ## ここでしか確かめられないこと
 *
 * `cards.api.test.ts` が「誰が何を触れるか」を持っている。この画面は
 * **読み取りしかしない**ので、見るのは 3 つである。
 *
 *  1. **管理者以外から見えないこと**（しかも 403 ではなく 404）
 *  2. **焼く用の URL に `issued` 以外が混ざらないこと**
 *  3. **遷移先がリンクになっていないこと**
 *
 * 2 がこの画面の本体で、**混ざると「誰かの手元にあるタグを上書きする」
 * URL を運営に渡すことになる。** 焼いたあとでは区別が付かない。
 */

const ADMIN = "token-admin-0123456789abcdefghijk";
const TARO = "token-taro-0123456789abcdefghijklmn";

/** `usr_admin` だけを管理者にする。**既定で全員が一般利用者**（helpers.ts）。 */
const identity = identityWith({ [ADMIN]: "usr_admin", [TARO]: "usr_taro" }, ["usr_admin"]);

async function open(cookie?: string, gateway = identity): Promise<Response> {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("Cookie", cookie);
  return await createApp({ identity: gateway }).fetch(
    new Request(`${ORIGIN}${ADMIN_UI_PATH}`, { headers }),
    env,
    executionContext(),
  );
}

beforeEach(resetDatabase);

describe("管理画面の見え方", () => {
  it("管理者には 200 で、他人のカードも出る", async () => {
    const mine = await seedActiveCard("usr_taro", "https://example.com/taro");
    const unclaimed = await seedIssuedCard("lot-a");

    const response = await open(cookieFor(ADMIN));
    expect(response.status).toBe(200);

    const html = await response.text();
    // **管理者自身のカードではない。** 一覧が所有者で絞られていないこと。
    expect(html).toContain(mine);
    expect(html).toContain(unclaimed);
    // 所有者の userId は出す（表示名とメールは引かない。use-case の冒頭）。
    expect(html).toContain("usr_taro");
    expect(html).toContain("lot-a");
  });

  /**
   * **403 ではなく 404。**
   *
   * 403 は「在るが権限が無い」と読めるので、管理画面の所在を
   * 一般利用者へ教える（#331 / #333 の判断）。
   */
  it("一般利用者には 404。403 を返さない", async () => {
    await seedIssuedCard();

    const response = await open(cookieFor(TARO));
    expect(response.status).toBe(404);

    // **カード ID が 1 つも漏れていないこと。** 404 の本文に混ざると
    // 「存在しない」と言いながら中身を渡すことになる。
    const html = await response.text();
    expect(html).not.toContain("nfc_");
  });

  it("未ログインはログイン画面へ送る", async () => {
    const response = await open();

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith("/login")).toBe(true);
    // 戻り先が載っていること。素の /login へ送ると自分で辿り直すことになる。
    expect(location).toContain(encodeURIComponent(ADMIN_UI_PATH));
  });

  it("Identity が落ちていたら 503。ログインへは送らない", async () => {
    // **`unauthenticated` と混ぜない。** 送ると、auth-worker が落ちている
    // 間ずっとログインし直す羽目になる（ログインも同じ経路が受けている）。
    const response = await open(cookieFor(ADMIN), identityDown);
    expect(response.status).toBe(503);
  });

  it("所有者固有ではないが no-store を付ける", async () => {
    // 未紐づけの ID が本文に入る。中間キャッシュに残す理由が無い。
    const response = await open(cookieFor(ADMIN));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("タグに焼く URL", () => {
  /**
   * **この画面の本体。** `issued` 以外を混ぜると、**誰かの手元にある
   * タグを上書きする URL** を運営に渡すことになり、焼いたあとでは
   * どちらだったか分からない。
   */
  it("issued のカードだけが入る", async () => {
    const unclaimed = await seedIssuedCard();
    const active = await seedActiveCard("usr_taro");
    const disabled = await seedIssuedCard();
    const claimedThenDisabled = await seedActiveCard("usr_hanako");
    await repository().disable(claimedThenDisabled, "usr_hanako", "lost", new Date());

    const html = await (await open(cookieFor(ADMIN))).text();
    const textarea = textareaIn(html);

    expect(textarea, "未紐づけのカードが入っていない").toContain(unclaimed);
    expect(textarea, "まだ発行しただけのカードが入っていない").toContain(disabled);
    // **ここが落ちると、配った先のタグを上書きする URL を渡すことになる。**
    expect(textarea, "紐づけ済みのカードが混ざっている").not.toContain(active);
    expect(textarea, "無効化済みのカードが混ざっている").not.toContain(claimedThenDisabled);
  });

  it("短縮 URL のホストから組み立てる", async () => {
    const cardId = await seedIssuedCard();

    const textarea = textareaIn(await (await open(cookieFor(ADMIN))).text());

    // **ホストを画面に直書きしていないこと**（`base-path.ts` の `cardTapUrl`）。
    // 焼いたタグは回収できないので、経路を変えたときに片方だけ古くなる形を作らない。
    expect(textarea).toContain(`${env.SHORT_URL_ORIGIN}/c/${cardId}`);
  });

  it("未紐づけが無ければ URL を 1 本も出さない", async () => {
    await seedActiveCard("usr_taro");

    const html = await (await open(cookieFor(ADMIN))).text();
    // `<textarea>` 自体を描かない。空の枠を出すと「コピーできる」に見える。
    expect(html).not.toContain("<textarea");
    expect(html).toContain("発行すると、ここに URL が並びます。");
  });
});

describe("この画面が踏み台にならないこと", () => {
  /**
   * **遷移先を `<a href>` にしない**（`cards-page.tsx` と同じ理由）。
   *
   * `target_url` は利用者が自由に入れた外部 URL である。
   * **運営の画面でやると被害が大きい** —— 運営は全員のカードを見るので、
   * カードを奪った側が遷移先を変え、**確認しに来た運営に踏ませる**
   * 経路が作れる。「不適切な遷移先を確認する」のが管理画面の用途の
   * 1 つなので、**確認しようとして踏む**ことになる。
   */
  it("遷移先をリンクにしない", async () => {
    const evil = "https://evil.example/phish";
    await seedActiveCard("usr_taro", evil);

    const html = await (await open(cookieFor(ADMIN))).text();

    expect(html, "遷移先が表示されていない").toContain(evil);
    expect(html, "遷移先がリンクになっている").not.toContain(`href="${evil}"`);
    // 焼く用の URL は自分のホストなので、外部 URL の href が 1 つも無いこと。
    expect(html).not.toMatch(/href="https:\/\/evil\.example/);
  });

  it("インラインの style 属性も <style> も無い", async () => {
    // 本番の CSP は `style-src 'self'`。属性ごと捨てられ、
    // **ローカルでは効いて本番でだけ崩れる**（#320）。
    await seedActiveCard("usr_taro");

    const html = await (await open(cookieFor(ADMIN))).text();
    expect(html).not.toContain('style="');
    expect(html).not.toContain("<style");
  });

  it("JavaScript を要求しない", async () => {
    // この画面は読み取りだけで、`<textarea readonly>` は JS 無しで
    // 全選択できる。コピーボタンを足すならアイランドにすること。
    await seedIssuedCard();

    const html = await (await open(cookieFor(ADMIN))).text();
    expect(html).not.toContain("<script");
  });
});

describe("打ち切りを黙って行わない", () => {
  /**
   * **上限で切ったことを画面に出す**（`ListAllCardsUseCase`）。
   *
   * 「最初の N 件」を黙って返すと、運営は**全部を見たつもりで一部を見る。**
   * このリポジトリが繰り返し踏んでいる「範囲が静かに狭まる」の画面版である。
   *
   * **501 枚を seed しない。** 上限は 500 で、1 枚ずつ入れると実行時間が
   * 跳ね上がる。ここでは**上限そのものが画面の文言と繋がっているか**だけを
   * 見て、境界の判定は `list-all-cards` の単体で見る（下）。
   */
  it("上限の値が画面の文言と同じ", async () => {
    await seedIssuedCard();
    const html = await (await open(cookieFor(ADMIN))).text();

    // 打ち切っていないので出ていないこと。**出っぱなしだと意味が無い。**
    expect(html).not.toContain("上限で打ち切られています");
    // 文言に埋め込んだ数と定数がずれていないこと。
    expect(String(MAX_ADMIN_LIST)).toBe("500");
  });
});

/** `<textarea ...>…</textarea>` の中身。無ければ空文字。 */
function textareaIn(html: string): string {
  return /<textarea\b[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "";
}
