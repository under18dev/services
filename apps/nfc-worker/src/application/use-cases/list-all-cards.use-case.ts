import type {
  AdminCardList,
  AdminCardView,
  CardRepository,
  IdentityGateway,
  NfcOutcome,
} from "../ports";
import { outcomeOk } from "../ports";
import type { Card } from "../../domain/entities/card";
import { requireAdminUserId } from "./authenticate";

/**
 * 1 画面に出す上限（#338 Step 3）。
 *
 * **運営の画面なので件数で守っているのではない。** ここが守っているのは
 * **応答の大きさ**で、カードが数千枚になったときに 1 枚の HTML へ全部
 * 描くと、Worker の CPU 時間と本文の大きさが先に当たる。
 *
 * **上限で切ったことは画面に出す**（`AdminCardList.truncated`）。
 * 黙って切ると、運営は**全部を見たつもりで一部を見る。**
 */
export const MAX_ADMIN_LIST = 500;

/**
 * 全カードの一覧（運営向け、#338 Step 3）。
 *
 * ## 管理者だけ
 *
 * 判定は `requireAdminUserId` で、`IssueCardsUseCase` と同じ。
 * **ルートには書かない** —— 経路が増えたときに素通りする形を作るため
 * （`cards.routes.ts` の発行ハンドラに同じ理由がある）。
 *
 * **#337 以降、`isAdmin` は Passkey のセッションでしか立たない。**
 * ここはその判定を自分では持たず、auth-worker の `getSession` が返す
 * `isAdmin` をそのまま信じる（`authenticate.ts` の冒頭）。
 *
 * ## これは「未紐づけカードの鍵束」である
 *
 * **#358 以降、`issued` のカードは ID を知っている人がタップすれば
 * その人のものになる。** つまりこの一覧は、**未紐づけの行については
 * 配布物そのものと同じ扱い**にしなければならない
 * （`IssueCardsUseCase` / `docs/runbook.md`）。
 *
 * **危ないのは `issued` の行で、それがまさに出さなければならない行である。**
 * 画面側は、この性質を利用者に見える形で書くこと（`admin-page.tsx`）。
 *
 * ## 所有者は userId までしか出さない
 *
 * **表示名もメールアドレスも引かない。** nfc-worker は Identity D1 を
 * 持たず、`IdentityGateway` も `getSession` しか置いていない
 * （`ports.ts` の冒頭）。**名前を出すために `getUserProfile` を足すと、
 * NFC 側が侵害されたときに漏れる範囲がメールアドレスまで広がる。**
 * 誰のものかを人間が知りたい場面は、監査ログ側で突き合わせること。
 */
export class ListAllCardsUseCase {
  constructor(
    private readonly identity: IdentityGateway,
    private readonly cards: CardRepository,
  ) {}

  async execute(sessionToken: string | undefined): Promise<NfcOutcome<AdminCardList>> {
    const actor = await requireAdminUserId(this.identity, sessionToken);
    if (!actor.ok) return actor;

    // **`limit + 1` 件返ってくる**（`CardRepository.listAll`）。
    // 多い 1 件は「まだ先がある」の合図で、画面には出さない。
    const rows = await this.cards.listAll(MAX_ADMIN_LIST);
    const truncated = rows.length > MAX_ADMIN_LIST;

    return outcomeOk({
      cards: rows.slice(0, MAX_ADMIN_LIST).map(toAdminView),
      truncated,
    });
  }
}

/**
 * Domain のカードを運営向けの表示用に落とす。
 *
 * **`card-view.ts` の `toCardView` と別にしてある。** あちらは所有者向けで
 * `ownerUserId` を落とすことに意味がある（`AdminCardView` の宣言を参照）。
 */
export function toAdminView(card: Card): AdminCardView {
  return {
    cardId: card.id,
    status: card.status,
    ownerUserId: card.ownerUserId,
    targetUrl: card.targetUrl,
    batch: card.batch,
    issuedAt: card.createdAt.toISOString(),
    claimedAt: card.claimedAt?.toISOString() ?? null,
    disabledAt: card.disabledAt?.toISOString() ?? null,
  };
}
