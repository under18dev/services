import type { CardRepository, CardView, IdentityGateway, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";
import { requireActor } from "./authenticate";
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
/**
 * 一覧と、**サイドバーの出し分けに要る `isAdmin`**（#333）。
 *
 * **`isAdmin` を一緒に返すのは、往復を増やさないため。** `requireActor`
 * が呼ぶ `getSession` が既に持っている値で、画面はこれ 1 本で描ける。
 *
 * **画面の都合がここに入っている**ことは承知のうえである。別に取りに
 * 行かせると、**同じ応答の中でサイドバーと本文が違うセッションを見る**
 * 窓ができる。
 */
export type ListMyCardsOutput = {
  readonly cards: readonly CardView[];
  readonly isAdmin: boolean;
};

export class ListMyCardsUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
  ) {}

  async execute(sessionToken: string | undefined): Promise<NfcOutcome<ListMyCardsOutput>> {
    const actor = await requireActor(this.identity, sessionToken);
    if (!actor.ok) return actor;

    const owned = await this.cards.listByOwner(actor.value.userId);
    return outcomeOk({ cards: owned.map(toCardView), isAdmin: actor.value.isAdmin });
  }
}
