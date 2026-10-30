import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./helpers";
import {
  appEnv,
  authorize,
  authorizeQuery,
  BASE,
  createPkcePair,
  fetchApp,
  locationParams,
  ORIGIN,
  seedClient,
  seedLoggedInUser,
  seedSigningKey,
  sessionCookie,
  tokenRequest,
  type PkcePair,
  type SeededUser,
  type SigningKey,
} from "./helpers.oauth";

/**
 * `amr` / `acr` / `acr_values`（#390、決定 8 の書き換え）。
 *
 * ## これまでとどう違うか
 *
 * 決定 8 はいま auth-worker 自身が強制している（`User.actsAsAdminWith`、
 * #337 / RR-5）。`admin.under18.dev` のような別ホストの RP は auth-worker の
 * 生のセッションを読めないので、**材料（`amr` / `acr`）を ID Token に出す**
 * ところまでが auth-worker の役目になる。要求するかどうかは RP が決める。
 *
 * ## ここでしか確かめられないこと
 *
 * 1. **`amr` は常に出る**（`auth_time` と同じ base claim）が、**`acr` は
 *    u18 の定義する水準を満たしたときだけ**出る
 * 2. **`acr_values` は要求であって必須ではない。** 満たせなくても
 *    （`prompt=none` と組まない限り）要求自体は拒否しない —— 対話で
 *    済ませられる場合に拒否すると「ログインしたのに弾かれた」になる
 * 3. **`prompt=none` と組んだときだけ、満たせなければ
 *    `unmet_authentication_requirements`** で即座に返す
 * 4. **知らない `acr_values` は無視する。** 他の IdP 向けの値を渡しても
 *    ログインを妨げない
 */

const CLIENT = {
  clientId: "u18-acr-test",
  secret: "dev-only-secret",
  redirectUri: "http://localhost:8790/cb",
} as const;

const ISSUER = ORIGIN;

let signingKey: SigningKey;

async function seedUser(authMethod: "passkey" | "email_otp"): Promise<SeededUser> {
  return seedLoggedInUser({ authMethod });
}

beforeEach(async () => {
  await resetDatabase();
  await seedClient({
    clientId: CLIENT.clientId,
    clientType: "confidential",
    isFirstParty: true,
    secret: CLIENT.secret,
    redirectUris: [CLIENT.redirectUri],
  });
  signingKey = await seedSigningKey();
});

function query(pkce: PkcePair, overrides: Record<string, string | undefined> = {}) {
  return authorizeQuery({
    client_id: CLIENT.clientId,
    redirect_uri: CLIENT.redirectUri,
    scope: "openid",
    code_challenge: pkce.challenge,
    ...overrides,
  });
}

function codeFrom(response: Response): string {
  const code = locationParams(response).get("code");
  if (code === null) {
    throw new Error(
      `コードが得られなかった: ${response.status} ${response.headers.get("Location")}`,
    );
  }
  return code;
}

async function exchangeForIdToken(code: string, pkce: PkcePair): Promise<JWTPayload> {
  const response = await tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: CLIENT.clientId,
      client_secret: CLIENT.secret,
      redirect_uri: CLIENT.redirectUri,
      code,
      code_verifier: pkce.verifier,
    },
    { env: appEnv(signingKey) },
  );
  expect(response.status, "トークン交換に失敗した").toBe(200);
  const body = (await response.json()) as { id_token: string };

  const jwksResponse = await fetchApp(
    new Request(`${BASE}/.well-known/jwks.json`),
    appEnv(signingKey),
  );
  const jwks = createLocalJWKSet((await jwksResponse.json()) as JSONWebKeySet);
  const { payload } = await jwtVerify(body.id_token, jwks, {
    issuer: ISSUER,
    audience: CLIENT.clientId,
  });
  return payload;
}

describe("amr（常に出る base claim）", () => {
  it("passkey セッションでは amr: ['swk']", async () => {
    const user = await seedUser("passkey");
    const pkce = await createPkcePair();
    const authorized = await authorize(query(pkce), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    const claims = await exchangeForIdToken(codeFrom(authorized), pkce);

    expect(claims["amr"]).toEqual(["swk"]);
  });

  it("email_otp セッションでは amr: ['otp']", async () => {
    const user = await seedUser("email_otp");
    const pkce = await createPkcePair();
    const authorized = await authorize(query(pkce), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    const claims = await exchangeForIdToken(codeFrom(authorized), pkce);

    expect(claims["amr"]).toEqual(["otp"]);
  });
});

describe("acr（u18 の定義する水準を満たしたときだけ出る）", () => {
  it("passkey セッションでは acr: 'passkey'", async () => {
    const user = await seedUser("passkey");
    const pkce = await createPkcePair();
    const authorized = await authorize(query(pkce), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    const claims = await exchangeForIdToken(codeFrom(authorized), pkce);

    expect(claims["acr"]).toBe("passkey");
  });

  it("email_otp セッションでは acr の claim 自体が無い", async () => {
    // **「u18 に acr という概念が無い」と「満たさなかった」を区別しない。**
    // RP がすることはどちらでも同じ（信用しない）。
    const user = await seedUser("email_otp");
    const pkce = await createPkcePair();
    const authorized = await authorize(query(pkce), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    const claims = await exchangeForIdToken(codeFrom(authorized), pkce);

    expect("acr" in claims).toBe(false);
  });

  it("acr_values を要求しなくても acr は出る（RP の要求とは独立）", async () => {
    // acr は「満たした事実」を答えるだけで、要求されたかどうかに左右されない。
    const user = await seedUser("passkey");
    const pkce = await createPkcePair();
    const authorized = await authorize(query(pkce), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    const claims = await exchangeForIdToken(codeFrom(authorized), pkce);

    expect(claims["acr"]).toBe("passkey");
  });
});

describe("acr_values は要求であって必須ではない", () => {
  it("満たせなくても、対話で済む場合は拒否しない（amr/acr が無いだけ）", async () => {
    // **ここが「IdP が強制する」との違い。** 満たせない要求を即座に拒否すると
    // 「ログインしたのに弾かれた」になる。RP 側（ID Token の acr の有無）に
    // 委ねる。
    const user = await seedUser("email_otp");
    const pkce = await createPkcePair();
    const authorized = await authorize(query(pkce, { acr_values: "passkey" }), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    expect(authorized.status).toBe(303);
    expect(locationParams(authorized).get("code")).toBeTruthy();

    const claims = await exchangeForIdToken(codeFrom(authorized), pkce);
    expect("acr" in claims).toBe(false);
  });

  it("知らない acr_values は無視する（他の IdP 向けの値でも落ちない）", async () => {
    const user = await seedUser("email_otp");
    const pkce = await createPkcePair();
    const authorized = await authorize(query(pkce, { acr_values: "urn:something:unrelated" }), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    expect(authorized.status).toBe(303);
    expect(locationParams(authorized).get("code")).toBeTruthy();
  });
});

describe("prompt=none と組んだときだけ、満たせなければ即座に拒否する", () => {
  it("passkey セッションなら prompt=none でも通る", async () => {
    const user = await seedUser("passkey");
    const pkce = await createPkcePair();
    const authorized = await authorize(query(pkce, { acr_values: "passkey", prompt: "none" }), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    expect(authorized.status).toBe(303);
    expect(locationParams(authorized).get("code")).toBeTruthy();
  });

  it("email_otp セッションでは unmet_authentication_requirements を返す", async () => {
    const user = await seedUser("email_otp");
    const pkce = await createPkcePair();
    const response = await authorize(query(pkce, { acr_values: "passkey", prompt: "none" }), {
      cookie: sessionCookie(user),
      env: appEnv(signingKey),
    });

    expect(response.status).toBe(303);
    expect(locationParams(response).get("error")).toBe("unmet_authentication_requirements");
    // 対話なしで済ませる要求なので、エラー画面ではなく RP の redirect_uri へ返す。
    expect(response.headers.get("Location")).toContain(CLIENT.redirectUri);
  });

  it("セッションが無ければ、acr とは無関係にいつもどおり login_required", async () => {
    // **順序の確認。** needsFreshLogin の判定が acr の判定より先に効く。
    const pkce = await createPkcePair();
    const response = await authorize(query(pkce, { acr_values: "passkey", prompt: "none" }), {
      env: appEnv(signingKey),
    });

    expect(response.status).toBe(303);
    expect(locationParams(response).get("error")).toBe("login_required");
  });
});

describe("Discovery", () => {
  it("acr_values_supported と claims_supported に出る", async () => {
    const response = await fetchApp(
      new Request(`${BASE}/.well-known/openid-configuration`),
      appEnv(signingKey),
    );
    const body = (await response.json()) as {
      acr_values_supported: string[];
      claims_supported: string[];
    };

    expect(body.acr_values_supported).toEqual(["passkey"]);
    expect(body.claims_supported).toContain("amr");
    expect(body.claims_supported).toContain("acr");
  });
});
