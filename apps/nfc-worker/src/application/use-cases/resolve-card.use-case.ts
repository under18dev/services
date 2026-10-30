import { type CardDisclosure, discloseCard } from "../../domain/services/disclosure";
import type { CardRepository } from "../ports";

/**
 * タップされたカードについて、外へ出してよい区別を返す（仕様書 10 / #31 / #358）。
 *
 * ## 認証しない。これは仕様である
 *
 * タグをかざした人は u18 の利用者とは限らない。カードを読むことと
 * アカウントにログインすることは別の責務であり（仕様書 10）、ここで
 * セッションを要求すると、その 2 つを混ぜることになる。
 * **この経路で得られる情報が所有者の身元に繋がってはならない** ——
 * 返すのは遷移先 URL か「紐づけられる」かだけで、`ownerUserId` は出さない。
 *
 * ## 何を区別するかは、この UseCase が決めていない
 *
 * **`domain/services/disclosure.ts` が 1 箇所で決める。** #358 で入口が
 * 2 つ（タップの解決と紐づけ画面）になったので、判断をここに書くと
 * 2 箇所で同じことを書くことになる。ここがやるのは D1 を引くことだけ。
 *
 * ## `NfcOutcome` を返さない
 *
 * 「見つからない」は失敗ではなく**3 つある結果のうちの 1 つ**である
 * （`concealed`）。失敗として返すと、呼び出し側が `claimable` を
 * 「成功」、`concealed` を「失敗」と読む形になり、**`resolvable` と
 * `claimable` の 2 つしか無いように見える。** 全域関数にしてある。
 */
export class ResolveCardUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(cardId: string): Promise<CardDisclosure> {
    return discloseCard(await this.cards.findById(cardId));
  }
}
