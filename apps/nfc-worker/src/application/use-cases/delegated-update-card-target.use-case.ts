import { validateTargetUrl } from "../../domain/services/target-url";
import type { CardEventRecorder, CardRepository, Clock, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

export type DelegatedUpdateCardTargetInput = {
  /** admin-worker が確認済みの userId。検証しない（宣言は `DelegatedDisableCardUseCase` と同じ）。 */
  readonly actorUserId: string;
  readonly cardId: string;
  readonly targetUrl: string;
};

/**
 * 運営（admin-worker 経由）が、他人のカードの遷移先を書き換える
 * （#382 / #390 決定 16 ③）。**`DelegatedDisableCardUseCase` と対になる
 * 2 本目。** 止めるほどではないが直したい場合の手段で、優先度は
 * 無効化より一段下がる（`AdminUpdateCardTargetUseCase` と同じ理由）。
 *
 * `IdentityGateway` に依存しない理由、冪等性・監査の考え方は
 * `DelegatedDisableCardUseCase` の冒頭を参照。
 *
 * ## 検証の順序は所有者向け・セッション版と揃える
 *
 * URL の検証は**存在確認の後**に行う。先に検証すると、存在しないカード
 * ID に対して「URL は妥当だがカードが無い」と「URL が不正」で応答が
 * 分かれ、カードの実在を測る物差しになる。
 *
 * ## 無効化済みには効かない
 *
 * `updateTargetAsAdmin` が `active` だけを条件にする。無効化済みの
 * カードは運営が書き換えても意味を持たない。
 */
export class DelegatedUpdateCardTargetUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly events: CardEventRecorder,
    private readonly clock: Clock,
    private readonly blockedOrigins: readonly string[],
  ) {}

  async execute(input: DelegatedUpdateCardTargetInput): Promise<NfcOutcome<null>> {
    const card = await this.cards.findById(input.cardId);
    if (card === null || card.isDisabled) {
      return outcomeErr({ kind: "card_not_found" });
    }

    const validated = validateTargetUrl(input.targetUrl, this.blockedOrigins);
    if (!validated.ok) {
      return outcomeErr({ kind: "invalid_target_url", reason: validated.reason });
    }

    const now = this.clock.now();
    const updated = await this.cards.updateTargetAsAdmin(input.cardId, validated.url, now);
    if (!updated) return outcomeErr({ kind: "card_not_found" });

    await this.events.record({
      cardId: input.cardId,
      event: "card.target_updated",
      actorUserId: input.actorUserId,
      metadata: { targetUrl: validated.url, actingAsAdmin: true },
    });

    return outcomeOk(null);
  }
}
