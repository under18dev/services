import { newClientId } from "@u18/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthenticateOAuthClientUseCase } from "../src/application/use-cases/authenticate-oauth-client.use-case";
import { ResolveOAuthClientUseCase } from "../src/application/use-cases/resolve-oauth-client.use-case";
import type { OAuthClientProps } from "../src/domain/entities/oauth-client";
import { InMemoryOAuthClientRepository } from "./fakes.oauth";
import { RecordingAuditLogger } from "./fakes";

const CONFIDENTIAL_SECRET = "s3cr3t-value";

function aClientProps(overrides: Partial<OAuthClientProps> = {}): OAuthClientProps {
  return {
    id: newClientId(),
    clientId: "u18-dashboard",
    name: "u18 Dashboard",
    clientType: "confidential",
    allowedScopes: "openid profile email",
    isFirstParty: true,
    logoUrl: null,
    disabledAt: null,
    redirectUris: ["https://app.example/cb"],
    createdAt: new Date("2026-10-24T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ResolveOAuthClientUseCase", () => {
  let clients: InMemoryOAuthClientRepository;
  let audit: RecordingAuditLogger;
  let useCase: ResolveOAuthClientUseCase;

  beforeEach(() => {
    clients = new InMemoryOAuthClientRepository();
    audit = new RecordingAuditLogger();
    useCase = new ResolveOAuthClientUseCase({ clients, audit });
  });

  it("登録済みのクライアントと Redirect URI を解決する", async () => {
    clients.seed(aClientProps());

    const result = await useCase.execute({
      clientId: "u18-dashboard",
      redirectUri: "https://app.example/cb",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.client.clientId).toBe("u18-dashboard");
    expect(result.value.redirectUri).toBe("https://app.example/cb");
  });

  it("未知の client_id は invalid_client", async () => {
    const result = await useCase.execute({
      clientId: "nope",
      redirectUri: "https://app.example/cb",
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_client", message: "client is not available" },
    });
  });

  it("失効済みのクライアントは即座に拒否する", async () => {
    clients.seed(aClientProps({ disabledAt: new Date("2026-10-23T00:00:00.000Z") }));

    const result = await useCase.execute({
      clientId: "u18-dashboard",
      redirectUri: "https://app.example/cb",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 未知の client_id と同じコード。区別は監査ログにだけ残す。
    expect(result.error.code).toBe("invalid_client");
    expect(audit.events[0]?.reason).toBe("client_disabled");
  });

  it("未登録の Redirect URI は invalid_redirect_uri（リダイレクトしてはならない）", async () => {
    clients.seed(aClientProps());

    const result = await useCase.execute({
      clientId: "u18-dashboard",
      redirectUri: "https://app.example/cb?x=1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_redirect_uri");
  });

  it("監査ログに redirect_uri の生文字列を残さない", async () => {
    clients.seed(aClientProps());

    await useCase.execute({
      clientId: "u18-dashboard",
      redirectUri: "https://evil.test/steal",
    });

    expect(JSON.stringify(audit.events)).not.toContain("evil.test");
  });
});

describe("AuthenticateOAuthClientUseCase", () => {
  let clients: InMemoryOAuthClientRepository;
  let audit: RecordingAuditLogger;
  let useCase: AuthenticateOAuthClientUseCase;

  beforeEach(() => {
    clients = new InMemoryOAuthClientRepository();
    audit = new RecordingAuditLogger();
    useCase = new AuthenticateOAuthClientUseCase({ clients, audit });
  });

  it("confidential クライアントは正しい secret で認証できる", async () => {
    clients.seed(aClientProps(), CONFIDENTIAL_SECRET);

    const result = await useCase.execute({
      clientId: "u18-dashboard",
      clientSecret: CONFIDENTIAL_SECRET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clientId).toBe("u18-dashboard");
  });

  it.each([
    ["secret が違う", "wrong-secret", "invalid_client_secret"],
    ["secret が無い", null, "missing_client_secret"],
  ])("confidential クライアントで %s なら拒否する", async (_label, secret, reason) => {
    clients.seed(aClientProps(), CONFIDENTIAL_SECRET);

    const result = await useCase.execute({ clientId: "u18-dashboard", clientSecret: secret });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 失敗の理由は外へ出さない。総当たりの手がかりになる。
    expect(result.error.code).toBe("invalid_client");
    expect(audit.events[0]?.reason).toBe(reason);
  });

  it("public クライアントは secret 無しで認証できる", async () => {
    clients.seed(aClientProps({ clientId: "u18-e2e", clientType: "public", isFirstParty: false }));

    const result = await useCase.execute({ clientId: "u18-e2e", clientSecret: null });
    expect(result.ok).toBe(true);
  });

  it("public クライアントが secret を提示したら拒否する", async () => {
    clients.seed(aClientProps({ clientId: "u18-e2e", clientType: "public", isFirstParty: false }));

    const result = await useCase.execute({ clientId: "u18-e2e", clientSecret: "anything" });

    expect(result.ok).toBe(false);
    expect(audit.events[0]?.reason).toBe("secret_presented_by_public_client");
  });

  it("失効済みのクライアントは正しい secret でも拒否する", async () => {
    clients.seed(
      aClientProps({ disabledAt: new Date("2026-10-23T00:00:00.000Z") }),
      CONFIDENTIAL_SECRET,
    );

    const result = await useCase.execute({
      clientId: "u18-dashboard",
      clientSecret: CONFIDENTIAL_SECRET,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_client");
  });

  it("未知の client_id は invalid_client", async () => {
    const result = await useCase.execute({ clientId: "nope", clientSecret: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_client");
  });

  it("失敗応答に client_secret を含めない", async () => {
    clients.seed(aClientProps(), CONFIDENTIAL_SECRET);

    const result = await useCase.execute({
      clientId: "u18-dashboard",
      clientSecret: "guessed-secret",
    });

    expect(JSON.stringify(result)).not.toContain("guessed-secret");
    expect(JSON.stringify(audit.events)).not.toContain("guessed-secret");
  });
});
