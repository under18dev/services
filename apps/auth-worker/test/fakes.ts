import type { AuditEvent, AuditLogger } from "../src/application/ports/audit-log.port";
import type { SideEffectScheduler } from "../src/application/ports/side-effect-scheduler.port";
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

  /**
   * `last_active_at`（#286）。
   *
   * **`UserProps` には持たせない。** application 側はこの値を一度も
   * 読まない（保持期間の洗い出しは運用者が SQL で引く）ので、
   * ドメインの entity に生やすと「読まれない項目」が増える。
   * テストから見たいだけなので、ここで別に持つ。
   */
  private readonly lastActive = new Map<string, Date>();

  async touchLastActive(id: string, at: Date): Promise<void> {
    this.lastActive.set(id, at);
  }

  lastActiveAtOf(id: string): Date | undefined {
    return this.lastActive.get(id);
  }

  /**
   * 本人の退会（#318）。**`active` の行だけに当たる**ところまで写す ——
   * 「二重の退会」と「先に BAN されている」を `false` で返す挙動を
   * use-case のテストが使う。
   */
  async closeAccount(id: string): Promise<boolean> {
    const props = this.store.get(id);
    if (props === undefined || props.status !== "active") return false;
    this.store.set(id, { ...props, status: "suspended" });
    return true;
  }

  /**
   * 管理画面の一覧（#375）。
   *
   * **本物と同じ並びにする**（`created_at` 降順、同値は `id` 降順）。
   * ここだけ違う並びにすると、**UseCase のカーソルの検査が
   * 「このフェイクでだけ通る」**ものになる。
   */
  async listForAdmin(criteria: {
    readonly query?: string;
    readonly after?: { readonly createdAt: Date; readonly id: string };
    readonly limit: number;
  }): Promise<readonly User[]> {
    const matches = [...this.store.values()]
      .filter((props) => {
        if (criteria.query === undefined) return true;
        const q = criteria.query.trim();
        return props.email.toLowerCase() === q.toLowerCase() || props.username === q;
      })
      .filter((props) => {
        if (criteria.after === undefined) return true;
        const at = props.createdAt.getTime();
        const cursorAt = criteria.after.createdAt.getTime();
        return at < cursorAt || (at === cursorAt && props.id < criteria.after.id);
      })
      .sort((a, b) => {
        const diff = b.createdAt.getTime() - a.createdAt.getTime();
        return diff !== 0 ? diff : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      })
      .slice(0, criteria.limit);

    return matches.map((props) => User.fromPersistence(props));
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

/**
 * 副作用をその場で待つスケジューラ（#126）。
 *
 * **テストの既定はこちら。** 応答後へ逃がす実装を既定にすると、
 * アサーションが副作用の完了前に走って不安定になる。
 * 「応答経路に乗っていないこと」は時間ではなく**呼び出し回数**で見る
 * （`test/session-timing.test.ts`）。
 */
export class ImmediateSideEffectScheduler implements SideEffectScheduler {
  /** 受け取ったラベル。順序と回数を見たいときに使う。 */
  readonly labels: string[] = [];

  async schedule(label: string, ...tasks: readonly Promise<unknown>[]): Promise<void> {
    this.labels.push(label);
    await Promise.allSettled(tasks);
  }
}
