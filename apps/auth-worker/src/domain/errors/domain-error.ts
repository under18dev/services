/**
 * Domain 層のエラー基底。
 *
 * HTTP ステータスや OAuth のエラーコードはここに持ち込まない。
 * プロトコルへの翻訳は Presentation 層の責務（仕様書 2.3）。
 */
export abstract class DomainError extends Error {
  /** 層をまたいで分岐するための安定した識別子。 */
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SessionExpiredError extends DomainError {
  readonly code = "session_expired";
  constructor() {
    super("session has expired");
  }
}

export class SessionRevokedError extends DomainError {
  readonly code = "session_revoked";
  constructor() {
    super("session has been revoked");
  }
}

export class UserNotActiveError extends DomainError {
  readonly code = "user_not_active";
  constructor(status: string) {
    super(`user is not active: ${status}`);
  }
}

export class ChallengeExpiredError extends DomainError {
  readonly code = "challenge_expired";
  constructor() {
    super("challenge has expired");
  }
}

export class ChallengeAlreadyUsedError extends DomainError {
  readonly code = "challenge_already_used";
  constructor() {
    super("challenge has already been used");
  }
}

export class TooManyAttemptsError extends DomainError {
  readonly code = "too_many_attempts";
  constructor() {
    super("too many verification attempts");
  }
}
