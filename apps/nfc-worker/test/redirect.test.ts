import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { nfcCardTaps } from "@u18/nfc-db";
import { createApp } from "../src/presentation/http/app";
import {
  ORIGIN,
  db,
  executionContext,
  identityWith,
  repository,
  resetDatabase,
  seedActiveCard,
  seedClaimedCard,
  seedIssuedCard,
} from "./helpers";

/**
 * `GET /c/:cardId` のリダイレクト解決（#31）。
 *
 * 公開経路なので Identity は呼ばれない。カードを読むことと
 * アカウント認証は別の責務（仕様書 10）。
 */

// 呼ばれたら落ちる fake。この経路が Identity に触れないことを固定する。
const identity = identityWith({});

async function get(cardId: string): Promise<Response> {
  return await createApp({ identity }).fetch(
    new Request(`${ORIGIN}/c/${cardId}`),
    env,
    executionContext(),
  );
}

beforeEach(resetDatabase);

describe("解決できるカード", () => {
  it("所有者の設定した https: へ 302 で飛ばす", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");

    const response = await get(cardId);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://example.com/taro");
  });

  it("301 ではなく 302 を返し、no-store を付ける", async () => {
    // 301 だとブラウザが対応付けを無期限にキャッシュし、所有者が
    // 遷移先を変えても無効化しても、その端末は二度と問い合わせに来ない。
    // Phase 4 の完了条件（カードを書き換えずに遷移先を変更可能）と
    // 紛失時の無効化が、端末ごとに破れる。
    const cardId = await seedActiveCard("usr_taro");

    const response = await get(cardId);

    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("遷移先にカード ID を渡さない", async () => {
    // 第三者のサイトが「同じカードから来た訪問者」を名寄せできないようにする。
    const cardId = await seedActiveCard("usr_taro");

    const response = await get(cardId);

    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("遷移先を変えると次のタップから新しい URL になる", async () => {
    // これが Phase 4 の完了条件「カードを書き換えずに遷移先を変更可能」。
    const cardId = await seedActiveCard("usr_taro", "https://example.com/before");
    await repository().updateTarget(cardId, "usr_taro", "https://example.com/after", new Date());

    const response = await get(cardId);

    expect(response.headers.get("Location")).toBe("https://example.com/after");
  });
});

describe("解決しない場合、カードの実在を漏らさない", () => {
  /**
   * 「存在しない」「無効化済み」「遷移先未設定」で応答が 1 バイトも
   * 変わらないことを固定する（仕様書 9 の列挙対策）。
   *
   * **#358 で「未紐づけ」だけがここから外れた。** 外れたことは
   * 下の別の `it` が固定している —— **畳む側の検査から静かに消さない。**
   */
  async function snapshot(cardId: string) {
    const response = await get(cardId);
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get("Content-Type"),
      cacheControl: response.headers.get("Cache-Control"),
    };
  }

  it("3 つの状態がすべて同じ応答になる", async () => {
    const missing = await snapshot("nfc_doesnotexisthere1");

    // 所有者はいるが遷移先が未設定（紐づけ直後）。
    const noTarget = await seedClaimedCard("usr_taro");

    const disabledCard = await seedActiveCard("usr_taro");
    await repository().disable(disabledCard, "usr_taro", "lost", new Date());

    expect(await snapshot(noTarget)).toEqual(missing);
    expect(await snapshot(disabledCard)).toEqual(missing);
    expect(missing.status).toBe(404);
  });

  it("未紐づけのカードだけが紐づけ画面へ送られる（#358）", async () => {
    // **これが #358 で開けた 1 ビットである。** 畳む側の検査から
    // `issued` を外した以上、外した先をここが押さえる。
    const unclaimed = await seedIssuedCard();

    const response = await get(unclaimed);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.pathname).toBe("/account/nfc/claim");
    expect(location.searchParams.get("card")).toBe(unclaimed);
  });

  it("紐づけ画面への 302 にも no-store と no-referrer が付く", async () => {
    // 紐づけが済めば次のタップは遷移先へ行くので、この 302 を端末に
    // 握らせない。`no-referrer` は外部ページから来た場合の参照元を渡さない。
    const unclaimed = await seedIssuedCard();

    const response = await get(unclaimed);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("無効化済みは、未紐づけと同じ扱いにならない", async () => {
    // **一緒に緩めないこと。** 拾った人間に「このカードは止められている」と
    // 教えないのが紛失対策の本体で、`issued` を区別する変更に巻き込まれ
    // やすいのがここである。
    const disabledCard = await seedActiveCard("usr_taro");
    await repository().disable(disabledCard, "usr_taro", "lost", new Date());

    expect(await snapshot(disabledCard)).toEqual(await snapshot("nfc_doesnotexisthere2"));
  });

  it("無効化されたカードは解決されない", async () => {
    const cardId = await seedActiveCard("usr_taro", "https://example.com/taro");
    expect((await get(cardId)).status).toBe(302);

    await repository().disable(cardId, "usr_taro", "lost", new Date());

    const response = await get(cardId);
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("応答にカード ID を含めない", async () => {
    // エラー画面がカード ID の反射先になると、そこ自体が
    // 攻撃者の作った文字列を表示する場所になる。
    const response = await get("nfc_reflectthisplease");
    expect(await response.text()).not.toContain("reflectthisplease");
  });

  it("形の不正なカード ID も同じ 404 になる", async () => {
    // 「形が不正」と「存在しない」を区別すると、カード ID の形を教えることになる。
    const response = await createApp({ identity }).fetch(
      new Request(`${ORIGIN}/c/${encodeURIComponent("../../etc/passwd")}`),
      env,
      executionContext(),
    );
    expect(response.status).toBe(404);
  });
});

describe("https 以外は Location に載らない", () => {
  it("DB に http: が入っていても配信しない", async () => {
    // 検証規則を後から厳しくした場合や、DB を別経路で書き換えられた
    // 場合に、古い行がそのまま Location に載るのを防ぐ。
    const cardId = await seedActiveCard("usr_taro");
    await rawSetTarget(cardId, "http://evil.example/");

    const response = await get(cardId);

    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("DB に javascript: が入っていても配信しない", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await rawSetTarget(cardId, "javascript:alert(document.cookie)");

    const response = await get(cardId);

    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  });
});

/**
 * タップ回数の記録（#394）。
 *
 * **応答は `app.fetch()` が返した時点で完了している** が、記録は
 * `executionCtx.waitUntil` へ載せてあるので、応答の後にも続く。
 * `createExecutionContext()` / `waitOnExecutionContext()`
 * （`@cloudflare/vitest-plugin`）で、本物の Workers ランタイムと同じ形で
 * 待ち合わせる——`session-timing.test.ts`（auth-worker）と同じ道具立て。
 */
describe("タップ回数の記録（#394）", () => {
  async function getWithRealContext(cardId: string): Promise<{ response: Response }> {
    const ctx = createExecutionContext();
    const response = await createApp({ identity }).fetch(
      new Request(`${ORIGIN}/c/${cardId}`),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { response };
  }

  async function tapRowsFor(cardId: string) {
    const rows = await db().select().from(nfcCardTaps).all();
    return rows.filter((row) => row.cardId === cardId);
  }

  it("resolvable なタップを記録する", async () => {
    const cardId = await seedActiveCard("usr_taro");

    const { response } = await getWithRealContext(cardId);
    expect(response.status).toBe(302);

    const rows = await tapRowsFor(cardId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
  });

  it("同じ日に複数回タップすると加算される", async () => {
    const cardId = await seedActiveCard("usr_taro");

    await getWithRealContext(cardId);
    await getWithRealContext(cardId);
    await getWithRealContext(cardId);

    const rows = await tapRowsFor(cardId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
  });

  it("claimable（未紐づけ）は数えない", async () => {
    const cardId = await seedIssuedCard();

    const { response } = await getWithRealContext(cardId);
    expect(response.status).toBe(302);

    expect(await tapRowsFor(cardId)).toHaveLength(0);
  });

  it("存在しないカードは数えない", async () => {
    await getWithRealContext("nfc_doesnotexisthere9");

    // 数える対象になる cardId 自体が無いので、テーブル全体が空のままであること。
    expect(await db().select().from(nfcCardTaps).all()).toHaveLength(0);
  });

  it("無効化済みは数えない", async () => {
    const cardId = await seedActiveCard("usr_taro");
    await repository().disable(cardId, "usr_taro", "lost", new Date());

    await getWithRealContext(cardId);

    expect(await tapRowsFor(cardId)).toHaveLength(0);
  });

  it("書き込みに失敗してもリダイレクト自体は成功する", async () => {
    // `executionCtx` が無い（= `waitUntilOf` が `undefined` を返す）
    // 呼び出し方でも、応答そのものは変わらないことを固定する。
    // 本物のタップ記録は `waitUntil` が取れなければ単に行われない。
    const cardId = await seedActiveCard("usr_taro");

    const response = await createApp({ identity }).fetch(
      new Request(`${ORIGIN}/c/${cardId}`),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://example.com/taro");
  });
});

/**
 * Repository を迂回して不正な値を直接書き込む。
 *
 * 通常の経路では Domain の検証を通るので、この状態は作れない。
 * 「保存時の検証を、過去に 1 度通ったことの記録としてしか信用しない」
 * という設計が効いているかを確かめるために、わざと壊した行を作る。
 */
async function rawSetTarget(cardId: string, targetUrl: string): Promise<void> {
  await env.NFC_DB.prepare("update nfc_cards set target_url = ? where id = ?")
    .bind(targetUrl, cardId)
    .run();
}
