import { DEV_SESSION_COOKIE_NAME } from "@u18/contracts";
import { newId } from "@u18/domain";
import { createNfcDatabase, nfcCardEvents, nfcCards } from "@u18/nfc-db";
import { env } from "cloudflare:test";
import type { IdentityGateway, NfcOutcome } from "../src/application/ports";
import { DrizzleCardRepository } from "../src/infrastructure/persistence/drizzle-card.repository";
import { WebCryptoClaimCodeService } from "../src/infrastructure/crypto/web-crypto";

/** テスト内のリクエストは常にこの origin から出す。Origin 検証が URL と比べるため。 */
export const ORIGIN = "http://localhost";

export const db = () => createNfcDatabase(env.NFC_DB);
export const repository = () => new DrizzleCardRepository(db());
export const claimCodes = new WebCryptoClaimCodeService();

/** 行を消すだけ。マイグレーションは再適用しない（auth-worker の helpers と同じ方針）。 */
export async function resetDatabase(): Promise<void> {
  await db().delete(nfcCardEvents).run();
  await db().delete(nfcCards).run();
}

/**
 * `IdentityGateway` の fake。
 *
 * 本物の Service Binding を立てない。この Worker の責務は
 * 「セッションから得た userId で所有者を判定する」ことであり、
 * セッションの検証そのものは auth-worker のテストが持っている。
 *
 * ここで重要なのは **userId がこの fake からしか来ない**こと。
 * リクエストのどこかに userId を書いて通ってしまう経路があれば、
 * fake が返さない userId でカードを操作できてしまい、テストが落ちる。
 */
export function identityWith(tokenToUserId: Record<string, string>): IdentityGateway {
  return {
    async getSession(sessionToken: string) {
      const userId = tokenToUserId[sessionToken];
      if (userId === undefined) return { ok: true, value: null } as NfcOutcome<null>;
      return {
        ok: true,
        value: {
          userId,
          sessionId: "ses_test",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    },
  };
}

/** auth-worker が落ちている状態の fake。 */
export const identityDown: IdentityGateway = {
  async getSession() {
    return {
      ok: false,
      failure: { kind: "identity_unavailable", detail: "boom" },
    };
  },
};

export function cookieFor(token: string): string {
  // development 固定（vitest.config.ts の ENVIRONMENT）。
  return `${DEV_SESSION_COOKIE_NAME}=${token}`;
}

export function executionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

export type SeededCard = {
  readonly cardId: string;
  readonly claimCode: string;
};

/**
 * 発行済み（未紐づけ）のカードを 1 枚作る。
 *
 * 発行は運営の操作で HTTP には出していないので、Repository を直接使う。
 */
export async function seedIssuedCard(batch: string | null = "test-batch"): Promise<SeededCard> {
  const cardId = newId("nfc", 20);
  const claimCode = claimCodes.generate();
  await repository().issue(
    { id: cardId, claimCodeHash: await claimCodes.hash(claimCode), batch },
    new Date(),
  );
  return { cardId, claimCode };
}

/** 指定したユーザーに紐づいた、遷移先**未設定**のカードを作る。 */
export async function seedClaimedCard(ownerUserId: string): Promise<string> {
  const { cardId, claimCode } = await seedIssuedCard();
  const now = new Date();
  const claimed = await repository().claim(
    cardId,
    await claimCodes.hash(claimCode),
    ownerUserId,
    new Date(now.getTime() - 1000),
    now,
  );
  if (!claimed) throw new Error("seedClaimedCard: claim failed");
  return cardId;
}

/** 指定したユーザーに紐づいた、遷移先つきのカードを作る。 */
export async function seedActiveCard(
  ownerUserId: string,
  targetUrl = "https://example.com/taro",
): Promise<string> {
  const cardId = await seedClaimedCard(ownerUserId);
  const updated = await repository().updateTarget(cardId, ownerUserId, targetUrl, new Date());
  if (!updated) throw new Error("seedActiveCard: updateTarget failed");
  return cardId;
}
