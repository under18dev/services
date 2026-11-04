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
/**
 * 一覧だけ。
 *
 * **かつては `isAdmin` も返していた**（#333）—— サイドバーに管理の節を
 * 出すかの判断に使っていた。**#433 で運営向けの項目が並びから消えた**ので、
 * 画面はもう要らない（`@u18/contracts` の `account-nav.ts`）。
 *
 * **1 項目の object のままにしてある。** 配列に戻すと、呼ぶ側 2 本
 * （画面と JSON API）の両方を触ることになり、**`cards` という名前が
 * 応答の形から消える** —— `cards.routes.ts` が「`CardView` の項目だけを
 * 返す」ことを見ているテストの読み手にとって、名前は手掛かりである。
 */
export type ListMyCardsOutput = {
  readonly cards: readonly CardView[];
};

export class ListMyCardsUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
  ) {}

  async execute(sessionToken: string | undefined): Promise<NfcOutcome<ListMyCardsOutput>> {
    const actor = await requireUserId(this.identity, sessionToken);
    if (!actor.ok) return actor;

    const owned = await this.cards.listByOwner(actor.value);
    return outcomeOk({ cards: owned.map(toCardView) });
  }
}
