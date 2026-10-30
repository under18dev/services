import { IMMUTABLE_ASSET_CACHE_CONTROL } from "@u18/web-ui";
import { KIWA_STYLESHEET_PATH, LOGIN_ISLAND_PATH } from "../src/presentation/http/ui/asset-paths";
import { SELF, createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createContainer } from "../src/composition/container";
import type { AppBindings } from "../src/presentation/http/app";
import { oauthRoutes } from "../src/presentation/http/oauth.routes";
import { requestContext } from "../src/presentation/http/request-context";

/**
 * `Cache-Control` が全経路に付いていること（#125 / 脅威モデル RR-10）。
 *
 * `/api/me` は利用者の本名・メールアドレス・管理者フラグを返す。明示しないと
 * 中間プロキシやブラウザの判断でキャッシュされうる。共用端末（学校・家庭）で
 * 前の利用者の情報が戻るのは避けたい。
 *
 * **OAuth 側には付いていたのに `/api/me` 系には 1 つも付いていなかった。**
 * 経路ごとに書く形だったのが原因なので、既定をミドルウェアで立てて
 * 「意図的に違う値を使う経路だけが上書きする」形にした。
 */

const BASE = "http://localhost";

describe("既定で no-store が付く", () => {
  // 認証を通さなくてよい。**401 でも付いている必要がある** ——
  // 失敗応答がキャッシュされると、後からログインしても 401 が返りうる。
  it.each(["/api/me", "/api/me/sessions", "/api/me/passkeys", "/api/me/grants", "/health"])(
    "%s",
    async (path) => {
      const response = await SELF.fetch(`${BASE}${path}`);

      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("未知のパス（404）にも付く", async () => {
    // notFound ハンドラもミドルウェアを通る。ここが抜けると
    // 「存在しないパス」の応答だけキャッシュされる。
    const response = await SELF.fetch(`${BASE}/no-such-path`);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("意図的に違う値を使う経路は既定に飲まれない", () => {
  it.each([
    ["/.well-known/openid-configuration", "public, max-age=300"],
    // アセットは URL に内容ハッシュが入るので永久に持たせてよい（#211）。
    // **パスを書き写さず `asset-paths.ts` から取る** —— 書き写すと
    // ハッシュが変わるたびに 404 を見ることになり、キャッシュの値を
    // 見るつもりの検査が「パスが合っているか」の検査に化ける。
    [KIWA_STYLESHEET_PATH, IMMUTABLE_ASSET_CACHE_CONTROL],
    [LOGIN_ISLAND_PATH, IMMUTABLE_ASSET_CACHE_CONTROL],
  ])("%s は %s", async (path, expected) => {
    const response = await SELF.fetch(`${BASE}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(expected);
  });
});

/**
 * **ミドルウェアを外しても付いていること。**
 *
 * RFC 6749 §5.1 と RFC 7009 が要求しているのは**その経路の性質**であって、
 * ミドルウェアの既定ではない。経路側の明示的な行を誰かが消しても、
 * ミドルウェアが代わりに付けてしまうので**通常のテストでは落ちない**。
 *
 * そこで、既定を立てるミドルウェアを**含まない**アプリに OAuth の経路だけを
 * 載せて確かめる。ここが落ちたら、経路側の行が消えている。
 */
describe("RFC が要求する経路は、既定のミドルウェア無しでも no-store", () => {
  function bareApp() {
    const app = new Hono<AppBindings>();
    // 既定の Cache-Control は**付けない**。container だけ用意する。
    app.use("*", async (c, next) => {
      c.set("container", createContainer(c.env, {}, requestContext(c)));
      await next();
    });
    app.route("/", oauthRoutes);
    return app;
  }

  it.each([
    ["/oauth/token", "POST"],
    ["/oauth/revoke", "POST"],
    ["/oauth/userinfo", "GET"],
  ])("%s %s", async (path, method) => {
    const request = new Request(`${BASE}${path}`, {
      method,
      ...(method === "POST"
        ? {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "grant_type=authorization_code",
          }
        : {}),
    });

    const response = await bareApp().fetch(request, env, createExecutionContext());

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
