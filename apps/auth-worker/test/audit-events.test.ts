import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS } from "../src/application/ports/audit-log.port";

/**
 * 監査イベント名の登録簿（`AUDIT_EVENTS`）と実装を照合する（#22）。
 *
 * 型だけでは片側しか守れない。**登録簿に無い名前を書けば TypeScript が
 * 止めてくれるが、登録簿に足しただけでどこからも発行されない名前は
 * 何も言わずに残る。** 侵害調査で「このイベントが 1 件も出てこない」と
 * 分かるのは最悪の順序なので、ここで実装側から見て照合する。
 *
 * 走査結果は `vitest.config.ts` が Node 側で集めてバインディング経由で
 * 渡している（テスト本体は workerd の中で動くので node:fs を使えない）。
 */
describe("AUDIT_EVENTS と実装", () => {
  const inSource = [...new Set(env.TEST_AUDIT_EVENT_NAMES)].sort();
  const registered: string[] = [...AUDIT_EVENTS].sort();

  it("登録簿の名前はすべて src から発行されている", () => {
    const dead = registered.filter((name) => !inSource.includes(name));

    expect(dead, "登録簿にあるが src のどこからも発行されていない").toEqual([]);
  });

  it("src で使われている名前はすべて登録簿にある", () => {
    // こちらは通常 TypeScript が先に止める。`as AuditEventName` のような
    // キャストで型検査をすり抜けた場合にだけ、ここが最後の網になる。
    const unregistered = inSource.filter((name) => !registered.includes(name));

    expect(unregistered, "src で発行されているが登録簿に無い").toEqual([]);
  });

  it("登録簿に重複が無い", () => {
    expect(registered.length).toBe(new Set(registered).size);
  });
});
