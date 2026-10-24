/**
 * 標準 OIDC クライアントライブラリ（openid-client）でローカルの
 * auth-worker に繋ぐ（#28 の受け入れ条件）。
 *
 * 適合性スイートが見るのは「仕様に適合しているか」。こちらが見るのは
 * 「実在の RP が使うライブラリで実際に繋がるか」。ライブラリ側が仕様より
 * 厳しい既定を持つことがあるので、別物として確かめる価値がある。
 *
 * ブラウザがやる部分（ログイン・同意）は fetch で肩代わりする。
 * OIDC の各手順は **すべてライブラリに任せる**。こちらで JWT を検証したり
 * トークン要求を組み立てたりしない —— それをやると「ライブラリで繋がるか」
 * ではなく「自分の実装同士が噛み合うか」を見ることになる。
 */
import * as client from "openid-client";

const ISSUER = process.env.ISSUER ?? "http://127.0.0.1:8790";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI ?? "http://localhost:9876/callback";
const COOKIE = process.env.SESSION_COOKIE;

const step = (n, s) => console.log(`\n[${n}] ${s}`);
const ok = (s) => console.log(`    OK  ${s}`);

step(1, "Discovery（ライブラリが .well-known を取得して Configuration を組む）");
const config = await client.discovery(
  new URL(ISSUER),
  CLIENT_ID,
  CLIENT_SECRET,
  undefined,
  // 平文 HTTP はライブラリが既定で拒否する。ローカル検証なので明示的に許す。
  { execute: [client.allowInsecureRequests] },
);
const meta = config.serverMetadata();
ok(`issuer = ${meta.issuer}`);
ok(`jwks_uri = ${meta.jwks_uri}`);
ok(
  `id_token_signing_alg_values_supported = ${JSON.stringify(meta.id_token_signing_alg_values_supported)}`,
);

step(2, "PKCE と nonce をライブラリに作らせる");
const code_verifier = client.randomPKCECodeVerifier();
const code_challenge = await client.calculatePKCECodeChallenge(code_verifier);
const nonce = client.randomNonce();
const state = client.randomState();
ok(`code_challenge_method = S256`);

step(3, "認可 URL をライブラリに組ませる");
const authUrl = client.buildAuthorizationUrl(config, {
  redirect_uri: REDIRECT_URI,
  scope: "openid profile email",
  code_challenge,
  code_challenge_method: "S256",
  nonce,
  state,
});
ok(`${authUrl.origin}${authUrl.pathname}?...（${authUrl.searchParams.size} パラメータ）`);

step(4, "ブラウザの代わりに認可 → 同意を通す");
const headers = { Cookie: COOKIE };
let res = await fetch(authUrl, { headers, redirect: "manual" });
let html = await res.text();
if (!html.includes('action="/oauth/consent"')) {
  throw new Error(`同意画面が出ない: HTTP ${res.status} ${res.headers.get("location") ?? ""}`);
}
const fields = new URLSearchParams();
for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
  fields.set(m[1], m[2]);
}
fields.set("decision", "allow");
const setCookie = res.headers.getSetCookie?.() ?? [];
const csrfCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
res = await fetch(`${ISSUER}/oauth/consent`, {
  method: "POST",
  redirect: "manual",
  headers: {
    Cookie: csrfCookie ? `${COOKIE}; ${csrfCookie}` : COOKIE,
    Origin: ISSUER,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: fields,
});
const location = res.headers.get("location");
if (!location) throw new Error(`同意後に Location が無い: HTTP ${res.status}`);
ok(`認可応答: ${location.split("?")[0]}?code=…&state=…`);

step(5, "トークン交換と ID Token 検証（ライブラリのロジック）");
const tokens = await client.authorizationCodeGrant(config, new URL(location), {
  pkceCodeVerifier: code_verifier,
  expectedNonce: nonce,
  expectedState: state,
});
ok(`token_type = ${tokens.token_type}, expires_in = ${tokens.expires_in}`);
ok(
  `受け取ったフィールド = ${Object.keys(tokens)
    .filter((k) => typeof tokens[k] !== "function")
    .sort()
    .join(", ")}`,
);
const claims = tokens.claims();
ok(`ID Token の検証を通過（iss/aud/exp/nonce はライブラリが検証済み）`);
ok(`sub = ${claims.sub.slice(0, 8)}…  iss = ${claims.iss}  aud = ${claims.aud}`);

step(6, "UserInfo");
const ui = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
ok(`UserInfo の sub が ID Token と一致: ${ui.sub === claims.sub}`);
ok(`返ってきた claim = ${Object.keys(ui).sort().join(", ")}`);

console.log("\n=== すべて通過 ===");
