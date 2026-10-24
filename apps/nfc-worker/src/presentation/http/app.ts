import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createContainer, type ContainerOverrides } from "../../composition/container";
import { registerCardRoutes } from "./cards.routes";
import { registerRedirectRoutes } from "./redirect.routes";
import type { AppBindings } from "./types";

/**
 * 管理 API のベースパス。
 *
 * **auth-worker と同一ホストの `/account/nfc/*` に載せる。**
 *
 * セッション Cookie は `__Host-` 接頭辞を使っており、Domain 属性を
 * 付けられない = 発行したホストにしか送られない
 * （`packages/contracts/src/session-cookie.ts`）。
 * 管理 API を `go.under18.dev` に置くと、ログイン済みのブラウザから
 * Cookie が届かず、永久に 401 になる。短縮 URL のホストと
 * 管理画面のホストを分ける判断は、ここで決まっている。
 *
 * dashboard-worker が `auth.under18.dev/account/*` を取っているため、
 * route の衝突に注意すること（wrangler.jsonc に詳述）。
 */
export const CARDS_BASE_PATH = "/account/nfc/cards";

/**
 * nfc-worker の HTTP アプリ。
 *
 * ## ルートを `src/index.ts` ではなくここに置く理由
 *
 * dashboard-worker はルート定義を `src/index.ts` に直接書いている。
 * ところが `packages/config/eslint.layers.js` のレイヤ規則は
 * 各 Worker の `src/presentation/` 配下だけを対象にしているので、
 * **`src/index.ts` に書いたハンドラはレイヤ lint の対象外**になる
 * （docs/architecture.md 9-2 が指摘している）。
 *
 * nfc-worker のハンドラは認可の入口そのものなので、
 * 「Presentation が Infrastructure を直接触っていない」ことを
 * 人のレビューではなく lint で保証したい。そのために
 * `presentation/http/` を切り、`src/index.ts` は Worker の
 * エクスポートだけを持つ薄い層にしてある。
 */
export function createApp(overrides: ContainerOverrides = {}): Hono<AppBindings> {
  // `strict: false` で末尾スラッシュの有無を同一視する。
  // 短縮 URL は人が手で打ち直したり、印刷物から転記したりする経路を
  // 想定しているので、`/c/<id>/` を 404 にする理由が無い。
  // 管理 API 側も同じ理由で揃えておく（一覧が `/cards` と `/cards/` で
  // 挙動を変えると、呼び出し側の書き方次第で 404 になる）。
  const app = new Hono<AppBindings>({ strict: false });

  app.use("*", secureHeaders());

  app.use("*", async (c, next) => {
    c.set("container", createContainer(c.env, overrides));
    await next();
  });

  app.get("/health", (c) =>
    // Identity にも D1 にも触れずに答える。死活確認が依存先の状態に
    // 引きずられると、どこが落ちているのか切り分けられなくなる
    // （dashboard-worker の /health と同じ方針）。
    c.json({ status: "ok", service: "u18-nfc", environment: c.env.ENVIRONMENT }),
  );

  registerRedirectRoutes(app);
  registerCardRoutes(app, CARDS_BASE_PATH);

  return app;
}
