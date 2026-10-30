import type { AdminCardList, CardRepository, NfcOutcome } from "../ports";
import { outcomeOk } from "../ports";
import { MAX_ADMIN_LIST, toAdminView } from "./list-all-cards.use-case";

/**
 * 全カードの一覧（admin-worker 経由の delegated RPC、#382 / #390 決定 16 ③）。
 *
 * **`ListAllCardsUseCase` との違いは、認可を持たないことだけ。** 理由は
 * `DelegatedDisableCardUseCase` の冒頭を参照。こちらは読み取りだけなので
 * 監査イベントは残さない（既存の `ListAllCardsUseCase` も残していない）。
 *
 * **上限（`MAX_ADMIN_LIST`）と写し方（`toAdminView`）はセッション版と
 * 共有する。** どちらも「誰が呼んだか」で変わる理由が無く、2 箇所に
 * 書くと片方だけ変えられる形を作る。
 */
export class DelegatedListAllCardsUseCase {
  constructor(private readonly cards: CardRepository) {}

  async execute(): Promise<NfcOutcome<AdminCardList>> {
    const rows = await this.cards.listAll(MAX_ADMIN_LIST);
    const truncated = rows.length > MAX_ADMIN_LIST;

    return outcomeOk({
      cards: rows.slice(0, MAX_ADMIN_LIST).map(toAdminView),
      truncated,
    });
  }
}
