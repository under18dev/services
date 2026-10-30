import type { Card } from "../../domain/entities/card";
import type { CardView } from "../ports";

/**
 * Domain Entity を所有者向けの DTO へ写す。
 *
 * Entity をそのまま返さないのは、`ownerUserId` のような「所有者本人にも
 * 見せる理由が無い」列を、足した瞬間に応答へ混ぜないため。新しい列を
 * 増やしたときに、ここへ 1 行書くまでは外へ出ない。
 *
 * **この Worker はもう秘密の列を持たない**（#358 で `claim_code_hash` が
 * 消えた）。それでもこの層を残すのは、**次に秘密の列が増えたときに
 * 既定で漏れない**ようにするためである。項目の集合は
 * `test/cards.api.test.ts` が固定している。
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
