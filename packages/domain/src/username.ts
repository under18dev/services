/**
 * ユーザー名の Value Object。
 *
 * 表示・メンション用の可変な識別子であって、認証の主キーではない（仕様書 6.2）。
 * 変更されうる前提なので、OIDC の `sub` には使わない。
 */

export class InvalidUsernameError extends Error {
  override readonly name = "InvalidUsernameError";
  constructor(reason: string) {
    super(`invalid username: ${reason}`);
  }
}

const PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const MIN_LENGTH = 3;
const MAX_LENGTH = 32;

/** なりすましやルーティング衝突を避けるため、先に塞いでおく名前。 */
const RESERVED = new Set([
  "admin",
  "administrator",
  "api",
  "auth",
  "dashboard",
  "login",
  "logout",
  "oauth",
  "root",
  "security",
  "support",
  "system",
  "u18",
  "well-known",
]);

export class Username {
  private constructor(readonly value: string) {}

  static create(raw: string): Username {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length < MIN_LENGTH) throw new InvalidUsernameError("too short");
    if (normalized.length > MAX_LENGTH) throw new InvalidUsernameError("too long");
    if (!PATTERN.test(normalized)) throw new InvalidUsernameError("contains disallowed characters");
    if (RESERVED.has(normalized)) throw new InvalidUsernameError("reserved");
    return new Username(normalized);
  }

  static tryCreate(raw: string): Username | null {
    try {
      return Username.create(raw);
    } catch {
      return null;
    }
  }

  equals(other: Username): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
