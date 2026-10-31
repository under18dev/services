import type { CardRepository, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";
import type { CardStatus } from "../../domain/entities/card";

/**
 * 状態ごとの枚数（admin-worker のホーム用、#449）。
 *
 * **認可を持たない。** `DelegatedListAllCardsUseCase` と同じ理由——
 * ここへ辿り着けること自体が Service Binding で保証されている。
 * 読み取りだけなので `actorUserId` も受け取らない（`listAllCards` と
 * 同じ判断。監査イベントを書かない操作は実在確認の対象にもならない）。
 */
export class DelegatedCountCardsUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(): Promise<NfcOutcome<Readonly<Record<CardStatus, number>>>> {
    const counts = await this.cards.countByStatus();
    return outcomeOk(counts);
  }
}
