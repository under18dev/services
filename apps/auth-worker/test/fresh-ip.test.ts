import { describe, expect, it } from "vitest";
import { freshIpFactory, RANGES, type IpScope, type IssuingScope } from "./fresh-ip";

/**
 * 割り当てが重なっていないこと。
 *
 * **これが落ちたら、2 つのテストファイルがレート制限の枠を食い合う。**
 * その落ち方は実行の速さに依存するので、**手元では何度走らせても緑で、
 * CI でだけ落ちる**（#252 で実際にそうなった）。ここで止める。
 */
describe("IP の割り当て", () => {
  const scopes = Object.keys(RANGES) as IpScope[];
  /** **配る scope だけ。** 予約した範囲を巡回させてはいけない。 */
  const issuing = scopes.filter((scope) => scope !== "fixed-values") as IssuingScope[];

  it("範囲が重ならない", () => {
    const owner = new Map<string, IpScope>();

    for (const scope of scopes) {
      const { prefix, from, to } = RANGES[scope];
      for (let i = from; i <= to; i += 1) {
        const address = `${prefix}.${i}`;
        const existing = owner.get(address);
        expect(existing, `${address} が ${existing} と ${scope} で重なっている`).toBeUndefined();
        owner.set(address, scope);
      }
    }
  });

  it("配る範囲に fixed-values を含めない", () => {
    // **`fixed-values` は予約だけで、誰にも配らない。** 直書きしている
    // ファイル（`audit-request-context.test.ts` の `198.51.100.42` など）
    // のために空けてある。
    //
    // **直書きが巡回の範囲に入っていないかは、ここでは見ない。**
    // 最初はここに一覧を手で並べていて、**`203.0.113.1` を 4 ファイルが
    // 直書きしているのに一覧が 2 つしか持っていなかった** —— 検査の題と
    // 中身が食い違っていた。実際のファイルを走査する
    // `scripts/check-test-ip-ranges.mjs` に移してある。
    const scopesExceptFixed = scopes.filter((scope) => scope !== "fixed-values");
    expect(scopesExceptFixed).not.toContain("fixed-values");
    expect(scopesExceptFixed.length).toBe(scopes.length - 1);
  });

  it("TEST-NET の中に収まっている", () => {
    // RFC 5737 が文書・例示用に予約している 3 つ。実在しうるアドレスを
    // テストに書かない。
    const reserved = ["192.0.2", "198.51.100", "203.0.113"];

    for (const scope of scopes) {
      expect(reserved, `${scope} の prefix`).toContain(RANGES[scope].prefix);
    }
  });

  it("範囲の端を外れない", () => {
    for (const scope of issuing) {
      const { from, to } = RANGES[scope];
      const next = freshIpFactory(scope);
      // 一周より多く回して、戻ってきても範囲内であること。
      for (let i = 0; i < (to - from + 1) * 2 + 3; i += 1) {
        const octet = Number(next().split(".")[3]);
        expect(octet).toBeGreaterThanOrEqual(from);
        expect(octet).toBeLessThanOrEqual(to);
      }
    }
  });

  it("順に違う値を返す", () => {
    const next = freshIpFactory("rate-limit");
    expect(next()).not.toBe(next());
  });
});
