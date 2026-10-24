import type { AuditEvent, AuditLogger } from "../src/application/ports/audit-log.port";
import type { TokenHasher } from "../src/application/ports/crypto.port";
import type {
  CreateSessionInput,
  SessionRepository,
} from "../src/application/ports/session.repository";
import type {
  NewUser,
  UpdateProfileOutcome,
  UserRepository,
} from "../src/application/ports/user.repository";
import { Session, type SessionProps } from "../src/domain/entities/session";
import { User, type UserProps } from "../src/domain/entities/user";

/**
 * UseCase の単体テスト用のインメモリ実装（仕様書 11.1）。
 *
 * Repository を Mock するのではなく、本物の振る舞い（条件付き更新の原子性を含む）を
 * 単純化して再現する。Mock だと「呼ばれたか」しか検証できず、認可の抜けを見逃す。
 */

export class InMemoryUserRepository implements UserRepository {
  private readonly store = new Map<string, UserProps>();

  seed(props: UserProps): User {
    this.store.set(props.id, props);
    return User.fromPersistence(props);
  }

  async findById(id: string): Promise<User | null> {
    const props = this.store.get(id);
    return props ? User.fromPersistence(props) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    for (const props of this.store.values()) {
      if (props.email.toLowerCase() === email.toLowerCase()) return User.fromPersistence(props);
    }
    return null;
  }

  async findByUsername(username: string): Promise<User | null> {
    for (const props of this.store.values()) {
      if (props.username.toLowerCase() === username.toLowerCase()) {
        return User.fromPersistence(props);
      }
    }
    return null;
  }

  async create(input: NewUser): Promise<User> {
    const now = new Date();
    const props: UserProps = {
      ...input,
      status: "active",
      // 新規作成されたユーザーは管理者ではない。本物の DB 側も
      // `users.is_admin` の既定値が false で、付与は運用の CLI からしか通らない。
      isAdmin: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(props.id, props);
    return User.fromPersistence(props);
  }

  async updateProfile(
    id: string,
    changes: { displayName?: string; username?: string },
  ): Promise<UpdateProfileOutcome> {
    const existing = this.store.get(id);
    if (!existing) return { kind: "not_found" };

    // 一意索引（lower(username)）と同じ判定。ここを緩めると、UseCase の
    // テストが「実際には 409 になる更新」を成功として通してしまう。
    if (changes.username !== undefined) {
      const taken = [...this.store.values()].some(
        (other) =>
          other.id !== id && other.username.toLowerCase() === changes.username?.toLowerCase(),
      );
      if (taken) return { kind: "username_taken" };
    }

    const next: UserProps = { ...existing, ...changes, updatedAt: new Date() };
    this.store.set(id, next);
    return { kind: "updated", user: User.fromPersistence(next) };
  }

  async markEmailVerified(id: string, email: string): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, { ...existing, email, emailVerified: true, updatedAt: new Date() });
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly store = new Map<string, SessionProps>();
  /** sessionId -> tokenHash。本物と同じく、平文トークンは持たない。 */
  private readonly tokenHashes = new Map<string, string>();

  /**
   * セッションを直接流し込む。
   *
   * トークンを明示しない場合は `hash:<sessionId>` を既定とし、
   * テストから「セッション ID をトークンとして」使えるようにする
   * （FakeHasher と対になる約束）。`create()` 経由で発行したセッションは
   * 本物と同じく、渡された tokenHash をそのまま覚える。
   */
  seed(props: SessionProps, tokenHash = this.hashOf(props.id)): Session {
    this.store.set(props.id, props);
    this.tokenHashes.set(props.id, tokenHash);
    return Session.fromPersistence(props);
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    for (const [id, hash] of this.tokenHashes) {
      if (hash !== tokenHash) continue;
      const props = this.store.get(id);
      if (props) return Session.fromPersistence(props);
    }
    return null;
  }

  /** セッション ID からテスト用のハッシュを導く。FakeHasher と対になる。 */
  hashOf(sessionId: string): string {
    return `hash:${sessionId}`;
  }

  async findById(id: string): Promise<Session | null> {
    const props = this.store.get(id);
    return props ? Session.fromPersistence(props) : null;
  }

  async listByUserId(userId: string): Promise<readonly Session[]> {
    return [...this.store.values()]
      .filter((p) => p.userId === userId)
      .map((p) => Session.fromPersistence(p));
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const now = new Date();
    const props: SessionProps = {
      id: input.id,
      userId: input.userId,
      expiresAt: input.expiresAt,
      revokedAt: null,
      authMethod: input.authMethod,
      lastSeenAt: now,
      userAgent: input.userAgent,
      ipHash: input.ipHash,
      createdAt: now,
    };
    this.store.set(props.id, props);
    this.tokenHashes.set(props.id, input.tokenHash);
    return Session.fromPersistence(props);
  }

  async touch(id: string, at: Date): Promise<void> {
    const props = this.store.get(id);
    if (props) this.store.set(id, { ...props, lastSeenAt: at });
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    const props = this.store.get(id);
    // 実装と同じく、すでに失効済みなら false。
    if (!props || props.revokedAt !== null) return false;
    this.store.set(id, { ...props, revokedAt: at });
    return true;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    let count = 0;
    for (const [id, props] of this.store) {
      if (props.userId === userId && props.revokedAt === null) {
        this.store.set(id, { ...props, revokedAt: at });
        count += 1;
      }
    }
    return count;
  }
}

/** セッション ID をそのままトークンとして扱う、テスト専用のハッシュ。 */
export class FakeHasher implements TokenHasher {
  async hash(value: string): Promise<string> {
    return `hash:${value}`;
  }
}

export class RecordingAuditLogger implements AuditLogger {
  readonly events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  eventNames(): string[] {
    return this.events.map((e) => e.event);
  }
}
