import type { IdentityGateway, NfcOutcome } from "../ports";
import { outcomeErr, outcomeOk } from "../ports";

/**
 * セッショントークンから操作者の userId を得る。
 *
 * ## ここが「他人のカードを変更できない」の起点である
 *
 * nfc-worker には Identity D1 が無いので、操作者が誰かを自力で決められない。
 * 決められないことを欠点ではなく制約として使う —— **userId は必ずこの関数を
 * 通して得る**。リクエストボディやクエリから userId を読む経路を作らない
 * （仕様書 4.2「単なる `userId` を受け取る RPC は本人確認の代わりにならない」）。
 *
 * Service Binding を持つ Worker は公開 URL 無しで auth-worker を呼べるが、
 * 呼べるのは `getSession` だけで、返るのは「このトークンの持ち主」である。
 * つまり nfc-worker が侵害されても、攻撃者が名乗れるのは
 * 自分が実際に持っているセッションの持ち主に限られる。
 */
export async function requireUserId(
  identity: IdentityGateway,
  sessionToken: string | undefined,
): Promise<NfcOutcome<string>> {
  if (sessionToken === undefined || sessionToken === "") {
    return outcomeErr({ kind: "unauthenticated" });
  }

  const result = await identity.getSession(sessionToken);
  if (!result.ok) return result;

  // 期限切れ・失効は auth-worker 側で null に畳まれて返る。
  // 理由を問い合わせる口を作らない（理由はトークンの実在を示す）。
  if (result.value === null) return outcomeErr({ kind: "unauthenticated" });

  return outcomeOk(result.value.userId);
}

/**
 * 操作者が管理者であることを確かめる（#187 / 仕様書 §14.1 決定 8）。
 *
 * ## nfc-worker は自分で判断しない
 *
 * `is_admin` は Identity D1 の列で、こちらには無い。`getSession` が返す
 * `isAdmin` を見る —— **これは auth-worker が D1 を引いて決めた値**であって、
 * 呼び出し元の申告ではない（`caller` との違いは仕様書 §14.1 決定 12）。
 *
 * ## 管理者でないことを理由に 404 を返さない
 *
 * `forbidden` を返す。ここで `not_found` に畳むと「発行エンドポイントが
 * 存在するか」を隠せるが、**隠して得るものが無い** —— 経路は仕様書にも
 * コードにも書いてあり、秘密ではない。一方で畳むと、権限を外された
 * 運営者が「壊れている」と誤解する。
 */
export async function requireAdminUserId(
  identity: IdentityGateway,
  sessionToken: string | undefined,
): Promise<NfcOutcome<string>> {
  if (sessionToken === undefined || sessionToken === "") {
    return outcomeErr({ kind: "unauthenticated" });
  }

  const result = await identity.getSession(sessionToken);
  if (!result.ok) return result;
  if (result.value === null) return outcomeErr({ kind: "unauthenticated" });

  if (!result.value.isAdmin) return outcomeErr({ kind: "forbidden" });

  return outcomeOk(result.value.userId);
}
