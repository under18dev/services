import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENTS,
  AUDIT_EVENT_RETENTION,
  auditEventDeadlines,
} from "../src/application/ports/audit-log.port";
import { AuditRetention } from "../src/domain/services/retention-policy";

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

/**
 * 保持区分と登録簿の照合（#22）。
 *
 * `Record<AuditEventName, ...>` なので**網羅は型が守る**。ここで見るのは
 * 型をすり抜ける形——キャストで足した名前、改名の片側忘れ——と、
 * 区分そのものの不変条件である。
 */
describe("AUDIT_EVENT_RETENTION", () => {
  const classified = Object.keys(AUDIT_EVENT_RETENTION).sort();
  const registered = [...AUDIT_EVENTS].sort();

  it("登録簿と過不足なく一致する", () => {
    // 片方だけ改名すると、改名後の名前が既定（180 日）に落ちる。
    // 長期側のつもりのイベントが静かに半年で消え始める形になる。
    expect(classified).toEqual(registered);
  });

  it("ops. のイベントはすべて security", () => {
    // **運用者が wrangler 越しに書くものは、どれも支配権に関わる**
    // （いまは管理権限の付与・剥奪）。180 日で消えると、
    // 「誰がいつ管理者にしたか」が半年で分からなくなる。
    //
    // **長らく登録簿に無く、区分が付かないまま 180 日で消えていた**
    // （#270）。直したあとに戻せないよう、ここで固定する ——
    // 直前の状態では、区分を standard に書き換えても**どのテストも
    // 落ちなかった。**
    const ops = Object.entries(AUDIT_EVENT_RETENTION).filter(([event]) => event.startsWith("ops."));

    expect(ops.length, "ops. のイベントが 1 つも無い").toBeGreaterThan(0);
    for (const [event, tier] of ops) {
      expect(tier, `${event} は security であること`).toBe("security");
    }
  });

  it("security は standard より長い", () => {
    // 逆転すると「長期側に置いたのに先に消える」になる。
    expect(AuditRetention.security).toBeGreaterThan(AuditRetention.standard);
  });

  it("境界は security 区分のイベントにだけ出る", () => {
    const deadlines = auditEventDeadlines(new Date("2026-10-24T00:00:00.000Z"));
    const expected = Object.entries(AUDIT_EVENT_RETENTION)
      .filter(([, tier]) => tier !== "standard")
      .map(([event]) => event)
      .sort();

    expect([...deadlines.keys()].sort()).toEqual(expected);
    // standard を入れると既定と同じ条件を 2 回書くことになる。
    expect(deadlines.size).toBeLessThan(registered.length);
  });

  it("security 区分が空にならない", () => {
    // 全部 standard に倒れたら、区分化そのものが効いていない。
    const secured = Object.values(AUDIT_EVENT_RETENTION).filter((t) => t === "security");
    expect(secured.length).toBeGreaterThan(0);
  });

  it("長期側は量の少ないイベントに限る", () => {
    // リクエストごとに 1 行出るイベントを 2 年持つと、区分化の目的
    // （行数を抑えつつ調査に要る記録を残す）と逆を向く。
    // 名前を直書きしているのは、「量が多い」が型で表現できないため。
    const perRequest = [
      "oauth.userinfo",
      "oauth.token.issued",
      "oauth.token.exchange",
      "oauth.client.authenticate",
      "session.issue",
      "session.rejected",
      "retention.sweep",
    ] as const;

    for (const event of perRequest) {
      expect(AUDIT_EVENT_RETENTION[event], `${event} を長期側に置いている`).toBe("standard");
    }
  });
});
