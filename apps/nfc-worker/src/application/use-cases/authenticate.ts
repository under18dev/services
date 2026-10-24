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
