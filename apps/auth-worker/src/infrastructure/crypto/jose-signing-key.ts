import { importJWK } from "jose";
import type { Clock } from "../../application/ports/clock.port";
import type {
  ActiveSigningKey,
  PublicSigningJwk,
  SigningKeyMetadataRepository,
  SigningKeyProvider,
} from "../../application/ports/signing-key.port";
import {
  auditSigningKeySecret,
  explainUnusableSigningKeys,
  parseSigningKeySecret,
  signingKeyHealth,
  type SigningKeyHealth,
  type SigningKeyLifecycle,
} from "../../domain/services/signing-key-rotation";

/**
 * Workers Secret に置いた秘密鍵。
 *
 * 未設定でも `null` としてコンテナを組み立てられるようにしてある。
 * 設定漏れで落とすのは署名のときだけで、JWKS や `/health` は巻き込まない
 * （`UnconfiguredEmailSender` と同じ方針。#53）。
 */
export type SigningKeySecret = {
  /**
   * `SIGNING_KEY_JWK`。`d` を含む EC 秘密鍵の JWK、または JWK Set
   * （`{"keys":[...]}`）。Set にすると新旧 2 鍵を同時に持てる（#23）。
   */
  readonly jwk: string;
  /**
   * `SIGNING_KEY_KID`。**単一 JWK 形式のときだけ**使う旧形式の名残で、
   * JWK Set 形式では各鍵が自分の `kid` を持つため参照しない。
   *
   * Set 形式で古い `SIGNING_KEY_KID` が残っていても黙って無視するのは、
   * それを尊重すると「Secret を JWK Set へ移行した瞬間に、消し忘れた
   * 1 行が署名鍵を過去へ巻き戻す」から。鍵の選択は常に
   * `signing_key_metadata` を正本にする。
   */
  readonly kid: string | null;
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
 * - **Secret は鍵を複数持てる（#23）。** どれで署名するかは
 *   `signing_key_metadata` が決める。Secret を「現役の鍵 1 本」ではなく
 *   「持っている鍵の束」にしたことで、鍵の追加と切り替えが別々の操作になり、
 *   ローテーション中に「新 kid を名乗る旧鍵署名」のような中間状態が作れなくなる。
 * - **署名の直前に Secret と行の公開鍵が同じものかを確かめる。** kid の存在だけ
 *   見ても、中身が別の鍵なら全 RP で検証に失敗する（docs/runbook.md 4.1 制約 3）。
 *   この検査は運用スクリプトと同じ関数（`auditSigningKeySecret`）を通る。
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

    const parsed = parseSigningKeySecret(secret.jwk, secret.kid);
    if (!parsed.ok) {
      throw new Error(`signing key is not configured: ${parsed.reason}`);
    }

    // 引くのは Secret に入っている kid の行だけ。全行を読むと、鍵を 1 本しか
    // 持たない通常時にもクエリが増える。`missing-from-secret`（DB だけが知って
    // いる現役鍵）の検出は運用スクリプト側に任せる —— リクエスト処理の途中で
    // 気付いても、そこで直せるものではない。
    const rows = (
      await Promise.all(parsed.keys.map((key) => this.metadata.findByKid(key.kid)))
    ).filter((row) => row !== null);

    const audit = auditSigningKeySecret(parsed.keys, rows, this.clock.now());
    if (audit.signingKid === null) {
      // 「誰にも検証できないトークンを黙って配る」より、発行を止めるほうがよい。
      // 復旧手順は docs/runbook.md 4.2（先に行を入れてから Secret を足す）。
      throw new Error(`signing key is not configured: ${explainUnusableSigningKeys(audit)}`);
    }

    const chosen = parsed.keys.find((key) => key.kid === audit.signingKid);
    if (chosen === undefined) {
      // auditSigningKeySecret は渡した鍵の中からしか選ばない。
      throw new Error(`signing key is not configured: kid "${audit.signingKid}" vanished`);
    }

    const key = await importJWK(chosen.jwk as Parameters<typeof importJWK>[0], "ES256");
    if (!(key instanceof CryptoKey)) {
      // 対称鍵（Uint8Array）が返るのは oct JWK のとき。ES256 では起きないが、
      // 型を絞るために確認する。
      throw new Error("signing key is not configured: SIGNING_KEY_JWK is not an EC private key");
    }

    return { kid: chosen.kid, alg: "ES256", privateKey: key };
  }

  async getPublicJwks(): Promise<readonly PublicSigningJwk[]> {
    return this.collectPublicJwks(await this.metadata.listPublishable(this.clock.now()));
  }

  /**
   * 行から JWKS に実際に載る鍵を取り出す。
   *
   * `getPublicJwks()` と `checkHealth()` の両方がここを通る。**配られる鍵の
   * 集合を決めるコードを 1 つにしておくのが肝**で、健全性の検査が別の
   * 絞り込みを持つと「`/health` は ok なのに JWKS にその kid が無い」が
   * 成立する（domain/services/signing-key-rotation.ts の `signingKeyHealth`）。
   */
  private collectPublicJwks(rows: readonly SigningKeyLifecycle[]): PublicSigningJwk[] {
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

  /**
   * `/health` の `checks.signingKey`。
   *
   * ## D1 を 1 回しか読まない
   *
   * `listPublishable()` の結果を突き合わせにも JWKS の判定にも使う。
   * `getActiveSigningKey()` のように Secret の kid ごとに `findByKid()` を
   * 打つと、**未認証で叩ける `/health` が 1 リクエストあたり複数クエリ**に
   * なる。公開エンドポイントの D1 クエリ数は増やさない（docs/runbook.md
   * 8.5 の未決事項 7）。
   *
   * 全行を渡すので `missing-from-secret`（DB は現役と言うが Secret に鍵が
   * 無い）もここで効く。`getActiveSigningKey()` が拾えない種類の不整合で、
   * 署名の最中に気付いても直せないが、`/health` なら直せる。
   *
   * ## 投げない
   *
   * Port の契約（`SigningKeyProvider.checkHealth`）。D1 が落ちていれば
   * `unavailable` を返すが、その場合は `checks.database` も同時に
   * `unreachable` になるので、原因を取り違える余地は無い。
   */
  async checkHealth(): Promise<SigningKeyHealth> {
    try {
      const secret = this.secret;
      if (secret === null) return "unavailable";

      const parsed = parseSigningKeySecret(secret.jwk, secret.kid);
      if (!parsed.ok) return "unavailable";

      const now = this.clock.now();
      const rows = await this.metadata.listPublishable(now);
      const audit = auditSigningKeySecret(parsed.keys, rows, now);

      return signingKeyHealth(
        audit,
        this.collectPublicJwks(rows).map((key) => key.kid),
      );
    } catch (cause) {
      console.error("signing key health check failed", cause);
      return "unavailable";
    }
  }
}
