import { hc } from "hono/client";
import type { CardsApiType } from "../../cards.routes";

/**
 * カード管理 API のクライアント（#338）。
 *
 * ## なぜアイランドの中で `hc()` を呼ばないのか
 *
 * **組み立て方そのものを検査から触れるようにするため。** dashboard-worker の
 * 同名ファイルと同じ理由である。
 *
 * ## 接頭辞は base URL 側に付ける
 *
 * `CardsApiType` は `createCardsApi()` の戻り値そのもので、
 * **`/account/nfc/cards` を含まない** —— `app.route(basePath, ...)` の
 * `basePath` は実行時の値なので型には現れない（`cards.routes.ts`）。
 *
 * だから base URL のほうに付ける。ここを間違えると
 * （`/account/nfc/cards/account/nfc/cards/...` になる等）、**型は通り、
 * ルート一覧も通り、ブラウザで 404 になって初めて分かる。**
 *
 * このファイルは DOM に触れない。だから Worker 側の型検査からも読めるし、
 * **アイランドと同じ関数**をテストから呼べる。
 */
export function createCardsClient(origin: string, basePath: string) {
  return hc<CardsApiType>(`${origin}${basePath}`);
}
