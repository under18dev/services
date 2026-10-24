import type { Card } from "../../domain/entities/card";
import type { CardView } from "../ports";

/**
 * Domain Entity を所有者向けの DTO へ写す。
 *
 * Entity をそのまま返さないのは、`claimCodeHash` のような
 * 「所有者にも見せる理由が無い」列を、足した瞬間に応答へ混ぜないため。
 * 新しい列を増やしたときに、ここへ 1 行書くまでは外へ出ない。
 */
export function toCardView(card: Card): CardView {
  return {
    cardId: card.id,
    status: card.status,
    targetUrl: card.targetUrl,
    claimedAt: card.claimedAt?.toISOString() ?? null,
    transferCount: card.transferCount,
    disabledAt: card.disabledAt?.toISOString() ?? null,
    disabledReason: card.disabledReason,
  };
}
