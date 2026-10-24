import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createContainer } from "../../composition/container";
import { authRoutes } from "./auth.routes";
import { healthRoutes } from "./health.routes";
import { meRoutes } from "./me.routes";
import { oauthRoutes } from "./oauth.routes";
import { problem } from "./problem";
import type { AppBindings } from "./types";

export type { AppBindings } from "./types";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use("*", secureHeaders());

  // コンテナの組み立てをミドルウェアに閉じ込め、各ルートは
  // `c.get("container")` だけを見る。ルートから Env を直接触らせない。
  app.use("*", async (c, next) => {
    c.set("container", createContainer(c.env));
    await next();
  });

  app.route("/", healthRoutes);
  app.route("/", oauthRoutes);
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
