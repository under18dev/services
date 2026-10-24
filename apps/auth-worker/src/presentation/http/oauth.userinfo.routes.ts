import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings } from "./types";

/**
 * `GET|POST /oauth/userinfo`（仕様書 5.2、#17）。
 *
 * OIDC Core §5.3 が定める UserInfo エンドポイント。判断は
 * `GetUserInfoUseCase` が持ち、ここは RFC 6750 の作法だけを担う。
 *
 * ## GET と POST の両方を受ける
 *
 * 仕様書 5.2 の表に `GET/POST` と書いてある（OIDC Core §5.3.1 も両方を
 * 必須としている）。同じハンドラを両メソッドに束ねてあるのは、
 * **Bearer トークンをヘッダからしか読まない**ので本文が要らず、
 * メソッドによる違いが 1 つも無いため。
 *
 * ## `access_token` をクエリや本文から読まない
 *
 * RFC 6750 §2.3 の form-encoded body、§2.2 の URI query は実装しない。
 * クエリに載ったトークンはブラウザ履歴・Referer・プロキシのアクセスログに
 * 残り、RFC 6750 自身が §5.3 で「使うべきでない」と書いている。
 * 本文のほうは害が小さいが、受け口を増やしただけ「どこから来た値を
 * 検証したのか」の答えが増える。ヘッダ 1 本に絞る。
 */
export const oauthUserinfoRoutes = new Hono<AppBindings>();

/**
 * RFC 6750 §3 の `WWW-Authenticate` 付き 401。
 *
 * ヘッダを省くと、RP のライブラリは「認証が要る」ことすら機械的に
 * 判断できず、401 を一般的な失敗として扱う。`error` の値を
 * `invalid_token` 以外に細分化しないのは UseCase 側の判断に揃えている
 * ——理由を呼び分けると、トークンの実在を確かめる材料になる。
 */
function unauthorized(c: Context<AppBindings>, error: string, description: string): Response {
  c.header("WWW-Authenticate", `Bearer error="${error}", error_description="${description}"`);
  return c.json({ error, error_description: description }, 401);
}

/**
 * `Authorization: Bearer <token>` を読む。
 *
 * スキーム名は大文字小文字を区別しない（RFC 7235 §2.1）。`bearer` で
 * 送ってくる RP を弾くと、原因の分からない 401 になる。
 */
function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match === null ? null : (match[1] ?? null);
}

oauthUserinfoRoutes.on(["GET", "POST"], "/oauth/userinfo", async (c) => {
  // claim を中間キャッシュにもブラウザにも残さない（OIDC Core §5.3.2 は
  // UserInfo 応答を個人情報として扱えと求めている）。失敗応答も含めて
  // 先に立てる——401 がキャッシュされると、失効の解除が効かなくなる。
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  const token = readBearerToken(c.req.header("Authorization"));
  if (token === null) {
    // トークンを提示していない要求には `error` を付けない（RFC 6750 §3）。
    // 「認証に失敗した」ではなく「認証がまだ無い」なので、
    // `invalid_token` を返すと RP は手元のトークンを捨ててしまう。
    c.header("WWW-Authenticate", 'Bearer realm="u18-identity"');
    return c.json({ error: "invalid_request", error_description: "bearer token is required" }, 401);
  }

  const result = await c.get("container").useCases.getUserInfo.execute({ accessToken: token });
  if (!result.ok) {
    return unauthorized(c, result.error.code, result.error.message);
  }

  return c.json(result.value.claims);
});
