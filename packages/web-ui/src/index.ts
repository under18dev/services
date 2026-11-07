export * from "./asset-hash";
export * from "./binary-asset";
export * from "./csrf";
export * from "./layout";
export * from "./page-headers";
export * from "./scopes";

/**
 * **`./google-sans-font` はここから re-export しない。**
 *
 * `google-sans-font.ts` はトップレベルで `bytesFromBase64(...)` を呼び、
 * 57,576 文字の base64 を `Uint8Array` へデコードする。esbuild は任意の
 * 関数呼び出しを副作用なしとは仮定しないので、この呼び出しは tree-shaking
 * で落ちない——barrel 経由で 1 つでも import すると、何も使っていない
 * Worker にまで 57KB 強が巻き込まれる（`island-classes.ts` が
 * `getButtonClasses()` で踏んだのと同じ形、services-3b が実測：
 * `pageSecurityHeaders` だけを barrel から import したバンドルが
 * 729 バイト -> 58,596 バイトに膨らんだ）。
 *
 * フォントを使う側は `@u18/web-ui/google-sans-font` を直接 import する
 * こと（`package.json` の `exports` を参照）。戻さないことを
 * `test/bundle-size.test.ts` が検査している。
 */
