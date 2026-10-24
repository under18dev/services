/**
 * Redirect URI の検証（仕様書 9 / RFC 6749 §3.1.2 / RFC 9700 §4.1）。
 *
 * ここには 2 つの別々の判断が入っている。混ぜないこと。
 *
 * 1. **登録時** (`validateRedirectUriForRegistration`) — 何を `oauth_redirect_uris` へ
 *    入れてよいか。緩めても危険になるのは「登録を許した相手」だけなので、
 *    人間が確認する前提で多少の融通が利く。
 * 2. **認可時** (`matchesRegisteredRedirectUri`) — 届いた `redirect_uri` を
 *    登録済みのどれかと照合してよいか。**ここは完全一致以外を一切作らない。**
 *    前方一致やワイルドカードを入れた瞬間、攻撃者は `https://client.example/cb`
 *    の登録を足がかりに `https://client.example/cb.evil.test` や
 *    `https://client.example/cb/../../redirect?to=evil` へ認可コードを
 *    流し込めるようになる（オープンリダイレクト）。
 */

/** 登録を拒否した理由。運用者に何を直せばよいか伝えるためだけに使う。 */
export type RedirectUriRejection =
  /** 絶対 URI として解釈できない。 */
  | "not_absolute"
  /** https: でも、許可されたループバック http: でもない。 */
  | "insecure_scheme"
  /** フラグメントを含む。認可応答のフラグメント領域と衝突する。 */
  | "has_fragment"
  /** `https://user:pass@host/` 形式。 */
  | "has_credentials"
  /** 正規形でない（大文字スキーム、既定ポートの明示、パス省略など）。 */
  | "not_normalized";

export type RedirectUriValidation =
  | { readonly ok: true; readonly uri: string }
  | { readonly ok: false; readonly reason: RedirectUriRejection };

/**
 * ループバックとみなすホスト。
 *
 * `127.0.0.1` 以外の `127.0.0.0/8` は入れない。ここは「開発者の手元」を
 * 表現するための小さな例外であって、ループバック空間の一般的な許可ではない。
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `http://localhost:8788/cb` のような、マシン外へ出ない宛先か。 */
export function isLoopbackRedirectUri(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * 登録してよい Redirect URI かを判定する。
 *
 * ## `http://localhost` をどう扱うか（仕様書 9「例外となるローカル開発の扱いは別途定義」）
 *
 * **既定では拒否し、登録側が明示的に `allowLoopbackHttp` を立てたときだけ許す。**
 *
 * - https を要求する理由は、認可コードが `Location` ヘッダと URL バーに
 *   そのまま載るため。平文 HTTP だと経路上の第三者がコードを読める。
 * - ループバック宛（`localhost` / `127.0.0.1` / `[::1]`）はパケットが
 *   マシンの外へ出ないので、この盗聴の前提が成り立たない。RFC 8252 §7.3 が
 *   ネイティブアプリ向けにループバック http を認めているのと同じ根拠で、
 *   ローカル開発に限って平文を許してよい。
 * - ただし **既定で許してはならない。** 本番 IdP に `http://localhost/...` を
 *   持つクライアントが残っていると、その client_id を知る攻撃者が被害者の
 *   ブラウザで認可を走らせ、自分のマシンで待ち受けているアプリへ
 *   コードを届けられる。PKCE があるので即座にトークンまでは取れないが、
 *   「登録済みの正規の宛先」が攻撃者のローカルにある状態そのものを避ける。
 * - RFC 8252 はループバックの**ポートを可変**にしてよいとするが、u18 は
 *   採用しない。ポートのワイルドカードは完全一致の例外を 1 つ作ることになり、
 *   その例外を認可時の比較へ持ち込みたくない（ネイティブアプリは MVP の
 *   対象外なので、失うものが無い）。開発用クライアントは固定ポートで登録する。
 *
 * ## 正規形を要求する理由
 *
 * 曖昧な入力を黙って正規化すると、「登録した文字列」と「クライアントが送る文字列」が
 * ずれ、認可時に完全一致で落ちる。原因は URL を目視しても分からない。
 * 登録の時点で弾いて、運用者に正規形を書かせるほうが事故が短い。
 */
export function validateRedirectUriForRegistration(
  raw: string,
  options: { readonly allowLoopbackHttp?: boolean } = {},
): RedirectUriValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_absolute" };
  }

  // `url.hash` は "#" だけの入力で空文字になるため、生の文字列で見る。
  // 空のフラグメントでも認可応答の組み立て時に邪魔になる。
  if (raw.includes("#")) return { ok: false, reason: "has_fragment" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "has_credentials" };

  const loopbackHttp =
    url.protocol === "http:" && isLoopbackRedirectUri(url) && options.allowLoopbackHttp === true;
  if (url.protocol !== "https:" && !loopbackHttp) {
    return { ok: false, reason: "insecure_scheme" };
  }

  // WHATWG URL の正規化を通しても文字列が変わらないこと。
  // `HTTPS://A.example/cb`・`https://a.example:443/cb`・`https://a.example`（パス省略）は
  // すべてここで落ちる。
  if (url.href !== raw) return { ok: false, reason: "not_normalized" };

  return { ok: true, uri: raw };
}

/**
 * 認可要求の `redirect_uri` が登録済みかを判定する。
 *
 * **完全一致（バイト単位の文字列比較）のみ。** 正規化も、末尾スラッシュの吸収も、
 * クエリの並べ替えもしない。ここで「気を利かせた」比較を入れると、
 * 登録者が意図していない宛先へ認可コードが飛ぶ経路ができる。
 * クエリが 1 文字違えば別の宛先として扱う。
 */
export function matchesRegisteredRedirectUri(
  requested: string,
  registered: readonly string[],
): boolean {
  if (requested === "") return false;
  return registered.includes(requested);
}
