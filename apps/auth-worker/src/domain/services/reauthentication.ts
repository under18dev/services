import type { Session } from "../entities/session";

/**
 * 影響の大きい操作に要求する「直近の本人確認」（仕様書 8.1 / 9）。
 *
 * username の変更や認証器の削除は、乗っ取りを完成させる側の操作である。
 * セッション Cookie を 1 枚盗っただけの相手に通させたくない一方で、
 * 何をするにも追加の確認を挟むと利用者が確認画面に慣れてしまう。
 * そこで条件は「最後に本人確認を通してから freshnessMs 以内か」だけにする。
 *
 * 判断材料は `sessions.created_at`。この実装にはセッション行を使い回したまま
 * 再認証する経路が無く、パスキー署名でもメール OTP でも、ログインは必ず
 * 新しいセッションを発行する（IssueSessionUseCase）。つまり createdAt は
 * 「最後に本人確認を通した時刻」そのもので、再認証した事実を別の列に
 * 持たなくても判定できる。利用者から見た再認証の手順は
 * 「ログインし直してからもう一度操作する」になる。
 */
export const ReauthenticationPolicy = {
  /**
   * 本人確認が「直近」とみなされる時間。
   *
   * OTP と WebAuthn Challenge の有効期間（どちらも 5 分）に合わせる。
   * 再認証を促された利用者がその場でログインし直せば必ず収まる長さで、
   * かつ「昼前に取られた Cookie を夕方に使う」類の悪用には足りない。
   */
  freshnessMs: 5 * 60 * 1000,
} as const;

/**
 * この操作を通してよいだけ新しい認証か。
 *
 * 盗まれた直後のセッションはこの窓をすり抜けうる。それはセッションの
 * 新しさを材料にする限り消えない脅威だが、窓を短く保てば
 * 「古い Cookie が後から悪用される」経路は塞げる。
 */
export function hasFreshAuthentication(session: Session, now: Date): boolean {
  return now.getTime() - session.createdAt.getTime() <= ReauthenticationPolicy.freshnessMs;
}
