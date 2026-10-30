import { TARGET_REJECTED_FALLBACK, TARGET_REJECTION_COPY, UPDATE_TARGET_COPY } from "./messages";

/**
 * 遷移先の変更の**応答の読み方**（#338）。
 *
 * ## なぜアイランドの中に書かないのか
 *
 * **アイランドは DOM を使うので Worker 上の vitest から動かせない。**
 * 判断だけをここへ出せば、バンドルされた文字列を正規表現で睨むのではなく
 * **関数として直接確かめられる**（dashboard-worker の `client/outcome.ts` と
 * 同じ理由）。
 *
 * ## 「成功したかもしれない」を作らない
 *
 * 失敗の扱いで一番まずいのは、**利用者が「変わったのか分からない」まま
 * 画面を離れること**である。だから:
 *
 *  - **知らない `reason` でも、専用の文言に落とす**（握り潰さない）
 *  - **知らない status は `unknown` に畳むが、成功とは言わない**
 *  - **本文が読めなくても、status から言えることは言う**
 */

export type TargetUpdateOutcome =
  | { readonly kind: "updated" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/** `cards.routes.ts` の `bodyFor()` が返す形。読めないこともある。 */
type ErrorBody = { readonly error?: unknown; readonly reason?: unknown };

/**
 * 応答から、画面に出すものを決める。
 *
 * @param response `ok` と `status` だけ見る（`fetch` の `Response` でも、
 *   テストの組み立てた値でも同じように扱えるようにしておく）
 * @param body 読めた JSON。読めなければ `null`
 */
export function readTargetUpdate(
  response: { readonly ok: boolean; readonly status: number },
  body: ErrorBody | null,
): TargetUpdateOutcome {
  if (response.ok) return { kind: "updated" };

  if (response.status === 400) {
    // **`invalid_target_url` だけが `reason` を持つ**（`bodyFor()`）。
    const reason = typeof body?.reason === "string" ? body.reason : null;
    const message =
      reason !== null
        ? (TARGET_REJECTION_COPY[reason] ?? TARGET_REJECTED_FALLBACK)
        : TARGET_REJECTED_FALLBACK;
    return { kind: "rejected", message };
  }

  if (response.status === 401)
    return { kind: "failed", message: UPDATE_TARGET_COPY.unauthenticated };

  // **404 は「他人のカード」も含む。** `card_not_found` が 403 を返さない
  // のは、他人のカード ID を当てたことを相手に伝えないためである
  // （`cards.routes.ts` の `statusFor`）。**画面でもそこを言い分けない。**
  if (response.status === 404) return { kind: "failed", message: UPDATE_TARGET_COPY.notFound };

  if (response.status === 503) return { kind: "failed", message: UPDATE_TARGET_COPY.unavailable };

  return { kind: "failed", message: UPDATE_TARGET_COPY.unknown };
}
