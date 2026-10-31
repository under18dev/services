import { auditLogs, oauthClients, oauthRedirectUris, users } from "@u18/db";
import { createExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_EVENT_RETENTION } from "../src/application/ports/audit-log.port";
import { createContainer } from "../src/composition/container";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { IdentityAdminRPC } from "../src/presentation/rpc/identity-admin.entrypoint";
import { IdentityRPC } from "../src/presentation/rpc/identity.entrypoint";
import { resetDatabase } from "./helpers";
import { appEnv, db, seedLoggedInUser, type SeededUser } from "./helpers.oauth";

/**
 * `IdentityAdminRPC`（#308 / 仕様書 4.2）。
 *
 * ## このファイルが守っているもの
 *
 * **これは緩和策の置き換えである。** `scripts/oauth-client.mjs` は
 * 「運用者の手元からしか叩けないこと自体が緩和策」と書いていた。それを
 * 「管理者だけが叩ける」へ置き換えたので、**管理者の資格が唯一の壁**に
 * なっている（脅威モデル RR-21）。壁が効いていることを機械で固定するのが
 * ここの目的で、確かめるのは 6 つ。
 *
 * 1. 管理者でないと 3 メソッドとも通らない（しかも**存在しないかのように**断る）
 * 2. 登録・失効には**再認証**が要る
 * 3. `client_secret` のハッシュが応答に出ない —— 型と実行時の両方で
 * 4. 重複 `client_id` / 不正な `redirect_uri` / `logo_url` / 失効の冪等性
 * 5. 監査ログに行が残り、**保持区分が `standard` に落ちていない**。
 *    逆に**拒否では行が増えない**（書き込みの増幅を作らない）
 * 6. **`IdentityRPC` の側にこの 3 つが生えていない**（束縛を分けた意味）
 *
 * Entrypoint を直に `new` している（`oauth-grants.rpc.test.ts` と同じ）。
 * Service Binding の配線は呼び出し元 Worker の責務で、ここで見たいのは
 * **認可と DTO への写し取り**である。D1 は本物を使う。
 */

const hasher = new Sha256TokenHasher();

let rpc: IdentityAdminRPC;

beforeEach(async () => {
  await resetDatabase();
  rpc = new IdentityAdminRPC(createExecutionContext(), appEnv());
});

afterEach(() => {
  // console の差し替えを次のテストへ持ち越さない。
  vi.restoreAllMocks();
});

/** 再認証の窓（5 分）から確実に外れる古さ。`rpc-parity.test.ts` と同じ値。 */
const STALE = new Date(Date.now() - 60 * 60 * 1000);

/**
 * 管理者としてログイン済みの利用者。
 *
 * **`authMethod` は `passkey` である。** `seedLoggedInUser` の既定は
 * `email_otp` だが、**本番にその組み合わせは存在しない** —— 決定 8
 * （#40 / #83）により `IssueSessionUseCase` は管理者の `email_otp`
 * セッションを拒否し、管理権限の付与は既存の非 Passkey セッションを失効
 * させる。実在しない前提でテストを回すと、**この入口が `authMethod` を
 * どう扱うか**（RR-5 / RR-21）を 1 本も確かめないまま緑になる。
 *
 * **いまは既定を外すだけで足りる。** #337 で `seedLoggedInUser` が
 * `isAdmin` と `authMethod` を受け取るようになったので、ここで行を
 * 更新し直す必要がなくなった。
 *
 * **`passkey` 固定なので、このヘルパを使うテストは決定 8 を確かめない。**
 * 旗が立っていても OTP のセッションでは通らないことは、下の
 * 「OTP のセッションでは、旗が立っていても通らない」が別に見ている。
 */
async function seedAdmin(options: { readonly authTime?: Date } = {}): Promise<SeededUser> {
  return seedLoggedInUser({ ...options, isAdmin: true, authMethod: "passkey" });
}

/** 既定のパラメータで 1 つ登録する。 */
function createClient(
  user: SeededUser,
  overrides: Partial<{
    name: string;
    clientType: "confidential" | "public";
    redirectUris: string[];
    scopes: string[];
  }> = {},
) {
  return rpc.createOAuthClient({
    sessionToken: user.sessionToken,
    caller: "dashboard-worker",
    name: overrides.name ?? "管理画面から作ったクライアント",
    clientType: overrides.clientType ?? "confidential",
    redirectUris: overrides.redirectUris ?? ["https://app.example/cb"],
    ...(overrides.scopes === undefined ? {} : { scopes: overrides.scopes }),
  });
}

async function auditRows(event: string) {
  const rows = await db().select().from(auditLogs).all();
  return rows.filter((row) => row.event === event);
}

/**
 * **管理者でないと 1 つも通らない。**
 *
 * `users.is_admin` が立っていないセッションは、3 メソッドすべてで
 * `not_found` になる。`forbidden` ではない —— 「権限がありません」と
 * 「そんな機能はありません」を区別すると、管理機能の存在そのものが
 * 一般利用者に漏れる。
 */
describe("管理者でないセッションは弾かれる", () => {
  const calls = [
    ["listOAuthClients", (u: SeededUser) => rpc.listOAuthClients({ sessionToken: u.sessionToken })],
    ["createOAuthClient", (u: SeededUser) => createClient(u)],
    [
      "disableOAuthClient",
      (u: SeededUser) =>
        rpc.disableOAuthClient({ sessionToken: u.sessionToken, clientId: "u18-admin-created" }),
    ],
  ] as const;

  it.each(calls)("%s は一般利用者に not_found を返す", async (_name, invoke) => {
    const user = await seedLoggedInUser();

    const result = await invoke(user);

    expect(result.ok).toBe(false);
    // forbidden に変えると、管理機能があることだけは分かってしまう。
    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it.each(calls)("%s は無効なセッションに unauthenticated を返す", async (_name, invoke) => {
    // 「知らないトークン」と「権限が無い」は別の応答でよい。前者は
    // 管理機能の存在を教えないし、ログインし直せば済む話と区別が要る。
    const stranger = { ...(await seedLoggedInUser()), sessionToken: "x".repeat(40) };

    const result = await invoke(stranger);

    expect(!result.ok && result.error.code).toBe("unauthenticated");
  });

  it("一般利用者の登録要求では行が 1 つも増えない", async () => {
    // コードだけ見て「作られていない」を確かめない。拒否の判定が
    // 検証の**後ろ**にあると、弾かれる前に行が入ることがある。
    const user = await seedLoggedInUser();

    await createClient(user);

    expect(await db().select().from(oauthClients).all()).toHaveLength(0);
    expect(await db().select().from(oauthRedirectUris).all()).toHaveLength(0);
  });

  it("管理者の判定は実際の users.is_admin を見ている", async () => {
    // 常に false を返すよう壊しても上の 3 つは緑のままなので、
    // 「立てれば通る」側も固定する。
    const user = await seedLoggedInUser({ authMethod: "passkey" });
    expect((await rpc.listOAuthClients({ sessionToken: user.sessionToken })).ok).toBe(false);

    await db().update(users).set({ isAdmin: true }).where(eq(users.id, user.userId)).run();

    expect((await rpc.listOAuthClients({ sessionToken: user.sessionToken })).ok).toBe(true);
  });

  it("OTP のセッションでは、旗が立っていても通らない", async () => {
    // **決定 8（#337 / RR-5）がこの入口にも効いていること。**
    //
    // `requireAdminSession` は `GetSessionUseCase` の `isAdmin` を見ており、
    // あれは `User.actsAsAdminWith(authMethod)` —— 旗が立っていることと、
    // **このセッションで管理者として振る舞ってよいこと**は別である。
    // 判定を書き足していないので「たまたま効いている」ように見えるが、
    // **効いていることを確かめずに置くと、`actsAsAdminWith` を
    // `isAdmin` だけ見る形に戻したときに管理領域だけが黙って開く。**
    //
    // 上の `seedAdmin` は `passkey` 固定なので、この 1 本が無いと
    // そちらの差し戻しを誰も捕まえない。
    const user = await seedLoggedInUser({ isAdmin: true, authMethod: "email_otp" });

    const result = await rpc.listOAuthClients({ sessionToken: user.sessionToken });

    // 一般利用者と同じ応答に畳む。「方式が足りない」と教えない。
    expect(!result.ok && result.error.code).toBe("not_found");
  });
});

describe("createOAuthClient", () => {
  it("client_secret の平文はこの応答にだけ出て、DB にはハッシュしか残らない", async () => {
    const admin = await seedAdmin();

    const result = await createClient(admin);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const secret = result.value.clientSecret;
    expect(typeof secret).toBe("string");
    expect(secret?.length).toBeGreaterThan(20);

    const row = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, result.value.client.clientId))
      .get();

    // DB に入っているのはハッシュだけ。平文は 1 文字も残らない。
    expect(row?.clientSecretHash).toBe(await hasher.hash(secret!));
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("応答に client_secret_hash が載らない（型と実行時の両方で）", async () => {
    const admin = await seedAdmin();

    const result = await createClient(admin);
    if (!result.ok) throw new Error("登録に失敗した");

    // 型で落ちること。`OAuthClientSummary` にこのフィールドは無いので、
    // ここから `@ts-expect-error` を外すと typecheck が落ちる
    // （`PasskeySummary` から公開鍵を外したのと同じ形。RR-13）。
    // @ts-expect-error OAuthClientSummary は client_secret_hash を持たない
    const leaked: unknown = result.value.client.clientSecretHash;
    expect(leaked).toBeUndefined();

    // 実行時にも確かめる —— 型はキャストで抜けられる。
    const storedHash = await hasher.hash(result.value.clientSecret!);
    expect(JSON.stringify(result)).not.toContain(storedHash);

    const list = await rpc.listOAuthClients({ sessionToken: admin.sessionToken });
    expect(JSON.stringify(list)).not.toContain(storedHash);
    expect(JSON.stringify(list)).not.toContain(result.value.clientSecret);
  });

  it("public クライアントは秘密を持たない", async () => {
    const admin = await seedAdmin();

    const result = await createClient(admin, { clientType: "public" });

    expect(result.ok && result.value.clientSecret).toBeNull();
    if (!result.ok) throw new Error("登録に失敗した");
    const row = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, result.value.client.clientId))
      .get();
    expect(row?.clientSecretHash).toBeNull();
  });

  it("client_id の衝突は conflict に畳まれ、既存行は書き換わらない", async () => {
    // **実際の二重登録はもう起こせない。** `client_id` が自動生成に
    // なった（運用者の判断、2026-10-30）ので、同じ値を 2 回送って
    // 衝突を再現する手段が無い。見ているのは「Repository が衝突を
    // `null` で伝えたら UseCase が `conflict` に写す」契約そのもの ——
    // `OAuthClientRepository.create` を差し替えて衝突を起こす。
    const admin = await seedAdmin();
    const created = await createClient(admin);
    if (!created.ok) throw new Error("登録に失敗した");

    // **`create` だけが意味を持つ偽物。** 見たいのは「Repository が
    // `null` を返したら UseCase が `conflict` に写す」契約だけで、他の
    // メソッドは呼ばれない前提のため、呼ばれたら即座に落ちるようにする。
    const neverCalled = (name: string) => (): never => {
      throw new Error(`${name} should not have been called`);
    };
    const container = createContainer(appEnv(), {
      oauthClients: {
        create: async () => null,
        findByClientId: neverCalled("findByClientId"),
        listRedirectUris: neverCalled("listRedirectUris"),
        listAll: neverCalled("listAll"),
        count: neverCalled("count"),
        verifySecret: neverCalled("verifySecret"),
        disable: neverCalled("disable"),
      },
    });

    const second = await container.useCases.createOAuthClient.execute({
      sessionToken: admin.sessionToken,
      name: "なりすまし",
      clientType: "confidential",
      redirectUris: ["https://app.example/cb"],
    });

    expect(!second.ok && second.error.code).toBe("conflict");
    const rows = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, created.value.client.clientId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("管理画面から作ったクライアント");
  });

  /**
   * 検証は `domain/services/redirect-uri.ts` に任せている。**CLI が同じ
   * 関数を読んでいる**ので、ここで別の判定を書くと「CLI で通した URI が
   * 認可時に弾かれる」という形でずれる。
   *
   * `http://localhost` が拒否されるのが重要。本番 IdP にループバック宛の
   * 行が残ると、`client_id` を知る攻撃者が被害者のブラウザで認可を走らせ、
   * 自分の手元で待つアプリへコードを届けられる。CLI には
   * `--allow-loopback-http` があるが、この入口には置いていない。
   */
  it.each([
    ["絶対 URI でない", "/cb"],
    ["平文 HTTP", "http://app.example/cb"],
    ["ループバックの HTTP", "http://localhost:8788/cb"],
    ["フラグメント付き", "https://app.example/cb#x"],
    ["資格情報付き", "https://user:pass@app.example/cb"],
    ["正規形でない", "https://app.example"],
  ])("不正な redirect_uri（%s）は登録されない", async (_name, uri) => {
    const admin = await seedAdmin();

    const result = await createClient(admin, { redirectUris: [uri] });

    expect(!result.ok && result.error.code).toBe("invalid_input");
    expect(await db().select().from(oauthClients).all()).toHaveLength(0);
    expect(await db().select().from(oauthRedirectUris).all()).toHaveLength(0);
  });

  it("redirect_uri が 1 つも無い登録は通らない", async () => {
    // Redirect URI を持たないクライアントは認可フローに入れない。
    // 「後で足す」を許すと、未検証の URI が直接 SQL で入る経路ができる。
    const admin = await seedAdmin();

    const result = await rpc.createOAuthClient({
      sessionToken: admin.sessionToken,
      name: "宛先なし",
      clientType: "public",
      redirectUris: [],
    });

    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it.each([
    ["平文 HTTP", "http://cdn.example/logo.png"],
    ["data: スキーム", "data:image/png;base64,iVBORw0KGgo="],
    ["javascript: スキーム", "javascript:alert(1)"],
    ["資格情報付き", "https://user:pass@cdn.example/logo.png"],
    ["絶対 URI でない", "/logo.png"],
  ])("不正な logo_url（%s）は登録されない", async (_name, logoUrl) => {
    // `redirect_uri` ほどの危険はないが、**同意画面と管理画面に描かれる**値
    // なので素通しにしない（`domain/services/logo-url.ts`）。
    const admin = await seedAdmin();

    const result = await rpc.createOAuthClient({
      sessionToken: admin.sessionToken,
      name: "ロゴが怪しい",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
      logoUrl,
    });

    expect(!result.ok && result.error.code).toBe("invalid_input");
    expect(await db().select().from(oauthClients).all()).toHaveLength(0);
  });

  it("https の logo_url は通る", async () => {
    const admin = await seedAdmin();

    const result = await rpc.createOAuthClient({
      sessionToken: admin.sessionToken,
      name: "ロゴあり",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
      logoUrl: "https://cdn.example/logo.png",
    });

    expect(result.ok && result.value.client.logoUrl).toBe("https://cdn.example/logo.png");
  });

  it("サポート外の scope は拒否される", async () => {
    // 黙って無視すると、クライアントが得たつもりの権限と実際に出る
    // claim がずれる（`domain/services/scope.ts`）。
    const admin = await seedAdmin();

    const result = await createClient(admin, { scopes: ["openid", "admin:all"] });

    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("登録したクライアントは認可フローから引ける形で入る", async () => {
    const admin = await seedAdmin();

    const result = await createClient(admin, {
      redirectUris: ["https://app.example/cb", "https://app.example/cb?tenant=u18"],
      scopes: ["openid", "profile"],
    });
    if (!result.ok) throw new Error("登録に失敗した");

    expect(result.value.client).toMatchObject({
      clientType: "confidential",
      scopes: ["openid", "profile"],
      disabledAt: null,
    });
    // **自動生成された値である。** 呼び出し元は何も指定していない
    // （運用者の判断、2026-10-30）。接頭辞だけ見る —— 生の乱数を
    // 文字列比較しても意味が無い。
    expect(result.value.client.clientId).toMatch(/^app_/);
    // 内部 ID（`cli_...`）は DTO に出さない。出すと、以後それを受け付ける
    // API を消せなくなる。
    expect(JSON.stringify(result.value.client)).not.toContain("cli_");

    const uris = await db().select().from(oauthRedirectUris).all();
    expect(uris.map((row) => row.uri).sort()).toEqual([
      "https://app.example/cb",
      "https://app.example/cb?tenant=u18",
    ]);
  });

  it("この入口から first-party では登録できない", async () => {
    // **「クライアントを登録できる」と「同意を省略できる」は別の権限**で、
    // 後者のほうが重い（脅威モデル T-1 は「ファーストパーティなので同意
    // 画面が出ず、被害者が気づかない」を攻撃の前提にしている）。1 つの口に
    // まとめると、管理者アカウント 1 つの乗っ取りで同意の省略まで取れる。
    // 一次パーティの登録は `oauth-client.mjs --first-party` だけに残す。
    const admin = await seedAdmin();

    const result = await createClient(admin);
    if (!result.ok) throw new Error("登録に失敗した");

    expect(result.value.client.isFirstParty).toBe(false);
    // DB の行でも確かめる。DTO だけ見ると、列に true が入っていても
    // 写し取りが落としているだけ、という形を見逃す。
    const row = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, result.value.client.clientId))
      .get();
    expect(row?.isFirstParty).toBe(false);
  });

  it("isFirstParty は契約の入力に存在しない（型で落ちる）", async () => {
    // 項目を残して「既定 false」にすると、次に見た人が「渡せば立つ」と
    // 読んで立てる。**契約から外してあること**をここで固定する ——
    // 入力に足し直すと、この `@ts-expect-error` が「未使用」で落ちる。
    const admin = await seedAdmin();

    const result = await rpc.createOAuthClient({
      sessionToken: admin.sessionToken,
      name: "一次パーティのつもり",
      clientType: "public",
      redirectUris: ["https://app.example/cb"],
      // @ts-expect-error createOAuthClientInputSchema に isFirstParty は無い
      isFirstParty: true,
    });
    if (!result.ok) throw new Error("登録に失敗した");

    // zod が未知のキーを落とすので、実行時にも立たない。
    expect(result.value.client.isFirstParty).toBe(false);
  });
});

/**
 * 再認証（#308 / 仕様書 8.1）。
 *
 * **盗んだセッション Cookie 1 枚で通させない。** 登録が決めるのは
 * **認可コードの宛先**で、攻撃者が自分の `redirect_uri` を登録できると、
 * Redirect URI の完全一致検証（脅威モデル T-1）を**登録の側から迂回**
 * できる。失効の側も、正規のクライアントを黙って止める手口になる。
 *
 * 窓は `deletePasskey` / username 変更と同じ 5 分
 * （`domain/services/reauthentication.ts`）。
 */
describe("登録と失効には再認証が要る", () => {
  it("古いセッションの管理者は登録できない（行も増えない）", async () => {
    const admin = await seedAdmin({ authTime: STALE });

    const result = await createClient(admin);

    expect(!result.ok && result.error.code).toBe("reauthentication_required");
    expect(await db().select().from(oauthClients).all()).toHaveLength(0);
  });

  it("古いセッションの管理者は失効させられない", async () => {
    const fresh = await seedAdmin();
    const created = await createClient(fresh);
    if (!created.ok) throw new Error("登録に失敗した");
    const stale = await seedAdmin({ authTime: STALE });

    const result = await rpc.disableOAuthClient({
      sessionToken: stale.sessionToken,
      clientId: created.value.client.clientId,
    });

    expect(!result.ok && result.error.code).toBe("reauthentication_required");
    const row = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, created.value.client.clientId))
      .get();
    expect(row?.disabledAt).toBeNull();
  });

  it("管理者でない古いセッションには not_found を返す（順序が逆でないこと）", async () => {
    // **再認証を先に見ると、一般利用者に `reauthentication_required` が
    // 返る** —— 「ログインし直せば通る何かがある」と伝わり、`not_found` に
    // 畳んだ意味が消える。管理者判定が先であることをここで固定する。
    const user = await seedLoggedInUser({ authTime: STALE });

    const result = await createClient(user);

    expect(!result.ok && result.error.code).toBe("not_found");
  });

  it("再認証の失敗も監査に残る", async () => {
    const admin = await seedAdmin({ authTime: STALE });

    await createClient(admin);

    const rows = await auditRows("oauth.client.created");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failure", reason: "stale_authentication" });
  });
});

describe("listOAuthClients", () => {
  it("失効済みも含めて返す", async () => {
    // 除くと、失効させた直後に行が消える。運用者は「失効したのか、
    // 消えたのか、そもそも無かったのか」を区別できない。
    const admin = await seedAdmin();
    const alive = await createClient(admin, { name: "生きている方" });
    const dead = await createClient(admin, { name: "止める方" });
    if (!alive.ok || !dead.ok) throw new Error("登録に失敗した");
    await rpc.disableOAuthClient({
      sessionToken: admin.sessionToken,
      clientId: dead.value.client.clientId,
    });

    const result = await rpc.listOAuthClients({ sessionToken: admin.sessionToken });
    if (!result.ok) throw new Error("一覧を取れなかった");

    const byId = new Map(result.value.map((client) => [client.clientId, client]));
    expect([...byId.keys()].sort()).toEqual(
      [alive.value.client.clientId, dead.value.client.clientId].sort(),
    );
    expect(byId.get(alive.value.client.clientId)?.disabledAt).toBeNull();
    expect(byId.get(dead.value.client.clientId)?.disabledAt).toEqual(expect.any(String));
  });

  it("Redirect URI を持たないクライアントも落ちない", async () => {
    // `oauth-client.mjs` 以外の経路（直接 SQL など）で入った行もある。
    // left join の畳み込みがそこで壊れないこと。
    const admin = await seedAdmin();
    await db()
      .insert(oauthClients)
      .values({
        id: "cli_no_uri",
        clientId: "u18-legacy",
        name: "宛先の無い古い行",
        clientType: "public",
        clientSecretHash: null,
        allowedScopes: "openid",
        isFirstParty: false,
        logoUrl: null,
      })
      .run();

    const result = await rpc.listOAuthClients({ sessionToken: admin.sessionToken });

    expect(result.ok && result.value).toHaveLength(1);
    expect(result.ok && result.value[0]?.redirectUris).toEqual([]);
  });
});

describe("disableOAuthClient", () => {
  it("失効は冪等で、2 度目は時刻を上書きしない", async () => {
    const admin = await seedAdmin();
    const created = await createClient(admin);
    if (!created.ok) throw new Error("登録に失敗した");
    const clientId = created.value.client.clientId;

    const first = await rpc.disableOAuthClient({ sessionToken: admin.sessionToken, clientId });
    const disabledAt = (
      await db().select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).get()
    )?.disabledAt;

    const second = await rpc.disableOAuthClient({ sessionToken: admin.sessionToken, clientId });

    expect(first.ok && first.value.disabled).toBe(true);
    expect(second.ok && second.value.disabled).toBe(false);
    const after = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .get();
    expect(after?.disabledAt?.toISOString()).toBe(disabledAt?.toISOString());
  });

  it("一次パーティのクライアントは失効させられない", async () => {
    // **登録の側で `is_first_party` を受け取らないのと対称。** 作れない
    // ものを止められると、管理者 1 人で `u18-dashboard` を失効させ、
    // u18 全サービスのログインを落とせる。止める経路は CLI に残す。
    const admin = await seedAdmin();
    await db()
      .insert(oauthClients)
      .values({
        id: "cli_first_party",
        clientId: "u18-dashboard",
        name: "u18 Dashboard",
        clientType: "confidential",
        clientSecretHash: await hasher.hash("secret"),
        allowedScopes: "openid profile email",
        isFirstParty: true,
        logoUrl: null,
      })
      .run();

    const result = await rpc.disableOAuthClient({
      sessionToken: admin.sessionToken,
      clientId: "u18-dashboard",
    });

    expect(!result.ok && result.error.code).toBe("conflict");
    const row = await db()
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, "u18-dashboard"))
      .get();
    expect(row?.disabledAt).toBeNull();
  });

  it("未登録の client_id も「失効済み」と同じ応答に畳む", async () => {
    // 区別すると、どの client_id が登録済みかを総当たりで調べられる。
    const admin = await seedAdmin();

    const result = await rpc.disableOAuthClient({
      sessionToken: admin.sessionToken,
      clientId: "u18-never-existed",
    });

    expect(result.ok && result.value.disabled).toBe(false);
  });
});

/**
 * 監査ログ（#22 / #308）。
 *
 * **保持区分を必ず見る。** 指定が無いと `standard`（180 日）に落ちる。
 * 支配権が変わる操作なのに半年で消えるのは `ops.admin.granted` が
 * 長らく踏んでいた形そのもの（#270）で、区分を書き換えても
 * **どのテストも落ちない**状態には戻さない。
 */
describe("監査ログ", () => {
  it.each(["oauth.client.created", "oauth.client.disabled"] as const)(
    "%s は standard に落ちていない",
    (event) => {
      expect(AUDIT_EVENT_RETENTION[event]).toEqual({ sink: "d1", retention: "security" });
    },
  );

  it("登録が success として残り、宛先も記録される", async () => {
    const admin = await seedAdmin();

    const result = await createClient(admin);
    if (!result.ok) throw new Error("登録に失敗した");

    const rows = await auditRows("oauth.client.created");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "success",
      userId: admin.userId,
      // 呼び出し元 Worker が `actor` に乗る（帰属であって認証ではない）。
      actor: "dashboard-worker",
    });
    // 増えたのは「認可コードを受け取ってよい場所」なので、調べるときに
    // 要るのは URI の側である。
    expect(JSON.stringify(rows[0]?.metadata)).toContain("https://app.example/cb");
    // 秘密とそのハッシュは入れない。
    expect(JSON.stringify(rows[0])).not.toContain(result.value.clientSecret);
    expect(JSON.stringify(rows[0])).not.toContain(await hasher.hash(result.value.clientSecret!));
  });

  it("失効が記録され、2 度目は失敗として残る", async () => {
    const admin = await seedAdmin();
    const created = await createClient(admin);
    if (!created.ok) throw new Error("登録に失敗した");
    const clientId = created.value.client.clientId;

    await rpc.disableOAuthClient({ sessionToken: admin.sessionToken, clientId });
    await rpc.disableOAuthClient({ sessionToken: admin.sessionToken, clientId });

    const rows = await auditRows("oauth.client.disabled");
    expect(rows.map((row) => row.outcome)).toEqual(["success", "failure"]);
    expect(rows[1]?.reason).toBe("already_disabled_or_unknown");
  });

  /**
   * **拒否では `audit_logs` の行が増えない**（#308 / #21 と同じ構図）。
   *
   * RPC 経路にレート制限は無いので、有効なセッションを持つ相手が呼び続け
   * られる。拒否のたびに 1 行書くと、**弾くこと自体が D1 への書き込みに
   * 変換される** —— しかも `security` 区分なら 2 年残る。
   *
   * コメントで「書かない」と宣言するだけでは守られない（RR-16）。
   * `requireAdminSession` に `audit.record` を 1 行足すと、ここが落ちる。
   */
  it.each([
    ["listOAuthClients", (u: SeededUser) => rpc.listOAuthClients({ sessionToken: u.sessionToken })],
    ["createOAuthClient", (u: SeededUser) => createClient(u)],
    [
      "disableOAuthClient",
      (u: SeededUser) =>
        rpc.disableOAuthClient({ sessionToken: u.sessionToken, clientId: "u18-whatever" }),
    ],
  ])("%s の拒否は audit_logs に行を作らない", async (_name, invoke) => {
    const user = await seedLoggedInUser();

    await invoke(user);
    await invoke(user);
    await invoke(user);

    expect(await db().select().from(auditLogs).all()).toHaveLength(0);
  });

  it("拒否は admin.denied として Workers のログへ出る（痕跡は消さない）", async () => {
    // 応答は `not_found` に畳むので、**叩かれたことはこのログにしか
    // 現れない。** 書き込みの増幅を避けつつ記録は残す、という形の両輪。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await seedLoggedInUser();

    await createClient(user, { name: "攻撃者が入れた名前" });

    const lines = warn.mock.calls.map(([first]) => String(first));
    const denied = lines.map((line) => JSON.parse(line)).filter((e) => e.event === "admin.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ operation: "createOAuthClient", userId: user.userId });
    // **呼び出し元が決めた文字列は出さない。** `client_id` は #333 で
    // 自動生成になったので、ここで注入を試せるのは `name` だけになった
    // （ログの中身を攻撃者に決めさせない）。拒否は `requireAdminSession`
    // の中で起きるので、そもそも `name` まで読まれていないはずである。
    expect(lines.join(" ")).not.toContain("攻撃者が入れた名前");
  });
});

/**
 * **束縛を分けたこと自体を固定する**（#308）。
 *
 * Service Binding はメソッド単位で絞れない。管理用メソッドが
 * `IdentityRPC` にも生えていたら、`IdentityRPC` を束縛している
 * **nfc-worker から呼べる** —— あちらは設計上、管理者のセッション
 * トークンを扱う Worker である（#187）。
 *
 * 誰がどちらの Entrypoint を束縛してよいかは
 * `scripts/check-service-bindings.mjs` が静的に見ている。ここで見るのは
 * 「分けた結果、実際に生えていないこと」。
 */
describe("IdentityRPC には管理用メソッドが生えていない", () => {
  it.each(["listOAuthClients", "createOAuthClient", "disableOAuthClient"] as const)(
    "%s を持たない",
    (method) => {
      const identity = new IdentityRPC(createExecutionContext(), appEnv()) as unknown as Record<
        string,
        unknown
      >;

      expect(identity[method]).toBeUndefined();
    },
  );
});
