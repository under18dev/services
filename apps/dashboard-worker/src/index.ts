import { createApp } from "./presentation/http/app";

/**
 * Worker のエントリ。
 *
 * **ここには既定の export 以外を置かないこと。** Worker のエントリ
 * モジュールは既定ハンドラと Entrypoint クラス以外の名前付き export を
 * 持てず、置くと workerd が起動時に
 *   `Incorrect type for map entry '<名前>':
 *    the provided value is not of type 'function or ExportedHandler'`
 * で落ちる。**この失敗は vitest でも `wrangler deploy --dry-run` でも
 * 検出されない**（実測）。
 *
 * ルート定義が `presentation/http/app.ts` にあるのは、レイヤ lint の
 * 対象が `src/presentation/` 配下だけだから（#119）。
 */
export default createApp() satisfies ExportedHandler<Env>;
