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
};

/**
 * 運営（admin-worker 経由）が、他人のカードを無効化する（#382 /
 * #390 決定 16 ③）。
 *
 * ## `AdminDisableCardUseCase` との違いは、認可を持たないことだけ
 *
 * `AdminDisableCardUseCase` は `sessionToken` を受け取り、
 * `requireAdminUserId` で `isAdmin` を確かめてから操作する ——
 * **`/account/nfc/admin` のセッション Cookie 経由の自己サービス UI
 * 専用**である。
 *
 * こちらは admin-worker の delegated RPC からだけ呼ばれる。認可は
 * 既に admin-worker が済ませているので、`IdentityGateway` への依存を
 * 持たない —— **依存が無いこと自体が「ここでは認可しない」設計の表明**
 * である（依存を持たせると、持っているのに呼ばない形になり、次に読む
 * 人が「呼び忘れでは」と疑う余地を作る）。
 *
 * ## 冪等性・監査は `AdminDisableCardUseCase` と揃える
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
      const now = this.clock.now();
      const disabled = await this.cards.disableAsAdmin(input.cardId, "admin_action", now);
      if (!disabled) return outcomeErr({ kind: "card_not_found" });

      await this.events.record({
        cardId: input.cardId,
        event: "card.disabled",
        actorUserId: input.actorUserId,
        metadata: { reason: "admin_action", actingAsAdmin: true },
      });
    }

    return outcomeOk(null);
  }
}
