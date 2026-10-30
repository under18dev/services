import { DEV_SESSION_COOKIE_NAME, rpcErr, rpcOk } from "@u18/contracts";
import { scopeLabel } from "@u18/web-ui";
import type { GrantListItem, PasskeySummary, SessionListItem, UserProfile } from "@u18/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ACCOUNT_BASE_PATH, createApp } from "../src/presentation/http/app";
import {
  APPS_PATH,
  GRANTS_PATH,
  OVERVIEW_PATH,
  PASSKEYS_PATH,
  PROFILE_PATH,
  KIWA_STYLESHEET_PATH,
  NFC_CARDS_PATH,
  SESSIONS_PATH,
} from "../src/presentation/http/ui/asset-paths";
import type { AppCatalogEntry, AppCatalogView } from "../src/presentation/http/ui/app-catalog";
import {
  APP_CATALOG,
  APP_CATEGORIES,
  buildAppCatalog,
  isAllowedUrl,
  isExternalUrl,
} from "../src/presentation/http/ui/app-catalog";
import { AppsPage } from "../src/presentation/http/ui/apps-page";
import { ORIGIN, envWith, executionContext, neverCalled } from "./helpers";
import { PAGES } from "./pages";

/**
 * アカウント管理画面（#9）。
 *
 * この画面は **JS 無しで成立する**。ここで確かめるのは
 * 「HTML が出ること」ではなく、**出てはいけないものが出ていないこと**と
 * **他の経路と同じ扱いになっていること**である。
 */

const COOKIE = `${DEV_SESSION_COOKIE_NAME}=token-value`;

const PROFILE: UserProfile = {
  id: "usr_test",
  username: "taro",
  displayName: "Taro",
  email: "taro@example.com",
  emailVerified: true,
  status: "active",
  isAdmin: false,
  createdAt: "2026-10-24T00:00:00.000Z",
};

async function get(path: string, identity: object, init: RequestInit = {}): Promise<Response> {
  return await createApp().fetch(
    new Request(`${ORIGIN}${path}`, init),
    envWith(identity as never),
    executionContext(),
  );
}

function withCookie(path: string, identity: object): Promise<Response> {
  return get(path, identity, { headers: { Cookie: COOKIE } });
}

const FULL_IDENTITY = {
  getUserProfile: async () => rpcOk(PROFILE),
  listPasskeys: async () => rpcOk([] as PasskeySummary[]),
  listSessions: async () => rpcOk([] as SessionListItem[]),
  listGrants: async () => rpcOk([] as GrantListItem[]),
};

// 一覧は `kiwa-stylesheet.test.ts` と共有する（`./pages` の冒頭）。
// **2 つのテストが同じ 6 枚を違う角度から見ているので、片方にしか
// 無い画面があるとその画面だけ片目で見ていることになる。**

describe("画面が HTML を返す", () => {
  it.each(PAGES)("%s", async (path) => {
    const response = await withCookie(path, FULL_IDENTITY);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  /**
   * **サイドバーには、この Worker が持たない行き先が 1 つある**（#338）。
   *
   * `/account/nfc` に答えるのは nfc-worker で（`wrangler.jsonc` の
   * production route が dashboard の `/account/*` より長いので勝つ）、
   * ここへ投げても 404 が返る。**それが正しい** —— 利用者から見れば
   * 同じオリジンの 1 つの画面だが、答える Worker は別である。
   *
   * **この 1 行は、ここでは確かめられない。** 本番 route で勝つ Worker を
   * 決め、その Worker の `route-inventory.ts` に登録があるかまで見るのは
   * `scripts/check-app-catalog-routes.mjs` の仕事である（#327 / #338）。
   * **ここで `toBe(404)` を見るだけにすると、nfc が route を動かしても
   * 緑のまま**になるので、何を誰が見ているかを書いておく。
   */
  const FOREIGN_NAV_HREFS: readonly string[] = [NFC_CARDS_PATH];

  it("サイドバーの行き先が、自分の画面と他 Worker の分に分かれる", async () => {
    // サイドバーに書いたパスと、実際に登録したルートがずれると 404 を踏む。
    // 画面から `href` を抜き出して、自分のものは全部引けることを確かめる。
    //
    // **ブランドのリンク（ホームへ戻る）も混ざる。** 除かずにそのまま
    // 引ければよい —— あれも押せる必要がある。
    const html = await (await withCookie(OVERVIEW_PATH, FULL_IDENTITY)).text();
    const navHrefs = [...html.matchAll(/<nav [^>]*aria-label="ダッシュボード"[^>]*>(.*?)<\/nav>/gs)]
      .flatMap((nav) => [...(nav[1] ?? "").matchAll(/href="([^"]+)"/g)])
      .map((m) => m[1] as string);

    // **一覧そのものを突き合わせる。** 「引ければよい」だけにすると、
    // 項目が 1 つ減っても緑になる。
    expect(new Set(navHrefs)).toEqual(new Set([...PAGES, ...FOREIGN_NAV_HREFS]));

    for (const href of navHrefs) {
      const response = await withCookie(href, FULL_IDENTITY);
      // 他 Worker のものは、この Worker に登録が無いので 404 でよい。
      // **200 を返したら、こちらが持つべきでないものを持っている。**
      const expected = FOREIGN_NAV_HREFS.includes(href) ? 404 : 200;
      expect(response.status, `ナビの ${href}`).toBe(expected);
    }
  });

  /**
   * モバイルの折りたたみ（#399 の作り直し）。
   *
   * **`<details>`/`<summary>` には戻らない。** 閉じている間に中身を
   * `::details-content` という擬似要素で包み `content-visibility: hidden`
   * を当てるブラウザがあり、子要素の `display: flex` では勝てず、PC でも
   * サイドバーごと消えた（#399 の本番回帰）。チェックボックス方式は
   * その擬似要素を経由しない。
   *
   * **DOM にクラスが付いていることまでしか、ここでは確かめられない。**
   * 「見えるかどうか」は生成された CSS 側（`.peer-checked\:flex` /
   * `.md\:flex` が何にも阻まれず効くこと）で確かめる——
   * `packages/web-ui/test/shell.test.ts` を参照。
   */
  it("モバイルの折りたたみに <details> を使わない", async () => {
    const html = await (await withCookie(OVERVIEW_PATH, FULL_IDENTITY)).text();

    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");

    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).toContain('class="peer sr-only"');
    const toggleId = checkbox?.match(/id="([^"]+)"/)?.[1];
    expect(toggleId).toBeDefined();

    expect(html).toContain(`for="${toggleId}"`);
  });
});

describe("末尾スラッシュの有無で 404 にしない", () => {
  // Hono は既定（`strict: true`）で `/account` と `/account/` を別物として
  // 扱う。**画面の入口なので、利用者が URL バーに打った側が登録されて
  // いなければ踏めない。** `createApp()` の `strict: false` がこれを同一視する。
  //
  // services-6f が #197 で見つけた。こちらの実装は `.route()` 経由だったので
  // 生きているのは逆側（`/account` が 200 で `/account/` が 404）だった。
  // 片側しか試していなければ、どちらの実装でも「通る」と読めてしまう。
  it.each([
    [OVERVIEW_PATH, `${OVERVIEW_PATH}/`],
    [SESSIONS_PATH, `${SESSIONS_PATH}/`],
    [GRANTS_PATH, `${GRANTS_PATH}/`],
  ])("%s と %s が同じ扱いになる", async (withoutSlash, withSlash) => {
    const a = await withCookie(withoutSlash, FULL_IDENTITY);
    const b = await withCookie(withSlash, FULL_IDENTITY);

    expect(a.status).toBe(200);
    expect(b.status, `${withSlash} が 404`).toBe(200);
  });
});

describe("参照しているスタイルシートを自分で配信している", () => {
  /**
   * 画面がどちらのスタイルシートを読むか（#332）。
   *
   * **1 本に戻った**（#332 の P1）。6 枚とも Kiwa UI（Tailwind）を読む。
   *
   * **「読むのは 1 本だけ」の検査は残してある。** 移行の間は
   * Tailwind の preflight が手書き CSS の前提（`body` の中央寄せなど）を
   * 潰すので「両方読み込む」が一番楽な逃げ道だった。手書き側は消えたが、
   * **Worker ごとの CSS が混ざらないことは引き続き見る必要がある。**
   *
   * `sentinel` は**中身が入れ替わっていないこと**を見るための目印。
   * 両方に出る文字列を選ぶと、取り違えても気づけない。
   */
  //
  // **6 枚とも Kiwa になった**（#332 の P1）。`sentinel` は中身が
  // 入れ替わっていないことを見るための目印で、Tailwind の出力の先頭に
  // 必ず出るバナーを使っている。
  const EXPECTED_STYLESHEET: readonly (readonly [string, string, string])[] = [
    [OVERVIEW_PATH, KIWA_STYLESHEET_PATH, "tailwindcss"],
    [PROFILE_PATH, KIWA_STYLESHEET_PATH, "tailwindcss"],
    [PASSKEYS_PATH, KIWA_STYLESHEET_PATH, "tailwindcss"],
    [SESSIONS_PATH, KIWA_STYLESHEET_PATH, "tailwindcss"],
    [GRANTS_PATH, KIWA_STYLESHEET_PATH, "tailwindcss"],
    [APPS_PATH, KIWA_STYLESHEET_PATH, "tailwindcss"],
  ];

  /**
   * **401 / 503 の経路も「ちょうど 1 本」である**（#338）。
   *
   * ## ここが空いていた
   *
   * 下の `it.each` は**必ず Cookie を付けて**取りに行く。ところが
   * `SignInRequiredPage` と `UnavailablePage`（`message-page.tsx`）は
   * **6 つの URL すべてから返る**共通の画面で、Cookie が無いときに
   * 出るのはそちらである。**つまり「1 枚のページは片方の CSS しか
   * 読まない」が、未認証の経路では一度も確かめられていなかった。**
   *
   * `/account/apps` は、**ログインしていれば Kiwa、していなければ手書き
   * CSS** で出ていた。壊れてはいなかった（どちらも 1 本である）が、
   * **2 本読む形になっても誰も気づかない**状態だった。
   *
   * ## ここは「どちらを読むか」ではなく「1 本である」を見る
   *
   * `message-page.tsx` は #332 の P1 で Kiwa へ移り、認証の有無で
   * スタイルシートが変わることは無くなった。**それでも本数だけを
   * 固定してある** —— 見るべきは「混ざっていないこと」で、どちらを
   * 読むかは上の `EXPECTED_STYLESHEET` が見ているため。
   */
  it.each(PAGES)("%s は未認証でもスタイルシートを 1 本しか読まない", async (path) => {
    const html = await (
      await get(path, {
        getUserProfile: () => neverCalled("getUserProfile"),
        listPasskeys: () => neverCalled("listPasskeys"),
        listSessions: () => neverCalled("listSessions"),
        listGrants: () => neverCalled("listGrants"),
      })
    ).text();

    const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
      (m) => m[1] as string,
    );

    expect(hrefs.length, `${path} の未認証応答が読むスタイルシート: ${hrefs.join(" ")}`).toBe(1);

    // **引けることまで見る。** 本数だけだと、存在しない URL を 1 本
    // 読んでいる状態が通る。
    const css = await get(hrefs[0] as string, {});
    expect(css.status, `${hrefs[0]} が引けない`).toBe(200);
  });

  it("一覧が PAGES を漏れなく覆っている", () => {
    // 画面を足して**ここに書き忘れる**と、下の `it.each` が静かに
    // その画面を見なくなる。
    expect(EXPECTED_STYLESHEET.map(([path]) => path)).toEqual(PAGES);
  });

  // **この Worker 単体で成立すること。** `<link href>` を手で書くと、
  // 配信ルート側だけ直して参照が古いまま、という形で 404 になる。
  // ブラウザは素の HTML を出すだけで、型検査もテストも何も言わない。
  it.each(EXPECTED_STYLESHEET)(
    "%s の <link> が指す先が 200 を返す",
    async (path, expected, sentinel) => {
      const html = await (await withCookie(path, FULL_IDENTITY)).text();
      const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
        (m) => m[1] as string,
      );

      // **1 本だけ。** 2 本読んでいたら上の「混ぜない」が破れている。
      expect(hrefs, `${path} が読むスタイルシート`).toEqual([expected]);

      const css = await get(expected, {});
      expect(css.status).toBe(200);
      expect(css.headers.get("Content-Type")).toContain("text/css");
      expect(await css.text()).toContain(sentinel);
    },
  );
});

describe("Cookie が無ければ RPC を呼ばずに 401 とログイン導線", () => {
  const identity = {
    getUserProfile: () => neverCalled("getUserProfile"),
    listPasskeys: () => neverCalled("listPasskeys"),
    listSessions: () => neverCalled("listSessions"),
    listGrants: () => neverCalled("listGrants"),
  };

  it.each(PAGES)("%s", async (path) => {
    const response = await get(path, identity);

    // 200 で「ログインしてください」と書いた HTML を返すと、
    // 外形監視からは正常に見える。JSON 経路と同じ 401 にする。
    expect(response.status).toBe(401);

    const html = await response.text();
    // ログイン画面は auth-worker 側。接頭辞を付けるとこの Worker へ戻ってくる。
    // 戻り先のクエリが付くので前方一致で見る。
    expect(html).toMatch(/href="\/login(\?|")/);
    expect(html).not.toContain(`href="${ACCOUNT_BASE_PATH}/login"`);
  });

  it("行き先の無い画面ではナビを出さない", async () => {
    // 出すと、押すたびに同じ 401 へ戻る。
    const html = await (await get(OVERVIEW_PATH, identity)).text();

    expect(html).not.toContain('class="nav"');
  });
});

describe("セッションが無効なら 401", () => {
  it("getProfile が null を返したとき", async () => {
    const response = await withCookie(OVERVIEW_PATH, {
      getUserProfile: async () => rpcOk(null),
      listPasskeys: async () => rpcOk([] as PasskeySummary[]),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("ログインが必要です");
  });
});

describe("Identity が使えないときは 503", () => {
  it.each([
    [OVERVIEW_PATH, "getUserProfile"],
    [SESSIONS_PATH, "listSessions"],
    [GRANTS_PATH, "listGrants"],
  ])("%s", async (path, method) => {
    const response = await withCookie(path, {
      ...FULL_IDENTITY,
      [method]: async () => rpcErr("internal", "sqlite: no such table: sessions"),
    });

    expect(response.status).toBe(503);

    const html = await response.text();
    // auth-worker 側の事情を画面へ出さない。構成を推測する材料になる。
    expect(html).not.toContain("sqlite");
  });
});

describe("利用者が決められない文字列をそのまま埋め込まない", () => {
  // User-Agent も clientName も**攻撃者が自分で値を決められる**。
  // hono/jsx のエスケープに任せており、`raw()` を使っていないことの固定。
  const XSS = '"><script>alert(1)</script>';

  it("セッションの User-Agent", async () => {
    const session: SessionListItem = {
      sessionId: "ses_1",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastSeenAt: "2026-10-24T00:00:00.000Z",
      expiresAt: "2026-11-24T00:00:00.000Z",
      current: true,
      userAgent: XSS,
    };

    const html = await (
      await withCookie(SESSIONS_PATH, { listSessions: async () => rpcOk([session]) })
    ).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("連携アプリの名前", async () => {
    // クライアント名は登録した第三者が自由に付けられる。
    const grant: GrantListItem = {
      clientId: "cli_1",
      clientName: XSS,
      logoUrl: "https://evil.example/pixel.png",
      scopes: ["openid"],
      grantedAt: "2026-10-24T00:00:00.000Z",
    };

    const html = await (
      await withCookie(GRANTS_PATH, { listGrants: async () => rpcOk([grant]) })
    ).text();

    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("連携アプリのロゴを読み込まない", () => {
  it("logoUrl が HTML に現れない", async () => {
    // CSP の img-src は第三者ホストを許していない（@u18/web-ui）。
    // 出すと「この画面を開いた事実」が第三者のサーバーへ伝わる。
    const grant: GrantListItem = {
      clientId: "cli_1",
      clientName: "Example App",
      logoUrl: "https://evil.example/pixel.png",
      scopes: ["openid"],
      grantedAt: "2026-10-24T00:00:00.000Z",
    };

    const html = await (
      await withCookie(GRANTS_PATH, { listGrants: async () => rpcOk([grant]) })
    ).text();

    expect(html).toContain("Example App");
    expect(html).not.toContain("evil.example");
  });
});

describe("画面には CSP が付く", () => {
  it.each(PAGES)("%s", async (path) => {
    const response = await withCookie(path, FULL_IDENTITY);
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp, `${path} に CSP が無い`).toBeTruthy();
    // インラインを許さないこと。許すと XSS の緩和がほぼ無くなる。
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("CSP が許していないものを画面が使っていない", () => {
  /**
   * **ヘッダ側しか見ていなかった。** 1 つ上の describe は
   * `'unsafe-inline'` が CSP に**混ざっていない**ことを見る。混ざって
   * いないのに**使っている**側は誰も見ておらず、ホームがパネルの間隔を
   * `style` 属性で付けたまま本番へ出た（パネル同士が枠線で密着した）。
   *
   * `style` 属性には CSP3 の `style-src-attr` が掛かり、無ければ
   * `style-src` へ落ちる。`style-src 'self'` なので**ブラウザが属性ごと
   * 捨てる**。HTML も状態コードも正しいまま見た目だけが崩れるので、
   * 応答を見ているテストでは気づけない。同じ理由で `<style>` も使えない。
   *
   * 間隔や寄せが要るときは `@u18/web-ui` の `styles.ts` へクラスを足す
   * （CSP を緩めない、という `page-headers.ts` の方針）。
   */
  it.each(PAGES)("%s に style 属性も <style> も無い", async (path) => {
    const html = await (await withCookie(path, FULL_IDENTITY)).text();

    expect(html, `${path} にインラインの style 属性がある`).not.toContain('style="');
    expect(html, `${path} に <style> がある`).not.toContain("<style");
  });
});

describe("Referrer-Policy を no-referrer にしない", () => {
  /**
   * Fetch 仕様では、referrer policy が参照元を落とすとき**ナビゲーション
   * 要求の `Origin` も `null` になる**。自分のページから出した form 送信が
   * `Origin: null` で届き、Origin 検証に落ちる。auth-worker が本番でこれを
   * 踏み、ログイン・新規登録・ログアウトが全滅した（#226）。
   *
   * **この Worker にはまだ form POST が無い。** だからこのテストは
   * 「いま壊れていること」ではなく、**#208（JS 無しで他端末を切る）を
   * 入れた瞬間に同じ障害を踏むこと**を防いでいる。そのとき
   * `@u18/web-ui` の `page-headers.ts` を読んだ人は #226 で直っていると
   * 思うので、ここで止める以外に気づく機会が無い。
   */
  it.each(PAGES)("%s", async (path) => {
    const response = await withCookie(path, FULL_IDENTITY);

    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("401 の応答にも付く", async () => {
    // 画面だけに付けても、ログインへ誘導する 401 の HTML から出した
    // form 送信は同じ問題を踏む。全体ミドルウェアで付けている以上
    // 付いているはずで、経路を 1 つに保てているかの確認でもある。
    const response = await get(OVERVIEW_PATH, {
      getUserProfile: () => neverCalled("getUserProfile"),
      listPasskeys: () => neverCalled("listPasskeys"),
      listSessions: () => neverCalled("listSessions"),
      listGrants: () => neverCalled("listGrants"),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });
});

describe("ダッシュボードのホーム（#308）", () => {
  it("件数を出す", async () => {
    // **「パスキー 0 本」はそれ自体が伝えたい状態である。** 一覧を開かないと
    // 分からない形にすると、危ない状態の人ほど気づかない。
    const html = await (await withCookie(OVERVIEW_PATH, FULL_IDENTITY)).text();

    // 数字そのものを見る。**クラス名を目印にしない** ——
    // 見た目のクラスは移行のたびに変わる（#332）。
    expect(html).toMatch(/>\s*0\s*</);
    expect(html).toContain("パスキー");
    expect(html).toContain("ログイン中の端末");
    expect(html).toContain("連携アプリ");
  });

  it("パスキーが 0 本なら、その状態を名指しで伝える", async () => {
    // `FULL_IDENTITY` の既定が 0 件。数字を出すだけでは「0 が危ない」ことが
    // 伝わらないので、文言でも言う。
    const html = await (await withCookie(OVERVIEW_PATH, FULL_IDENTITY)).text();

    expect(html).toContain("パスキーを登録してください");
    expect(html).toContain("受信箱を使えなくなると");
  });

  it("パスキーがあれば、その案内は出さない", async () => {
    const passkey: PasskeySummary = {
      id: "pk_1",
      label: "テスト",
      deviceType: "platform",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastUsedAt: null,
    };
    const html = await (
      await withCookie(OVERVIEW_PATH, {
        ...FULL_IDENTITY,
        listPasskeys: async () => rpcOk([passkey]),
      })
    ).text();

    expect(html).not.toContain("パスキーを登録してください");
  });

  it("ホームには一覧の中身を出さない", async () => {
    // **導線と件数だけを置く。** 中身まで出すと、個別ページと 2 箇所で
    // 同じものを描くことになり、片方だけ古くなる。
    const html = await (await withCookie(OVERVIEW_PATH, FULL_IDENTITY)).text();
    expect(html).not.toContain("data-passkey-id");
    expect(html).not.toContain("data-session-id");
    expect(html).not.toContain("data-grant-client-id");
  });
});

describe("プロフィール（#308）", () => {
  it("登録情報を出す", async () => {
    const html = await (await withCookie(PROFILE_PATH, FULL_IDENTITY)).text();

    expect(html).toContain("表示名");
    expect(html).toContain("ユーザー名");
    expect(html).toContain("メールアドレス");
  });

  it("未確認のメールアドレスを黙らない", async () => {
    // この状態だと復旧経路が無い。黙ると本人が気づけない。
    const html = await (
      await withCookie(PROFILE_PATH, {
        ...FULL_IDENTITY,
        getUserProfile: async () => rpcOk({ ...PROFILE, emailVerified: false }),
      })
    ).text();

    expect(html).toContain("未確認");
  });
});

describe("0 件のときに空の一覧を出さない", () => {
  it.each([
    [PASSKEYS_PATH, "登録されているパスキーはありません"],
    [GRANTS_PATH, "連携を許可したアプリはありません"],
  ])("%s", async (path, message) => {
    const html = await (await withCookie(path, FULL_IDENTITY)).text();

    expect(html).toContain(message);
  });
});

describe("実装側の語を画面に出さない", () => {
  it("User-Agent は要約と原文の両方を出す", async () => {
    // 要約だけだと「当たっているか」を利用者が確かめられない。
    // 原文だけだと 1 件が 2 行になり、拾い読みができない。
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    const session: SessionListItem = {
      sessionId: "ses_1",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastSeenAt: "2026-10-24T00:00:00.000Z",
      expiresAt: "2026-11-24T00:00:00.000Z",
      current: false,
      userAgent: ua,
    };

    const html = await (
      await withCookie(SESSIONS_PATH, { listSessions: async () => rpcOk([session]) })
    ).text();

    expect(html).toContain("Chrome / macOS");
    expect(html).toContain("AppleWebKit/537.36");
  });

  it("要約できない User-Agent は原文を見出しにする（二重に出さない）", async () => {
    const session: SessionListItem = {
      sessionId: "ses_1",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastSeenAt: "2026-10-24T00:00:00.000Z",
      expiresAt: "2026-11-24T00:00:00.000Z",
      current: false,
      userAgent: "curl/8.7.1",
    };

    const html = await (
      await withCookie(SESSIONS_PATH, { listSessions: async () => rpcOk([session]) })
    ).text();

    expect(html.match(/curl\/8\.7\.1/g)).toHaveLength(1);
  });

  it("Passkey の deviceType を生のまま出さない", async () => {
    // `cross-platform` は実装側の語。画面に出しても利用者には伝わらない。
    const passkey: PasskeySummary = {
      id: "pk_1",
      label: null,
      deviceType: "cross-platform",
      createdAt: "2026-10-24T00:00:00.000Z",
      lastUsedAt: null,
    };

    const html = await (
      await withCookie(PASSKEYS_PATH, {
        getUserProfile: async () => rpcOk(PROFILE),
        listPasskeys: async () => rpcOk([passkey]),
      })
    ).text();

    expect(html).not.toContain("cross-platform");
    expect(html).toContain("名前のないパスキー");
    expect(html).toContain("他の端末・セキュリティキー");
  });

  it("scope は同意画面と同じ文言で出す", async () => {
    // 許可したときと取り消すときで言葉が違うと、利用者は
    // 「同じものを取り消そうとしている」と確信できない。
    const grant: GrantListItem = {
      clientId: "cli_1",
      clientName: "Example App",
      logoUrl: null,
      scopes: ["profile", "wallet:write"],
      grantedAt: "2026-10-24T00:00:00.000Z",
    };

    const html = await (
      await withCookie(GRANTS_PATH, { listGrants: async () => rpcOk([grant]) })
    ).text();

    expect(html).toContain(scopeLabel("profile"));
    // 知らない scope は畳まずコードのまま出す。「その他」にすると、
    // 何を許可しているか分からないものが画面から消える。
    expect(html).toContain("wallet:write");
  });
});

/**
 * u18 Identity で使えるアプリのカタログ（`/account/apps`、#308）。
 *
 * **`/account/grants` と取り違えやすい。** あちらは「自分が同意した RP」、
 * こちらは「u18 で使えるアプリとして**運用側が載せたもの**」の案内
 * （`oauth_clients` の全件ではない）。ここで確かめるのは、
 * **カタログの中身がどうであれ画面が成立すること**と、**「連携済み」が
 * `listGrants` の結果だけから決まること**である。
 *
 * ## 実物を見るテストが空振りしないこと
 *
 * `APP_CATALOG` は 0 件になりうる設計なので、`for (const e of APP_CATALOG)`
 * と書くと**カタログが空になった日にアサーション 0 件で緑になる。**
 * さらに `toContain("サービス")` は**サイドバーの見出しにも当たる**ので、
 * カタログ本体が空の画面でも通ってしまう。
 *
 * **実物を見るテストは `panel-title">` で絞り、0 件の側も明示的に
 * 検査する**（下の `it("実物のカタログを端から端まで描く")`）。
 */
describe("アプリのカタログ（#308）", () => {
  /**
   * カタログを差し替えて画面だけを描く。
   *
   * **本物のカタログ（`APP_CATALOG`）は 1 件しか無く、しかも RP ではない**
   * ので、`/account/apps` を引くだけでは「0 件」も「連携済み」も踏めない。
   * `AppsPage` に直接 props を渡して、カタログが変わったときの形を見る。
   */
  async function renderApps(view: AppCatalogView): Promise<string> {
    const probe = new Hono().get("/", (c) => c.html(AppsPage({ view, isAdmin: false }) as never));
    return await (await probe.request("/")).text();
  }

  /** `client_id` は OIDC の公開識別子。内部 ID（`cli_*`）の形にしない。 */
  const GRANT: GrantListItem = {
    clientId: "u18-example-app",
    clientName: "Example App",
    logoUrl: null,
    scopes: ["openid"],
    grantedAt: "2026-10-24T00:00:00.000Z",
  };

  const EXTERNAL: AppCatalogEntry = {
    id: "example",
    name: "Example App",
    description: "説明",
    url: "https://app.example/",
    category: "service",
    clientId: "u18-example-app",
  };

  const SAME_ORIGIN: AppCatalogEntry = {
    id: "nfc",
    name: "NFC カード",
    description: "説明",
    url: "/account/nfc",
    category: "service",
  };

  function labelOf(key: AppCatalogEntry["category"]): string {
    const category = APP_CATEGORIES.find((c) => c.key === key);
    if (category === undefined) throw new Error(`未知のカテゴリ: ${key}`);
    return category.label;
  }

  it("実物のカタログを端から端まで描く", async () => {
    const html = await (await withCookie(APPS_PATH, FULL_IDENTITY)).text();

    // **0 件も正当な状態なので、両方を明示的に見る。** `for` を回すだけだと
    // 空になった日に 0 周で緑になり、このテストは何も守らなくなる。
    if (APP_CATALOG.length === 0) {
      expect(html).toContain("まだありません");
      return;
    }

    for (const entry of APP_CATALOG) {
      expect(html, `${entry.name} が出ていない`).toContain(entry.name);
      expect(html, `${entry.name} の説明が出ていない`).toContain(entry.description);
      // `href` に入っているので、内部・外部のどちらでも必ず現れる。
      expect(html, `${entry.name} の行き先が出ていない`).toContain(`href="${entry.url}"`);
    }

    // **カテゴリ名はサイドバーにも同じ語がある。** カードの見出しで絞らないと、
    // 一覧が空の画面でも通る。
    //
    // 絞り込みに使っているのは Kiwa UI の `data-slot`（#332）。**見た目の
    // class を目印にしない** —— `panel-title` を見ていたときは、画面を
    // Kiwa へ移しただけでここが落ちた。落ちたのは正しいが、**直し先が
    // 「次のスタイルシートの class 名」になる**ので、移行のたびに同じ
    // 書き換えが要る。`data-slot` は上流が構造を表すために置いている
    // 属性で、スタイルシートが変わっても付いてくる。
    for (const key of new Set(APP_CATALOG.map((entry) => entry.category))) {
      expect(html, `${labelOf(key)} の見出しがカードに無い`).toContain(
        `data-slot="card-title" class="leading-none">${labelOf(key)}`,
      );
    }

    expect(html).not.toContain("まだありません");
  });

  it("いま載せているもの", () => {
    // **増減を黙って通さない。** 上のテストは「載っているものが描けるか」を
    // 見るだけなので、1 件減っても緑のまま。何が載っているかはここで固定する。
    expect(APP_CATALOG.map((entry) => `${entry.category}:${entry.id}`)).toEqual([
      "service:nfc-cards",
    ]);
  });

  it("載せた行き先は https に解決できる", () => {
    // `javascript:` や平文 http を落とす関門（`isAllowedUrl`）に、
    // **実物が通ること**を確かめる。0 件だと空振りするので件数も見る。
    expect(APP_CATALOG.length).toBeGreaterThan(0);
    for (const entry of APP_CATALOG) {
      expect(isAllowedUrl(entry.url), `${entry.name} の url が ${entry.url}`).toBe(true);
    }
  });

  it("カタログが 0 件でも画面が壊れない", async () => {
    // **枠だけ作って埋まっているように見せない**（#306）。載せられるものが
    // 無いことは、それ自体が伝えたい状態である。
    expect(buildAppCatalog([], []).groups).toEqual([]);

    const html = await renderApps(buildAppCatalog([], []));

    expect(html).toContain("まだありません");
    // 見出しだけ残ると「読み込みに失敗した」に見える。
    expect(html).not.toContain('panel-title">サービス');
  });

  it("中身の無いカテゴリを出さない", () => {
    expect(buildAppCatalog([SAME_ORIGIN], []).groups.map((g) => g.category.key)).toEqual([
      "service",
    ]);
  });

  it("出せない url の行は落とす", () => {
    // いまは手書きなので実害が無いが、カタログを D1 へ移すと
    // `url` は運用者が画面から入れた文字列になる。
    const bad: AppCatalogEntry = { ...SAME_ORIGIN, id: "bad", url: "javascript:alert(1)" };
    const html = buildAppCatalog([bad], []);

    expect(html.groups).toEqual([]);
  });

  describe("「連携済み」は listGrants の結果と一致する", () => {
    it("grants に同じ client_id があれば連携済み", async () => {
      const view = buildAppCatalog([EXTERNAL], [GRANT]);

      expect(view.groups[0]?.items[0]?.connected).toBe(true);
      expect(await renderApps(view)).toContain("連携済み");
    });

    it("grants に無ければバッジを出さない", async () => {
      const view = buildAppCatalog([EXTERNAL], []);

      expect(view.groups[0]?.items[0]?.connected).toBe(false);
      expect(await renderApps(view)).not.toContain("連携済み");
    });

    it("別の client_id の grant では連携済みにしない", () => {
      const other = buildAppCatalog([EXTERNAL], [{ ...GRANT, clientId: "u18-other" }]);

      expect(other.groups[0]?.items[0]?.connected).toBe(false);
    });

    it("client_id を持たないアプリは、連携の有無を一切出さない", async () => {
      // 同一オリジンでセッション Cookie を直接読むアプリ（NFC）は OAuth を
      // 通らない。**「未連携」と出すと嘘になる。** `false` ではなく `null`。
      const view = buildAppCatalog([SAME_ORIGIN], [GRANT]);

      expect(view.groups[0]?.items[0]?.connected).toBe(null);

      const html = await renderApps(view);
      expect(html).not.toContain("連携済み");
      expect(html).not.toContain("未連携");
    });
  });

  describe("listGrants が取れなくても一覧を出す", () => {
    /**
     * **この画面はダッシュボードで唯一「RPC が失敗しても出せる中身がある」。**
     * 他の 5 枚は一覧そのものが RPC の戻り値だが、こちらは本体がコードの
     * 中にあり、RPC はバッジのためだけに呼んでいる。
     */
    it("503 にせず 200 で描く", async () => {
      const response = await withCookie(APPS_PATH, {
        ...FULL_IDENTITY,
        listGrants: async () => rpcErr("internal", "sqlite: no such table: oauth_grants"),
      });

      expect(response.status).toBe(200);

      const html = await response.text();
      for (const entry of APP_CATALOG) expect(html).toContain(entry.name);
      // auth-worker 側の事情を画面へ出さない。
      expect(html).not.toContain("sqlite");
    });

    it("確認できていないことを黙らない", async () => {
      // 黙ってバッジを消すと、連携しているのにしていないように見える。
      const html = await (
        await withCookie(APPS_PATH, {
          ...FULL_IDENTITY,
          listGrants: async () => rpcErr("internal", "boom"),
        })
      ).text();

      expect(html).toContain("連携状況を確認できません");
    });

    it("grants が null なら connected は false ではなく null", () => {
      // `false`（まだ同意していない）に畳むと、「未連携」と読める情報を
      // 出せてしまう。
      const view = buildAppCatalog([EXTERNAL], null);

      expect(view.grantsKnown).toBe(false);
      expect(view.groups[0]?.items[0]?.connected).toBe(null);
    });

    it("取れたときは余計なことを言わない", async () => {
      const html = await (await withCookie(APPS_PATH, FULL_IDENTITY)).text();

      expect(html).not.toContain("連携状況を確認できません");
    });

    it("セッションが切れていれば 401 にする", async () => {
      // 一覧を出しても、サイドバーの行き先が全部 401 になる。
      const response = await withCookie(APPS_PATH, {
        ...FULL_IDENTITY,
        listGrants: async () => rpcErr("unauthenticated", "session expired"),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("外部サイトへのリンク", () => {
    it("別ホストへ出すリンクには rel が付く", async () => {
      const html = await renderApps(buildAppCatalog([EXTERNAL], []));

      expect(html).toContain('rel="noopener noreferrer"');
    });

    it("同一オリジンのリンクには付けない", async () => {
      // 付けても害は無いが、**付いていることが「外部だ」の合図でなくなる。**
      const html = await renderApps(buildAppCatalog([SAME_ORIGIN], []));

      expect(html).not.toContain('rel="noopener noreferrer"');
    });

    it.each([
      ["//evil.example/", "プロトコル相対"],
      ["/\\evil.example/", "バックスラッシュ（特別スキームでは / として読まれる）"],
      ["https://app.example/", "ふつうの絶対 URL"],
    ])("%s を外部と判定する（%s）", (url) => {
      // **文字列の形で判定していたら取りこぼす形。** `new URL()` に
      // 解決させてオリジンを比べている。
      expect(isExternalUrl(url)).toBe(true);
    });

    it("同一オリジンの絶対パスは内部と判定する", () => {
      expect(isExternalUrl("/account/nfc")).toBe(false);
    });

    it("出て行くリンクだけ URL を併記する", async () => {
      // 押す前にどこへ行くのか分かる必要があるのは外部だけ。内部にも出すと
      // パスと全体 URL が同じ見た目で並び、どれが外部なのか読めなくなる。
      const external = await renderApps(buildAppCatalog([EXTERNAL], []));
      const internal = await renderApps(buildAppCatalog([SAME_ORIGIN], []));

      // **「文字として出ているか」で見る。** `href` にも同じ値が入るので、
      // 要素の中身であること（`>...<`）まで見ないと区別が付かない。
      // class 名を目印にしない理由は「実物のカタログを端から端まで描く」を参照。
      expect(external).toContain(">https://app.example/</p>");
      expect(internal).not.toContain(">/account/nfc</p>");
    });
  });

  it("この画面は JavaScript を要求しない", async () => {
    // 読むだけの画面なので `<script>` を出さない。
    const html = await (await withCookie(APPS_PATH, FULL_IDENTITY)).text();

    expect(html).not.toContain("<script");
  });

  // **インラインの `style` を書かないことはここで見ない。** #320 が
  // `PAGES` 全体を見る検査を足しており（上の「CSP が許していないものを
  // 画面が使っていない」）、`APPS_PATH` はそこに入っている。こちらにも
  // 書くと、同じことを 2 箇所で見て片方だけ古くなる。
});
