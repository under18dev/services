/**
 * セッション Cookie の名前。
 *
 * auth-worker が発行し、dashboard-worker が読む。両者が同じ名前を見るよう
 * 契約として共有する（以前は dashboard 側が開発用の名前をハードコードしていて、
 * 本番で永久に Cookie を読めない状態だった）。
 *
 * ## `__Host-` 接頭辞が決定を縛ることに注意
 *
 * `__Host-` はブラウザに「Secure かつ Path=/ かつ **Domain 属性なし**」を強制させる。
 * Domain 属性を付けられないということは、この Cookie は **発行したホストにしか
 * 送られない**。つまり auth.example と dashboard.example のように
 * ホストが分かれている構成では、dashboard-worker はこの Cookie を受け取れない。
 *
 * 仕様書 14-1「本番 Issuer ドメインと Cookie のドメイン・サイト境界」は未決だが、
 * `__Host-` を採る時点で次のいずれかを選んだことになる:
 *
 *  1. auth と dashboard を**同一ホスト**に載せる（パスで分ける）。`__Host-` を維持できる。
 *  2. `Domain=.example` の共有 Cookie にする。`__Host-` の保護（サブドメインからの
 *     Cookie 上書き防止）を捨てることになる。
 *  3. dashboard は Cookie を使わず、auth から別途トークンを受け取る。
 *
 * Phase 2 でこれを決めるまで、dashboard-worker の Cookie 読み取りは
 * 同一ホスト構成（1）を前提とした暫定実装である。
 */
export const SESSION_COOKIE_NAME = "__Host-u18_session";

/** 開発時は http://localhost で Secure を付けられないため接頭辞なしを使う。 */
export const DEV_SESSION_COOKIE_NAME = "u18_session";

export function sessionCookieName(environment: string | undefined): string {
  return environment === "development" ? DEV_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

/**
 * セッション Cookie を無効化する `Set-Cookie` の値。
 *
 * auth-worker と dashboard-worker の**両方**がログアウト・自己失効で Cookie を
 * 落とす。属性が片方でもずれると、ブラウザは別の Cookie とみなして元の
 * Cookie を消さない。名前だけ共有して生成を各自に書くと、そのずれが
 * 本番でしか表に出ない（#41 で Cookie 名をハードコードして本番で読めなかった
 * のと同じ構図）ので、ここで 1 つに持つ。
 *
 * `Max-Age=0` と空値の両方を置くのは、どちらか一方しか見ない実装への保険。
 *
 * ## `Domain` 引数を足さないこと
 *
 * `__Host-` 接頭辞は `Domain` 属性が**無い**ことをブラウザに強制させる。
 * #33 で auth は `auth.under18.dev/*`、dashboard は `auth.under18.dev/account/*` と
 * 同一ホストに載ることが決まったので、`Path=/` のままで両者に届く。
 *
 * 将来どちらかが別サブドメインへ移ったとき、`Domain` を足して解決しては
 * **いけない**。それは `__Host-` を捨てる（サブドメインからの Cookie 上書きを
 * 許す）ことと同義で、しかも失敗が目に見えない形で緩む。正しい対処は
 * #33 のドメイン構成を見直すこと。
 */
export function buildClearedSessionCookie(environment: string | undefined): string {
  const secure = environment === "development" ? "" : "; Secure";
  return `${sessionCookieName(environment)}=; Path=/; Max-Age=0; HttpOnly${secure}; SameSite=Lax`;
}
