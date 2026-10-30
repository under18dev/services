import { env } from "cloudflare:test";
import { hasAssetHash } from "@u18/web-ui";
import { beforeEach, describe, expect, it } from "vitest";
import { CARDS_UI_PATH, createApp } from "../src/presentation/http/app";
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
 * カード一覧の画面。
 *
 * API（`cards.api.test.ts`）が「誰のカードを触れるか」を持っているので、
 * ここは**画面として成立しているか**だけを見る。
 */

const TARO = "token-taro-0123456789abcdefghijklmn";
const HANAKO = "token-hanako-0123456789abcdefghijk";
const identity = identityWith({ [TARO]: "usr_taro", [HANAKO]: "usr_hanako" });

async function open(cookie?: string, gateway = identity): Promise<Response> {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("Cookie", cookie);
  return await createApp({ identity: gateway }).fetch(
    new Request(`${ORIGIN}${CARDS_UI_PATH}`, { headers }),
    env,
    executionContext(),
  );
}

beforeEach(resetDatabase);

describe("カード一覧の画面", () => {
  it("自分のカードが出る", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const response = await open(cookieFor(TARO));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain(cardId);
    expect(html).toContain("https://example.com/taro");
    expect(html).toContain("有効");
  });

  it("他人のカードは出ない", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const html = await (await open(cookieFor(HANAKO))).text();
    expect(html).not.toContain(cardId);
    expect(html).not.toContain("https://example.com/taro");
  });

  it("1 枚も無ければその旨が出る（空の一覧を黙って返さない）", async () => {
    const html = await (await open(cookieFor(TARO))).text();
    expect(html).toContain("カードをスマートフォンでタップすると");
  });

  it("未紐づけのカードは所有者が居ないので出ない", async () => {
    const cardId = await seedIssuedCard();

    const html = await (await open(cookieFor(TARO))).text();
    expect(html).not.toContain(cardId);
  });

  it("未ログインはログイン画面へ送る（JSON を見せない）", async () => {
    const response = await open();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(/^\/login\?/);
  });

  it("ログイン後にこの画面へ戻れるよう戻り先を載せる", async () => {
    // 素の /login へ送ると、ログインしたあと利用者が自分でここまで
    // 辿り直すことになる。
    const response = await open();
    const location = response.headers.get("Location") ?? "";
    const returnTo = new URL(location, ORIGIN).searchParams.get("return_to");
    expect(returnTo).toBe(CARDS_UI_PATH);
  });

  it("auth-worker が落ちているときはログインへ送らない", async () => {
    // ログインも同じ Worker が受けているので、送ると利用者が
    // 延々とログインし直す羽目になる。
    const response = await open(cookieFor(TARO), identityDown);
    expect(response.status).toBe(503);
  });

  it("遷移先をリンクにしない（この画面を踏み台にさせない）", async () => {
    await seedActiveCard("usr_taro", "https://evil.example/landing");

    const html = await (await open(cookieFor(TARO))).text();
    expect(html).toContain("https://evil.example/landing");
    // `href` に入っていないこと。入ると一覧を開いた人が 1 クリックで飛べる。
    expect(html).not.toContain('href="https://evil.example/landing"');
  });

  it("共有キャッシュに載せない", async () => {
    await seedActiveCard("usr_taro", "https://example.com/taro");

    const response = await open(cookieFor(TARO));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("CSP が掛かっている（インラインを許さない）", async () => {
    await seedActiveCard("usr_taro", "https://example.com/taro");

    const csp = (await open(cookieFor(TARO))).headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
  });

  it("一覧そのものは JS を要求しない（#338 で島が付いた後も）", async () => {
    // **「`<script>` が 1 つも無い」ではなくなった**（#338 で遷移先の
    // 変更が入った）。それでも**一覧・状態・遷移先の表示はサーバーが
    // 描いている**ことは変わらない。島が落ちても読めること自体を見る。
    await seedActiveCard("usr_taro", "https://example.com/taro");

    const html = await (await open(cookieFor(TARO))).text();

    // 島は 1 本だけ。増えたらここで気づく。
    expect(html.match(/<script/g)?.length ?? 0).toBe(1);
    expect(html).toContain("https://example.com/taro");
    // **JS が無いと何ができないかを言っている。**
    expect(html).toContain("<noscript>");
  });

  it("インラインの style も使わない", async () => {
    // **ヘッダに `'unsafe-inline'` が無いことと、画面が使っていないことは
    // 別である。** `style` 属性は CSP3 の `style-src-attr` が無ければ
    // `style-src` へ落ち、`'self'` なのでブラウザが属性ごと捨てる。HTML は
    // 正しく返るので、ヘッダだけ見ていると見た目が崩れたまま本番へ出る
    // （dashboard-worker がこれを踏んだ）。この Worker も同じ
    // `pageSecurityHeaders` と同じスタイルシートを使う。
    await seedActiveCard("usr_taro", "https://example.com/taro");

    const html = await (await open(cookieFor(TARO))).text();
    expect(html).not.toContain('style="');
    expect(html).not.toContain("<style");
  });

  it("無効化済みのカードも所有者には見える", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");
    await repository().disable(cardId, "usr_taro", "紛失", new Date());

    const html = await (await open(cookieFor(TARO))).text();
    expect(html).toContain(cardId);
    expect(html).toContain("無効化済み");
    expect(html).toContain("紛失");
  });
});

/**
 * ページが参照するアセットが、この Worker から引けること（#211）。
 *
 * ## ここが空いていた
 *
 * この画面は長らく auth-worker の `/ui/u18.css` を**借りていた**。
 * #211 であちらの URL に内容ハッシュが入り、`/ui/u18.css` は 404 に
 * なった —— **借りている側は何も変えていないので、画面は描かれるが
 * スタイルが当たらない。** 500 にもならず外形監視にも出ない。
 *
 * **そのとき、どちらのテストもそれを見られなかった。** このファイルは
 * `u18.css` を一度も見ておらず、auth のテストはこの画面が何を参照して
 * いるかを知らない。**依存が Worker をまたいで HTTP の上にあり、両側の
 * テストが自分の Worker の内側に閉じていた。**
 *
 * だからここで見るのは「スタイルシートの URL が正しいか」ではなく、
 * **この Worker に投げて返ってくるか**である。借りる関係が戻れば
 * （= 自分で配信しなくなれば）、ここで落ちる。
 */
describe("ページが参照するアセット", () => {
  const assetUrlsIn = (html: string): string[] =>
    [...html.matchAll(/(?:href|src)="([^"]*\/ui\/[^"]*)"/g)].map((match) => match[1] ?? "");

  it("参照している URL をこの Worker が返す", async () => {
    await seedActiveCard("usr_taro", "https://example.com/taro");
    const urls = assetUrlsIn(await (await open(cookieFor(TARO))).text());

    expect(urls.length, "アセットを 1 つも参照していない").toBeGreaterThan(0);

    for (const url of urls) {
      // **auth-worker の形（`/ui/...`）ではなく、この Worker の
      // route 配下（`/account/nfc/ui/...`）であること。** ここが
      // `/ui/u18.css` に戻ると、本番では auth-worker に当たる。
      expect(url, `${url} がこの Worker の route 配下にない`).toMatch(/^\/account\/nfc\/ui\//);
      expect(hasAssetHash(url), `${url} にハッシュが入っていない`).toBe(true);

      const response = await createApp({ identity }).fetch(
        new Request(`${ORIGIN}${url}`),
        env,
        executionContext(),
      );
      expect(response.status, `${url} が引けない`).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("immutable");
    }
  });

  it("スタイルシートに個人情報が混ざらない", async () => {
    // **この Worker で唯一 `no-store` を外す経路である。** 中身が
    // 全利用者に同じであることが前提なので、そこを固定する。
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");
    const urls = assetUrlsIn(await (await open(cookieFor(TARO))).text());

    for (const url of urls) {
      const body = await (
        await createApp({ identity }).fetch(new Request(`${ORIGIN}${url}`), env, executionContext())
      ).text();
      expect(body).not.toContain(cardId);
      expect(body).not.toContain("usr_taro");
    }
  });
});

describe("片道の操作（#382）", () => {
  it("有効なカードには、止める／ゆずるの入口が出る", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const html = await (await open(cookieFor(TARO))).text();

    expect(html).toContain("このカードを止める");
    expect(html).toContain("人にゆずる");
    // どのカードに対する操作かが、読み上げにも分かること。
    expect(html).toContain(`${cardId} をこのカードを止める`);
  });

  it("未紐づけ・無効化済みには出さない", async () => {
    // **出しても必ず失敗する入口を描かない。** `issued` はまだ誰のものでも
    // なく、`disabled` は既に止まっている。
    const disabled = await seedActiveCard("usr_taro");
    await repository().disable(disabled, "usr_taro", "lost", new Date());

    const html = await (await open(cookieFor(TARO))).text();

    expect(html).not.toContain("このカードを止める");
    expect(html).not.toContain("人にゆずる");
  });

  it("「この画面からできないこと」の節が消えている", async () => {
    // **#382 の完了条件。** 残り 2 本が入ったので、あの節に書くことが
    // 無くなった —— **「できるのにできないと書いてある」を作らない。**
    await seedActiveCard("usr_taro");

    const html = await (await open(cookieFor(TARO))).text();

    expect(html).not.toContain("この画面からできないこと");
    expect(html).not.toContain("API から操作してください");
  });

  it("JS が無いときに、操作が要ることを言う", async () => {
    await seedActiveCard("usr_taro");

    const html = await (await open(cookieFor(TARO))).text();

    expect(html).toContain("カードを止めたり人にゆずったりするには JavaScript が必要です");
  });
});
