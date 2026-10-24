import { importJWK } from "jose";
import type { Clock } from "../../application/ports/clock.port";
import type {
  ActiveSigningKey,
  PublicSigningJwk,
  SigningKeyMetadata,
  SigningKeyMetadataRepository,
  SigningKeyProvider,
} from "../../application/ports/signing-key.port";

/**
 * Workers Secret に置いた秘密鍵。
 *
 * 未設定でも `null` としてコンテナを組み立てられるようにしてある。
 * 設定漏れで落とすのは署名のときだけで、JWKS や `/health` は巻き込まない
 * （`UnconfiguredEmailSender` と同じ方針。#53）。
 */
export type SigningKeySecret = {
  /** `SIGNING_KEY_JWK`。`d` を含む EC 秘密鍵の JWK JSON。 */
  readonly jwk: string;
  /** `SIGNING_KEY_KID`。`signing_key_metadata` の行と対応していること。 */
  readonly kid: string;
};

/**
 * JWK から JWKS に出す 7 フィールドだけを取り出す。
 *
 * **ここが「秘密鍵を絶対に配らない」ための関門。** 入力の JWK に `d` が
 * 入っていても（運用手順の取り違えで `public_jwk` 列に秘密鍵を貼った場合など。
 * docs/runbook.md 2.4.1 が警告しているケース）、返す値には列挙した
 * フィールドしか載らない。`{ ...jwk }` のような展開を**絶対に書かないこと**。
 */
function toPublicJwk(kid: string, raw: unknown): PublicSigningJwk | null {
  if (typeof raw !== "object" || raw === null) return null;
  const jwk = raw as Record<string, unknown>;

  // ES256 以外は型が合わない。MVP の署名アルゴリズムは ES256 固定で、
  // Discovery もそれしか広告していない（仕様書 5.1）。
  if (jwk["kty"] !== "EC" || jwk["crv"] !== "P-256") return null;
  if (typeof jwk["x"] !== "string" || typeof jwk["y"] !== "string") return null;

  return {
    // kid は JWK の中身ではなくテーブルの主キーを正とする。
    // 行と JWK で食い違っていた場合、JWKS の見出しは行に合わせる。
    kid,
    kty: "EC",
    crv: "P-256",
    x: jwk["x"],
    y: jwk["y"],
    alg: "ES256",
    use: "sig",
  };
}

function parseJwk(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * ID Token 署名鍵の提供元（仕様書 5.4 / 7.1）。
 *
 * - 秘密鍵は Workers Secret から読み、`jose` に import させる。
 *   独自の JWT パーサや暗号プリミティブは書かない。
 * - 公開鍵の正本は `signing_key_metadata`。Secret の秘密鍵から公開鍵を
 *   導出して JWKS に足すことはしない —— そうすると、テーブルに載せていない
 *   鍵が設定ミスで世界に配布されうる。「JWKS に出る鍵＝運用者が明示的に
 *   登録した鍵」という対応を崩さない。
 */
export class JoseSigningKeyProvider implements SigningKeyProvider {
  /**
   * import 済みの秘密鍵。
   *
   * コンテナはリクエストごとに作られるので、これはリクエスト内のキャッシュ。
   * 同一リクエストで複数のトークンに署名しても import は 1 回で済む。
   */
  private imported: Promise<ActiveSigningKey> | null = null;

  constructor(
    private readonly metadata: SigningKeyMetadataRepository,
    private readonly clock: Clock,
    /** 未設定なら null。理由は `unavailableReason` に入れる。 */
    private readonly secret: SigningKeySecret | null,
    private readonly unavailableReason: string,
  ) {}

  getActiveSigningKey(): Promise<ActiveSigningKey> {
    this.imported ??= this.loadActiveSigningKey();
    return this.imported;
  }

  private async loadActiveSigningKey(): Promise<ActiveSigningKey> {
    const secret = this.secret;
    if (secret === null) {
      throw new Error(`signing key is not configured: ${this.unavailableReason}`);
    }

    const row = await this.metadata.findByKid(secret.kid);
    if (row === null) {
      // kid が未登録のまま署名すると、JWKS に載っていない kid を名乗る
      // ID Token を配ることになり、RP 側では全件検証失敗になる。
      // 「誰にも検証できないトークンを黙って配る」より、発行を止めるほうがよい。
      // 復旧手順は docs/runbook.md 4.2 ステップ 2（先に行を入れる）。
      throw new Error(
        `signing key is not configured: kid "${secret.kid}" has no row in signing_key_metadata`,
      );
    }
    if (!isActiveAt(row, this.clock.now())) {
      throw new Error(
        `signing key is not configured: kid "${secret.kid}" is not active in signing_key_metadata`,
      );
    }

    const jwk = parseJwk(secret.jwk);
    if (typeof jwk !== "object" || jwk === null) {
      throw new Error("signing key is not configured: SIGNING_KEY_JWK is not valid JSON");
    }
    // 公開鍵を SIGNING_KEY_JWK に貼る取り違えをここで止める（runbook 2.4.1）。
    // `d` が無い JWK を import しても署名の瞬間まで気付けない。
    if (typeof (jwk as Record<string, unknown>)["d"] !== "string") {
      throw new Error(
        "signing key is not configured: SIGNING_KEY_JWK has no private component (d)",
      );
    }

    const key = await importJWK(jwk as Parameters<typeof importJWK>[0], "ES256");
    if (!(key instanceof CryptoKey)) {
      // 対称鍵（Uint8Array）が返るのは oct JWK のとき。ES256 では起きないが、
      // 型を絞るために確認する。
      throw new Error("signing key is not configured: SIGNING_KEY_JWK is not an EC private key");
    }

    return { kid: secret.kid, alg: "ES256", privateKey: key };
  }

  async getPublicJwks(): Promise<readonly PublicSigningJwk[]> {
    const rows = await this.metadata.listPublishable(this.clock.now());

    const keys: PublicSigningJwk[] = [];
    for (const row of rows) {
      if (row.algorithm !== "ES256") {
        console.error("skipping signing key with unsupported algorithm", {
          kid: row.kid,
          algorithm: row.algorithm,
        });
        continue;
      }
      const jwk = toPublicJwk(row.kid, parseJwk(row.publicJwk));
      if (jwk === null) {
        // 壊れた 1 行で JWKS 全体を落とさない。他の鍵が生きていれば
        // 既存のトークンは検証できる。
        console.error("skipping malformed public_jwk", { kid: row.kid });
        continue;
      }
      keys.push(jwk);
    }
    return keys;
  }
}

/** 新規署名に使ってよい期間内か（仕様書 5.4）。 */
function isActiveAt(row: SigningKeyMetadata, now: Date): boolean {
  if (row.activeFrom.getTime() > now.getTime()) return false;
  if (row.activeUntil !== null && row.activeUntil.getTime() <= now.getTime()) return false;
  return true;
}
