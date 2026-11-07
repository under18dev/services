/**
 * base64 で埋め込んだバイナリアセットを配信用の `Uint8Array` に戻す。
 *
 * ## なぜ base64 なのか
 *
 * CSS / JS の生成物（`kiwa-stylesheet.ts` 等）は `JSON.stringify` した
 * UTF-8 文字列をそのまま TS の定数にしている（`build-client.mjs`）。
 * woff2 はバイナリなので、同じやり方で `"utf8"` として読むと壊れる——
 * 無効な UTF-8 バイト列は読み込み時に別のバイト列へ置き換えられる。
 * base64 を経由すれば、純粋な ASCII 文字列として既存の
 * `JSON.stringify` 埋め込みパターンに乗せられる。
 *
 * ## なぜ配信のたびにデコードしないのか
 *
 * 呼び出し側は `bytesFromBase64()` の結果をモジュールのトップレベルで
 * 1 回だけ呼び、できた `Uint8Array` を使い回すこと。Workers の isolate は
 * 複数リクエストにまたがって再利用されるので、リクエストのたびに
 * デコードし直すのは無駄な CPU 時間になる。
 */
export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
