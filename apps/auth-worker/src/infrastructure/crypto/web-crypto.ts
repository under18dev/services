import type {
  ConstantTimeComparator,
  IpHasher,
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
 * IP アドレスのハッシュ化。
 *
 * IPv4 の空間は総当たり可能なので、pepper なしの SHA-256 では匿名化にならない。
 * 環境ごとに異なる pepper を混ぜる（仕様書 9 Privacy）。
 */
export class PepperedIpHasher implements IpHasher {
  constructor(private readonly pepper: string) {}

  hash(ip: string): Promise<string> {
    return sha256Hex(`${this.pepper}:${ip}`);
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
