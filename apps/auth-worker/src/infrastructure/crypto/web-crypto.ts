import type {
  ConstantTimeComparator,
  IpHasher,
  PkceVerifier,
  RandomTokenGenerator,
  TokenHasher,
} from "../../application/ports/crypto.port";

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(digest);
}

/**
 * トークンのハッシュ化。
 *
 * 対象はいずれも 128bit 以上のランダム値なので、総当たりは現実的でない。
 * パスワード用の遅いハッシュ（Argon2 等）は不要で、むしろ検証のたびに
 * CPU 時間を使う分だけ Workers では不利になる。
 */
export class Sha256TokenHasher implements TokenHasher {
  hash(value: string): Promise<string> {
    return sha256Hex(value);
  }
}

/**
 * 直近に import した HMAC 鍵。
 *
 * コンテナはリクエストごとに作り直す（composition/container.ts）ので、
 * インスタンスに持たせても毎リクエスト `importKey` が走る。isolate 内で
 * 使う pepper は実質 1 つなので、**最後の 1 組だけ**をモジュールスコープに
 * 置く。pepper の値そのものを比較キーにしているため、別の pepper の鍵を
 * 取り違えることはない（テストのように複数の pepper が混ざっても、
 * 入れ替わるたびに import し直すだけ）。
 */
let cachedHmacKey: { readonly pepper: string; readonly key: Promise<CryptoKey> } | null = null;

function hmacKeyFor(pepper: string): Promise<CryptoKey> {
  if (cachedHmacKey?.pepper === pepper) return cachedHmacKey.key;
  const key = crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedHmacKey = { pepper, key };
  return key;
}

/**
 * IP アドレスのハッシュ化。
 *
 * IPv4 の空間は総当たり可能なので、pepper なしの SHA-256 では匿名化にならない。
 * 環境ごとに異なる pepper を鍵にする（仕様書 9 Privacy）。
 *
 * 構成は `HMAC-SHA256(key = pepper, message = ip)` の 16 進小文字 64 文字。
 * 以前は `SHA-256("${pepper}:${ip}")` だった。鍵付きハッシュとして素直な
 * 構成に揃えるために切り替えた。出力の形は同じなので、`ip_hash` の列や
 * レート制限の鍵の形は変わらない。**値は変わる** —— 切り替えより前の
 * `ip_hash` とは照合できない（ランブック 2.4.2）。
 */
export class PepperedIpHasher implements IpHasher {
  constructor(private readonly pepper: string) {}

  async hash(ip: string): Promise<string> {
    const key = await hmacKeyFor(this.pepper);
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
    return toHex(mac);
  }
}

export class WebCryptoTokenGenerator implements RandomTokenGenerator {
  /** 既定 32 バイト = 256bit。セッショントークン・認可コード向け。 */
  generate(byteLength = 32): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return toBase64Url(bytes);
  }

  /**
   * 数字の OTP。
   *
   * `% 10` は 256 が 10 の倍数でないため偏る。棄却サンプリングで
   * 一様分布にする。
   */
  generateNumericCode(digits: number): string {
    let out = "";
    const buffer = new Uint8Array(1);
    while (out.length < digits) {
      crypto.getRandomValues(buffer);
      const value = buffer[0] ?? 0;
      if (value < 250) out += (value % 10).toString();
    }
    return out;
  }
}

export class TimingSafeComparator implements ConstantTimeComparator {
  /**
   * 定時間比較。
   *
   * 長さが違う場合は即 false を返すが、ここで比較するのは固定長の
   * ハッシュ・OTP なので長さ自体は秘密ではない。
   */
  equals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
}

/**
 * PKCE S256 の検証（RFC 7636 §4.6）。
 *
 * `BASE64URL(SHA256(ASCII(code_verifier)))` を計算して `code_challenge` と
 * 定時間比較する。計算結果を外へ返さず、ここで比較まで終える
 * （`PkceVerifier` のコメントを参照）。
 */
export class WebCryptoPkceVerifier implements PkceVerifier {
  constructor(private readonly comparator: ConstantTimeComparator) {}

  async verifyS256(codeVerifier: string, codeChallenge: string): Promise<boolean> {
    // RFC 7636 は ASCII での符号化を指定している。`code_verifier` の文字集合は
    // unreserved に限られる（domain/services/pkce.ts で検証済み）ので、
    // UTF-8 エンコードした結果は ASCII と一致する。
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
    const computed = toBase64Url(new Uint8Array(digest));
    return this.comparator.equals(computed, codeChallenge);
  }
}

/**
 * pepper が設定されていない環境向けのダミー。
 *
 * メール送信と同じ理由で、起動時ではなく**ハッシュ化しようとした時点**で
 * 失敗する。IP のハッシュ化はセッション発行でしか起きないので、
 * 設定ミスはログイン時に表面化し、/health や Discovery は巻き添えにならない。
 */
export class UnconfiguredIpHasher implements IpHasher {
  constructor(private readonly reason: string) {}

  async hash(_ip: string): Promise<string> {
    throw new Error(`ip hashing is not configured: ${this.reason}`);
  }
}
