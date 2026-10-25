import { hc } from "hono/client";
import type { DashboardAppType } from "../../app";

/**
 * アカウント API のクライアント。
 *
 * ## なぜアイランドの中で `hc()` を呼ばないのか
 *
 * **組み立て方そのものを検査から触れるようにするため。**
 *
 * `hc<DashboardAppType>(base)` の `base` を間違えると
 * （接頭辞まで渡して `/account/account/api/...` になる等）、**型は通り、
 * ルート一覧も通り、ブラウザで 404 になって初めて分かる。**
 *
 * アイランド本体は DOM を使うので Worker 上の vitest から import できない。
 * 組み立てだけをここへ出しておけば、**アイランドと同じ関数**をテストから
 * 呼べる（`test/island-url-closure.test.ts`）。テスト側で `hc()` を
 * 書き直すと、**検査しているのはテストの中の組み立て方**になってしまう。
 *
 * このファイルは DOM に触れない。だから Worker 側の型検査からも読める。
 */
export function createApiClient(origin: string) {
  return hc<DashboardAppType>(origin);
}
