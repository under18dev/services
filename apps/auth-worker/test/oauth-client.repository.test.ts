import { env } from "cloudflare:test";
import { createIdentityDatabase, oauthClients, oauthRedirectUris } from "@u18/db";
import { newClientId } from "@u18/domain";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { CreateOAuthClientInput } from "../src/application/ports/oauth-client.repository";
import { DrizzleOAuthClientRepository } from "../src/infrastructure/persistence/drizzle-oauth-client.repository";
import { Sha256TokenHasher, TimingSafeComparator } from "../src/infrastructure/crypto/web-crypto";
import { resetDatabase } from "./helpers";

const hasher = new Sha256TokenHasher();

async function aClientInput(
  overrides: Partial<CreateOAuthClientInput> = {},
): Promise<CreateOAuthClientInput> {
  return {
    id: newClientId(),
    clientId: "u18-dashboard-test",
    name: "u18 Dashboard (test)",
    clientType: "confidential",
    clientSecretHash: await hasher.hash("correct-horse-battery-staple"),
    allowedScopes: "openid profile email",
    isFirstParty: true,
    logoUrl: null,
    redirectUris: ["https://app.example/cb"],
    ...overrides,
  };
}

describe("DrizzleOAuthClientRepository", () => {
  let repo: DrizzleOAuthClientRepository;
  let db: ReturnType<typeof createIdentityDatabase>;

  beforeEach(async () => {
    await resetDatabase();
    db = createIdentityDatabase(env.IDENTITY_DB);
    repo = new DrizzleOAuthClientRepository(db, hasher, new TimingSafeComparator());
  });

  it("first-party / confidential のクライアントを登録して引ける", async () => {
    const input = await aClientInput();
    await repo.create(input);

    const found = await repo.findByClientId("u18-dashboard-test");
    expect(found?.clientId).toBe("u18-dashboard-test");
    expect(found?.isConfidential).toBe(true);
    expect(found?.isFirstParty).toBe(true);
    expect(found?.isDisabled).toBe(false);
    expect(found?.allowedScopes).toEqual(["openid", "profile", "email"]);
    expect(found?.redirectUris).toEqual(["https://app.example/cb"]);
  });

  it("third-party / public のクライアントも登録できる", async () => {
    await repo.create(
      await aClientInput({
        clientId: "u18-e2e-public",
        clientType: "public",
        clientSecretHash: null,
        isFirstParty: false,
        allowedScopes: "openid profile",
      }),
    );

    const found = await repo.findByClientId("u18-e2e-public");
    expect(found?.isConfidential).toBe(false);
    expect(found?.isFirstParty).toBe(false);
    expect(found?.allowedScopes).toEqual(["openid", "profile"]);
  });

  it("同じ client_id は二重登録できない", async () => {
    const first = await repo.create(await aClientInput());
    expect(first).not.toBeNull();

    // 2 本目は unique index で弾かれ、既存行は書き換わらない。
    const second = await repo.create(await aClientInput({ name: "なりすまし" }));
    expect(second).toBeNull();

    const rows = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, "u18-dashboard-test"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("u18 Dashboard (test)");
  });

  it("存在しない client_id では null を返す", async () => {
    expect(await repo.findByClientId("nope")).toBeNull();
  });

  it("Redirect URI を持たないクライアントも引ける", async () => {
    await repo.create(await aClientInput({ redirectUris: [] }));

    const found = await repo.findByClientId("u18-dashboard-test");
    expect(found).not.toBeNull();
    expect(found?.redirectUris).toEqual([]);
    expect(found?.matchesRedirectUri("https://app.example/cb")).toBe(false);
  });

  it("複数の Redirect URI を完全一致で照合する", async () => {
    await repo.create(
      await aClientInput({
        redirectUris: ["https://app.example/cb", "https://app.example/cb?tenant=u18"],
      }),
    );

    const found = await repo.findByClientId("u18-dashboard-test");
    expect(found?.redirectUris).toHaveLength(2);
    expect(found?.matchesRedirectUri("https://app.example/cb?tenant=u18")).toBe(true);
    // クエリが 1 文字違えば別の宛先（仕様書 9）。
    expect(found?.matchesRedirectUri("https://app.example/cb?tenant=u19")).toBe(false);
  });

  it("client_secret の平文は DB に残らない", async () => {
    const secret = "correct-horse-battery-staple";
    await repo.create(await aClientInput({ clientSecretHash: await hasher.hash(secret) }));

    const row = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, "u18-dashboard-test"))
      .get();

    expect(row?.clientSecretHash).toBe(await hasher.hash(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("正しい client_secret だけを受け入れる", async () => {
    await repo.create(await aClientInput());

    expect(await repo.verifySecret("u18-dashboard-test", "correct-horse-battery-staple")).toBe(
      true,
    );
    expect(await repo.verifySecret("u18-dashboard-test", "correct-horse-battery-stapl")).toBe(
      false,
    );
    expect(await repo.verifySecret("u18-dashboard-test", "")).toBe(false);
  });

  it("public クライアントは秘密で認証できない", async () => {
    await repo.create(
      await aClientInput({
        clientId: "u18-e2e-public",
        clientType: "public",
        clientSecretHash: null,
      }),
    );

    expect(await repo.verifySecret("u18-e2e-public", "anything")).toBe(false);
  });

  it("未登録の client_id の照合は false", async () => {
    expect(await repo.verifySecret("nope", "anything")).toBe(false);
  });

  it("失効させたクライアントは即座に拒否される", async () => {
    await repo.create(await aClientInput());
    const at = new Date("2026-10-24T03:00:00.000Z");

    expect(await repo.disable("u18-dashboard-test", at)).toBe(true);

    const found = await repo.findByClientId("u18-dashboard-test");
    expect(found?.isDisabled).toBe(true);
    // 秘密が正しくても通さない。
    expect(await repo.verifySecret("u18-dashboard-test", "correct-horse-battery-staple")).toBe(
      false,
    );
  });

  it("二重の失効は 1 回しか成功せず、時刻が上書きされない", async () => {
    await repo.create(await aClientInput());
    const first = new Date("2026-10-24T03:00:00.000Z");
    const second = new Date("2026-10-24T04:00:00.000Z");

    expect(await repo.disable("u18-dashboard-test", first)).toBe(true);
    expect(await repo.disable("u18-dashboard-test", second)).toBe(false);

    const found = await repo.findByClientId("u18-dashboard-test");
    expect(found?.disabledAt?.toISOString()).toBe(first.toISOString());
  });

  it("listRedirectUris は client_id から登録済み URI を返す", async () => {
    await repo.create(
      await aClientInput({ redirectUris: ["https://app.example/cb", "https://app.example/cb2"] }),
    );

    const uris = await repo.listRedirectUris("u18-dashboard-test");
    expect([...uris].sort()).toEqual(["https://app.example/cb", "https://app.example/cb2"]);
    expect(await repo.listRedirectUris("nope")).toEqual([]);
  });

  it("listAll は失効済みも含めて登録順に返す", async () => {
    // 失効済みを落とすと、管理画面から失効させた直後に行が消える
    // （#308）。Repository は事実を返し、可否は呼び出し側が決める。
    await repo.create(await aClientInput({ clientId: "u18-first" }));
    await repo.create(
      await aClientInput({ clientId: "u18-second", redirectUris: ["https://b.example/cb"] }),
    );
    await repo.disable("u18-second", new Date("2026-10-29T03:00:00.000Z"));

    const all = await repo.listAll();

    expect(all.map((client) => client.clientId)).toEqual(["u18-first", "u18-second"]);
    expect(all[0]?.isDisabled).toBe(false);
    expect(all[1]?.isDisabled).toBe(true);
    // join で行が増えても、クライアントは 1 つに畳まれて URI だけが集まる。
    expect(all[0]?.redirectUris).toEqual(["https://app.example/cb"]);
    expect(all[1]?.redirectUris).toEqual(["https://b.example/cb"]);
  });

  it("listAll は Redirect URI を持たない行も返す", async () => {
    // left join を inner join にすると、ここだけが静かに消える。
    await repo.create(await aClientInput({ redirectUris: [] }));

    const all = await repo.listAll();

    expect(all).toHaveLength(1);
    expect(all[0]?.redirectUris).toEqual([]);
  });

  it("listAll は client_secret のハッシュを Domain まで運ばない", async () => {
    const secret = "correct-horse-battery-staple";
    await repo.create(await aClientInput({ clientSecretHash: await hasher.hash(secret) }));

    const all = await repo.listAll();

    // `OAuthClient` に hash のフィールドが無いので、snapshot を走査しても
    // 出てこない（型だけでなく値でも確かめる。RR-13 と同じ方針）。
    expect(JSON.stringify(all[0]?.snapshot())).not.toContain(await hasher.hash(secret));
  });

  it("1 件も無ければ空配列", async () => {
    expect(await repo.listAll()).toEqual([]);
  });

  it("クライアントを削除すると Redirect URI も消える", async () => {
    await repo.create(await aClientInput());

    await env.IDENTITY_DB.prepare("pragma foreign_keys = on").run();
    await db.delete(oauthClients).where(eq(oauthClients.clientId, "u18-dashboard-test")).run();

    expect(await db.select().from(oauthRedirectUris).all()).toHaveLength(0);
  });
});
