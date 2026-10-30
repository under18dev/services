import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import type { Jwks } from "./discovery";

/**
 * ID Token を検証する（RP 側、OIDC Core 1.0 §3.1.3.7）。
 *
 * ## `algorithms` を明示する
 *
 * jose は宣言しない限り JWT ヘッダの `alg` を信用して検証鍵の種類を選ぶ。
 * **u18 Identity は ES256 しか発行しない**（decision 9 相当、
 * `id_token_signing_alg_values_supported: ["ES256"]`）。ここを固定しないと、
 * 攻撃者が `alg: none` やサーバーの公開鍵を対称鍵として使う
 * alg confusion の入口になる。固定することで、**JWKS に無い鍵も弾く**。
 *
 * ## `nonce` は jose が見ない
 *
 * `jwtVerify` の標準クレーム検証に `nonce` は含まれない（issuer / audience /
 * exp はある）。**ここで手で突き合わせる。** 突き合わせないと、攻撃者が
 * 別のセッションに対して発行された正規の ID Token を横流しして使える
 * （リプレイ）。
 */

export type VerifiedIdToken = {
  readonly sub: string;
  readonly payload: JWTPayload;
};

export async function verifyIdToken(params: {
  readonly idToken: string;
  readonly jwks: Jwks;
  readonly issuer: string;
  readonly audience: string;
  readonly nonce: string;
}): Promise<VerifiedIdToken> {
  // `Jwks` は `discovery.ts` 側で「配列であること」までしか検証していない
  // 緩い型。`jose` の `JSONWebKeySet` へは、ここで受け渡す直前に 1 度だけ
  // キャストする——検証の緩さがこの関数の外へ漏れないようにするため。
  const keySet = createLocalJWKSet(params.jwks as unknown as JSONWebKeySet);

  const { payload } = await jwtVerify(params.idToken, keySet, {
    issuer: params.issuer,
    audience: params.audience,
    algorithms: ["ES256"],
  });

  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new Error("id_token に sub が無い");
  }
  // **定時間比較にしない。** nonce は秘密ではなく、1 回使ったら捨てる
  // 公開の乱数（state と同じ扱い）。タイミング差が漏らすものが無い。
  if (payload.nonce !== params.nonce) {
    throw new Error("id_token の nonce が一致しない");
  }

  return { sub: payload.sub, payload };
}
