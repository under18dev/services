import { SignJWT } from "jose";
import type { IdTokenClaims, IdTokenIssuer } from "../../application/ports/id-token.port";
import type { SigningKeyProvider } from "../../application/ports/signing-key.port";

/** OIDC の時刻 claim はすべて **秒**（NumericDate）。ミリ秒で入れると 1970 年扱いになる。 */
const toSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/**
 * ID Token の発行（仕様書 5.4 / 14-1 の決定 6）。
 *
 * 署名は `jose` に委ねる。独自の JWT 直列化や base64url の手組みはしない
 * （仕様書 5.4「独自の JWT パーサーや暗号プリミティブを作らない」）。
 *
 * ## `alg` を引数にしない
 *
 * `setProtectedHeader` に渡す `alg` はこのファイルの定数である。
 * 鍵の側（`ActiveSigningKey.alg`）も `"ES256"` 固定の型なので、
 * 設定ミスで HS256 の鍵が入っても型で止まる。Discovery が広告しているのも
 * `["ES256"]` だけで、3 箇所が同じ 1 つの決定を指している。
 *
 * ## claim の順序と上書き
 *
 * `additionalClaims` を先に展開し、`iss` / `sub` / `aud` / `exp` / `iat` は
 * `jose` の setter で後から入れる。**`filterClaimsByScope()` の結果に
 * `sub` が含まれていても、ここで必ず上書きされる**。ID Token の `sub` が
 * scope フィルタの中身に左右されると、profile scope の有無で `sub` の
 * 有無が変わるような事故が起きうる。
 */
export class JoseIdTokenIssuer implements IdTokenIssuer {
  constructor(private readonly signingKeys: SigningKeyProvider) {}

  async issue(claims: IdTokenClaims): Promise<string> {
    // 鍵が無ければここで throw する。握り潰すと、検証できない（あるいは
    // 署名の無い）トークンを配ることになる。
    const key = await this.signingKeys.getActiveSigningKey();

    const payload: Record<string, unknown> = {
      ...claims.additionalClaims,
      auth_time: toSeconds(claims.authTime),
    };
    // nonce が無いときは claim 自体を出さない。`"nonce": null` を載せると、
    // RP 側の「nonce が一致するか」の検証が null 同士で通ってしまう実装がある。
    if (claims.nonce !== null) payload["nonce"] = claims.nonce;

    return new SignJWT(payload)
      .setProtectedHeader({
        alg: "ES256",
        // kid が無いと RP は JWKS のどの鍵で検証すべきか決められない。
        // 鍵のローテーション中（旧鍵と新鍵が同時に JWKS へ出ている期間）に
        // 総当たりで検証させることになる。
        kid: key.kid,
        typ: "JWT",
      })
      .setIssuer(claims.issuer)
      .setSubject(claims.subject)
      .setAudience(claims.audience)
      .setIssuedAt(toSeconds(claims.issuedAt))
      .setExpirationTime(toSeconds(claims.expiresAt))
      .sign(key.privateKey);
  }
}
