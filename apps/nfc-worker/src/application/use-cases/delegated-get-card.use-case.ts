import type { CardRepository, CardTapRecorder, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";
import type { CardStatus } from "../../domain/entities/card";

export type AdminCardDetailView = {
  readonly cardId: string;
  readonly status: CardStatus;
  readonly ownerUserId: string | null;
  readonly targetUrl: string | null;
  readonly batch: string | null;
  readonly issuedAt: string;
  readonly claimedAt: string | null;
  readonly transferCount: number;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly tapCount: number;
  readonly lastTappedAt: string | null;
};

/**
 * カード 1 枚の詳細（admin-worker のカード詳細ページ用、#472）。
 *
 * **`listAllCards` を引いて `cardId` で絞らないこと。** あちらは
 * `MAX_ADMIN_LIST`（500 枚）で打ち切るので、古いカードは一覧の外に出て
 * 「見つからない」ように見える——`DelegatedListCardsByOwnerUseCase` の
 * 冒頭と同じ理由。1 枚を名指しで引くので `findById` を直接使い、
 * 打ち切りはそもそも起こらない。
 *
 * **認可は持たない。** 呼べるのは admin-worker だけで、理由は
 * `DelegatedDisableCardUseCase` の冒頭。読み取りだけなので監査イベントも
 * 残さない。
 */
export class DelegatedGetCardUseCase {
  constructor(
    private readonly cards: CardRepository,
    private readonly cardTaps: CardTapRecorder,
  ) {}

  async execute(command: { readonly cardId: string }): Promise<NfcOutcome<AdminCardDetailView>> {
    const card = await this.cards.findById(command.cardId);
    if (card === null) return outcomeErr({ kind: "card_not_found" });

    const summary = await this.cardTaps.summaryFor(command.cardId);

    return outcomeOk({
      cardId: card.id,
      status: card.status,
      ownerUserId: card.ownerUserId,
      targetUrl: card.targetUrl,
      batch: card.batch,
      issuedAt: card.createdAt.toISOString(),
      claimedAt: card.claimedAt?.toISOString() ?? null,
      transferCount: card.transferCount,
      disabledAt: card.disabledAt?.toISOString() ?? null,
      disabledReason: card.disabledReason,
      tapCount: summary?.total ?? 0,
      lastTappedAt: summary?.lastTappedAt ?? null,
    });
  }
}
