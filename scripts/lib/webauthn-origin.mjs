// @ts-check
/**
 * `RP_ID` と `WEBAUTHN_ORIGIN` が噛み合っているかを設定から検査する。
 *
 * ## なぜ要るか
 *
 * Passkey の検証そのものは `passkey-webauthn.test.ts` が**本物の P-256
 * 認証器を相手に**通している。そのファイルの冒頭にはこう書いてある ——
 *
 * > Fake で置き換えると「設定値を渡し忘れていても通る」ので、
 * > この 1 本だけは実物のライブラリを通す。
 *
 * **その警戒は正しいが、守れているのは localhost の値だけである。**
 * テストは `RP_ID = "localhost"` / `ORIGIN = "http://localhost:8787"` を
 * ファイル内の定数として持っており、`wrangler.jsonc` の本番 vars は
 * **どのテストからも 1 度も読まれていない。**
 *
 * つまり本番の 2 値が食い違っていても、CI は最後まで緑になる。
 *
 * ## 食い違うと何が起きるか
 *
 * ブラウザは `rpId` が取得元 origin の**登録可能な接尾辞**であることを
 * 要求する。違えば `navigator.credentials` が `SecurityError` で終わり、
 * **登録も認証も 1 件も成立しない。** サーバ側のログには何も残らない
 * （リクエストが来ないため）ので、「Passkey が使えない」以上のことが
 * 分からない状態になる。
 *
 * origin 側は逆に**厳密一致**で照合する（`simplewebauthn.service.ts` の
 * `expectedOrigin`）。末尾に `/` が 1 つ余計に付いているだけで、
 * ブラウザが送る `clientDataJSON.origin` と一致しなくなる。
 *
 * ## 今この検査は何も見つけていない
 *
 * 本番の値（`under18.dev` / `https://auth.under18.dev`）は正しい。
 * これは**見つかった不具合の修理ではなく、沈黙していた場所に置く見張り**
 * である。本番の Passkey がまだ 0 件で、この経路は一度も動いていない。
 */

/** WebAuthn が平文を許す host（Secure Context 扱い）。 */
function isLocalhost(host) {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

/**
 * 1 つの env の vars を見て、問題を文字列の配列で返す。問題が無ければ空。
 *
 * @param {{ RP_ID?: unknown, WEBAUTHN_ORIGIN?: unknown }} vars
 * @returns {string[]}
 */
export function checkWebAuthnVars(vars) {
  const rpId = vars.RP_ID;
  const origin = vars.WEBAUTHN_ORIGIN;
  const problems = [];

  const hasRpId = typeof rpId === "string" && rpId !== "";
  const hasOrigin = typeof origin === "string" && origin !== "";

  // 両方無いなら Passkey を持たない Worker。見る対象ではない。
  if (!hasRpId && !hasOrigin) return problems;

  // **片方だけは必ず落とす。** 片側を消して「使っていないから」と
  // 片付けると、もう片方が残って意味のない検証が通り続ける。
  if (!hasRpId) {
    problems.push("WEBAUTHN_ORIGIN があるのに RP_ID が無い");
    return problems;
  }
  if (!hasOrigin) {
    problems.push("RP_ID があるのに WEBAUTHN_ORIGIN が無い");
    return problems;
  }

  if (/[:/]/.test(rpId) || rpId.startsWith(".") || rpId !== rpId.toLowerCase()) {
    problems.push(
      `RP_ID "${rpId}" はホスト名ではない。scheme / port / path を含まない小文字のドメインにする`,
    );
    return problems;
  }

  let url;
  try {
    url = new URL(origin);
  } catch {
    problems.push(`WEBAUTHN_ORIGIN "${origin}" は URL として読めない`);
    return problems;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    problems.push(`WEBAUTHN_ORIGIN "${origin}" の scheme は http か https にする`);
    return problems;
  }

  // **厳密一致で照合するので、余計な path も末尾の `/` も許さない。**
  // `new URL(x).origin` は scheme://host[:port] だけを返すので、
  // 設定文字列がそれと同一でなければ余計なものが付いている。
  if (url.origin !== origin) {
    problems.push(
      `WEBAUTHN_ORIGIN "${origin}" に余計な path か末尾の / がある。"${url.origin}" にする` +
        `（clientDataJSON.origin と厳密一致で照合するため）`,
    );
  }

  if (url.protocol === "http:" && !isLocalhost(url.host)) {
    problems.push(
      `WEBAUTHN_ORIGIN "${origin}" が http。localhost 以外では Secure Context にならず Passkey が使えない`,
    );
  }

  const host = url.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    problems.push(
      `RP_ID "${rpId}" が WEBAUTHN_ORIGIN のホスト "${host}" の接尾辞になっていない。` +
        `ブラウザが SecurityError で拒むため、登録も認証も 1 件も成立しない`,
    );
  }

  return problems;
}
