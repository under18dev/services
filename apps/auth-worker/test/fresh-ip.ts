/**
 * テストが名乗る `CF-Connecting-IP` の割り当て（#237 の続き）。
 *
 * ## なぜ 1 箇所に集めるのか
 *
 * **レート制限の枠は IP 単位で、binding の状態はテストファイルをまたいで
 * 共有される。** 2 つのファイルが同じアドレスを使うと枠を食い合い、
 * どちらかが無関係な理由で落ちる。
 *
 * しかもその落ち方は**実行の速さに依存する。** 窓は 60 秒で、手元では
 * 10 回撃つのに 400ms しか掛からないが、CI では前のテストが同じ IP に
 * 触れてから何秒経っているかが変わる。**手元で何度走らせても緑で、
 * CI でだけ落ちる**ので、原因に辿り着きにくい。
 *
 * 実際 #252 の CI で `rate-limit-form.test.ts` の「宛先を変えても上限で
 * 止まる」が `expected 200 to be 429` で落ちた。あのファイルと
 * `rate-limit.test.ts` が**両方 `203.0.113.x` を使っていた。**
 *
 * ## 表そのものが検査になっている
 *
 * 下の `RANGES` は**重なってはならない**。`test/fresh-ip.test.ts` が
 * 総当たりで確かめる。ファイルを足す人はここに 1 行足すので、
 * **重なりに気づかないまま足すことができない。**
 *
 * ## TEST-NET に収める
 *
 * RFC 5737 が文書・例示用に予約しているのは 3 つだけ
 * （`192.0.2.0/24` / `198.51.100.0/24` / `203.0.113.0/24`）。
 * テストファイルのほうが多いので、**第 3 オクテットではなく第 4 を
 * 分ける。** 実在しうるアドレスを書かないため。
 */

/** 誰が使うか。**1 つの値を 2 つのファイルで使わない。** */
export type IpScope =
  | "login-ui"
  | "signup-ui"
  | "rate-limit"
  | "rate-limit-form"
  | "oauth-helpers"
  /**
   * **配らない。直書き用に空けてある範囲。**
   *
   * 巡回させず 1 つの値を書いているファイルがある
   * （`audit-request-context.test.ts` の `198.51.100.42` など）。それらが
   * 巡回の範囲に入っていると、**その値を `CF-Connecting-IP` に載せた瞬間に
   * 枠を食い合う。** ここを予約しておけば、表の中だけで衝突が決まる。
   */
  | "fixed-values";

type Range = {
  /** `a.b.c` まで。 */
  readonly prefix: string;
  /** 使う第 4 オクテットの範囲（両端を含む）。 */
  readonly from: number;
  readonly to: number;
};

/**
 * 割り当て表。
 *
 * **`fixed-values` が直書き用の範囲である。** `scripts/check-test-ip-ranges.mjs`
 * が実際のテストファイルを走査して、**巡回の範囲に直書きが混ざっていないか**を
 * 見る。一覧を手で並べない —— 最初はそうしていて、**`203.0.113.1` を 4 ファイルが
 * 直書きしているのに一覧が 2 つしか持っておらず、検査の題と中身が食い違っていた。**
 */
export const RANGES: Readonly<Record<IpScope, Range>> = {
  "login-ui": { prefix: "192.0.2", from: 1, to: 99 },
  "signup-ui": { prefix: "192.0.2", from: 100, to: 199 },
  "rate-limit": { prefix: "203.0.113", from: 1, to: 99 },
  "rate-limit-form": { prefix: "203.0.113", from: 100, to: 199 },
  "oauth-helpers": { prefix: "198.51.100", from: 100, to: 199 },
  // **配らない。** 直書きしているファイルのための範囲。
  "fixed-values": { prefix: "198.51.100", from: 1, to: 99 },
};

/**
 * **配る** scope。
 *
 * `fixed-values` は予約だけなので含まない。**型で分けてある** ——
 * `filter` で外す形だと、次に予約範囲が増えたときに書き足しが要り、
 * 忘れても何も起きない。型なら渡した時点で落ちる。
 */
export type IssuingScope = Exclude<IpScope, "fixed-values">;

/**
 * その scope 専用のアドレスを順に返す関数を作る。
 *
 * **範囲を使い切ったら先頭へ戻る。** 1 ファイルが 100 要求を超えると
 * 自分自身と衝突しうるが、そこは同じファイルの中なので読めば分かる。
 * 読んでも分からないファイルまたぎの衝突だけを、この表が消している。
 */
export function freshIpFactory(scope: IssuingScope): () => string {
  const { prefix, from, to } = RANGES[scope];
  const span = to - from + 1;
  let n = 0;
  return () => `${prefix}.${from + (n++ % span)}`;
}
