import type { CardRepository, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

/**
 * カード ID を遷移先 URL へ解決する（仕様書 10 / #31）。
 *
 * ## 認証しない。これは仕様である
 *
 * タグをかざした人は u18 の利用者とは限らない。カードを読むことと
 * アカウントにログインすることは別の責務であり（仕様書 10）、ここで
 * セッションを要求すると、その 2 つを混ぜることになる。
 * 逆に言えば、**この経路で得られる情報が所有者の身元に繋がってはならない**。
 * 返すのは遷移先 URL だけで、`ownerUserId` も `status` も外に出さない。
 *
 * ## 失敗の理由を返さない
 *
 * 未発行・未紐づけ・無効化済み・遷移先未設定を区別せず、すべて
 * `card_not_found` にする。区別すると、カード ID を総当たりする相手に
 * 「この ID は配布済みだが誰も紐づけていない」といった情報が渡る。
 * 配布前のカードの ID が分かれば、紐づけコードを当てる試行の対象を
 * 絞れてしまう（仕様書 9 の列挙対策と同じ考え方）。
 */
export class ResolveCardUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(cardId: string): Promise<NfcOutcome<{ readonly targetUrl: string }>> {
    const card = await this.cards.findById(cardId);

    // `card === null` と「解決できない状態」を同じ失敗に畳む。
    if (card === null || !card.isResolvable()) {
      return outcomeErr({ kind: "card_not_found" });
    }

    // isResolvable() が targetUrl の null と非 https を既に落としている。
    // それでも `?? ""` ではなく明示的に確かめるのは、将来 isResolvable() の
    // 条件が緩んだときに、ここが黙って空文字へリダイレクトしないようにするため。
    const targetUrl = card.targetUrl;
    if (targetUrl === null) return outcomeErr({ kind: "card_not_found" });

    return outcomeOk({ targetUrl });
  }
}
