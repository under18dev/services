import type { CardRepository, CardView, IdentityGateway, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";
import { requireUserId } from "./authenticate";
import { toCardView } from "./card-view";

/**
 * 自分のカード一覧（#31 の管理 API）。
 *
 * 入力はセッショントークンだけ。`userId` を引数に取らないのは
 * `IdentityRpcContract` と同じ理由で、取った瞬間に「他人の userId を
 * 指定して一覧を読む」入口になるため（docs/architecture.md 5.2）。
 *
 * 無効化済みのカードも返す。所有者本人には「自分が無効化した」ことが
 * 見えないと、紛失報告のあとで状態を確かめる手段が無くなる。
 */
export class ListMyCardsUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
  ) {}

  async execute(sessionToken: string | undefined): Promise<NfcOutcome<readonly CardView[]>> {
    const actor = await requireUserId(this.identity, sessionToken);
    if (!actor.ok) return actor;

    const owned = await this.cards.listByOwner(actor.value);
    return outcomeOk(owned.map(toCardView));
  }
}
