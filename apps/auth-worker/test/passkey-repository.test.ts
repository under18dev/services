import { env } from "cloudflare:test";
import { aUser } from "@u18/testing";
import { createIdentityDatabase, passkeys, users } from "@u18/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DrizzlePasskeyRepository } from "../src/infrastructure/persistence/drizzle-passkey.repository";
import { DrizzleWebAuthnChallengeRepository } from "../src/infrastructure/persistence/drizzle-webauthn-challenge.repository";
import { resetDatabase } from "./helpers";

const NOW = new Date("2026-10-24T00:00:00.000Z");
const LATER = new Date("2026-10-24T00:05:00.000Z");

describe("DrizzlePasskeyRepository", () => {
  let repo: DrizzlePasskeyRepository;
  let db: ReturnType<typeof createIdentityDatabase>;
  const user = aUser();
  const other = aUser();

  function aNewPasskey(overrides: Partial<Parameters<DrizzlePasskeyRepository["create"]>[0]> = {}) {
    return {
      id: "pky_1",
      userId: user.id,
      credentialId: "credential-1",
      publicKey: "cHVibGljLWtleQ",
      counter: 0,
      aaguid: "00000000-0000-0000-0000-000000000000",
      deviceType: "multiDevice" as const,
      backedUp: true,
      transports: ["internal", "hybrid"],
      label: "iPhone",
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
    repo = new DrizzlePasskeyRepository(db);
    await db
      .insert(users)
      .values(
        [user, other].map((fixture) => ({
          id: fixture.id,
          username: fixture.username,
          displayName: fixture.displayName,
          primaryEmail: fixture.email,
          emailVerified: fixture.emailVerified,
        })),
      )
      .run();
  });

  it("登録したパスキーを Credential ID で引ける", async () => {
    await repo.create(aNewPasskey());

    const found = await repo.findByCredentialId("credential-1");
    expect(found?.userId).toBe(user.id);
    expect(found?.transports).toEqual(["internal", "hybrid"]);
    expect(found?.backedUp).toBe(true);
    expect(found?.label).toBe("iPhone");
  });

  it("同じ Credential ID は 2 人目に登録させない", async () => {
    // 一意制約の判定を DB に任せる。例外ではなく null で負けを伝える。
    await repo.create(aNewPasskey());

    const stolen = await repo.create(aNewPasskey({ id: "pky_2", userId: other.id }));

    expect(stolen).toBeNull();
    expect((await repo.findByCredentialId("credential-1"))?.userId).toBe(user.id);
  });

  it("利用者ごとのパスキーだけを返す", async () => {
    await repo.create(aNewPasskey());
    await repo.create(aNewPasskey({ id: "pky_2", userId: other.id, credentialId: "credential-2" }));

    const mine = await repo.listByUserId(user.id);
    expect(mine.map((passkey) => passkey.credentialId)).toEqual(["credential-1"]);
  });

  it("認証成功でカウンターと最終利用時刻を進める", async () => {
    await repo.create(aNewPasskey({ counter: 3 }));

    expect(await repo.recordUse("credential-1", 4, NOW)).toBe(true);

    const found = await repo.findByCredentialId("credential-1");
    expect(found?.counter).toBe(4);
    expect(found?.lastUsedAt).toEqual(NOW);
  });

  it("巻き戻ったカウンターでは行を更新しない", async () => {
    // 条件付き UPDATE (`counter <= :next`) に任せる。読んでから書くと、
    // 同時ログインの片方が古い値で上書きできてしまう。
    await repo.create(aNewPasskey({ counter: 10 }));

    expect(await repo.recordUse("credential-1", 9, NOW)).toBe(false);
    expect((await repo.findByCredentialId("credential-1"))?.counter).toBe(10);
  });

  it("ユーザーを削除するとパスキーも消える", async () => {
    await repo.create(aNewPasskey());

    await env.IDENTITY_DB.prepare("pragma foreign_keys = on").run();
    await db.delete(users).where(eq(users.id, user.id)).run();

    expect(await db.select().from(passkeys).all()).toHaveLength(0);
  });
});

describe("DrizzleWebAuthnChallengeRepository", () => {
  let repo: DrizzleWebAuthnChallengeRepository;

  beforeEach(async () => {
    await resetDatabase();
    repo = new DrizzleWebAuthnChallengeRepository(createIdentityDatabase(env.IDENTITY_DB));
  });

  function aChallenge(id: string) {
    return {
      id,
      userId: null,
      challenge: `challenge-value-${id}`,
      purpose: "authentication" as const,
      expiresAt: LATER,
    };
  }

  it("発行した Challenge を消費できる", async () => {
    await repo.create(aChallenge("wac_1"));

    const consumed = await repo.consume("wac_1", NOW);

    expect(consumed?.challenge).toBe("challenge-value-wac_1");
    expect(consumed?.consumedAt).toEqual(NOW);
    expect(consumed?.isExpiredAt(NOW)).toBe(false);
  });

  it("2 回目の消費は null になる", async () => {
    await repo.create(aChallenge("wac_1"));

    await repo.consume("wac_1", NOW);
    expect(await repo.consume("wac_1", NOW)).toBeNull();
  });

  it("存在しない Challenge は null", async () => {
    expect(await repo.consume("wac_missing", NOW)).toBeNull();
  });

  it("同時に 2 回消費しても成功するのは 1 回だけ", async () => {
    // ここが単回使用の根拠（仕様書 9 WebAuthn）。両方成功すると、
    // 1 つの Challenge で 2 回の検証が通ってしまう。
    await repo.create(aChallenge("wac_1"));

    const [first, second] = await Promise.all([
      repo.consume("wac_1", NOW),
      repo.consume("wac_1", NOW),
    ]);

    expect([first, second].filter((result) => result !== null)).toHaveLength(1);
  });

  it("期限切れの判定は保存した時刻で行う", async () => {
    await repo.create(aChallenge("wac_1"));

    const consumed = await repo.consume("wac_1", NOW);
    expect(consumed?.isExpiredAt(new Date(LATER.getTime() + 1))).toBe(true);
  });
});
