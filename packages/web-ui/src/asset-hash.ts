/**
 * 配信するアセットの URL に入れる内容ハッシュ（#211）。
 *
 * ## なぜ要るのか
 *
 * CSS とアイランド JS は URL が固定で `max-age` 付きだった。**デプロイ
 * 直後に、古いアセットと新しいサーバーが最大 5 分重なる。** いまは
 * アイランドが送るのが `$delete` だけなので壊れようがないが、契約に本文が
 * 増えた瞬間に「デプロイ直後の 5 分だけ保存できない人がいる」が起きる。
 * **再現しないので原因に辿り着けない**類の障害になる。
 *
 * URL に内容が混ざっていれば、中身が変われば URL も変わる。古い URL を
 * 掴んでいるブラウザは古い中身を使い続け、新しいページは新しい URL を
 * 指すので、**重なりそのものが消える。** そうなると `immutable` を付けられ、
 * `max-age` を短くしておく理由も無くなる。
 *
 * ## なぜビルド時ではなく実行時に計算するのか
 *
 * ビルドスクリプトにハッシュを吐かせる形も考えたが、**生成物とハッシュが
 * ずれる余地**が残る。#132（生成が走らないままデプロイされた）と同じ形で、
 * 「ハッシュだけ古い」状態はブラウザから見ると**内容が変わったのに URL が
 * 同じ** —— いま直そうとしているものがそのまま戻る。
 *
 * 配信する文字列そのものから計算すれば、ずれようがない。計算は
 * モジュール読み込み時に 1 回だけで、50 KiB 程度なら数十マイクロ秒である。
 *
 * ## なぜ暗号学的ハッシュではないのか
 *
 * 必要なのは「中身が変われば値が変わる」だけで、**衝突を作られて困る
 * 場面が無い**（攻撃者が中身を選べるなら、その時点でアセットを差し替え
 * られている）。WebCrypto の `subtle.digest` は非同期なので、モジュールの
 * トップで使うと起動時に await が要る。同期で済む FNV-1a を使う。
 *
 * 32 bit だとデプロイを重ねるうちに前回と同じ値を引きうるので、
 * **異なる初期値で 2 本回して 64 bit 相当**にしている。
 */

const FNV_PRIME = 0x01000193;
const FNV_OFFSET_A = 0x811c9dc5;
/** 2 本目の初期値。素性は問わない。1 本目と違えばよい。 */
const FNV_OFFSET_B = 0x7fffffff;

function fnv1a(input: string, offset: number): number {
  let hash = offset;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 32 bit に畳む。`*` は精度が足りないので Math.imul を使う。
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * アセットの内容から URL に入れる短い文字列を作る。
 *
 * 16 進 16 文字。**中身が 1 バイトでも変われば変わる**ことだけが要件で、
 * 値そのものに意味は無い。
 */
export function assetHash(content: string): string {
  const a = fnv1a(content, FNV_OFFSET_A).toString(16).padStart(8, "0");
  const b = fnv1a(content, FNV_OFFSET_B).toString(16).padStart(8, "0");
  return `${a}${b}`;
}

/**
 * `foo.js` と内容から `foo.<hash>.js` を作る。
 *
 * **拡張子の前に入れる。** 末尾に付けると `Content-Type` を拡張子で
 * 決めている経路（Workers Assets や中間プロキシ）が別の型だと思う。
 */
export function hashedFileName(fileName: string, content: string): string {
  const dot = fileName.lastIndexOf(".");
  const hash = assetHash(content);
  if (dot <= 0) return `${fileName}.${hash}`;
  return `${fileName.slice(0, dot)}.${hash}${fileName.slice(dot)}`;
}

/**
 * ハッシュ付きで配信するアセットの `Cache-Control`。
 *
 * **URL が内容ごとに変わるので、永久にキャッシュしてよい。** 1 年は
 * RFC 9111 が「これ以上は意味がない」としている上限に合わせた値。
 * `immutable` は再検証そのものを止める（付けないと、再読み込みのたびに
 * 条件付き要求が飛ぶ）。
 */
export const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
