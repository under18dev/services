/**
 * form POST 用の CSRF 対策（仕様書 9 CSRF）。
 *
 * ## なぜ Worker をまたいで 1 つにしてあるか
 *
 * `page-headers.ts` の CSP とまったく同じ理由である。ログイン・同意
 * （auth-worker）とアカウント管理（dashboard-worker）は**同じオリジン
 * `auth.under18.dev` で配信される**（仕様書 §14.1 決定 1）。
 * **どれか 1 つが緩ければ、攻撃者はそこを足がかりに他を狙える。**
 *
 * それに加えて、CSRF には CSP に無い事情がある —— **仕組みが 2 つあると、
 * どちらが正しいかを誰も言えなくなる。** 片方にだけ入っている手当て
 * （下の `Sec-Fetch-Site` の件がまさにそれだった）が、もう片方では
 * 「まだ踏んでいないだけ」になる。
 *
 * ## なぜ Origin 検証だけで済ませないのか
 *
 * 既存の JSON API は Origin の一致だけで守っている。ブラウザは `fetch` の
 * POST に必ず Origin を付けるので、それで足りていた。ところが **HTML の
 * form 送信は Origin の付き方がブラウザ・設定に依存する**。Origin 検証は
 * fail-closed（無ければ拒否）なので、Origin を送らない経路があると
 * 「正規の利用者が操作できない」側に倒れる。
 *
 * かといって form のときだけ Origin 検証を緩めると、CSRF 対策が SameSite
 * 頼みになる。そこで form には **Origin 検証 + トークン**の二重にし、
 * Origin 側は「そもそも落ちない」ことを前提にしない。
 *
 * ## 方式: 署名なしの double-submit cookie
 *
 * HttpOnly な Cookie に 256bit のランダム値を入れ、同じ値を hidden input に
 * 埋めて、POST 時に定時間比較する。攻撃者はクロスサイトからこの Cookie を
 * 読めず（HttpOnly かつ SameSite=Lax）、値を当てることもできない。
 * HMAC 方式にしないのは、鍵（Secret）を 1 つ増やさずに同じ強度が得られるため。
 *
 * セッション Cookie と同じく、本番は `__Host-` 接頭辞を使う。
 * サブドメインから上書きされると double-submit が成立しなくなるため、
 * ここは接頭辞の保護が効いていることが前提条件になっている。
 *
 * ## Hono に依存しない
 *
 * このモジュールは `Context` を受け取らない。**受け取ると、Worker ごとに
 * 違う `Bindings` の型を揃える作業が、仕組みを共有する条件になってしまう。**
 * 判断に要る値（Cookie の中身・送られてきたトークン・Origin 検証の結果）を
 * 呼び出し側が取り出して渡す。取り出す部分は各 Worker の薄い adapter にある。
 */

/** form に埋める hidden input の名前。描くほうと読むほうで同じ名前を使う。 */
export const CSRF_FIELD_NAME = "csrf_token";

const CSRF_COOKIE_NAME = "__Host-u18_csrf";
/** development は http://localhost で Secure を付けられないので接頭辞なし。 */
const DEV_CSRF_COOKIE_NAME = "u18_csrf";

/** Cookie の寿命。画面を開いてから入力を終えるまでの時間だけあればよい。 */
const CSRF_COOKIE_MAX_AGE_SECONDS = 60 * 60;

/** トークンの長さ。32 バイト = 256bit。 */
const CSRF_TOKEN_BYTES = 32;

export function csrfCookieName(environment: string): string {
  return environment === "development" ? DEV_CSRF_COOKIE_NAME : CSRF_COOKIE_NAME;
}

/**
 * Cookie に入れる値を作る。
 *
 * **`WebCryptoTokenGenerator.generate()` と同じ形**（32 バイトの乱数を
 * base64url）。あちらは auth-worker の container に居て dashboard からは
 * 見えないが、**同じ値を作るためにパッケージ間の依存を 1 本増やすより、
 * 32 バイトの乱数をここで作るほうが小さい。**
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(CSRF_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function buildCsrfCookie(environment: string, token: string): string {
  const secure = environment === "development" ? "" : "; Secure";
  // HttpOnly にできるのは、トークンをサーバー側で HTML に埋めるため。
  // JS から読む必要がない以上、読めなくしておく。
  return `${csrfCookieName(environment)}=${token}; Path=/; Max-Age=${CSRF_COOKIE_MAX_AGE_SECONDS}; HttpOnly${secure}; SameSite=Lax`;
}

/**
 * 定時間比較。
 *
 * 長さが違う場合は即 false を返すが、比較するのは固定長のトークンなので
 * 長さ自体は秘密ではない（`TimingSafeComparator` と同じ判断）。
 */
function equalsConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 判定に要る材料。呼び出し側の adapter が Context から取り出して渡す。 */
export type CsrfCheck = {
  /** Origin 検証の結果。**form 用の判定を渡すこと**（下の `isTrustedOrigin`）。 */
  readonly originAllowed: boolean;
  /** Cookie に入っていた値。 */
  readonly expected: string | undefined;
  /** hidden input で送られてきた値。 */
  readonly submitted: string | undefined;
  /**
   * 拒否のログに出す名前。**監査イベントの登録簿にある値を渡すこと。**
   *
   * 項目名を `event` にしてあるのは、auth-worker の `vitest.config.ts` が
   * `event: "..."` を拾って登録簿と照合しているため（#22）。
   * **別の名前にすると、登録簿にあるのに発行されていない名前として
   * 報告される** —— 実際この移設でそうなりかけた。
   */
  readonly event: string;
  /** 拒否のログに出す調査用の情報。値そのものは入れない。 */
  readonly path: string;
  readonly origin: string | null;
  readonly secFetchSite: string | null;
};

/**
 * form POST を受け取ってよいかを判定する。
 *
 * Origin とトークンの**両方**を要求する。片方でも欠けたら拒否する。
 *
 * ## 落ちた理由をログにだけ出す
 *
 * 画面には書かない —— 「トークンが古い」「Origin が違う」を出し分けると、
 * 攻撃者に何を直せばよいか教えることになる。
 *
 * **ログに出ないと調べようがない。** 実際、本番で「どのメールアドレスを
 * 入れても操作を受け付けられない」という報告が出て、`wrangler tail` で生の
 * ヘッダを見るまで `Origin: null` だと分からなかった。理由が 1 行出ていれば
 * そこで終わっていた。
 *
 * **値そのものは出さない。** トークンをログに書くと、ログを読める範囲が
 * そのまま CSRF を抜ける範囲になる。長さと有無だけで切り分けはつく。
 */
export function isValidCsrf(check: CsrfCheck): boolean {
  const deny = (reason: string): false => {
    console.warn(
      JSON.stringify({
        event: check.event,
        reason,
        path: check.path,
        origin: check.origin,
        secFetchSite: check.secFetchSite,
        hasCookie: check.expected !== undefined && check.expected.length > 0,
        submittedLength: check.submitted?.length ?? 0,
      }),
    );
    return false;
  };

  if (!check.originAllowed) return deny("origin");
  if (check.expected === undefined || check.expected.length === 0) return deny("no_cookie");
  if (check.submitted === undefined || check.submitted.length === 0) return deny("no_token");
  if (!equalsConstantTime(check.expected, check.submitted)) return deny("token_mismatch");
  return true;
}

/**
 * 状態を変えるリクエストの Origin 検証（仕様書 9 CSRF）。
 *
 * ## `Origin: null` を `Sec-Fetch-Site` で救う
 *
 * Fetch 仕様では、referrer policy が参照元を落とすとき**ナビゲーション
 * 要求の `Origin` も `null` になる**。自分のページから出した form 送信が
 * `Origin: null` で届き、`new URL("null")` が投げて拒否される。
 * **auth-worker は本番でこれを踏み、ログイン・新規登録・ログアウトが
 * 全滅した**（#226）。
 *
 * `Referrer-Policy` は `same-origin` に直してあるが、**それだけに頼らない。**
 * 参照元の扱いは将来また変わりうるし、利用者側の設定でも変わる。
 *
 * `Sec-Fetch-Site` は**禁止ヘッダ名**でスクリプトから書けない。値が
 * `same-origin` なら、ブラウザ自身が「この要求は自分のオリジンから出た」と
 * 言っている。クロスサイトの攻撃者が送らせた form は `cross-site` になるので
 * 通らない。**`Origin` が読めたときはそちらを優先する**ので、判定が緩むのは
 * `null` の場合だけである。
 *
 * ## JSON API 側で使うかは Worker ごとに違う
 *
 * auth-worker は**同じ関数を JSON API にも使っている**（`origin.ts` が
 * これを呼ぶ）。dashboard-worker の JSON API は `Origin` の一致だけを見る
 * 厳しいほうのままにしてある —— `fetch` の POST にブラウザは必ず Origin を
 * 付けるので、あちらで `Origin: null` が来るのは正規の経路ではない。
 * **緩める理由が無いところを緩めない。**
 *
 * なお `Sec-Fetch-Site` はスクリプトから書けないヘッダなので、この救済で
 * 通るのは**ブラウザ自身が同一オリジンだと言っている要求**に限られる。
 * 片方で使って片方で使わないのは強さの差ではなく、**救済が要る経路かどうか**の
 * 差である。
 */
export function isTrustedOrigin(
  origin: string | undefined,
  secFetchSite: string | undefined,
  expectedOrigin: string,
): boolean {
  if (origin === "null" && secFetchSite === "same-origin") return true;
  if (origin === undefined) return false;

  const actual = parseOrigin(origin);
  if (actual === null) return false;

  return actual === parseOrigin(expectedOrigin);
}

/**
 * 文字列の厳密一致はしない。`ISSUER` は OIDC の `iss` として使う値で、
 * 末尾スラッシュや大文字小文字の揺れが混ざりうる。そのまま比較すると、
 * 設定が 1 文字違うだけで更新系が全件 403 になる。
 */
function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}
