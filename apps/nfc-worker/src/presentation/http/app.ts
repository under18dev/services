import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createContainer, type ContainerOverrides } from "../../composition/container";
import { CARDS_BASE_PATH, CARDS_UI_PATH } from "./base-path";
import { registerCardRoutes } from "./cards.routes";
import { registerCardsUiRoutes } from "./ui/cards-ui.routes";
import { registerRedirectRoutes } from "./redirect.routes";
import type { AppBindings } from "./types";

// パスの定義は base-path.ts にある（ui/asset-paths.ts との循環を避けるため）。
export { CARDS_BASE_PATH, CARDS_UI_PATH };

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
    //
    // **`environment` は出さない**（脅威モデル RR-18）。未認証で叩ける
    // endpoint に構成情報を置かない —— ステージングの存在や構成が読める。
    // auth-worker と dashboard-worker からは RR-18 の時点で外したが、
    // **この Worker だけ残っていた**。`go.under18.dev/health` は実際に
    // 外から 200 を返す（#280）ので、公開されたままだった。
    //
    // `--env production` の付け忘れはここでは見ない。auth-worker の
    // Discovery の `issuer` で検出する（`deploy.yml`）。
    c.json({ status: "ok", service: "u18-nfc" }),
  );

  registerRedirectRoutes(app);
  registerCardRoutes(app, CARDS_BASE_PATH);
  // 画面は API より先に登録しない。`/account/nfc` と `/account/nfc/cards`
  // は別のパスなので衝突しないが、順序を揃えておくと読む側が迷わない。
  registerCardsUiRoutes(app, CARDS_UI_PATH);

  return app;
}
