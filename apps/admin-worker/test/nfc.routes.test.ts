import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  AdminCardListViewDelegated,
  BatchDisableCardsDelegatedInput,
  CardTapHistoryDelegatedInput,
  CountBatchIssuedCardsDelegatedInput,
  CountDisabledInBatchDelegatedInput,
  DisableCardDelegatedInput,
  GetCardDelegatedInput,
  IdentityAdminDelegatedRpcContract,
  IssueCardsDelegatedInput,
  IssueCardsDelegatedResult,
  ListAllCardsDelegatedInput,
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
import {
  ORIGIN,
  cookieHeaderFrom,
  executionContext,
  fakeApprovals,
  loginAs,
  minimalIdentityAdmin,
} from "./helpers";

/**
 * NFC 管理画面（`/nfc`、#382 / #390 決定 16 ③）。
 *
 * **`NfcAdminDelegatedRPC` 自体はここでは確かめない。** あちらは
 * nfc-worker 側の契約テスト（`nfc-admin-delegated.rpc.test.ts`）が持つ。
 * ここで見るのは HTTP 層の責務だけ——CSRF・actorUserId の渡し方・
 * 失敗したときの文言。
 */

const SUB = "usr_admin_nfc";

function card(overrides: Partial<AdminCardListViewDelegated> = {}): AdminCardListViewDelegated {
  return {
    cardId: "nfc_0001",
    status: "issued",
    ownerUserId: null,
    targetUrl: null,
    batch: null,
    issuedAt: "2026-10-01T00:00:00.000Z",
    claimedAt: null,
    disabledAt: null,
    tapCount: 0,
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
    getCard: GetCardDelegatedInput[];
    cardTapHistory: CardTapHistoryDelegatedInput[];
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
    getCard: [] as GetCardDelegatedInput[],
    cardTapHistory: [] as CardTapHistoryDelegatedInput[],
  };

  const rpc: NfcAdminDelegatedRpcContract = {
    listAllCards: async (): Promise<ListAllCardsDelegatedResult> =>
      rpcOk({ cards: [card()], truncated: false }),
    countCards: async () => rpcOk({ issued: 1, active: 0, disabled: 0 }),
    // `/nfc` は所有者ごとの一覧を呼ばない（呼ぶのは `/users/:userId`）。
    listCardsByOwner: async () => rpcOk({ cards: [] }),
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
    // カード詳細（#472）用。
    getCard: async (input) => {
      calls.getCard.push(input);
      return rpcOk({
        cardId: input.cardId,
        status: "issued",
        ownerUserId: null,
        targetUrl: null,
        batch: null,
        issuedAt: "2026-10-01T00:00:00.000Z",
        claimedAt: null,
        transferCount: 0,
        disabledAt: null,
        disabledReason: null,
        tapCount: 0,
        lastTappedAt: null,
      });
    },
    cardTapHistory: async (input) => {
      calls.cardTapHistory.push(input);
      return rpcOk({
        dailyTotals: [],
        totalTaps: 0,
        retentionDays: 180,
        lastTappedAt: null,
        daysSinceLastTap: null,
        last7d: { total: 0, previousTotal: 0 },
        last30d: { total: 0, previousTotal: 0 },
      });
    },
    // 解析画面（#454）用。この test ファイルは `/nfc` だけを見るので、
    // ここでは呼ばれない前提の最小スタブ。
    tapTimeseries: async () =>
      rpcOk({ dailyTotals: [], totalTaps: 0, dailyAverage: 0, maxDay: null, retentionDays: 180 }),
    usageFunnel: async () =>
      rpcOk({ issued: 0, claimedEver: 0, tappedEver: 0, retentionDays: 180 }),
    batchAnalytics: async () => rpcOk({ rows: [] }),
    cardUsageRanking: async () => rpcOk({ ranking: [], dormant: { count: 0, rows: [] } }),
    disabledReasonBreakdown: async () => rpcOk({ rows: [] }),
    transferCountDistribution: async () => rpcOk({ zero: 0, one: 0, two: 0, threeOrMore: 0 }),
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

  it("所有者を名前で出す（#471）。解決できれば利用者詳細へのリンクになる", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [card({ cardId: "nfc_active", status: "active", ownerUserId: "usr_taro" })],
          truncated: false,
        }),
    });
    const identityAdmin: IdentityAdminDelegatedRpcContract = {
      ...minimalIdentityAdmin(),
      getUsersByIds: async () =>
        rpcOk([
          { id: "usr_taro", username: "taro", displayName: "太郎", status: "active" as const },
        ]),
    };
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc, identityAdmin });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("太郎 (@taro)");
    expect(html).toContain('href="/users/usr_taro"');
    // 解決できたので、生の ID を <code> で出す経路は通らない。
    expect(html).not.toContain(">usr_taro<");
  });

  it("所有者を名前で出す（#471）。解決できなければ ID の先頭だけを <code> で出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_active", status: "active", ownerUserId: "usr_does_not_resolve" }),
          ],
          truncated: false,
        }),
    });
    const identityAdmin: IdentityAdminDelegatedRpcContract = {
      ...minimalIdentityAdmin(),
      // 名前が引けなかった想定——`Map` に入らない。
      getUsersByIds: async () => rpcOk([]),
    };
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc, identityAdmin });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    // **「不明」と書かない**（issue #471 の冒頭）。先頭 8 文字 + `…` を出す。
    expect(html).toContain("usr_does…");
    expect(html).toContain('title="usr_does_not_resolve"');
    expect(html).not.toContain("不明");
    expect(html).not.toContain('href="/users/usr_does_not_resolve"');
  });

  it("所有者がいない（未紐づけ）カードはダッシュのまま", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [card({ cardId: "nfc_issued", status: "issued", ownerUserId: null })],
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
    expect(html).toContain("—");
  });

  it("1 枚ずつの操作フォームは出さない（#481、カードの詳細から行う）", async () => {
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
    // **カード 1 枚への 1 枚ずつの操作フォームが一覧から消えた。**
    // 無効化・復帰・手放す・遷移先の変更はカードの詳細（/nfc/:cardId）から。
    expect(html).not.toContain('action="/nfc/nfc_disabled/reinstate"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/reinstate-to-issued"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/disable"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/release"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/target"');
    expect(html).not.toContain('action="/nfc/nfc_active/reinstate"');
    // **カード ID がカード詳細へのリンクになっている。**
    expect(html).toContain('href="/nfc/nfc_disabled"');
    expect(html).toContain('href="/nfc/nfc_active"');
    // **選択のチェックボックスが出ている（#481 の一括操作用）。**
    expect(html).toContain('data-select="nfc-cards"');
    expect(html).toContain('value="nfc_disabled"');
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

describe("GET /nfc/:cardId（カード詳細、#472）", () => {
  it("カードの概要とタップの集計を描く", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      getCard: async (input) => {
        calls.getCard.push(input);
        return rpcOk({
          cardId: "nfc_active",
          status: "active",
          ownerUserId: "usr_taro",
          targetUrl: "https://example.com/taro",
          batch: "bunkasai-2026",
          issuedAt: "2026-10-01T00:00:00.000Z",
          claimedAt: "2026-10-02T00:00:00.000Z",
          transferCount: 1,
          disabledAt: null,
          disabledReason: null,
          tapCount: 5,
          lastTappedAt: "2026-10-20",
        });
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("nfc_active");
    expect(html).toContain("bunkasai-2026");
    // 名前解決の fake を用意していないので、`UserRef`（#471 で入った）が
    // 「引けなかった」場合のフォールバック（userId の先頭だけ）を出す。
    expect(html).toContain("usr_taro".slice(0, 8));
    // actorUserId は session.sub から、cardId は URL パラメータから。
    expect(calls.getCard).toEqual([{ actorUserId: SUB, cardId: "nfc_active" }]);
  });

  /**
   * #481 で一覧（`nfc-page.tsx`）から消した、状態ごとの操作の出し分けを
   * カード詳細（`card-detail-page.tsx` の `CardDetailActions`）側で確かめる。
   * 一覧側の同等のテストは #481 で削除した——機能そのものがここへ移った。
   */
  it("所有者のいる disabled には復帰フォームだけを出す。無効化・手放す・遷移先の変更は出さない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      getCard: async (input) =>
        rpcOk({
          cardId: input.cardId,
          status: "disabled",
          ownerUserId: "usr_taro",
          targetUrl: null,
          batch: null,
          issuedAt: "2026-10-01T00:00:00.000Z",
          claimedAt: "2026-10-02T00:00:00.000Z",
          transferCount: 0,
          disabledAt: "2026-10-05T00:00:00.000Z",
          disabledReason: "lost",
          tapCount: 0,
          lastTappedAt: null,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_disabled`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('action="/nfc/nfc_disabled/reinstate"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/reinstate-to-issued"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/disable"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/release"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/target"');
  });

  it("所有者の無い disabled（issued 由来）には「未紐づけへ戻す」だけを出す（#436）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      getCard: async (input) =>
        rpcOk({
          cardId: input.cardId,
          status: "disabled",
          ownerUserId: null,
          targetUrl: null,
          batch: null,
          issuedAt: "2026-10-01T00:00:00.000Z",
          claimedAt: null,
          transferCount: 0,
          disabledAt: "2026-10-05T00:00:00.000Z",
          disabledReason: "admin_batch",
          tapCount: 0,
          lastTappedAt: null,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_disabled`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain('action="/nfc/nfc_disabled/reinstate-to-issued"');
    expect(html).not.toContain('action="/nfc/nfc_disabled/reinstate"');
  });

  it("disabled なら理由と日時を上に出す。理由が空なら「記録されていません」", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      getCard: async (input) =>
        rpcOk({
          cardId: input.cardId,
          status: "disabled",
          ownerUserId: "usr_taro",
          targetUrl: null,
          batch: null,
          issuedAt: "2026-10-01T00:00:00.000Z",
          claimedAt: "2026-10-02T00:00:00.000Z",
          transferCount: 0,
          disabledAt: "2026-10-05T00:00:00.000Z",
          disabledReason: null,
          tapCount: 0,
          lastTappedAt: null,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_disabled`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("理由は記録されていません");
  });

  it("引き取り済みでタップ 0 件なら、死蔵をはっきり出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      getCard: async (input) =>
        rpcOk({
          cardId: input.cardId,
          status: "active",
          ownerUserId: "usr_taro",
          targetUrl: "https://example.com/taro",
          batch: null,
          issuedAt: "2026-10-01T00:00:00.000Z",
          claimedAt: "2026-10-02T00:00:00.000Z",
          transferCount: 0,
          disabledAt: null,
          disabledReason: null,
          tapCount: 0,
          lastTappedAt: null,
        }),
      cardTapHistory: async () =>
        rpcOk({
          dailyTotals: [],
          totalTaps: 0,
          retentionDays: 180,
          lastTappedAt: null,
          daysSinceLastTap: null,
          last7d: { total: 0, previousTotal: 0 },
          last30d: { total: 0, previousTotal: 0 },
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_dormant`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("引き取り済みですが、1 回もタップされていません");
  });

  it("?days= を 30/90/180 の 3 択へ丸めて cardTapHistory を呼ぶ", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active?days=not-a-number`, {
        headers: { Cookie: sessionCookie },
      }),
      env,
      executionContext(),
    );
    await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active?days=90`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(calls.cardTapHistory.map((input) => input.days)).toEqual([30, 90]);
  });

  it("見つからなければ 404 で、一覧へ戻る導線を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      getCard: async () => rpcErr(RpcErrorCode.NotFound, "not_found"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_missing`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("そのカードは見つかりません");
    expect(html).toContain('href="/nfc"');
  });

  it("取得に失敗したら 503", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      getCard: async () => rpcErr(RpcErrorCode.Internal, "boom"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(503);
  });

  /**
   * **登録順の罠を直接確かめる**（issue #472 の指示）。`/nfc/:cardId` を
   * `/nfc/analytics` より先に登録すると、`:cardId` に `"analytics"` が
   * 吸われて解析画面が「カードが見つかりません」になる
   * （`app.tsx` の登録順コメントを参照）。
   */
  it("GET /nfc/analytics は /nfc/:cardId に吸われない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/analytics`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("NFC 解析");
    expect(html).not.toContain("そのカードは見つかりません");
    // 吸われていれば getCard({ cardId: "analytics" }) が呼ばれているはず。
    expect(calls.getCard).toHaveLength(0);
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

describe("POST /nfc/cards（機械向け JSON 発行 API、#461）", () => {
  it("未ログインは 401 の JSON で答える（302 で /login へ送らない）", async () => {
    // **機械向けレビューで足した分岐。** `wantsJsonResponse` が真なら
    // セッションガード（`app.ts`）は 302 ではなく JSON を返す——`urllib`
    // が 302 を追って `/login` の HTML を 200 として受け取る事故を防ぐ。
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ count: 1 }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(calls.issueCards).toHaveLength(0);
  });

  it("未承認は 403 の JSON で答える（302 で /pending へ送らない）", async () => {
    const sessionCookie = await loginAs(SUB, fakeApprovals([]));
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/cards`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({ count: 1 }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_approved" });
    expect(calls.issueCards).toHaveLength(0);
  });

  it("Origin が無ければ 403 で、issueCards を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/cards`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ count: 1 }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.issueCards).toHaveLength(0);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("Content-Type が application/json でなければ 403 で、issueCards を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/cards`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
        },
        body: "count=1",
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.issueCards).toHaveLength(0);
  });

  it("Origin と Content-Type が揃えば issueCards を actorUserId 付きで呼び、cardId を本文で返す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/cards`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({ count: 1, batch: "2026-bunkasai" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(201);
    // **cardId が応答に載る。** 一覧を引き直して差分を取らせない
    // （`scripts/nfc-burn.py` が避けている形、issue #461 の本体）。
    expect(await response.json()).toEqual({ cards: [{ cardId: "nfc_0002" }] });
    expect(calls.issueCards).toEqual([{ actorUserId: SUB, count: 1, batch: "2026-bunkasai" }]);
  });

  it("batch を省略すると null で渡す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    await app.fetch(
      new Request(`${ORIGIN}/nfc/cards`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({ count: 1 }),
      }),
      env,
      executionContext(),
    );

    expect(calls.issueCards).toEqual([{ actorUserId: SUB, count: 1, batch: null }]);
  });

  it("issueCards が invalid_input を返したら 400 で、コード名を本文に出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      issueCards: async () => rpcErr(RpcErrorCode.InvalidInput, "too_many"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/cards`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({ count: 999 }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_input" });
  });

  it("本文が JSON として読めなくても 403 にならず、issueCards 側の invalid_input に落ちる", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      issueCards: async () => rpcErr(RpcErrorCode.InvalidInput, "malformed"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/cards`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: "not json",
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
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

  it("from=detail なら、成功後に詳細（/nfc/<cardId>）へ戻す（#472）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active`, { headers: { Cookie: sessionCookie } }),
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
        body: new URLSearchParams({ csrf_token: csrfToken, from: "detail" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc/nfc_active");
    expect(calls.disableCard).toEqual([{ actorUserId: SUB, cardId: "nfc_active" }]);
  });

  it("from=detail なら、失敗後も詳細を描き直す（一覧には戻さない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      disableCard: async () => rpcErr(RpcErrorCode.NotFound, "not_found"),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc/nfc_active`, { headers: { Cookie: sessionCookie } }),
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
        body: new URLSearchParams({ csrf_token: csrfToken, from: "detail" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    // 詳細の画面（カード ID そのものを見出しに出す）に戻っていること。
    expect(html).toContain("nfc_active");
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

describe("GET /nfc/open（#481、ID で直接開く）", () => {
  it("cardId を指定すると /nfc/<cardId> へ 303 で飛ぶ", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/open?cardId=nfc_0099`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/nfc/nfc_0099");
  });

  it("cardId が空なら一覧をエラーつきで描き直す（303 にしない）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/open`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("カード ID を入力してください。");
  });

  it("/nfc/analytics には吸われない（登録順の罠と同じ確認）", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/open?cardId=nfc_0099`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(303);
    // `getCard` が呼ばれていれば、`:cardId` に "open" が吸われている証拠。
    expect(calls.getCard).toHaveLength(0);
  });
});

/** 選択による一括操作（#481）の共通セットアップ。 */
async function postBulk(
  app: ReturnType<typeof createApp>,
  path: "/nfc/bulk-disable" | "/nfc/bulk-reinstate",
  sessionCookie: string,
  csrfCookie: string,
  csrfToken: string,
  fields: Record<string, string | string[]>,
): Promise<Response> {
  const body = new URLSearchParams();
  body.set(CSRF_FIELD_NAME_FOR_TEST, csrfToken);
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const v of value) body.append(key, v);
    } else {
      body.set(key, value);
    }
  }
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
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
}

const CSRF_FIELD_NAME_FOR_TEST = "csrf_token";

describe("POST /nfc/bulk-disable（選択による一括無効化、#481）", () => {
  it("CSRF トークンが無ければ 403 で、disableCard を呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc/bulk-disable`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ card_id: "nfc_0001" }),
      }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(403);
    expect(calls.disableCard).toHaveLength(0);
  });

  it("1 枚も選んでいなければ 400 でエラーを出す", async () => {
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

    const response = await postBulk(
      app,
      "/nfc/bulk-disable",
      sessionCookie,
      csrfCookie,
      csrfToken,
      {},
    );

    expect(response.status).toBe(400);
    expect(calls.disableCard).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("カードを選んでください。");
  });

  it("上限（100 枚）を超えたら拒否し、disableCard を呼ばない", async () => {
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

    const tooMany = Array.from({ length: 101 }, (_, i) => `nfc_${i}`);
    const response = await postBulk(app, "/nfc/bulk-disable", sessionCookie, csrfCookie, csrfToken, {
      card_id: tooMany,
    });

    expect(response.status).toBe(400);
    expect(calls.disableCard).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("100 枚までです。");
  });

  it("1 段階目: 内訳（効く・既に無効化済み）を見せるだけで、disableCard は呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_a", status: "issued" }),
            card({ cardId: "nfc_b", status: "active" }),
            card({ cardId: "nfc_c", status: "disabled" }),
          ],
          truncated: false,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await postBulk(app, "/nfc/bulk-disable", sessionCookie, csrfCookie, csrfToken, {
      card_id: ["nfc_a", "nfc_b", "nfc_c", "nfc_missing"],
    });

    expect(response.status).toBe(200);
    expect(calls.disableCard).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("選択");
    expect(html).toContain("4 枚");
    expect(html).toContain("2 枚");
    expect(html).toContain("既に無効化済みです");
    expect(html).toContain("見つかりません");
    // 再送信用に、選択した全件（対象外も含む）が hidden で積まれていること。
    expect(html).toMatch(/name="card_id" value="nfc_a"/);
    expect(html).toMatch(/name="card_id" value="nfc_missing"/);
  });

  it("選んだ中に効くものが無ければ、確認画面を出さずエラーにする", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({ cards: [card({ cardId: "nfc_a", status: "disabled" })], truncated: false }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await postBulk(app, "/nfc/bulk-disable", sessionCookie, csrfCookie, csrfToken, {
      card_id: "nfc_a",
    });

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("選んだ中に無効化できるカードがありません。");
  });

  it("2 段階目（confirmed=1）: 効くものだけ disableCard を呼び、部分失敗を正直に出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_a", status: "issued" }),
            card({ cardId: "nfc_b", status: "active" }),
            card({ cardId: "nfc_c", status: "disabled" }),
          ],
          truncated: false,
        }),
      disableCard: async (input) => {
        calls.disableCard.push(input);
        if (input.cardId === "nfc_b") return rpcErr(RpcErrorCode.NotFound, "not_found");
        return rpcOk(null);
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

    const response = await postBulk(app, "/nfc/bulk-disable", sessionCookie, csrfCookie, csrfToken, {
      card_id: ["nfc_a", "nfc_b", "nfc_c"],
      confirmed: "1",
    });

    expect(response.status).toBe(200);
    // `nfc_c`（既に disabled）は対象外なので呼ばれない。
    expect(calls.disableCard.map((input) => input.cardId).sort()).toEqual(["nfc_a", "nfc_b"]);
    expect(calls.disableCard.every((input) => input.actorUserId === SUB)).toBe(true);
    const html = await response.text();
    expect(html).toContain("1 件成功");
    expect(html).toContain("1 件失敗");
    expect(html).toContain("対象外 1 件");
  });
});

describe("POST /nfc/bulk-reinstate（選択による一括復帰、#481）", () => {
  it("持ち主の有無でカードごとに reinstateCard / reinstateCardToIssued を呼び分ける", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({
          cards: [
            card({ cardId: "nfc_owned", status: "disabled", ownerUserId: "usr_taro" }),
            card({ cardId: "nfc_unowned", status: "disabled", ownerUserId: null }),
          ],
          truncated: false,
        }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await postBulk(
      app,
      "/nfc/bulk-reinstate",
      sessionCookie,
      csrfCookie,
      csrfToken,
      { card_id: ["nfc_owned", "nfc_unowned"], confirmed: "1" },
    );

    expect(response.status).toBe(200);
    expect(calls.reinstateCard).toEqual([{ actorUserId: SUB, cardId: "nfc_owned" }]);
    expect(calls.reinstateCardToIssued).toEqual([{ actorUserId: SUB, cardId: "nfc_unowned" }]);
    const html = await response.text();
    expect(html).toContain("2 件成功");
  });

  it("issued・active は対象外（理由つき）で、reinstateCard 系は呼ばない", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc, calls } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({ cards: [card({ cardId: "nfc_a", status: "active" })], truncated: false }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const getResponse = await app.fetch(
      new Request(`${ORIGIN}/nfc`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );
    const csrfCookie = cookieHeaderFrom(getResponse);
    const csrfToken = csrfTokenFrom(csrfCookie);

    const response = await postBulk(
      app,
      "/nfc/bulk-reinstate",
      sessionCookie,
      csrfCookie,
      csrfToken,
      { card_id: "nfc_a" },
    );

    expect(response.status).toBe(400);
    expect(calls.reinstateCard).toHaveLength(0);
    expect(calls.reinstateCardToIssued).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain("選んだ中に復帰できるカードがありません。");
  });
});

describe("?batch= によるサーバー側の絞り込み（#481）", () => {
  it("GET /nfc が ?batch= を listAllCards へ渡し、絞り込み中だと画面に出す", async () => {
    const sessionCookie = await loginAsApproved();
    const receivedInputs: (ListAllCardsDelegatedInput | undefined)[] = [];
    const { rpc } = fakeNfcCards({
      listAllCards: async (input) => {
        receivedInputs.push(input);
        return rpcOk({
          cards: [card({ cardId: "nfc_a", batch: "2026-bunkasai" })],
          truncated: false,
        });
      },
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc?batch=2026-bunkasai`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    expect(receivedInputs).toEqual([{ batch: "2026-bunkasai" }]);
    const html = await response.text();
    expect(html).toContain("絞り込み中");
    expect(html).toContain("2026-bunkasai");
  });

  it("打ち切り + 絞り込み中なら、専用の文言を出す", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards({
      listAllCards: async () =>
        rpcOk({ cards: [card({ batch: "2026-bunkasai" })], truncated: true }),
    });
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc?batch=2026-bunkasai`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).toContain("このロットには他にも読み込めていないカードがあります");
  });

  it("空文字の ?batch= は絞り込み無しとして扱う", async () => {
    const sessionCookie = await loginAsApproved();
    const { rpc } = fakeNfcCards();
    const app = createApp({ approvals: fakeApprovals([SUB]), nfcCards: rpc });

    const response = await app.fetch(
      new Request(`${ORIGIN}/nfc?batch=`, { headers: { Cookie: sessionCookie } }),
      env,
      executionContext(),
    );

    const html = await response.text();
    expect(html).not.toContain("絞り込み中");
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
