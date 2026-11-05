import { ADMIN_ACTION_DISABLED_REASON } from "../../domain/services/disabled-reason";
import type { CardEventRecorder, CardRepository, Clock, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

export type DelegatedDisableCardInput = {
  /**
   * admin-worker が確認済みの、操作者（運営）の userId。
   *
   * **ここでは検証しない。** 検証は admin-worker 側（OIDC ログイン +
   * 承認リスト）で終わっており、ここへ辿り着けること自体が Service
   * Binding で保証されている（`NfcAdminDelegatedRpcContract` の冒頭）。
   */
  readonly actorUserId: string;
  readonly cardId: string;
  /**
   * `disabled_reason` に書く理由（#486）。**省略時は `ADMIN_ACTION_DISABLED_REASON`
   * （`"admin_action"`）**——単発の運営操作という、この口のこれまでの
   * 既定の意味そのまま。admin-worker の凍結連動の無効化だけが
   * `"owner_suspended"` を渡す（契約の `disableCardDelegatedInputSchema`
   * の JSDoc を参照）。
   */
  readonly reason?: string;
};

/**
 * 運営（admin-worker 経由）が、他人のカードを無効化する（#382 /
 * #390 決定 16 ③）。
 *
 * ## ここは認可を持たない
 *
 * admin-worker の delegated RPC からだけ呼ばれる。認可は既に
 * admin-worker が済ませているので、`IdentityGateway` への依存を
 * 持たない —— **依存が無いこと自体が「ここでは認可しない」設計の表明**
 * である（依存を持たせると、持っているのに呼ばない形になり、次に読む
 * 人が「呼び忘れでは」と疑う余地を作る）。
 *
 * **#433 まで兄弟が居た。** `AdminDisableCardUseCase` が `sessionToken`
 * を受け取り、`requireAdminUserId` で `isAdmin` を確かめてから同じことを
 * していた —— `/account/nfc/admin`（セッション Cookie 経由の運営画面）
 * 専用である。あの画面ごと消えたので、**他人のカードを止める口は
 * これ 1 本になった。**
 *
 * ## 冪等性・監査
 *
 * 既に無効化済みのカードへもう一度叩いても失敗にしない。`actorUserId`
 * をそのまま `nfc_card_events.actor_user_id` へ記録し、`metadata` に
 * `actingAsAdmin: true` を立てる —— **「所有者が止めた」と区別できる
 * ようにする**ための印で、こちらも消さない。
 */
export class DelegatedDisableCardUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: DelegatedDisableCardInput): Promise<NfcOutcome<null>> {
    const card = await this.cards.findById(input.cardId);
    if (card === null) return outcomeErr({ kind: "card_not_found" });

    if (!card.isDisabled) {
      const reason = input.reason ?? ADMIN_ACTION_DISABLED_REASON;
      const now = this.clock.now();
      const disabled = await this.cards.disableAsAdmin(input.cardId, reason, now);
      if (!disabled) return outcomeErr({ kind: "card_not_found" });

      // **イベントの `metadata.reason` も同じ値に揃える**（#436 の
      // `DelegatedBatchDisableCardsUseCase` と同じ判断）。1 つの操作が
      // 2 つの違う文字列で説明される状態を増やさない。
      await this.events.record({
        cardId: input.cardId,
        event: "card.disabled",
        actorUserId: input.actorUserId,
        metadata: { reason, actingAsAdmin: true },
      });
    }

    return outcomeOk(null);
  }
}
