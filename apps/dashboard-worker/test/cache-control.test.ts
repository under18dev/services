import { IMMUTABLE_ASSET_CACHE_CONTROL } from "@u18/web-ui";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import {
  GRANTS_PATH,
  OVERVIEW_PATH,
  SESSIONS_PATH,
  STYLESHEET_PATH,
} from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, envWith, executionContext, neverCalled } from "./helpers";

/**
 * `Cache-Control` が全経路に付いていること（#125 / 脅威モデル RR-10）。
 *
 * **この Worker が返すのは全部個人情報である。** auth-worker から中継した
 * プロフィール・セッション一覧・同意済みアプリで、中間プロキシやブラウザに
 * 残ると共用端末で前の利用者の情報が戻る。
 *
 * **例外は `/account/ui/u18.css` ただ 1 つ。** 全利用者に同じ CSS で、
 * 個人情報を 1 文字も含まない。増やすときは、ここの「例外はこれ 1 つ」を
 * 更新したうえで、なぜ個人情報が含まれないのかを書くこと。
 */
describe("全経路に no-store が付く", () => {
  const identity = {
    getUserProfile: () => neverCalled("getUserProfile"),
    listSessions: () => neverCalled("listSessions"),
    listGrants: () => neverCalled("listGrants"),
    revokeSession: () => neverCalled("revokeSession"),
    revokeGrant: () => neverCalled("revokeGrant"),
  } as never;

  // Cookie を付けない。**401 でも付いている必要がある** —— 失敗応答が
  // キャッシュされると、後からログインしても 401 が返りうる。
  it.each([
    ["GET", `${ACCOUNT_BASE_PATH}/api/me`],
    ["GET", `${ACCOUNT_BASE_PATH}/api/me/sessions`],
    ["GET", `${ACCOUNT_BASE_PATH}/api/me/grants`],
    ["DELETE", `${ACCOUNT_BASE_PATH}/api/me/sessions/ses_x`],
    ["DELETE", `${ACCOUNT_BASE_PATH}/api/me/grants/cli_x`],
  ])("%s %s", async (method, path) => {
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${path}`, { method, headers: { Origin: ORIGIN } }),
      envWith(identity),
      executionContext(),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("/account/health にも付く", async () => {
    // 死活確認がキャッシュされると、落ちていても緑に見える窓ができる。
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ACCOUNT_BASE_PATH}/health`),
      envWith({ pingIdentity: async () => ({ ok: true, value: { status: "ok" } }) } as never),
      executionContext(),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([OVERVIEW_PATH, SESSIONS_PATH, GRANTS_PATH])("HTML の %s にも付く", async (path) => {
    // 画面にはプロフィールもセッション一覧も載る。JSON の経路より
    // むしろ共用端末で戻りやすい（「戻る」で再描画されうる）。
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${path}`),
      envWith(identity),
      executionContext(),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("接頭辞の無いパス（404）にも付く", async () => {
    const response = await createApp().fetch(
      new Request(`${ORIGIN}/api/me`),
      envWith(identity),
      executionContext(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("キャッシュしてよい経路はスタイルシートだけ", () => {
  it("スタイルシートは immutable で返る", async () => {
    // ここだけ既定の no-store を上書きしている。全利用者に同じ CSS で、
    // 個人情報を含まない。毎回取り直させる理由が無い。
    //
    // **`immutable` にできるのは URL に内容ハッシュが入っているから**
    // （#211）。中身が変われば URL が変わるので、古いものを掴んだ
    // ブラウザと新しいサーバーが重なる窓が無い。
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${STYLESHEET_PATH}`),
      envWith({} as never),
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });

  it("ハッシュの無い古い URL は 404 になる", async () => {
    // **これは正しい挙動である。** デプロイ前の URL を掴んだブラウザは
    // 新しいサーバーから取れない —— 代わりに、新しいページが新しい URL を
    // 指しているので、ページを読めば必ず新しいものを取りに行く。
    // ここが 200 を返すなら、古い URL も生かしていることになり、
    // #211 で消したはずの「古いものが使われ続ける窓」が戻る。
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ACCOUNT_BASE_PATH}/ui/u18.css`),
      envWith({} as never),
      executionContext(),
    );

    expect(response.status).toBe(404);
  });

  it("Cookie を送っても応答が変わらない", async () => {
    // 利用者ごとに違う内容が混ざっていたら、public で配ってはいけない。
    // 「個人情報を含まない」を、説明ではなく振る舞いで確かめる。
    const fetchCss = (headers: HeadersInit) =>
      createApp().fetch(
        new Request(`${ORIGIN}${STYLESHEET_PATH}`, { headers }),
        envWith({} as never),
        executionContext(),
      );

    const anonymous = await (await fetchCss({})).text();
    const authenticated = await (await fetchCss({ Cookie: "u18_session=someones-token" })).text();

    expect(authenticated).toBe(anonymous);
  });
});
