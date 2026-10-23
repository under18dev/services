import type { AuthMethod, Session } from "../../domain/entities/session";

export interface CreateSessionInput {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly authMethod: AuthMethod;
  readonly userAgent: string | null;
  readonly ipHash: string | null;
}

export interface SessionRepository {
  /** トークンハッシュで引く。期限切れ・失効済みも返し、判定は Domain に任せる。 */
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  findById(id: string): Promise<Session | null>;
  listByUserId(userId: string): Promise<readonly Session[]>;
  create(input: CreateSessionInput): Promise<Session>;
  /** セッション一覧の「最終アクセス」を更新する。失敗してもログインは妨げない。 */
  touch(id: string, at: Date): Promise<void>;
  /**
   * 失効させる。すでに失効済みなら false を返す。
   * 冪等にするため、存在しない ID でも例外は投げない。
   */
  revoke(id: string, at: Date): Promise<boolean>;
  /** ログアウト（全デバイス）やアカウント停止で使う。失効させた件数を返す。 */
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}
