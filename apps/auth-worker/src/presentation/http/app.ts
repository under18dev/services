import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createContainer } from "../../composition/container";
import { authRoutes } from "./auth.routes";
import { healthRoutes } from "./health.routes";
import { meRoutes } from "./me.routes";
import { oauthRoutes } from "./oauth.routes";
import { problem } from "./problem";
import { requestContext } from "./request-context";
import type { AppBindings } from "./types";
import { uiRoutes } from "./ui/login.routes";

export type { AppBindings } from "./types";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use("*", secureHeaders());

  // **キャッシュさせないのを既定にする（#125 / RR-10）。**
  //
  // `/api/me` は利用者の本名・メールアドレス・管理者フラグを返す。
  // 明示しないと、中間プロキシやブラウザの判断でキャッシュされうる。
  // 共用端末（学校・家庭）で前の利用者の情報が戻るのは避けたい。
  //
  // **経路ごとに書くと足し忘れる。** 実際、OAuth 側には付いていたのに
  // `/api/me` 系には 1 つも付いていなかった。既定で付けて、意図的に
  // 違う値を使う経路だけが上書きする形にする（`wrangler.jsonc` の
  // `env.production` と同じ「既定が安全側」の形）。
  //
  // 上書きが効くことは実測済み —— `c.header()` / `c.json(_, _, headers)` /
  // `c.body(_, _, headers)` のいずれも、ここで立てた値に勝つ。
  // 現在上書きしているのは JWKS（`public, max-age=300`）、Discovery（同）、
  // `/ui/*` の静的アセット（同）の 3 つ。
  //
  // **RFC が要求している経路（`/oauth/token` ほか）は、ここに頼らず
  // 経路側にも明示したままにしてある。** 根拠はその経路の性質であって
  // ミドルウェアの既定ではない。ここを変えた人が「RFC が要求している
  // 必須ヘッダを外した」ことに気づけるよう、diff に現れる形を残す。
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // コンテナの組み立てをミドルウェアに閉じ込め、各ルートは
  // `c.get("container")` だけを見る。ルートから Env を直接触らせない。
  //
  // 発信元もここで一度だけ読む（#122）。全ルートが同じミドルウェアを通るので、
  // 監査ログの `ip_hash` / `user_agent` はルート側が何もしなくても乗る。
  // ルートごとに渡す形にすると、足し忘れたルートだけが静かに欠ける。
  app.use("*", async (c, next) => {
    c.set("container", createContainer(c.env, {}, requestContext(c)));
    await next();
  });

  app.route("/", healthRoutes);
  app.route("/", oauthRoutes);
  // ログイン画面（仕様書 14-1 の決定 4）。セッション Cookie を発行するホストと
  // 同一オリジンである必要があるので、auth-worker 自身が配信する。
  app.route("/", uiRoutes);
  app.route("/api/auth", authRoutes);
  app.route("/api", meRoutes);

  app.notFound((c) => problem(c, 404, "not_found", "endpoint does not exist"));

  app.onError((error, c) => {
    // 内部例外の詳細をクライアントへ返さない。調査は Workers のログ側で行う。
    console.error("unhandled error", error);
    return problem(c, 500, "internal_error", "an unexpected error occurred");
  });

  return app;
}
