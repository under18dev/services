import { CARD_ACTION_COPY, CARD_ACTION_SHARED_COPY } from "./messages";

/**
 * 片道の操作の**応答の読み方**（#382）。
 *
 * `target-update.ts` と同じ理由でアイランドの外に出してある ——
 * **DOM を使わないので Worker 上の vitest から直接呼べる。**
 *
 * ## `target` と分けた理由
 *
 * あちらは **400 に `reason` が載る**（`invalid_target_url`）ので、
 * 理由ごとの文言を引く必要がある。こちらに入力は無いので 400 は来ない ——
 * **来たら想定外として畳む。「成功したかもしれない」とは言わない。**
 */

export type CardActionKind = "disable" | "release";

export type CardActionOutcome =
  { readonly kind: "done" } | { readonly kind: "failed"; readonly message: string };

/**
 * 応答から、画面に出すものを決める。
 *
 * @param response `ok` と `status` だけ見る
 * @param action どちらの操作か。**失敗の文言が違う**
 */
export function readCardAction(
  response: { readonly ok: boolean; readonly status: number },
  action: CardActionKind,
): CardActionOutcome {
  if (response.ok) return { kind: "done" };

  if (response.status === 401)
    return { kind: "failed", message: CARD_ACTION_SHARED_COPY.unauthenticated };

  // **404 は「他人のカード」も含む。** 他人のカード ID を当てたことを
  // 相手に伝えないための 404 なので（`cards.routes.ts` の `statusFor`）、
  // 画面でもそこを言い分けない。
  if (response.status === 404) return { kind: "failed", message: CARD_ACTION_SHARED_COPY.notFound };

  if (response.status === 503)
    return { kind: "failed", message: CARD_ACTION_SHARED_COPY.unavailable };

  // 400 もここへ来る。**入力が無い操作なので、想定していない。**
  return { kind: "failed", message: CARD_ACTION_COPY[action].failed };
}
