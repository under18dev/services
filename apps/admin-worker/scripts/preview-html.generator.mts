import { mkdir, writeFile } from "node:fs/promises";
import { RpcErrorCode, rpcErr, rpcOk } from "@u18/contracts";
import type {
  AdminCardDetailDelegated,
  AdminCardStatusDelegated,
  AdminCardViewDelegated,
  AuditLogEntryAdmin,
  BatchAnalyticsRow,
  CardTapHistoryDelegatedInput,
  GetCardDelegatedInput,
  GetOAuthClientDelegatedInput,
  GetUserDelegatedInput,
  GetUsersByIdsDelegatedInput,
  IdentityAdminDelegatedRpcContract,
  ListAllCardsDelegatedInput,
  ListAuditLogsDelegatedInput,
  ListCardsByOwnerDelegatedInput,
  ListUsersDelegatedInput,
  NfcAdminDelegatedRpcContract,
  OAuthClientSummary,
  TapTimeseriesDelegatedInput,
  UserAdminSummary,
} from "@u18/contracts";
import { createApp } from "../src/presentation/http/app";
import type { ContainerOverrides } from "../src/composition/container";
import type { ApprovalRepository } from "../src/application/ports/approval.repository";
import { ALL_DEFINED_PERMISSIONS, effectivePermissions } from "../src/domain/permissions";
import { createFakeIdp } from "../test/fake-idp";
import { ADMIN_ISLAND_JS } from "../src/presentation/http/ui/generated/admin-island.bundle";
import { KIWA_STYLESHEET } from "../src/presentation/http/ui/generated/kiwa-stylesheet";

/**
 * ログイン無しでブラウザ確認できる静的 HTML を書き出す（issue なし、
 * 3b の依頼：運用者がホーム・NFC 解析・ユーザー詳細の見た目を確認する
 * 手段が無い）。
 *
 * **本物のデータは一切読まない。** `createApp()` のテストと同じように
 * `nfcCards` / `identityAdmin` / `approvals` を fake に差し替えるだけ
 * ——本物の D1 / Service Binding には一度も触れない。
 *
 * **plain Node で動く。** `createApp()` 自体は Workers 専用 API を
 * 要求しない（D1 / Service Binding は overrides で避けている、OIDC の
 * 鍵処理は `jose` で Node 互換）ので、`@cloudflare/vitest-pool-workers`
 * （workerd の中でしかテストを動かせない——`node:fs` の実ファイル操作が
 * 使えない、`oauth-client-cli.test.ts` の同じ理由）を経由する必要が無い。
 * 呼び出し元の `scripts/preview-html.mjs` が esbuild でこのファイルを
 * plain Node 向けにバンドルしてから実行する。
 *
 * 出力先は `process.env.PREVIEW_OUTPUT_DIR`——esbuild でバンドルすると
 * `import.meta.url` は一時ファイルの場所を指してしまうので、呼び出し元
 * から環境変数で絶対パスを渡してもらう。
 */

const OUTPUT_DIR_ENV = process.env.PREVIEW_OUTPUT_DIR;
if (OUTPUT_DIR_ENV === undefined || OUTPUT_DIR_ENV === "") {
  throw new Error("PREVIEW_OUTPUT_DIR が設定されていません（preview-html.mjs から渡す）");
}
const OUTPUT_DIR: string = OUTPUT_DIR_ENV;

const env = {
  AUTH_ISSUER: "http://localhost:8787",
  ADMIN_ORIGIN: "http://localhost:8790",
  OIDC_CLIENT_ID: "u18-admin",
  SHORT_URL_ORIGIN: "http://localhost:8789",
  ENVIRONMENT: "development",
  SESSION_SECRET: "preview-html-session-secret-at-least-32-bytes!!",
  OIDC_CLIENT_SECRET: "preview-html-client-secret",
} as unknown as Env;

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
}

// ------------------------------------------------------------- 固定の「いま」
//
// すべての日時をこれ基準で組み立てる。生成するたびに日付がずれるのは
// 構わない——見た目を確かめるための値で、スナップショット比較はしない。
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

// --------------------------------------------------------------------- 利用者
//
// 12 人。1 人は管理者フラグ、1 人はメール未確認、1 人は運営による凍結
// （#455 がいちばん見せたい「凍結の理由」の帯を描くため）、1 人は
// 本人の退会（#318、同じ status: "suspended" でも区別されること自体を
// 確かめるため）、1 人は deleted。
const USERS: readonly UserAdminSummary[] = Array.from({ length: 12 }, (_, i): UserAdminSummary => {
  const n = i + 1;
  const id = `usr_preview${String(n).padStart(2, "0")}`;
  const status: UserAdminSummary["status"] =
    n === 3 || n === 7 ? "suspended" : n === 12 ? "deleted" : "active";
  return {
    id,
    username: `preview-user-${String(n).padStart(2, "0")}`,
    displayName: `プレビュー利用者${n}`,
    primaryEmail: `preview-user-${String(n).padStart(2, "0")}@example.test`,
    emailVerified: n !== 5,
    status,
    hasAdminFlag: n === 1,
    createdAt: isoDaysAgo(150 - n * 7),
  };
});

/** `/users/:userId` のプレビュー対象。運営による凍結（#455 の本題）を持つ人。 */
const DETAIL_USER_ID = "usr_preview03";
/** 本人の退会（#318）側の人。`decideSuspensionOrigin` が両方を区別することの確認用。 */
const SELF_CLOSED_USER_ID = "usr_preview07";

// ------------------------------------------------------------------- カード
//
// 45 枚。batch は 2 つ + 無し。issued（未紐づけ）・active（引き取り済み）・
// disabled の内訳はおおよそ 15 / 22 / 8。
const BATCHES: readonly (string | null)[] = ["2026-bunkasai", "2026-spring-event", null];
const CARDS: AdminCardViewDelegated[] = [];
let cardSeq = 0;
function newCardId(): string {
  cardSeq += 1;
  return `nfc_preview${String(cardSeq).padStart(4, "0")}`;
}
function pushCard(
  status: AdminCardStatusDelegated,
  ownerUserId: string | null,
  batch: string | null,
  issuedDaysAgo: number,
  claimedDaysAgo: number | null,
  disabledDaysAgo: number | null,
): AdminCardViewDelegated {
  const cardId = newCardId();
  const card: AdminCardViewDelegated = {
    cardId,
    status,
    ownerUserId,
    targetUrl: ownerUserId === null ? null : `https://go.under18.dev/c/${cardId}`,
    batch,
    issuedAt: isoDaysAgo(issuedDaysAgo),
    claimedAt: claimedDaysAgo === null ? null : isoDaysAgo(claimedDaysAgo),
    disabledAt: disabledDaysAgo === null ? null : isoDaysAgo(disabledDaysAgo),
  };
  CARDS.push(card);
  return card;
}

// issued（未紐づけ）— 15 枚
for (let i = 0; i < 15; i += 1) {
  pushCard("issued", null, BATCHES[i % BATCHES.length]!, 5 + i * 2, null, null);
}

// active（引き取り済み）— 22 枚。所有者を利用者へ割り当てる
// （deleted の usr_preview12 には割り当てない——退会済みは手放している想定）。
const ACTIVE_OWNERS = USERS.filter((u) => u.status !== "deleted").map((u) => u.id);
for (let i = 0; i < 22; i += 1) {
  const owner = ACTIVE_OWNERS[i % ACTIVE_OWNERS.length]!;
  pushCard("active", owner, BATCHES[i % BATCHES.length]!, 60 + i, 55 + i, null);
}

// disabled — 8 枚。理由は disabled_reason_breakdown の内訳と揃える。
for (let i = 0; i < 8; i += 1) {
  const owner = ACTIVE_OWNERS[(i + 3) % ACTIVE_OWNERS.length]!;
  pushCard("disabled", owner, BATCHES[i % BATCHES.length]!, 90 + i, 85 + i, 10 + i);
}

/** `/nfc/:cardId` のプレビュー対象（#472）。無効化・理由未記録のデモ。 */
const DETAIL_CARD_ID = CARDS[CARDS.length - 1]!.cardId;
/** 引き取り済みでタップ 0 件（死蔵）のデモ。`cardDetailFor` の判定と対にしてある。 */
const DORMANT_CARD_ID = CARDS[21]!.cardId;

const DISABLED_REASON_ROWS: readonly { readonly reason: string | null; readonly count: number }[] =
  [
    { reason: "lost", count: 3 },
    { reason: "unused", count: 2 },
    { reason: "admin_action", count: 2 },
    { reason: "admin_batch", count: 1 },
  ];

/**
 * カード詳細（#472）の 1 枚ぶん。`CARDS` には `transferCount` /
 * `disabledReason` / `tapCount` / `lastTappedAt` が無い（一覧用の型に
 * 無いので）——ここで決定的に作る。1 枚だけ「理由は記録されていません」
 * （運用者からの指摘で足した表示）を再現する。
 */
const DISABLED_REASON_CYCLE: readonly (string | null)[] = [
  "lost",
  "unused",
  "admin_action",
  "admin_batch",
  null,
];

function cardDetailFor(card: AdminCardViewDelegated): AdminCardDetailDelegated {
  const index = CARDS.indexOf(card);
  // 7 の倍数の active カードは、引き取り済みでタップ 0 件の「死蔵」の見た目を
  // 再現する（issue #472 の「死蔵の 1 枚ごとの顔」）。
  const tapCount = card.status === "active" && index % 7 !== 0 ? 3 + (index % 40) : 0;
  const lastTappedAt = tapCount > 0 ? isoDaysAgo(index % 10).slice(0, 10) : null;

  return {
    cardId: card.cardId,
    status: card.status,
    ownerUserId: card.ownerUserId,
    targetUrl: card.targetUrl,
    batch: card.batch,
    issuedAt: card.issuedAt,
    claimedAt: card.claimedAt,
    transferCount: card.status === "active" ? index % 3 : 0,
    disabledAt: card.disabledAt,
    disabledReason:
      card.status === "disabled"
        ? (DISABLED_REASON_CYCLE[index % DISABLED_REASON_CYCLE.length] ?? null)
        : null,
    tapCount,
    lastTappedAt,
  };
}

// --------------------------------------------------------------------- 監査ログ
//
// 20 行。`DETAIL_USER_ID` には ops.user.suspended を 1 行、
// `SELF_CLOSED_USER_ID` には account.closed を 1 行——どちらも
// `suspension-origin.ts` が引く専用クエリで実際に引っかかる形にする。
const AUDIT_LOG: AuditLogEntryAdmin[] = [];
let auditSeq = 0;
function pushAudit(
  event: string,
  userId: string | null,
  daysAgo: number,
  outcome: "success" | "failure" = "success",
  metadata: Record<string, unknown> | null = null,
): void {
  auditSeq += 1;
  AUDIT_LOG.push({
    id: `aud_preview${String(auditSeq).padStart(4, "0")}`,
    event,
    userId,
    actor: "admin-worker",
    outcome,
    reason: null,
    metadata,
    ipHash: null,
    userAgent: null,
    createdAt: isoDaysAgo(daysAgo),
  });
}

pushAudit("ops.user.suspended", DETAIL_USER_ID, 5, "success", {
  reason: "compromise",
  revokedSessions: 2,
  actorUserId: "usr_preview01",
});
pushAudit("account.closed", SELF_CLOSED_USER_ID, 10, "success", {});
pushAudit("user.created", "usr_preview01", 150);
pushAudit("passkey.register", "usr_preview01", 149);
pushAudit("passkey.login", "usr_preview01", 2);
pushAudit("session.issue", "usr_preview02", 1);
pushAudit("oauth.token.issued", "usr_preview02", 1);
pushAudit("card.issued", null, 4, "success", { batch: "2026-bunkasai", count: 15 });
pushAudit("card.claimed", "usr_preview04", 55);
pushAudit("card.disabled", "usr_preview06", 10, "success", { reason: "lost" });
pushAudit("card.reinstated", "usr_preview06", 3, "success", { actingAsAdmin: true });
pushAudit("card.released", "usr_preview08", 20);
pushAudit("oauth.client.created", "usr_preview01", 60, "success", { clientId: "app_preview3" });
pushAudit("oauth.client.disabled", "usr_preview01", 8, "success", { clientId: "app_preview5" });
pushAudit("oauth.client.owner_changed", "usr_preview01", 7, "success", {
  clientId: "app_preview3",
});
pushAudit("oauth.client.app_url_changed", "usr_preview01", 6, "success", {
  clientId: "app_preview3",
});
pushAudit("ops.user.sessions_revoked", "usr_preview09", 6, "success", { revokedSessions: 1 });
pushAudit("ops.user.reinstated", "usr_preview10", 30);
pushAudit("ops.approval.granted", "usr_preview01", 100);
pushAudit("passkey.login", "usr_preview02", 0);
pushAudit("session.issue", "usr_preview04", 0);
pushAudit("otp.verify", "usr_preview11", 0, "failure");
AUDIT_LOG.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

// ----------------------------------------------------------- OAuth クライアント
const CLIENTS: readonly OAuthClientSummary[] = [
  {
    clientId: "u18-dashboard",
    name: "u18 Dashboard",
    clientType: "confidential",
    isFirstParty: true,
    logoUrl: null,
    redirectUris: ["https://account.under18.dev/callback"],
    scopes: ["openid", "profile", "email"],
    createdAt: isoDaysAgo(300),
    disabledAt: null,
    ownerUserId: null,
    appUrl: null,
  },
  {
    clientId: "u18-nfc",
    name: "u18 NFC Portal",
    clientType: "confidential",
    isFirstParty: true,
    logoUrl: null,
    redirectUris: ["https://auth.under18.dev/account/nfc/callback"],
    scopes: ["openid", "profile"],
    createdAt: isoDaysAgo(300),
    disabledAt: null,
    ownerUserId: null,
    appUrl: null,
  },
  {
    clientId: "app_preview3",
    name: "文化祭 入場管理アプリ（サンプル）",
    clientType: "confidential",
    isFirstParty: false,
    logoUrl: null,
    redirectUris: ["https://bunkasai-gate.example.test/callback"],
    scopes: ["openid", "profile"],
    createdAt: isoDaysAgo(60),
    disabledAt: null,
    ownerUserId: "usr_preview01",
    appUrl: "https://bunkasai-gate.example.test/",
  },
  {
    clientId: "app_preview4",
    name: "検証用 Public Client（サンプル）",
    clientType: "public",
    isFirstParty: false,
    logoUrl: null,
    redirectUris: ["https://spa.example.test/callback"],
    scopes: ["openid"],
    createdAt: isoDaysAgo(40),
    disabledAt: null,
    ownerUserId: null,
    appUrl: null,
  },
  {
    clientId: "app_preview5",
    name: "廃止されたテスト連携（サンプル）",
    clientType: "confidential",
    isFirstParty: false,
    logoUrl: null,
    redirectUris: ["https://retired.example.test/callback"],
    scopes: ["openid", "profile", "email"],
    createdAt: isoDaysAgo(90),
    disabledAt: isoDaysAgo(8),
    ownerUserId: null,
    appUrl: null,
  },
];

// --------------------------------------------------------------------- 解析
function buildTapTimeseries(days: number) {
  const dailyTotals = Array.from({ length: days }, (_, i) => {
    const dayIndex = days - 1 - i;
    const total = Math.max(0, Math.round(4 + 3 * Math.sin(dayIndex / 3) + (dayIndex % 5) - 2));
    return { date: isoDaysAgo(dayIndex).slice(0, 10), total };
  });
  const totalTaps = dailyTotals.reduce((sum, d) => sum + d.total, 0);
  const maxDay = dailyTotals.reduce(
    (max, d) => (max === null || d.total > max.total ? d : max),
    null as { date: string; total: number } | null,
  );
  return {
    dailyTotals,
    totalTaps,
    dailyAverage: Math.round((totalTaps / days) * 10) / 10,
    maxDay,
    retentionDays: 180,
  };
}

const BATCH_ANALYTICS_ROWS: readonly BatchAnalyticsRow[] = BATCHES.map((batch) => {
  const rows = CARDS.filter((c) => c.batch === batch);
  return {
    batch,
    issued: rows.length,
    claimedEver: rows.filter((c) => c.claimedAt !== null).length,
    disabled: rows.filter((c) => c.status === "disabled").length,
    tapsAllTime: rows.length * 3,
    tapsLast7d: Math.round(rows.length * 0.4),
  };
});

const EVER_CLAIMED = CARDS.filter((c) => c.claimedAt !== null);

// ---------------------------------------------------------------- RPC の fake

function unused(name: string): () => never {
  return () => {
    throw new Error(`${name} はこのプレビュー生成では使わない想定`);
  };
}

function filterAuditLog(input: ListAuditLogsDelegatedInput): readonly AuditLogEntryAdmin[] {
  let rows: readonly AuditLogEntryAdmin[] = AUDIT_LOG;
  if (input.userId !== undefined) rows = rows.filter((e) => e.userId === input.userId);
  if (input.event !== undefined) rows = rows.filter((e) => e.event === input.event);
  if (input.outcome !== undefined) rows = rows.filter((e) => e.outcome === input.outcome);
  return rows.slice(0, input.limit ?? 50);
}

const nfcCards: NfcAdminDelegatedRpcContract = {
  disableCard: unused("disableCard"),
  updateCardTarget: unused("updateCardTarget"),
  releaseCard: unused("releaseCard"),
  reinstateCard: unused("reinstateCard"),
  reinstateCardToIssued: unused("reinstateCardToIssued"),
  countBatchIssuedCards: unused("countBatchIssuedCards"),
  batchDisableCards: unused("batchDisableCards"),
  reinstateBatchToIssuedCards: unused("reinstateBatchToIssuedCards"),
  countDisabledInBatch: unused("countDisabledInBatch"),
  issueCards: unused("issueCards"),
  listAllCards: async (input?: ListAllCardsDelegatedInput) => {
    const filtered =
      input?.batch === undefined ? CARDS : CARDS.filter((c) => c.batch === input.batch);
    return rpcOk({
      cards: filtered.map((c) => ({ ...c, tapCount: cardDetailFor(c).tapCount })),
      truncated: false,
    });
  },
  listCardsByOwner: async (input: ListCardsByOwnerDelegatedInput) =>
    rpcOk({ cards: CARDS.filter((c) => c.ownerUserId === input.ownerUserId) }),
  countCards: async () =>
    rpcOk({
      issued: CARDS.filter((c) => c.status === "issued").length,
      active: CARDS.filter((c) => c.status === "active").length,
      disabled: CARDS.filter((c) => c.status === "disabled").length,
    }),
  tapTimeseries: async (input: TapTimeseriesDelegatedInput) =>
    rpcOk(buildTapTimeseries(input.days)),
  usageFunnel: async () =>
    rpcOk({
      issued: CARDS.length,
      claimedEver: EVER_CLAIMED.length,
      tappedEver: Math.max(0, EVER_CLAIMED.length - 3),
      retentionDays: 180,
    }),
  batchAnalytics: async () => rpcOk({ rows: BATCH_ANALYTICS_ROWS }),
  cardUsageRanking: async () => {
    const active = CARDS.filter((c) => c.status === "active");
    const ranking = active.slice(0, 5).map((c, i) => ({
      cardId: c.cardId,
      batch: c.batch,
      status: c.status,
      total: 42 - i * 7,
    }));
    const dormantRows = active.slice(5, 8).map((c) => ({
      cardId: c.cardId,
      batch: c.batch,
      claimedAt: c.claimedAt ?? isoDaysAgo(60),
      status: c.status,
    }));
    return rpcOk({ ranking, dormant: { count: dormantRows.length, rows: dormantRows } });
  },
  disabledReasonBreakdown: async () => rpcOk({ rows: DISABLED_REASON_ROWS }),
  getCard: async (input: GetCardDelegatedInput) => {
    const card = CARDS.find((c) => c.cardId === input.cardId);
    if (card === undefined) return rpcErr(RpcErrorCode.NotFound, "not_found");
    return rpcOk(cardDetailFor(card));
  },
  cardTapHistory: async (input: CardTapHistoryDelegatedInput) => {
    const card = CARDS.find((c) => c.cardId === input.cardId);
    if (card === undefined) return rpcErr(RpcErrorCode.NotFound, "not_found");

    const detail = cardDetailFor(card);
    const dailyTotals = Array.from({ length: input.days }, (_, i) => {
      const date = isoDaysAgo(input.days - 1 - i).slice(0, 10);
      const total = detail.tapCount > 0 && i % 4 === 0 ? 1 : 0;
      return { date, total };
    });
    const totalTaps = dailyTotals.reduce((sum, day) => sum + day.total, 0);
    const daysSinceLastTap =
      detail.lastTappedAt === null
        ? null
        : Math.round((NOW - Date.parse(`${detail.lastTappedAt}T00:00:00Z`)) / DAY_MS);

    return rpcOk({
      dailyTotals,
      totalTaps,
      retentionDays: 180,
      lastTappedAt: detail.lastTappedAt,
      daysSinceLastTap,
      last7d: { total: Math.min(totalTaps, 2), previousTotal: Math.min(totalTaps, 1) },
      last30d: { total: Math.min(totalTaps, 6), previousTotal: Math.min(totalTaps, 4) },
    });
  },
  transferCountDistribution: async () => {
    const total = EVER_CLAIMED.length;
    const zero = Math.round(total * 0.65);
    const one = Math.round(total * 0.2);
    const two = Math.round(total * 0.1);
    return rpcOk({ zero, one, two, threeOrMore: Math.max(0, total - zero - one - two) });
  },
};

const identityAdmin: IdentityAdminDelegatedRpcContract = {
  suspendUser: unused("suspendUser"),
  reinstateUser: unused("reinstateUser"),
  revokeUserSessions: unused("revokeUserSessions"),
  createOAuthClient: unused("createOAuthClient"),
  disableOAuthClient: unused("disableOAuthClient"),
  setOAuthClientOwner: unused("setOAuthClientOwner"),
  setOAuthClientAppUrl: unused("setOAuthClientAppUrl"),
  listUsers: async (input: ListUsersDelegatedInput) => {
    let rows = USERS;
    if (input.query !== undefined) {
      rows = rows.filter((u) => u.primaryEmail === input.query || u.username === input.query);
    }
    const limit = input.limit ?? 50;
    return rpcOk({ users: rows.slice(0, limit), nextCursor: null });
  },
  getUser: async (input: GetUserDelegatedInput) => {
    const user = USERS.find((u) => u.id === input.userId);
    return user === undefined ? rpcErr(RpcErrorCode.NotFound, "user not found") : rpcOk(user);
  },
  // カードの所有者・監査ログの actor を名前で出す（#471）。
  getUsersByIds: async (input: GetUsersByIdsDelegatedInput) =>
    rpcOk(
      USERS.filter((u) => input.userIds.includes(u.id)).map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        status: u.status,
      })),
    ),
  listOAuthClients: async () => rpcOk(CLIENTS),
  getOAuthClient: async (input: GetOAuthClientDelegatedInput) => {
    const found = CLIENTS.find((c) => c.clientId === input.clientId);
    return found === undefined ? rpcErr(RpcErrorCode.NotFound, "client not found") : rpcOk(found);
  },
  countOAuthClients: async () => rpcOk(CLIENTS.length),
  listAuditLogs: async (input: ListAuditLogsDelegatedInput) =>
    rpcOk({ entries: filterAuditLog(input), nextCursor: null }),
};

const PENDING_SUB = "usr_preview_pending";
const SUB = "usr_preview01";

// ------------------------------------------------------------------- 承認
//
// `test/helpers.ts` の `fakeApprovals` と同じ in-memory 実装。**そのままは
// import できない**——あちらのファイルは `cloudflare:test` の `env` も
// 読むので、plain Node では読み込めない。ロジックは完全に同じ。
// `/approvals`（#190）のプレビューにも使うので、3 人ぶん用意する——
// `SUB` 本人（super approver）と、権限を絞った一般の承認者 2 人。
type FakeApprovalRow = {
  isSuperApprover: boolean;
  permissions: bigint;
  approvedBySub: string | null;
  createdAt: Date;
};

const approvalRows = new Map<string, FakeApprovalRow>([
  [
    SUB,
    {
      isSuperApprover: true,
      permissions: ALL_DEFINED_PERMISSIONS,
      approvedBySub: null,
      createdAt: new Date(isoDaysAgo(300)),
    },
  ],
  [
    "usr_preview02",
    {
      isSuperApprover: false,
      permissions: ALL_DEFINED_PERMISSIONS,
      approvedBySub: SUB,
      createdAt: new Date(isoDaysAgo(90)),
    },
  ],
  [
    "usr_preview09",
    {
      isSuperApprover: false,
      permissions: 0n,
      approvedBySub: SUB,
      createdAt: new Date(isoDaysAgo(20)),
    },
  ],
]);

const approvals: ApprovalRepository = {
  isApproved: async (sub) => approvalRows.has(sub),
  isSuperApprover: async (sub) => approvalRows.get(sub)?.isSuperApprover ?? false,
  countSuperApprovers: async () =>
    [...approvalRows.values()].filter((row) => row.isSuperApprover).length,
  getEffectivePermissions: async (sub) => {
    const row = approvalRows.get(sub);
    return row === undefined ? null : effectivePermissions(row);
  },
  listAll: async () =>
    [...approvalRows.entries()]
      .map(([sub, row]) => ({ sub, ...row }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
  getBySub: async (sub) => {
    const row = approvalRows.get(sub);
    return row === undefined ? null : { sub, ...row };
  },
  grant: async (sub, isSuperApprover, approvedBySub) => {
    const existing = approvalRows.get(sub);
    approvalRows.set(sub, {
      isSuperApprover,
      permissions: existing?.permissions ?? 0n,
      approvedBySub: existing?.approvedBySub ?? approvedBySub,
      createdAt: existing?.createdAt ?? new Date(),
    });
    return { isSuperApprover };
  },
  revoke: async (sub) => approvalRows.delete(sub),
  setPermissions: async (sub, permissions) => {
    const existing = approvalRows.get(sub);
    if (existing === undefined) return false;
    approvalRows.set(sub, { ...existing, permissions });
    return true;
  },
  recordAuditEvent: async () => undefined,
};

// ------------------------------------------------------------------- ログイン

/**
 * `test/helpers.ts` の `loginAs` と同じ手順。**そのままは import できない**
 * ——あちらは `cloudflare:test` の `env` を読むが、ここは plain Node で
 * 動くので自前の `env` を使う。ロジックは完全に同じ。
 */
async function loginAs(
  sub: string,
  overrides: ContainerOverrides,
  acr = "passkey",
): Promise<string> {
  const idp = await createFakeIdp(env.AUTH_ISSUER);
  const loginApp = createApp({ ...overrides, fetcher: idp.fetcherReturning("unused") });
  const loginResponse = await loginApp.fetch(
    new Request(`${env.ADMIN_ORIGIN}/login`),
    env,
    executionContext,
  );
  const authorizeUrl = new URL(loginResponse.headers.get("Location") ?? "");
  const state = authorizeUrl.searchParams.get("state")!;
  const nonce = authorizeUrl.searchParams.get("nonce")!;
  const loginStateCookie = cookieHeaderFrom(loginResponse);

  const idToken = await idp.signIdToken({ sub, aud: env.OIDC_CLIENT_ID, nonce, acr });
  const callbackApp = createApp({ ...overrides, fetcher: idp.fetcherReturning(idToken) });
  const callbackResponse = await callbackApp.fetch(
    new Request(`${env.ADMIN_ORIGIN}/callback?code=c1&state=${state}`, {
      headers: { Cookie: loginStateCookie },
    }),
    env,
    executionContext,
  );
  return cookieHeaderFrom(callbackResponse);
}

// --------------------------------------------------------------------- 書き出し

const overrides: ContainerOverrides = { approvals, nfcCards, identityAdmin };
const app = createApp(overrides);

async function fetchHtml(path: string, cookie?: string): Promise<string> {
  const response = await app.fetch(
    new Request(`${env.ADMIN_ORIGIN}${path}`, {
      ...(cookie === undefined ? {} : { headers: { Cookie: cookie } }),
    }),
    env,
    executionContext,
  );
  const body = await response.text();
  if (response.status >= 500) {
    throw new Error(`${path} が ${response.status} を返しました:\n${body.slice(0, 2000)}`);
  }
  return body;
}

/** `<link rel="stylesheet" href="/ui/kiwa.<hash>.css"/>` を相対パスへ書き換える。 */
function withLocalStylesheet(html: string): string {
  return html.replace(/href="\/ui\/kiwa\.[0-9a-f]+\.css"/, 'href="./kiwa.css"');
}

/**
 * `<script type="module" src="/ui/admin-island.<hash>.js">` を相対パスへ
 * 書き換える（#470）。**JS も書き出さないと、プレビューで並べ替え・
 * 絞り込み・コピー・タブ・通知の動きを確かめられない**（issue の絶対条件）。
 */
function withLocalIsland(html: string): string {
  return html.replace(/src="\/ui\/admin-island\.[0-9a-f]+\.js"/, 'src="./admin-island.js"');
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const sessionCookie = await loginAs(SUB, overrides);
  const pendingCookie = await loginAs(PENDING_SUB, overrides);

  const pages: { readonly name: string; readonly title: string; readonly html: string }[] = [];

  async function addPage(
    name: string,
    title: string,
    path: string,
    cookie?: string,
  ): Promise<void> {
    const html = withLocalIsland(withLocalStylesheet(await fetchHtml(path, cookie)));
    pages.push({ name, title, html });
  }

  await addPage("home", "ホーム（/）", "/", sessionCookie);
  await addPage("nfc", "NFC カード（/nfc）", "/nfc", sessionCookie);
  await addPage("nfc-analytics", "NFC 解析（/nfc/analytics）", "/nfc/analytics", sessionCookie);
  await addPage(
    "nfc-card-detail",
    `カード詳細（/nfc/${DETAIL_CARD_ID}、#472・無効化＋理由未記録のデモ）`,
    `/nfc/${DETAIL_CARD_ID}`,
    sessionCookie,
  );
  await addPage(
    "nfc-card-detail-dormant",
    `カード詳細（/nfc/${DORMANT_CARD_ID}、#472・死蔵のデモ）`,
    `/nfc/${DORMANT_CARD_ID}`,
    sessionCookie,
  );
  await addPage("users", "利用者一覧（/users）", "/users", sessionCookie);
  await addPage(
    "users-detail",
    `利用者詳細（/users/${DETAIL_USER_ID}、運営による凍結の例）`,
    `/users/${DETAIL_USER_ID}`,
    sessionCookie,
  );
  await addPage(
    "users-detail-self-closed",
    `利用者詳細（/users/${SELF_CLOSED_USER_ID}、本人の退会の例）`,
    `/users/${SELF_CLOSED_USER_ID}`,
    sessionCookie,
  );
  await addPage("clients", "OAuth クライアント（/clients）", "/clients", sessionCookie);
  await addPage(
    "clients-detail",
    "OAuth クライアント詳細（/clients/app_preview3、#473）",
    "/clients/app_preview3",
    sessionCookie,
  );
  await addPage("audit", "監査ログ（/audit）", "/audit", sessionCookie);
  await addPage("approvals", "承認・権限の管理（/approvals、#190）", "/approvals", sessionCookie);
  await addPage("pending", "承認待ち（/pending）", "/pending", pendingCookie);
  await addPage(
    "callback-failure",
    "ログイン失敗画面（/callback、未認証でも見られる）",
    "/callback",
  );

  /**
   * `data-tabs` の見本（#470）。**実在するルートではない。** この issue の
   * 3 画面はどれもタブを使わない（#454 の 6 区画を縦一列のままにする判断
   * のため）ので、どのページを引いても `data-tabs` が動いている様子を
   * 確かめられない。#471〜#473 が最初の利用者になる前に、架空データで
   * 1 枚だけ動く見本を出しておく（3b の指示）。
   */
  const tabsSampleHtml = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>data-tabs の見本 | u18 Identity</title>
<link rel="stylesheet" href="./kiwa.css" />
<script type="module" src="./admin-island.js" defer></script>
</head>
<body>
<main class="px-5 py-8 md:px-10 md:py-12">
<div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
<div class="flex flex-col gap-2">
<h1 class="text-2xl">data-tabs の見本（架空データ）</h1>
<p class="text-sm/relaxed text-foreground-muted">
JS が無効なら、下の 3 枚は見出し付きで縦に並んだまま読めます。
JS が有効なら、タブで切り替えられます。
</p>
</div>
<div data-tabs class="flex flex-col gap-4">
<div role="tablist" class="flex gap-2 border-b border-border" aria-label="見本のタブ">
<button type="button" data-tab="apple" class="px-3 py-2 text-sm font-medium text-foreground-muted hover:text-foreground">りんご</button>
<button type="button" data-tab="banana" class="px-3 py-2 text-sm font-medium text-foreground-muted hover:text-foreground">ばなな</button>
<button type="button" data-tab="cherry" class="px-3 py-2 text-sm font-medium text-foreground-muted hover:text-foreground">さくらんぼ</button>
</div>
<section data-panel="apple" class="flex flex-col gap-2">
<h2 class="text-lg">りんご</h2>
<p class="text-sm/relaxed text-foreground-muted">1 枚目の中身（架空）。</p>
</section>
<section data-panel="banana" class="flex flex-col gap-2">
<h2 class="text-lg">ばなな</h2>
<p class="text-sm/relaxed text-foreground-muted">2 枚目の中身（架空）。</p>
</section>
<section data-panel="cherry" class="flex flex-col gap-2">
<h2 class="text-lg">さくらんぼ</h2>
<p class="text-sm/relaxed text-foreground-muted">3 枚目の中身（架空）。</p>
</section>
</div>
</div>
</main>
</body>
</html>
`;
  pages.push({
    name: "tabs-sample",
    title: "data-tabs の見本（#470、架空データ）",
    html: tabsSampleHtml,
  });

  /**
   * `data-select` / `data-select-all` / `data-select-count` の見本（#481）。
   * **実在するルートではない。** `/nfc` 自体の書き換え（1 枚ずつの操作を
   * 外し、選択 + 一括操作を入れる）は別セッションの担当で、まだ main に
   * 入っていない——`tabs-sample` と同じ理由で、架空データの見本を先に
   * 出しておく。
   *
   * **送信先（`action`）は実在しない。** ここは JS 側の挙動（件数表示・
   * 全選択・絞り込みとの連携）を確かめる見本であって、実際の一括操作を
   * 試す場所ではない。
   */
  const bulkSelectSampleHtml = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>選択と一括操作の見本 | u18 Identity</title>
<link rel="stylesheet" href="./kiwa.css" />
<script type="module" src="./admin-island.js" defer></script>
</head>
<body>
<main class="px-5 py-8 md:px-10 md:py-12">
<div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
<div class="flex flex-col gap-2">
<h1 class="text-2xl">選択と一括操作の見本（架空データ）</h1>
<p class="text-sm/relaxed text-foreground-muted">
JS が無効でも、チェックして下のボタンを押せば一括操作の form は送信できます
（送信先はこの見本では実在しません）。JS が有効なら、件数表示と「表示中を
全選択」が動きます。上の絞り込み欄で banana を隠すと、banana の選択も
一緒に外れます。
</p>
</div>
<form method="post" action="/__preview-only__/bulk-sample" class="flex flex-col gap-4">
<input
  type="text"
  data-filter="sample-cards"
  hidden
  placeholder="この一覧から絞り込み"
  aria-label="この一覧から絞り込み"
  class="w-full rounded-lg border border-border px-3 py-2 text-sm"
/>
<table id="sample-cards" data-sortable class="w-full text-sm">
<thead>
<tr>
<th><input type="checkbox" data-select-all="sample-cards" hidden /></th>
<th data-sort="text">カード ID</th>
<th data-sort="text">状態</th>
</tr>
</thead>
<tbody>
<tr><td><input type="checkbox" data-select="sample-cards" name="card_id" value="nfc_apple" /></td><td>nfc_apple</td><td>有効</td></tr>
<tr><td><input type="checkbox" data-select="sample-cards" name="card_id" value="nfc_banana" /></td><td>nfc_banana</td><td>有効</td></tr>
<tr><td><input type="checkbox" data-select="sample-cards" name="card_id" value="nfc_cherry" /></td><td>nfc_cherry</td><td>無効化済み</td></tr>
</tbody>
</table>
<output data-select-count="sample-cards" class="text-sm text-foreground-muted">選択したカードに対して操作します。</output>
<div class="flex gap-3">
<button type="submit" name="action" value="disable" class="rounded-lg border border-border px-3 py-2 text-sm">選択したカードを無効化する</button>
<button type="submit" name="action" value="reinstate" class="rounded-lg border border-border px-3 py-2 text-sm">選択したカードを復帰させる</button>
</div>
</form>
</div>
</main>
</body>
</html>
`;
  pages.push({
    name: "bulk-select-sample",
    title: "選択と一括操作の見本（#481、架空データ）",
    html: bulkSelectSampleHtml,
  });

  await writeFile(`${OUTPUT_DIR}/kiwa.css`, KIWA_STYLESHEET, "utf8");
  await writeFile(`${OUTPUT_DIR}/admin-island.js`, ADMIN_ISLAND_JS, "utf8");
  for (const page of pages) {
    await writeFile(`${OUTPUT_DIR}/${page.name}.html`, page.html, "utf8");
  }

  const indexHtml = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>admin-worker HTML プレビュー</title>
<link rel="stylesheet" href="./kiwa.css" />
</head>
<body style="padding: 2rem; max-width: 40rem; margin: 0 auto;">
<h1>admin-worker HTML プレビュー</h1>
<p><strong>すべて架空のデータです。本番には一切繋がっていません。</strong></p>
<ul>
${pages.map((p) => `  <li><a href="./${p.name}.html">${p.title}</a></li>`).join("\n")}
</ul>
</body>
</html>
`;
  await writeFile(`${OUTPUT_DIR}/index.html`, indexHtml, "utf8");

  console.log(`書き出し完了: ${OUTPUT_DIR}/index.html を開いてください（${pages.length} 画面）。`);
}

await main();
