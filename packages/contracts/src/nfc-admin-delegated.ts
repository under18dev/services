import { z } from "zod";
import type { RpcResult } from "./errors";

/**
 * nfc-worker の **`NfcAdminDelegatedRPC`** が公開する DTO（#382「他人の
 * カードへの操作」、#390 決定 16 ③）。
 *
 * ## なぜ `IdentityAdminDelegatedRPC` と同じ「delegated」系なのか
 *
 * admin-worker は OIDC で admin-worker 自身にログインし、admin-worker
 * 独自の承認リストで管理者性を確認している。auth-worker のセッション
 * Cookie を持たないので、**既存の管理 API（`sessionToken` 必須）を
 * そのまま呼べない。** d5 が auth-worker 側に設計した
 * `IdentityAdminDelegatedRPC` と同じ形を nfc-worker にも用意する。
 *
 * ## trust boundary は Service Binding そのものである
 *
 * **ここに届く `actorUserId` を検証しない。** 検証しなくてよい理由は、
 * この Entrypoint へ辿り着けること自体が Service Binding で保証されて
 * いるから —— admin-worker だけがこの Entrypoint を束縛でき、
 * admin-worker は呼ぶ前に自分の承認リストで管理者性を確かめている。
 * 二重に確かめる理由が無い（運用者の判断：権限判定は admin-worker 側へ
 * 全面移行）。
 *
 * **`actorUserId` は admin-worker が申告する ID Token の `sub`。**
 * nfc-worker はこの値を検証していない —— **admin-worker 自身の承認
 * リストの正しさに依存する。** `docs/threat-model.md` N-10 に同じ注記がある。
 *
 * ## セッション Cookie 経由の既存契約とは別にしてある
 *
 * `cards.routes.ts` / `cards-ui.routes.tsx` が使う JSON API・画面は
 * 一切変えていない。**この契約は admin-worker からの Service Binding
 * 経由の呼び出し専用**で、HTTP 経路は持たない。
 */

export const disableCardDelegatedInputSchema = z.object({
  /** admin-worker が確認済みの、操作者（運営）の userId。検証しない。 */
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
});

export type DisableCardDelegatedInput = z.infer<typeof disableCardDelegatedInputSchema>;
export type DisableCardDelegatedResult = RpcResult<null>;

export const updateCardTargetDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
  targetUrl: z.string().min(1),
});

export type UpdateCardTargetDelegatedInput = z.infer<typeof updateCardTargetDelegatedInputSchema>;
export type UpdateCardTargetDelegatedResult = RpcResult<null>;

export const releaseCardDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
});

export type ReleaseCardDelegatedInput = z.infer<typeof releaseCardDelegatedInputSchema>;
export type ReleaseCardDelegatedResult = RpcResult<null>;

export const reinstateCardDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
});

export type ReinstateCardDelegatedInput = z.infer<typeof reinstateCardDelegatedInputSchema>;
export type ReinstateCardDelegatedResult = RpcResult<null>;

export const reinstateCardToIssuedDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
});

export type ReinstateCardToIssuedDelegatedInput = z.infer<
  typeof reinstateCardToIssuedDelegatedInputSchema
>;
export type ReinstateCardToIssuedDelegatedResult = RpcResult<null>;

export const countBatchIssuedCardsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  batch: z.string().min(1).max(64),
});

export type CountBatchIssuedCardsDelegatedInput = z.infer<
  typeof countBatchIssuedCardsDelegatedInputSchema
>;
export type CountBatchIssuedCardsDelegatedResult = RpcResult<{ readonly count: number }>;

export const batchDisableCardsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  batch: z.string().min(1).max(64),
});

export type BatchDisableCardsDelegatedInput = z.infer<typeof batchDisableCardsDelegatedInputSchema>;
export type BatchDisableCardsDelegatedResult = RpcResult<{
  readonly cardIds: readonly string[];
}>;

export const countDisabledInBatchDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  batch: z.string().min(1).max(64),
});

export type CountDisabledInBatchDelegatedInput = z.infer<
  typeof countDisabledInBatchDelegatedInputSchema
>;
export type CountDisabledInBatchDelegatedResult = RpcResult<{ readonly count: number }>;

export const reinstateBatchToIssuedCardsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  batch: z.string().min(1).max(64),
});

export type ReinstateBatchToIssuedCardsDelegatedInput = z.infer<
  typeof reinstateBatchToIssuedCardsDelegatedInputSchema
>;
export type ReinstateBatchToIssuedCardsDelegatedResult = RpcResult<{
  readonly cardIds: readonly string[];
}>;

/**
 * 一覧・発行で使う、運営向けの表示用データ。
 *
 * **nfc-worker の `AdminCardView`（Application 層）を直接 import しない。**
 * Worker をまたぐ契約は `@u18/contracts` 側で独立して定義する ——
 * 直接参照すると、nfc-worker 内部の型を変えた瞬間に admin-worker の
 * ビルドが壊れる形になる（Worker 境界を跨ぐ依存の向きを 1 本にする）。
 */
export type AdminCardStatusDelegated = "issued" | "active" | "disabled";

export type AdminCardViewDelegated = {
  readonly cardId: string;
  readonly status: AdminCardStatusDelegated;
  /** 未紐づけなら null。 */
  readonly ownerUserId: string | null;
  readonly targetUrl: string | null;
  readonly batch: string | null;
  readonly issuedAt: string;
  readonly claimedAt: string | null;
  readonly disabledAt: string | null;
};

/**
 * 全カードの一覧（`/nfc`）だけで使う形（#481「並べ替えにタップ数を足す」）。
 *
 * **`AdminCardViewDelegated` に `tapCount` を直接足さない。**
 * `ListCardsByOwnerDelegatedResult` が同じ `AdminCardViewDelegated` を
 * 使い回していて、あちらは**所有者で引いたカードにタップ回数を乗せない**
 * ことを型で保証している（この型の宣言の下の JSDoc を参照）——共有の型へ
 * 足すと、その保証を黙って崩す。全カードの一覧にだけ要るので、専用の型を
 * 別に起こす。
 */
export type AdminCardListViewDelegated = AdminCardViewDelegated & {
  /** タップされた回数の合計（#394）。所有者には見せない——この一覧にだけ乗せる。 */
  readonly tapCount: number;
};

/**
 * `listAllCards` の入力（#481）。**全部省略可。** 省略すれば、これまでと
 * 同じ「全カード」の一覧になる。
 */
export const listAllCardsDelegatedInputSchema = z.object({
  /**
   * ロット名で絞り込む（完全一致）。**クライアント側の絞り込み（#470）と
   * 違い、`MAX_ADMIN_LIST` で打ち切る前に効く。** `/nfc/analytics` の
   * バッチ別の表から「このロットの N 枚を見る」に辿り着く唯一の経路
   * （issue #481 への追記）。
   */
  batch: z.string().min(1).max(64).optional(),
});

export type ListAllCardsDelegatedInput = z.infer<typeof listAllCardsDelegatedInputSchema>;

export type ListAllCardsDelegatedResult = RpcResult<{
  readonly cards: readonly AdminCardListViewDelegated[];
  /**
   * 上限で打ち切ったか。true なら画面にそう出すこと（セッション版と同じ判断）。
   *
   * **`batch` を渡したときは「そのロットの中で」打ち切ったかの意味になる。**
   * 全カードの打ち切りとは別の質問——`batch` 指定時にこれが true でも、
   * 他のロットのカードが読めていないわけではない。画面側がこの違いを
   * 読み違えないこと（3b のレビュー、issue #481）。
   */
  readonly truncated: boolean;
}>;

/**
 * 状態ごとの枚数（admin-worker のホーム用、#449）。
 *
 * **`listAllCards` を呼んで数えないこと。** あちらは `MAX_ADMIN_LIST` で
 * 打ち切るので、合計の用途には向かない——集計は nfc-worker 側の
 * `group by` 1 クエリで行う（`DelegatedCountCardsUseCase` を参照）。
 */
export type CountCardsDelegatedResult = RpcResult<
  Readonly<Record<AdminCardStatusDelegated, number>>
>;

export const issueCardsDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  count: z.number().int().min(1),
  /** ロット名。指定なしは null（空文字と区別する。`nfc-admin.routes.ts` を参照）。 */
  batch: z.string().min(1).max(64).nullable(),
});

export type IssueCardsDelegatedInput = z.infer<typeof issueCardsDelegatedInputSchema>;
export type IssueCardsDelegatedResult = RpcResult<{
  readonly cards: readonly { readonly cardId: string }[];
}>;

export const getCardDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
});

export type GetCardDelegatedInput = z.infer<typeof getCardDelegatedInputSchema>;

/**
 * カード 1 枚の詳細（admin-worker のカード詳細ページ用、#472）。
 *
 * **`AdminCardViewDelegated` を使い回さない。** あちらは一覧用で、1 枚を
 * 名指しで見る画面が要る `transferCount` / `disabledReason` /
 * `tapCount` / `lastTappedAt` を持たない——一覧の行にこれを全部足すと、
 * 列が増えすぎて `/nfc` の表が読みにくくなる（1 枚ずつ詳細で見る理由
 * そのもの）。
 */
export type AdminCardDetailDelegated = {
  readonly cardId: string;
  readonly status: AdminCardStatusDelegated;
  readonly ownerUserId: string | null;
  readonly targetUrl: string | null;
  readonly batch: string | null;
  readonly issuedAt: string;
  readonly claimedAt: string | null;
  readonly transferCount: number;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  /** タップされた回数の合計（#394）。カードが現存する限り全期間ぶん。 */
  readonly tapCount: number;
  /** 最後にタップされた日（UTC の日付文字列）。1 度も無ければ `null`。 */
  readonly lastTappedAt: string | null;
};

/** `not_found` ならそのカードは存在しない（`users.routes.tsx` の `userNotFound` と同じ扱い）。 */
export type GetCardDelegatedResult = RpcResult<AdminCardDetailDelegated>;

export const cardTapHistoryDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  cardId: z.string().min(1),
  days: z.union([z.literal(30), z.literal(90), z.literal(180)]),
});

export type CardTapHistoryDelegatedInput = z.infer<typeof cardTapHistoryDelegatedInputSchema>;

export type CardTapPeriodComparison = {
  readonly total: number;
  readonly previousTotal: number;
};

/**
 * カード 1 枚のタップ履歴（#472）。
 *
 * **時間帯（0-23 時）別は持たない。** `nfc_card_taps` は日付までしか
 * 持たない集計テーブルで（`packages/nfc-db/src/schema/taps.ts`）、
 * 理由は `DelegatedCardTapHistoryUseCase`（nfc-worker）の冒頭を参照
 * ——日次集計である設計そのものが意図的で、1 枚のカードの時間帯別は
 * 所有者 1 人の生活パターンそのものになるため作らないと判断した。
 *
 * **生のタップログ（1 件ずつの時刻・UA・IP）も持たない。** 1 枚のカードは
 * 1 人の持ち物なので、生ログはその人の行動履歴そのものになる。
 */
export type CardTapHistoryAnalytics = {
  /** `days` 件、古い日から新しい日の順。タップが無い日も `0` で埋まる。 */
  readonly dailyTotals: readonly { readonly date: string; readonly total: number }[];
  /** 表示した期間（`days` 日ぶん）の合計。 */
  readonly totalTaps: number;
  readonly retentionDays: number;
  readonly lastTappedAt: string | null;
  /** 最終タップから何日経ったか。`lastTappedAt` が `null` なら `null`。 */
  readonly daysSinceLastTap: number | null;
  /** 直近 7 日と、その直前 7 日の比較。 */
  readonly last7d: CardTapPeriodComparison;
  /** 直近 30 日と、その直前 30 日の比較。 */
  readonly last30d: CardTapPeriodComparison;
};

export type CardTapHistoryDelegatedResult = RpcResult<CardTapHistoryAnalytics>;

export const listCardsByOwnerDelegatedInputSchema = z.object({
  actorUserId: z.string().min(1),
  /** 持ち主の userId。**カード側の `owner_user_id` と突き合わせる。** */
  ownerUserId: z.string().min(1).max(64),
});

export type ListCardsByOwnerDelegatedInput = z.infer<typeof listCardsByOwnerDelegatedInputSchema>;

/**
 * 1 人が持っているカード（admin-worker のユーザー詳細ページ用、#455）。
 *
 * **`listAllCards` を引いて `ownerUserId` で絞らないこと。** あちらは
 * `MAX_ADMIN_LIST`（500 枚）で打ち切るので、**古いカードを持っている人の
 * 行は、黙って 1 枚も出ない。** 打ち切りの有無が「このユーザーはカードを
 * 持っていない」と見分けられない形になる。
 *
 * **`truncated` を持たない。** 件数が頭打ちになるのは `owner_user_id` が
 * 1 人ぶんだからで、全カードの一覧と違って「上限で切った」という状態が
 * そもそも起こらない。
 *
 * **タップ回数（`AdminCardView.tapCount` にあたるもの）はこの型に無い**
 * （#394 / #454 / #455）。`nfc_card_taps` は「誰が使ったか」を持たない
 * 設計で（`packages/nfc-db/src/schema/taps.ts` の冒頭）、所有者で引いた
 * カードに回数を添えると、**設計上持たないはずの「この人が何回使ったか」
 * を組み立てたことになる。** 詰め忘れではなく、詰めようがない形にして
 * ある（`OAuthClientSummary` が `client_secret_hash` を持たないのと同じ
 * 考え方）。
 */
export type ListCardsByOwnerDelegatedResult = RpcResult<{
  readonly cards: readonly AdminCardViewDelegated[];
}>;

/**
 * NFC の解析画面（#454）。読み取り専用で `actorUserId` を受け取らない
 * ——監査イベントを書かない操作は実在確認の対象にもならない
 * （`listAllCards` と同じ判断）。
 */
export const tapTimeseriesDelegatedInputSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180)]),
});

export type TapTimeseriesDelegatedInput = z.infer<typeof tapTimeseriesDelegatedInputSchema>;

/**
 * 解析画面（#454）の 6 区画ぶんの値型。**`RpcResult` で包む前の生の形**
 * ——admin-worker 側が `Promise.allSettled` で成功値だけ取り出したあと、
 * 画面の props にそのまま渡す（`AuditLogEntryAdmin` と同じ扱い方）。
 */
export type TapTimeseriesAnalytics = {
  readonly dailyTotals: readonly { readonly date: string; readonly total: number }[];
  readonly totalTaps: number;
  readonly dailyAverage: number;
  readonly maxDay: { readonly date: string; readonly total: number } | null;
  readonly retentionDays: number;
};
export type TapTimeseriesDelegatedResult = RpcResult<TapTimeseriesAnalytics>;

export type UsageFunnelAnalytics = {
  readonly issued: number;
  readonly claimedEver: number;
  readonly tappedEver: number;
  readonly retentionDays: number;
};
export type UsageFunnelDelegatedResult = RpcResult<UsageFunnelAnalytics>;

export type BatchAnalyticsRow = {
  readonly batch: string | null;
  readonly issued: number;
  readonly claimedEver: number;
  readonly disabled: number;
  readonly tapsAllTime: number;
  readonly tapsLast7d: number;
};
export type BatchAnalyticsDelegatedResult = RpcResult<{
  readonly rows: readonly BatchAnalyticsRow[];
}>;

export const cardUsageRankingDelegatedInputSchema = z.object({
  limit: z.number().int().min(1).max(100),
});

export type CardUsageRankingDelegatedInput = z.infer<typeof cardUsageRankingDelegatedInputSchema>;

export type CardUsageRankingRow = {
  readonly cardId: string;
  readonly batch: string | null;
  readonly status: AdminCardStatusDelegated;
  readonly total: number;
};
export type DormantCardRow = {
  readonly cardId: string;
  readonly batch: string | null;
  readonly claimedAt: string;
  readonly status: AdminCardStatusDelegated;
};
export type CardUsageRankingAnalytics = {
  readonly ranking: readonly CardUsageRankingRow[];
  readonly dormant: { readonly count: number; readonly rows: readonly DormantCardRow[] };
};
export type CardUsageRankingDelegatedResult = RpcResult<CardUsageRankingAnalytics>;

export type DisabledReasonBreakdownAnalytics = {
  readonly rows: readonly { readonly reason: string | null; readonly count: number }[];
};
export type DisabledReasonBreakdownDelegatedResult = RpcResult<DisabledReasonBreakdownAnalytics>;

export type TransferCountDistributionAnalytics = {
  readonly zero: number;
  readonly one: number;
  readonly two: number;
  readonly threeOrMore: number;
};
export type TransferCountDistributionDelegatedResult =
  RpcResult<TransferCountDistributionAnalytics>;

/**
 * `NfcAdminDelegatedRPC` の契約。
 *
 * **メソッドが増えるたびに、ここと Entrypoint の両方を変えること。**
 * Service Binding はメソッド単位で絞れないので、この Entrypoint を
 * 束縛した Worker は定義した全メソッドを呼べる —— 束縛先は admin-worker
 * だけにすること（`scripts/check-service-bindings.mjs`）。
 */
export interface NfcAdminDelegatedRpcContract {
  /**
   * #427 から、`issued`（未紐づけ）も対象にできる。それ以前は `active`
   * だけだった——未紐づけのカードを無効化する経路が 1 つも無く、
   * `batchDisableCards` の単発版が無いまま一括だけが存在する状態を
   * 避けるために広げた。
   */
  disableCard(input: DisableCardDelegatedInput): Promise<DisableCardDelegatedResult>;
  updateCardTarget(input: UpdateCardTargetDelegatedInput): Promise<UpdateCardTargetDelegatedResult>;
  /**
   * 所有権を剥奪し、`issued`（未紐づけ）へ戻す（#422）。**「付け替え」
   * ではない。** 直接別の利用者へ束縛する口は持たない——次にタップした
   * 人のものになる。理由は `DelegatedReleaseCardUseCase` の冒頭を参照。
   */
  releaseCard(input: ReleaseCardDelegatedInput): Promise<ReleaseCardDelegatedResult>;
  /**
   * 無効化されたカードを `active` へ戻す（#427、`go.under18.dev/docs` の
   * 「止めたカードは、自分では元に戻せません。戻したいときは運営に連絡
   * してください。」に対応する口）。
   *
   * **`active` へ戻すだけで、`issued`（手放す）とはまとめない。** 「戻し
   * たい」と「渡したい」は運営側の判断が違う場面で、1 操作に混ぜると
   * 復帰のつもりが次の拾得者へ渡る事故を作れる。渡したい場合は、復帰
   * させたあとであらためて `releaseCard` を呼ぶ——弱い操作を 2 つ並べる
   * ほうが、強い操作を 1 つ作るより安全（#422 の `releaseCard` と同じ
   * 判断）。理由は `DelegatedReinstateCardUseCase` の冒頭を参照。
   */
  reinstateCard(input: ReinstateCardDelegatedInput): Promise<ReinstateCardDelegatedResult>;
  /**
   * 無効化された、所有者の無い（`issued` 由来の）カード 1 枚を `issued`
   * へ戻す（#436、`reinstateCard` の対——所有者ありは `reinstateCard`、
   * 所有者無しはこちら）。`reinstateCard` を所有者の無いカードへ呼ぶと
   * 所有者の無いまま `active` になる壊れた行ができるため、呼び分けが
   * 要る。理由は `DelegatedReinstateCardToIssuedUseCase` の冒頭を参照。
   */
  reinstateCardToIssued(
    input: ReinstateCardToIssuedDelegatedInput,
  ): Promise<ReinstateCardToIssuedDelegatedResult>;
  /**
   * batch 一括無効化の確認画面が出す件数（#427「配布前の箱ごと盗難」）。
   * **書き込まない。** 2 段階確認の 1 段階目が呼ぶ——
   * `DelegatedBatchDisableCardsUseCase` の冒頭を参照。
   */
  countBatchIssuedCards(
    input: CountBatchIssuedCardsDelegatedInput,
  ): Promise<CountBatchIssuedCardsDelegatedResult>;
  /**
   * batch 単位で `issued`（未紐づけ）のカードを一括無効化する（#427）。
   * **`active` は対象外。** 理由・監査は `DelegatedBatchDisableCardsUseCase`
   * の冒頭を参照。戻す経路は `reinstateBatchToIssuedCards`（#436）。
   */
  batchDisableCards(
    input: BatchDisableCardsDelegatedInput,
  ): Promise<BatchDisableCardsDelegatedResult>;
  /**
   * batch 一括復帰の確認画面が出す件数（#436）。**書き込まない。**
   * 2 段階確認の 1 段階目が呼ぶ——`countBatchIssuedCards` と対称。
   */
  countDisabledInBatch(
    input: CountDisabledInBatchDelegatedInput,
  ): Promise<CountDisabledInBatchDelegatedResult>;
  /**
   * batch 単位で一括無効化された `issued` 由来のカードを一括で `issued`
   * へ戻す（#436、`batchDisableCards` の逆）。**この一括操作で無効化
   * された行だけが対象。** 理由は `DelegatedReinstateBatchToIssuedCardsUseCase`
   * の冒頭を参照。
   */
  reinstateBatchToIssuedCards(
    input: ReinstateBatchToIssuedCardsDelegatedInput,
  ): Promise<ReinstateBatchToIssuedCardsDelegatedResult>;
  /**
   * 全カードの一覧。**`input` は省略できる**——省略すれば従来どおり
   * 全カード。`batch` を渡せば、`MAX_ADMIN_LIST` の打ち切りの前にロット名
   * で絞り込む（#481）。`actorUserId` は受け取らない——他の読み取り専用
   * メソッドと同じ判断。
   */
  listAllCards(input?: ListAllCardsDelegatedInput): Promise<ListAllCardsDelegatedResult>;
  /** 状態ごとの枚数。入力は無い（#449）。 */
  countCards(): Promise<CountCardsDelegatedResult>;
  /**
   * 1 人が持っているカード（#455）。**`listAllCards` を引いて絞らない
   * こと**——理由は `ListCardsByOwnerDelegatedResult` の冒頭を参照。
   */
  listCardsByOwner(input: ListCardsByOwnerDelegatedInput): Promise<ListCardsByOwnerDelegatedResult>;
  issueCards(input: IssueCardsDelegatedInput): Promise<IssueCardsDelegatedResult>;

  /**
   * カード 1 枚の詳細（#472）。**`listAllCards` を引いて絞らない**——
   * 理由は `ListCardsByOwnerDelegatedResult` の冒頭と同じ（上限打ち切りで
   * 一覧の外に出たカードが「見つからない」ように見える）。1 枚を名指しで
   * 引くので打ち切りは起こらない。
   */
  getCard(input: GetCardDelegatedInput): Promise<GetCardDelegatedResult>;
  /**
   * カード 1 枚のタップ履歴（#472）。`days` は `30 | 90 | 180` の 3 択——
   * 画面はここで検証に落ちることが無いよう、呼ぶ前に不正値を 30 へ丸める
   * こと（`tapTimeseries` と同じ約束）。
   */
  cardTapHistory(input: CardTapHistoryDelegatedInput): Promise<CardTapHistoryDelegatedResult>;

  /**
   * NFC の解析画面（#454）。6 本とも読み取り専用。
   *
   * タップの日次時系列。`days` は `30 | 90 | 180` の 3 択——画面はここで
   * 検証に落ちることが無いよう、呼ぶ前に不正値を 30 へ丸めること
   * （`DelegatedTapTimeseriesUseCase` の冒頭を参照）。
   */
  tapTimeseries(input: TapTimeseriesDelegatedInput): Promise<TapTimeseriesDelegatedResult>;
  /** 発行 → 引き取り → 使用のファネル。入力は無い。 */
  usageFunnel(): Promise<UsageFunnelDelegatedResult>;
  /** バッチ単位の集計（発行・引き取り・無効化・タップ）。入力は無い。 */
  batchAnalytics(): Promise<BatchAnalyticsDelegatedResult>;
  /**
   * タップ上位ランキングと、引き取り済みでタップ 0 件の死蔵検出。
   * **`ownerUserId` を返さない**（`DelegatedCardUsageRankingUseCase` の
   * 冒頭を参照）。
   */
  cardUsageRanking(input: CardUsageRankingDelegatedInput): Promise<CardUsageRankingDelegatedResult>;
  /** `disabled_reason` 別の内訳。入力は無い。出てきた値をそのまま返す。 */
  disabledReasonBreakdown(): Promise<DisabledReasonBreakdownDelegatedResult>;
  /** `transferCount` の分布（0 / 1 / 2 / 3 以上）。入力は無い。 */
  transferCountDistribution(): Promise<TransferCountDistributionDelegatedResult>;
}
