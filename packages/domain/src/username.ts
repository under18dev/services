/**
 * ユーザー名の Value Object。
 *
 * 表示・メンション用の可変な識別子であって、認証の主キーではない（仕様書 6.2）。
 * 変更されうる前提なので、OIDC の `sub` には使わない。
 */

/**
 * 使えない理由。
 *
 * **文字列の合併にしてある。** 画面に出す文言はここから引く側
 * （`apps/dashboard-worker/.../client/account-island.ts`）が
 * `Record<InvalidUsernameReason, string>` で持つので、**理由を 1 つ足すと
 * 文言を書くまでビルドが通らない。** 理由を増やした人の手元で止まる。
 *
 * 例外のメッセージを解析させない —— 文面を変えた瞬間に、読む側が静かに
 * 既定の文言へ落ちる。
 */
export type InvalidUsernameReason = "too_short" | "too_long" | "disallowed_characters" | "reserved";

export class InvalidUsernameError extends Error {
  override readonly name = "InvalidUsernameError";
  constructor(readonly reason: InvalidUsernameReason) {
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
    const reason = Username.reasonFor(raw);
    if (reason !== null) throw new InvalidUsernameError(reason);
    return new Username(raw.trim().toLowerCase());
  }

  static tryCreate(raw: string): Username | null {
    return Username.reasonFor(raw) === null ? new Username(raw.trim().toLowerCase()) : null;
  }

  /**
   * 使えない理由。使えるなら `null`。
   *
   * **判定の本体はここにある。** `create` は例外に、`tryCreate` は `null` に
   * 翻訳するだけ。画面は理由そのものが要る（「使えません」だけでは直しようが
   * ない）ので、**例外のメッセージを解析させずに**済むようにしてある。
   *
   * 判定を 3 箇所に書かないこと —— 登録と変更と画面でルールがずれる。
   */
  static reasonFor(raw: string): InvalidUsernameReason | null {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length < MIN_LENGTH) return "too_short";
    if (normalized.length > MAX_LENGTH) return "too_long";
    if (!PATTERN.test(normalized)) return "disallowed_characters";
    if (RESERVED.has(normalized)) return "reserved";
    return null;
  }

  equals(other: Username): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
