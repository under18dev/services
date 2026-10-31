import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  AdminCardViewDelegated,
  BatchDisableCardsDelegatedInput,
  CountBatchIssuedCardsDelegatedInput,
  CountDisabledInBatchDelegatedInput,
  DisableCardDelegatedInput,
  IssueCardsDelegatedInput,
  IssueCardsDelegatedResult,
  ListAllCardsDelegatedResult,
  NfcAdminDelegatedRpcContract,
  ReinstateBatchToIssuedCardsDelegatedInput,
  ReinstateCardDelegatedInput,
  ReinstateCardToIssuedDelegatedInput,
  ReleaseCardDelegatedInput,
  UpdateCardTargetDelegatedInput,
} from "@u18/contracts";
import { createApp } from "../src/presentation/http/app";
import { KIWA_STYLESHEET_PATH } from "../src/presentation/http/ui/asset-paths";
import { ORIGIN, cookieHeaderFrom, executionContext, fakeApprovals, loginAs } from "./helpers";

/**
 * NFC 管理画面（`/nfc`、#382 / #390 決定 16 ③）。
 *
 * **`NfcAdminDelegatedRPC` 自体はここでは確かめない。** あちらは
 * nfc-worker 側の契約テスト（`nfc-admin-delegated.rpc.test.ts`）が持つ。
 * ここで見るのは HTTP 層の責務だけ——CSRF・actorUserId の渡し方・
 * 失敗したときの文言。
 */

const SUB = "usr_admin_nfc";

function card(overrides: Partial<AdminCardViewDelegated> = {}): AdminCardViewDelegated {
  return {
    cardId: "nfc_0001",
    status: "issued",
    ownerUserId: null,
    targetUrl: null,
    batch: null,
    issuedAt: "2026-10-01T00:00:00.000Z",
    claimedAt: null,
    disabledAt: null,
    ...overrides,
  };
}

/** 呼ばれた引数を覚えつつ、戻り値を差し替えられる fake。 */
function fakeNfcCards(overrides: Partial<NfcAdminDelegatedRpcContract> = {}): {
  readonly rpc: NfcAdminDelegatedRpcContract;
  readonly calls: {
    disableCard: DisableCardDelegatedInput[];
    updateCardTarget: UpdateCardTargetDelegatedInput[];
    issueCards: IssueCardsDelegatedInput[];
    releaseCard: ReleaseCardDelegatedInput[];
    reinstateCard: ReinstateCardDelegatedInput[];
    reinstateCardToIssued: ReinstateCardToIssuedDelegatedInput[];
    countBatchIssuedCards: CountBatchIssuedCardsDelegatedInput[];
    batchDisableCards: BatchDisableCardsDelegatedInput[];
    countDisabledInBatch: CountDisabledInBatchDelegatedInput[];
    reinstateBatchToIssuedCards: ReinstateBatchToIssuedCardsDelegatedInput[];
  };
} {
  const calls = {
    disableCard: [] as DisableCardDelegatedInput[],
    updateCardTarget: [] as UpdateCardTargetDelegatedInput[],
    issueCards: [] as IssueCardsDelegatedInput[],
    releaseCard: [] as ReleaseCardDelegatedInput[],
    reinstateCard: [] as ReinstateCardDelegatedInput[],
    reinstateCardToIssued: [] as ReinstateCardToIssuedDelegatedInput[],
    countBatchIssuedCards: [] as CountBatchIssuedCardsDelegatedInput[],
    batchDisableCards: [] as BatchDisableCardsDelegatedInput[],
    countDisabledInBatch: [] as CountDisabledInBatchDelegatedInput[],
    reinstateBatchToIssuedCards: [] as ReinstateBatchToIssuedCardsDelegatedInput[],
  };

  const rpc: NfcAdminDelegatedRpcContract = {
    listAllCards: async (): Promise<ListAllCardsDelegatedResult> =>
      rpcOk({ cards: [card()], truncated: false }),
    issueCards: async (input): Promise<IssueCardsDelegatedResult> => {
      calls.issueCards.push(input);
      return rpcOk({ cards: [{ cardId: "nfc_0002" }] });
    },
    disableCard: async (input) => {
      calls.disableCard.push(input);
      return rpcOk(null);
    },
    updateCardTarget: async (input) => {
      calls.updateCardTarget.push(input);
      return rpcOk(null);
    },
    releaseCard: async (input) => {
      calls.releaseCard.push(input);
      return rpcOk(null);
    },
    reinstateCard: async (input) => {
      calls.reinstateCard.push(input);
      return rpcOk(null);
    },
    reinstateCardToIssued: async (input) => {
      calls.reinstateCardToIssued.push(input);
      return rpcOk(null);
    },
    countBatchIssuedCards: async (input) => {
      calls.countBatchIssuedCards.push(input);
      return rpcOk({ count: 0 });
    },
    batchDisableCards: async (input) => {
      calls.batchDisableCards.push(input);
      return rpcOk({ cardIds: [] });
    },
    countDisabledInBatch: async (input) => {
      calls.countDisabledInBatch.push(input);
      return rpcOk({ count: 0 });
    },
    reinstateBatchToIssuedCards: async (input) => {
      calls.reinstateBatchToIssuedCards.push(input);
      return rpcOk({ cardIds: [] });
    },
    ...overrides,
  };

  return { rpc, calls };
}

async function loginAsApproved(): Promise<string> {
  const approvals = fakeApprovals([SUB]);
  return loginAs(SUB, approvals);
}

describe("GET /nfc", () => {
  it("一覧・コピペ用 URL・CSRF トークンを描く", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_issued", status: "issued" }),
            card({
              cardId: "nfc_active",
              status: "active",
              ownerUserId: "usr_taro",
              targetUrl: "https://example.com/taro",
            }),
          ],
          truncated: false,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("nfc_issued");
    expect(html).toContain("nfc_active");
    expect(html).toContain("usr_taro");
    // **焼く用の URL は issued のカードだけ。** active が混ざると、
    // 誰かの手元にあるタグを上書きする URL を運営に渡すことになる。
    expect(html).toContain(`${env.SHORT_URL_ORIGIN}/c/nfc_issued`);
    expect(html).not.toContain(`${env.SHORT_URL_ORIGIN}/c/nfc_active`);
    // CSRF の hidden input が、発行フォームに描かれていること。
    expect(html).toMatch(/name="csrf_token"/);
  });

  it("所有者のいる disabled には復帰フォームだけを出す。active には出さない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_disabled", status: "disabled", ownerUserId: "usr_taro" }),
            card({ cardId: "nfc_active", status: "active", ownerUserId: "usr_taro" }),
          ],
          truncated: false,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('action="/nfc/nfc_disabled/reinstate"');
    // **「未紐づけへ戻す」は出さない。** 所有者がいるので reinstate（→
    // active）側だけで足りる（#436）。
    expect(html).not.toContain('action="/nfc/nfc_disabled/reinstate-to-issued"');
    // **復帰フォームには無効化・遷移先の書き換え・手放させるを出さない。**
    // 「戻したい」と「渡したい」は別の操作（nfc-page.tsx の CardActions）。
    expect(html).not.toContain('action="/nfc/nfc_disabled/disable"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/release"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/target"');
    // active には復帰フォームを出さない。
    expect(html).not.toContain('action="/nfc/nfc_active/reinstate"');
  });

  it("所有者の無い disabled（issued 由来）には「未紐づけへ戻す」だけを出す（#436）", async () => {
    // **これが #450 レビューの本体。** 所有者を見ずに active を書く
    // reinstate を、所有者の無いカードへ誘導してはいけない。
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [card({ cardId: "nfc_disabled", status: "disabled", ownerUserId: null })],
          truncated: false,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('action="/nfc/nfc_disabled/reinstate-to-issued"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/reinstate"');
  });

  it("truncated が true なら打ち切りの注記を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () => rpcOk({ cards: [card()], truncated: true }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("上限で打ち切られています");
  });

  it("listAllCards が失敗したら 503。Kiwa の外枠と再読み込みの導線を持つ（#443）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain(`<link rel="stylesheet" href="${KIWA_STYLESHEET_PATH}"/>`);
    expect(html).toContain("しばらくしてからもう一度お試しください。");
    // **再読み込みの導線は「いまのページ」自身へ。** 別の画面へ飛ばさない。
    expect(html).toContain('href="/nfc"');
  });

  it("発行直後は枚数を出す（PRG）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc?issued=3`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("3 枚発行しました");
  });
});

describe("POST /nfc（発行）", () => {
  it("CSRF トークンが無ければ 403 で、issueCards を呼ばない。文言は日本語（#443）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const body = new URLSearchParams({ count: "10" });
    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.issueCards).toHaveLength(0);
    const html = await response.text();
    // **英語 1 語の "forbidden" のまま出さない。** 他が日本語なので浮く。
    expect(html).not.toBe("forbidden");
    // Kiwa の外枠で描き、/nfc へ戻る導線を持つ（#443）。
    expect(html).toContain(`<link rel="stylesheet" href="${KIWA_STYLESHEET_PATH}"/>`);
    expect(html).toContain('href="/nfc"');
  });

  it("CSRF が通れば issueCards を actorUserId 付きで呼び、PRG で戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({
      count: "10",
      batch: "2026-bunkasai",
      csrf_token: csrfToken,
    });
    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body,
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc?issued=1");
    expect(calls.issueCards).toEqual([{ actorUserId: SUB, count: 10, batch: "2026-bunkasai" }]);
  });

  it("ロット名を空欄にすると null で渡す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ count: "5", batch: "", csrf_token: csrfToken });
    await app.fetch(
      new Request(`${ORIGIN}/nfc`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body,
      }),
      env,
      executionContext(),
    );

    expect(calls.issueCards).toEqual([{ actorUserId: SUB, count: 5, batch: null }]);
  });

  it("issueCards が失敗したら、画面を描き直して文言を出す（303 では戻さない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      issueCards: async () => rpcErr(RpcErrorCode.InvalidInput, "too_many"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const body = new URLSearchParams({ count: "999", csrf_token: csrfToken });
    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body,
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("枚数は 1〜200 の数で指定してください。");
  });
});

describe("POST /nfc/:cardId/disable", () => {
  it("CSRF トークンが無ければ 403 で、disableCard を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active/disable`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({}),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.disableCard).toHaveLength(0);
  });

  it("CSRF が通れば disableCard を session.sub で呼び、/nfc へ戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active/disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc");
    expect(calls.disableCard).toEqual([{ actorUserId: SUB, cardId: "nfc_active" }]);
  });

  it("見つからなければ、画面を描き直して文言を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      disableCard: async () => rpcErr(RpcErrorCode.NotFound, "not_found"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_missing/disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("そのカードは見つかりませんでした。");
  });
});

describe("POST /nfc/:cardId/release", () => {
  it("CSRF トークンが無ければ 403 で、releaseCard を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active/release`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({}),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.releaseCard).toHaveLength(0);
  });

  it("CSRF が通れば releaseCard を session.sub で呼び、/nfc へ戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active/release`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc");
    expect(calls.releaseCard).toEqual([{ actorUserId: SUB, cardId: "nfc_active" }]);
  });

  it("見つからなければ、画面を描き直して文言を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      releaseCard: async () => rpcErr(RpcErrorCode.NotFound, "not_found"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_missing/release`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("そのカードは見つかりませんでした。");
  });
});

describe("POST /nfc/:cardId/reinstate", () => {
  it("CSRF トークンが無ければ 403 で、reinstateCard を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_disabled/reinstate`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({}),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.reinstateCard).toHaveLength(0);
  });

  it("CSRF が通れば reinstateCard を session.sub で呼び、/nfc へ戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_disabled/reinstate`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc");
    expect(calls.reinstateCard).toEqual([{ actorUserId: SUB, cardId: "nfc_disabled" }]);
  });

  it("見つからなければ、画面を描き直して文言を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      reinstateCard: async () => rpcErr(RpcErrorCode.NotFound, "not_found"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_missing/reinstate`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("そのカードは見つかりませんでした。");
  });
});

describe("POST /nfc/:cardId/reinstate-to-issued", () => {
  it("CSRF トークンが無ければ 403 で、reinstateCardToIssued を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_disabled/reinstate-to-issued`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({}),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.reinstateCardToIssued).toHaveLength(0);
  });

  it("CSRF が通れば reinstateCardToIssued を session.sub で呼び、/nfc へ戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_disabled/reinstate-to-issued`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc");
    expect(calls.reinstateCardToIssued).toEqual([{ actorUserId: SUB, cardId: "nfc_disabled" }]);
  });

  it("見つからなければ、画面を描き直して文言を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      reinstateCardToIssued: async () => rpcErr(RpcErrorCode.NotFound, "not_found"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_missing/reinstate-to-issued`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("そのカードは見つかりませんでした。");
  });
});

describe("POST /nfc/:cardId/target", () => {
  it("CSRF トークンが無ければ 403 で、updateCardTarget を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active/target`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ targetUrl: "https://example.com/new" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.updateCardTarget).toHaveLength(0);
  });

  it("CSRF が通れば updateCardTarget を actorUserId 付きで呼ぶ", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active/target`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ targetUrl: "https://example.com/new", csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc");
    expect(calls.updateCardTarget).toEqual([
      { actorUserId: SUB, cardId: "nfc_active", targetUrl: "https://example.com/new" },
    ]);
  });

  /**
   * **理由コードを日本語へ訳す側。** `TARGET_URL_REASON_LABEL` の対応表が
   * 腐っていないかを確かめる——キーを 1 つ変えても、ここが落ちない形には
   * しない。
   */
  it.each([
    ["not_absolute", "絶対 URL で入力してください"],
    ["not_https", "https:// の URL だけ"],
    ["private_host", "内部向けのアドレス"],
  ])("理由コード %s を文言へ訳す", async (reasonCode, expectedSubstring) => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      updateCardTarget: async () => rpcErr(RpcErrorCode.InvalidInput, reasonCode),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active/target`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ targetUrl: "not a url", csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(expectedSubstring);
  });

  it("対応表に無い理由コードは、見つからない扱いの文言にする", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      updateCardTarget: async () => rpcErr(RpcErrorCode.NotFound, "not_found"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_missing/target`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ targetUrl: "https://example.com/x", csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("そのカードは見つかりませんでした。");
  });
});

describe("POST /nfc/batch-disable", () => {
  it("CSRF トークンが無ければ 403 で、countBatchIssuedCards も batchDisableCards も呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-disable`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ batch: "bunkasai-2026" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.countBatchIssuedCards).toHaveLength(0);
    expect(calls.batchDisableCards).toHaveLength(0);
  });

  it("1 段階目: バッチ名を入れると件数を数えるだけで、無効化は呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      countBatchIssuedCards: async (input) => {
        calls.countBatchIssuedCards.push(input);
        return rpcOk({ count: 3 });
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ batch: "bunkasai-2026", csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(calls.countBatchIssuedCards).toEqual([{ actorUserId: SUB, batch: "bunkasai-2026" }]);
    expect(calls.batchDisableCards).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("bunkasai-2026");
    expect(html).toContain("3 枚");
    // 2 段階目の hidden フィールドが対象バッチ名を持って出ていること。
    expect(html).toMatch(/name="target_batch" value="bunkasai-2026"/);
  });

  it("対象が 0 件なら確認画面を出さず、エラーにする", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      countBatchIssuedCards: async () => rpcOk({ count: 0 }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ batch: "no-such-batch", csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("そのバッチには未紐づけのカードがありません。");
    expect(html).not.toMatch(/name="target_batch"/);
  });

  it("2 段階目: 再入力が一致すれば batchDisableCards を呼び、PRG で戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      batchDisableCards: async (input) => {
        calls.batchDisableCards.push(input);
        return rpcOk({ cardIds: ["nfc_a", "nfc_b"] });
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          batch: "bunkasai-2026",
          target_batch: "bunkasai-2026",
          csrf_token: csrfToken,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc?batch_disabled=2");
    expect(calls.batchDisableCards).toEqual([{ actorUserId: SUB, batch: "bunkasai-2026" }]);
  });

  it("2 段階目: 再入力が一致しなければ、無効化を呼ばず確認画面へ差し戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      countBatchIssuedCards: async () => rpcOk({ count: 5 }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-disable`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          batch: "typo-ed-name",
          target_batch: "bunkasai-2026",
          csrf_token: csrfToken,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    expect(calls.batchDisableCards).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("入力が一致しません");
    expect(html).toContain("bunkasai-2026");
  });

  it("CSRF トークンが通っていても、target_batch が hidden なだけでは権限を迂回しない（意図の確認でしかない）", async () => {
    // **これは正常系の裏返しの確認。** target_batch を偽造して直接
    // POST しても、権限（CSRF・セッション）の検査は同じに掛かる。
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-disable`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ batch: "x", target_batch: "x" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.batchDisableCards).toHaveLength(0);
  });
});

describe("POST /nfc/batch-reinstate", () => {
  it("CSRF トークンが無ければ 403 で、countDisabledInBatch も reinstateBatchToIssuedCards も呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-reinstate`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ batch: "bunkasai-2026" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.countDisabledInBatch).toHaveLength(0);
    expect(calls.reinstateBatchToIssuedCards).toHaveLength(0);
  });

  it("1 段階目: バッチ名を入れると件数を数えるだけで、復帰は呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      countDisabledInBatch: async (input) => {
        calls.countDisabledInBatch.push(input);
        return rpcOk({ count: 3 });
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-reinstate`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ batch: "bunkasai-2026", csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(calls.countDisabledInBatch).toEqual([{ actorUserId: SUB, batch: "bunkasai-2026" }]);
    expect(calls.reinstateBatchToIssuedCards).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("bunkasai-2026");
    expect(html).toContain("3 枚");
    expect(html).toMatch(/name="target_batch" value="bunkasai-2026"/);
  });

  it("対象が 0 件なら確認画面を出さず、エラーにする", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      countDisabledInBatch: async () => rpcOk({ count: 0 }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-reinstate`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({ batch: "no-such-batch", csrf_token: csrfToken }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("そのバッチには、一括無効化で止めたカードがありません。");
    expect(html).not.toMatch(/name="target_batch"/);
  });

  it("2 段階目: 再入力が一致すれば reinstateBatchToIssuedCards を呼び、PRG で戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      reinstateBatchToIssuedCards: async (input) => {
        calls.reinstateBatchToIssuedCards.push(input);
        return rpcOk({ cardIds: ["nfc_a", "nfc_b"] });
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-reinstate`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          batch: "bunkasai-2026",
          target_batch: "bunkasai-2026",
          csrf_token: csrfToken,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc?batch_reinstated=2");
    expect(calls.reinstateBatchToIssuedCards).toEqual([
      { actorUserId: SUB, batch: "bunkasai-2026" },
    ]);
  });

  it("2 段階目: 再入力が一致しなければ、復帰を呼ばず確認画面へ差し戻す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      countDisabledInBatch: async () => rpcOk({ count: 5 }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-reinstate`, {
        method: "POST",
        headers: {
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: new URLSearchParams({
          batch: "typo-ed-name",
          target_batch: "bunkasai-2026",
          csrf_token: csrfToken,
        }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    expect(calls.reinstateBatchToIssuedCards).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("入力が一致しません");
    expect(html).toContain("bunkasai-2026");
  });

  it("CSRF トークンが通っていても、target_batch が hidden なだけでは権限を迂回しない（意図の確認でしかない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/batch-reinstate`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ batch: "x", target_batch: "x" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.reinstateBatchToIssuedCards).toHaveLength(0);
  });
});

describe("未ログイン・未承認", () => {
  it("未ログインは /login へ送る（セッションガードが先に効く）", async () => {
    const app = createApp({ approvals: fakeApprovals([]) });

    const response = await app.fetch(new Request(`${ORIGIN}/nfc`), env, executionContext());

    expect(response.status).toBe(302);
    expect(response.headers.get("Location") ?? "").toContain("/login?return_to=");
  });

  it("未承認は /pending へ送る", async () => {
    const approvals = fakeApprovals([]);
    const sessionCookie = await loginAs(SUB, approvals);
    const app = createApp({ approvals });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/pending");
  });
});

/** `ensureCsrfToken` が立てた Cookie から、トークンの値だけを取り出す。 */
function csrfTokenFrom(cookieHeader: string): string {
  const match = /u18_csrf=([^;]+)/.exec(cookieHeader);
  if (match === null) throw new Error("csrf cookie not found");
  return decodeURIComponent(match[1]!);
}
