import { Hono } from "hono";
import { authenticateClient, field, oauthError } from "./oauth.client-auth";
import type { AppBindings } from "./types";

/**
 * `POST /oauth/revoke`（RFC 7009、#17）。
 *
 * ## このファイルが返す status は 200 と 400/401 の 3 つしかない
 *
 * 400 / 401 は**クライアント認証より手前**の失敗だけに使う（要求の形が
 * 壊れている、クライアントが認証できない）。そこを抜けた要求は、
 * トークンが未知だろうと期限切れだろうと他人のものだろうと、すべて
 * 空本文の 200 になる。RFC 7009 §2.2 がそう定めているからだが、
 * 理由のほうが重要である——**応答の違いはトークンの実在を測る物差しになる。**
 * 404 を返せば「この文字列は発行済みか」を 1 要求につき 1 ビット教え、
 * 403 を返せば「実在し、かつ別のクライアントのものだ」まで教えてしまう。
 *
 * 所有者でないトークンを実際に失効させないことは `RevokeAccessTokenUseCase`
 * が担保する。ここは「違いを外から見せない」側だけを担う。2 つを
 * 分けてあるので、片方を読んだだけでは安全性を判断できない点には注意。
 *
 * ## サポートするトークン種別
 *
 * **Access Token のみ**。Refresh Token は MVP で 1 本も発行しない
 * （仕様書 1.2）ので、失効させる対象が存在しない。`token_type_hint` は
 * 受け取るが探索先は変えない（RFC 7009 §2.1 は hint で見つからなければ
 * 他の種別も探せと求めており、「常に全部を探す」は適合している）。
 * Discovery の `revocation_endpoint_auth_methods_supported` と合わせて、
 * この方針は `/.well-known/openid-configuration` に出してある。
 */
export const oauthRevokeRoutes = new Hono<AppBindings>();

oauthRevokeRoutes.post("/oauth/revoke", async (c) => {
  // 失効要求も応答もキャッシュさせない。「200 だった」が中間でキャッシュ
  // されると、2 回目の失効要求が実際には届かない。
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return oauthError(c, 400, "invalid_request", "request body must be form-encoded");
  }

  // クライアント認証を先に行う。RFC 7009 §2.1 が `/oauth/token` と同じ方式を
  // 求めているので、読み取りは `oauth.client-auth.ts` を共有している。
  //
  // **認証をトークンの存在確認より先に置く**のは順序の問題ではなく必須で、
  // 後にすると認証の無い要求でも DB を引くことになり、応答時間の差が
  // そのままトークン実在の oracle になる。
  const authenticated = await authenticateClient(c, form);
  if (!authenticated.ok) return authenticated.response;

  const token = field(form, "token");
  if (token === null) {
    // `token` は RFC 7009 §2.1 の必須パラメータ。欠けているのは要求の形の
    // 問題で、トークンの状態について何も語らない。ここだけは 400 でよい。
    return oauthError(c, 400, "invalid_request", "token parameter is required");
  }

  await c.get("container").useCases.revokeAccessToken.execute({
    client: authenticated.client,
    token,
    tokenTypeHint: field(form, "token_type_hint"),
  });

  // RFC 7009 §2.2: 本文を持たない 200。失効できたかどうかは返さない。
  // `UseCase` の戻り値をあえて捨てているのはそのためで、ここで
  // `{ revoked: true }` のような本文を足すと上の保証がその場で消える。
  return c.body(null, 200);
});
