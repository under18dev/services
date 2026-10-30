import { jwtVerify, SignJWT } from "jose";

/**
 * admin-worker 自身のセッション。
 *
 * ## これは骨組み段階の仮の実装である（#390）
 *
 * d5 の設計（#390 の 2）では、OIDC で得た `access_token` は
 * **1 度だけ検証に使って捨てる**——admin-worker は
 * `access_token → oauth_tokens → sessions`（`actsAsAdminWith`）を 1 回
 * 確かめたあと、auth-worker に専用の `delegated_sessions` を 1 本発行して
 * もらい、**その平文トークンだけを自分の Cookie に入れる。** 以後の毎
 * リクエストは delegated session をハッシュで引き、親セッションの
 * `revokedAt` / `expiresAt` まで遡って確かめる。
 *
 * **その発行経路（Service Binding か専用 RPC）はまだ無い。** ここでは
 * 「ログインが完了した」ことだけを admin-worker 自身の署名で一時的に
 * 示す、**最小の sub だけを運ぶセッション**にしてある。d5 の設計が
 * 繋がったら、ここは `sub` ではなく `delegated_sessions` のトークンを
 * そのまま運ぶ形に置き換わる——**呼び出し側（`app.ts`）が見るのは
 * 「検証できたか／sub は何か」だけ**なので、中身の差し替えはこの
 * ファイルに閉じる。
 *
 * ## ID Token をそのままセッションにしない
 *
 * `/callback` で検証した ID Token（ES256、auth-worker の鍵で署名）を
 * Cookie へ丸ごと置く案は採らない。**ID Token は「認証した事実の証明書」
 * であって「継続的なセッション」ではない**（OIDC Core 1.0 は ID Token の
 * 有効期間をログインセッションの寿命として扱うことを要求していない）。
 * admin-worker が自分の鍵（`SESSION_SECRET`、HS256）で署名し直すことで、
 * IdP の鍵のアルゴリズムやローテーションから admin-worker のセッション
 * 実装を切り離す。
 *
 * ## `isAdmin` を乗せない（d5 と合意済み）
 *
 * 権限は「いま持っているか」を都度確かめるもので、トークンの中に固定
 * すると剥奪が遅れる（決定 8 / RR-5 と同じ理由）。
 */

const ALG = "HS256";

/**
 * 仮の寿命。**固定値である。** delegated session が繋がったら、
 * 寿命は auth-worker 側が決める値（親セッションの残り寿命）に従う形へ
 * 置き換わる——ここで決め打ちしているのは「骨組みだけで最後までログイン
 * が通ることを確かめる」ためで、運用上の根拠を持つ値ではない。
 */
const PLACEHOLDER_TTL_SECONDS = 60 * 60;

export async function createSessionToken(secret: Uint8Array, sub: string): Promise<string> {
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${PLACEHOLDER_TTL_SECONDS}s`)
    .sign(secret);
}

export type SessionPayload = { readonly sub: string };

/** 壊れている・期限切れなら null。例外を投げない——呼び出し側は「ログインへ送る」の 1 択で済む。 */
export async function verifySessionToken(
  secret: Uint8Array,
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
    if (typeof payload.sub !== "string" || payload.sub === "") return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}
