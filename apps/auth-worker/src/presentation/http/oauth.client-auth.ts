import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OAuthClient } from "../../domain/entities/oauth-client";
import type { AppBindings } from "./types";

/**
 * `/oauth/token` と `/oauth/revoke` で共有するクライアント認証の読み取り
 *  （RFC 6749 §2.3.1 / RFC 7009 §2.1、#16 / #17）。
 *
 * ## なぜ共有するのか
 *
 * RFC 7009 §2.1 は失効エンドポイントのクライアント認証について
 * 「トークンエンドポイントと**同じ**方式を使う」と定めている。同じと書いて
 * ある規則を 2 箇所に書き写すと、片方だけが直る日が来る。実際ここには
 * 「Basic とボディの併用を禁じる」「ヘッダとボディで `client_id` が食い違えば
 * 拒否する」という、忘れると静かに保証が消える判断が 2 つ入っている。
 */

/** OAuth 2.0 のエラー応答（RFC 6749 §5.2）。 */
export function oauthError(
  c: Context<AppBindings>,
  status: ContentfulStatusCode,
  error: string,
  description: string,
  /** `invalid_client` を 401 で返すときだけ付ける。 */
  withChallenge = false,
): Response {
  if (withChallenge) {
    // RFC 6749 §5.2: Authorization ヘッダで認証を試みたクライアントへ
    // 401 を返すときは `WWW-Authenticate` を付けなければならない。
    c.header("WWW-Authenticate", 'Basic realm="u18-identity"');
  }
  return c.json({ error, error_description: description }, status);
}

/**
 * `Authorization: Basic` からクライアント認証情報を取り出す。
 *
 * RFC 6749 §2.3.1 は `client_id` / `client_secret` を
 * **`application/x-www-form-urlencoded` で符号化してから** base64 せよと
 * 定めている。復号せずに使うと、`+` や `%` を含む秘密を持つクライアントが
 * 認証できない。
 */
export function readBasicAuth(header: string | undefined): { id: string; secret: string } | null {
  if (header === undefined) return null;

  const match = /^Basic\s+(\S+)$/i.exec(header);
  if (match === null) return null;

  let decoded: string;
  try {
    decoded = atob(match[1] ?? "");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return null;

  try {
    return {
      id: decodeURIComponent(decoded.slice(0, separator).replaceAll("+", " ")),
      secret: decodeURIComponent(decoded.slice(separator + 1).replaceAll("+", " ")),
    };
  } catch {
    // 不正な %エンコードは認証失敗として扱う。黙って生の文字列へ落とさない。
    return null;
  }
}

/** 空文字をフィールド未指定と同じに扱う。`client_secret=` を「秘密を提示した」と読まない。 */
export function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value !== "" ? value : null;
}

export type ClientAuthResult =
  | { readonly ok: true; readonly client: OAuthClient }
  /** そのまま返せる応答。呼び出し側は中身を組み立て直さないこと。 */
  | { readonly ok: false; readonly response: Response };

/**
 * `Authorization: Basic` と本文の `client_id` / `client_secret` を読み、
 * クライアントを認証する。
 *
 * **どちらか一方だけ**を許す。両方に秘密が載った要求は拒否する
 * （RFC 6749 §2.3.1 が「複数の認証方式を使ってはならない」と定めている）。
 * 受け入れると、どちらが検証されたのかが実装依存になる。
 */
export async function authenticateClient(
  c: Context<AppBindings>,
  form: FormData,
): Promise<ClientAuthResult> {
  const basic = readBasicAuth(c.req.header("Authorization"));
  const bodyClientId = field(form, "client_id");
  const bodySecret = field(form, "client_secret");

  if (basic !== null && bodySecret !== null) {
    // 2 つの認証方式を同時に使っている（RFC 6749 §2.3.1 で禁止）。
    return {
      ok: false,
      response: oauthError(
        c,
        400,
        "invalid_request",
        "multiple client authentication methods used",
      ),
    };
  }
  if (basic !== null && bodyClientId !== null && bodyClientId !== basic.id) {
    // ヘッダと本文で別の client_id を名乗っている。どちらを信じるかを
    // 実装の都合で決めない。
    return {
      ok: false,
      response: oauthError(c, 400, "invalid_request", "client_id does not match the credentials"),
    };
  }

  const clientId = basic?.id ?? bodyClientId;
  if (clientId === null) {
    return {
      ok: false,
      response: oauthError(c, 400, "invalid_request", "client_id is required"),
    };
  }

  const authenticated = await c.get("container").useCases.authenticateOAuthClient.execute({
    clientId,
    clientSecret: basic?.secret ?? bodySecret,
  });

  if (!authenticated.ok) {
    // RFC 6749 §5.2: Authorization ヘッダで認証を試みた場合は 401、
    // それ以外は 400 でもよい。u18 は 401 に揃える——クライアントの
    // 設定ミスを「要求が壊れている」ではなく「認証に失敗した」と
    // 読めるほうが、運用時に原因へ届きやすい。
    return {
      ok: false,
      response: oauthError(
        c,
        401,
        "invalid_client",
        "client authentication failed",
        basic !== null,
      ),
    };
  }

  return { ok: true, client: authenticated.value };
}
