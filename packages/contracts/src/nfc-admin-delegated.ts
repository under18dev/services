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

export type ListAllCardsDelegatedResult = RpcResult<{
  readonly cards: readonly AdminCardViewDelegated[];
  /** 上限で打ち切ったか。true なら画面にそう出すこと（セッション版と同じ判断）。 */
  readonly truncated: boolean;
}>;

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
  /** 全カードの一覧。入力は無い——引数を受け取っても検証するものが無い。 */
  listAllCards(): Promise<ListAllCardsDelegatedResult>;
  issueCards(input: IssueCardsDelegatedInput): Promise<IssueCardsDelegatedResult>;
}
