import { createApp } from "./presentation/http/app";

/**
 * Worker のエクスポートだけを持つ薄い層。
 *
 * ルート定義を `presentation/http/app.ts` に置くのは、`eslint.layers.js`
 * のレイヤ規則が各 Worker の `src/presentation/` 配下だけを見るため
 * （`apps/nfc-worker/src/presentation/http/app.ts` と同じ理由）。
 */
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    createApp().fetch(request, env, ctx),
};
