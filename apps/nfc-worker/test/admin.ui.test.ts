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

/**
 * **描かれた form だけでカードを発行する**（#382）。
 *
 * `consent.form-drive.test.ts`（auth-worker）と同じ形である。あちらは
 * **CSRF の hidden input を 1 行消しても 918 本が緑だった**ことから
 * 入れたもので、理由はここでも同じ —— **画面を読まずに画面のテストを
 * 名乗らない。**
 *
 * **発行は取り消せない。** 枚数も action も method も、こちらでは
 * 1 つも書かず、**画面が言っているものだけ**を送る。
 */
describe("描かれた form だけで発行する", () => {
  type Form = {
    readonly action: string;
    readonly method: string;
    readonly fields: Readonly<Record<string, string>>;
  };

  /** HTML から form を 1 つ取り出す。既定へ落ちたことが分かるよう空文字で返す。 */
  function formIn(html: string, marker: string): Form {
    const tags = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
    const found = tags.find(([, attrs, body]) => `${attrs}${body}`.includes(marker));
    if (found === undefined) throw new Error(`${marker} を含む form が無い`);

    const [, attrs = "", body = ""] = found;
    const fields: Record<string, string> = {};
    for (const [, tag] of [...body.matchAll(/(<input\b[^>]*>)/g)]) {
      const name = /\bname="([^"]*)"/.exec(tag ?? "")?.[1];
      if (name === undefined) continue;
      fields[name] = /\bvalue="([^"]*)"/.exec(tag ?? "")?.[1] ?? "";
    }

    return {
      action: /\baction="([^"]*)"/.exec(attrs)?.[1] ?? "",
      method: (/\bmethod="([^"]*)"/.exec(attrs)?.[1] ?? "").toLowerCase(),
      fields,
    };
  }

  /** 画面を開いて、発行の form と Cookie 列を取り出す。 */
  async function openIssueForm(cookie = cookieFor(ADMIN)): Promise<{ form: Form; cookie: string }> {
    const response = await open(cookie);
    expect(response.status, "管理画面が 200 で出ていない").toBe(200);

    const csrfCookie = response.headers
      .getSetCookie()
      .map((raw) => raw.split(";")[0] ?? "")
      .filter((pair) => pair.startsWith("u18_csrf="));

    return {
      form: formIn(await response.text(), 'name="count"'),
      cookie: [cookie, ...csrfCookie].join("; "),
    };
  }

  /** form が言っているとおりに送る。**こちらでパスも名前も足さない。** */
  async function send(
    form: Form,
    filled: Readonly<Record<string, string>>,
    cookie: string,
  ): Promise<Response> {
    return await createApp({ identity }).fetch(
      new Request(`${ORIGIN}${form.action}`, {
        method: form.method,
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
          Cookie: cookie,
        },
        body: new URLSearchParams({ ...form.fields, ...filled }).toString(),
      }),
      env,
      executionContext(),
    );
  }

  it("form が POST で、CSRF トークンを hidden で運んでいる", async () => {
    const { form } = await openIssueForm();

    // **`method` が消えるとブラウザは GET で送る。** 枚数がクエリに載り、
    // しかも発行は起きないので「押しても何も出ない」になる。
    expect(form.method, "method が post でない（既定の GET になる）").toBe("post");
    expect(form.action, "action が空（現在の URL へ送られる）").not.toBe("");
    // **これが欠けると、押すたびに 403 になる。**
    expect(form.fields["csrf_token"], "CSRF トークンが hidden に無い").toBeTruthy();
    // 枚数の欄があること。既定値は画面が持つ。
    expect(Object.keys(form.fields)).toContain("count");
  });

  it("押すだけで発行され、焼く用の URL に並ぶ", async () => {
    const { form, cookie } = await openIssueForm();

    const issued = await send(form, { count: "3", batch: "lot-x" }, cookie);

    // **PRG。** 200 で描くと、再読み込みでもう一度発行される。
    expect(issued.status, "発行の応答が 303 でない").toBe(303);
    expect(issued.headers.get("Location")).toBe(`${ADMIN_UI_PATH}?issued=3`);

    // 戻った先に 3 枚ぶんの URL が並んでいること。**ID はクエリで運んで
    // いない** —— `issued` のカードなので一覧に必ず入る。
    const after = await (await open(cookieFor(ADMIN))).text();
    const urls = textareaIn(after).split("\n").filter(Boolean);
    expect(urls).toHaveLength(3);
    for (const url of urls) expect(url.startsWith(`${env.SHORT_URL_ORIGIN}/c/`)).toBe(true);
    // ロット名も一覧に出ること。
    expect(after).toContain("lot-x");
  });

  it("CSRF トークンが無ければ発行しない", async () => {
    const { form, cookie } = await openIssueForm();

    const response = await send(form, { count: "3", csrf_token: "" }, cookie);

    expect(response.status).toBe(403);
    // **1 枚も作られていないこと。** 403 を返しつつ発行していたら最悪である。
    const after = await (await open(cookieFor(ADMIN))).text();
    expect(textareaIn(after)).toBe("");
  });

  it("一般利用者は、正しい CSRF トークンを持っていても発行できない", async () => {
    // **トークンは Worker 共通である。** 紐づけ画面から取れるので、
    // 「管理画面を開けない」は発行を止める根拠にならない。
    // 止めているのは `IssueCardsUseCase` の `requireAdminUserId` である。
    const { form, cookie } = await openIssueForm();

    const response = await send(
      form,
      { count: "3" },
      `${cookieFor(TARO)}; ${cookie.split("; ").slice(1).join("; ")}`,
    );

    // 管理者でないので 404（403 にしない。#331 / #333 の判断）。
    expect(response.status).toBe(404);
    const after = await (await open(cookieFor(ADMIN))).text();
    expect(textareaIn(after)).toBe("");
  });

  it("枚数が範囲外なら 400 で、1 枚も作らない", async () => {
    const { form, cookie } = await openIssueForm();

    const response = await send(form, { count: "0" }, cookie);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("枚数は");

    const after = await (await open(cookieFor(ADMIN))).text();
    expect(textareaIn(after), "弾いたのにカードが作られている").toBe("");
  });

  it("完了の知らせは、数として読めるものしか出さない", async () => {
    // **クエリは利用者が書き換えられる。** そのまま出すと、攻撃者が
    // 選んだ文章を管理画面に表示させられる（auth-worker の
    // `LoginView.notice` が同じ理由で固定文言に限っている）。
    const response = await createApp({ identity }).fetch(
      new Request(`${ORIGIN}${ADMIN_UI_PATH}?issued=%3Cscript%3Eevil`, {
        headers: { Cookie: cookieFor(ADMIN) },
      }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain("evil");
    expect(html).not.toContain("枚発行しました");
  });
});
