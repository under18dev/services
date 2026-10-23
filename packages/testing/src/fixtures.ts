import { newSessionId, newUserId } from "@u18/domain";

/**
 * テスト用のデータ生成。
 *
 * テストが「何を検証しているか」を読みやすくするため、既定値を全部埋めて
 * 上書きしたいフィールドだけを渡せる形にする。
 */

export type UserFixture = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  status: "active" | "suspended" | "deleted";
  createdAt: Date;
  updatedAt: Date;
};

export const FIXED_NOW = new Date("2026-10-24T00:00:00.000Z");

export function aUser(overrides: Partial<UserFixture> = {}): UserFixture {
  const id = overrides.id ?? newUserId();
  return {
    id,
    username: `user_${id.slice(4, 12)}`,
    displayName: "Test User",
    email: `${id}@example.com`,
    emailVerified: true,
    status: "active",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export type SessionFixture = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  authMethod: "passkey" | "email_otp";
  lastSeenAt: Date;
  userAgent: string | null;
  ipHash: string | null;
  createdAt: Date;
};

export function aSession(overrides: Partial<SessionFixture> = {}): SessionFixture {
  const id = overrides.id ?? newSessionId();
  return {
    id,
    userId: overrides.userId ?? newUserId(),
    tokenHash: `hash_${id}`,
    expiresAt: new Date(FIXED_NOW.getTime() + 12 * 60 * 60 * 1000),
    revokedAt: null,
    authMethod: "passkey",
    lastSeenAt: FIXED_NOW,
    userAgent: "vitest",
    ipHash: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}
