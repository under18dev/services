import { SELF, env } from "cloudflare:test";
import { auditLogs, createIdentityDatabase, emailChallenges, users } from "@u18/db";
import { newId } from "@u18/domain";
import { aUser } from "@u18/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { Sha256TokenHasher } from "../src/infrastructure/crypto/web-crypto";
import { DrizzleSessionRepository } from "../src/infrastructure/persistence/drizzle-session.repository";
import { resetDatabase } from "./helpers";

/**
 * 監査ログに秘密が入らないことを、実際に書かれた行を走査して確かめる（#22）。
 *
 * `AuditEvent.metadata` のコメントは「秘密を入れない」と書いているが、
 * **コメントは守られているかどうかを教えてくれない。** 入れてしまっても
 * 型検査もテストも通り、気づくのは D1 が漏れたときになる。
 *
 * ## やり方
 *
 * 秘密の形をした値（セッショントークン・メールアドレス・OTP・
 * client_secret・生 IP など）を**こちらから送り込み**、本物の HTTP 経路を
 * 通してから `audit_logs` を全件走査する。送った値が 1 つでも行の中に
 * 現れたら落とす。
 *
 * 値は正しくなくてよい。**拒否される経路こそ秘密を書きやすい**
 * （「何が来たか」を残したくなる）ので、むしろ失敗側を厚く通している。
 *
 * ## 空振りを防ぐ
 *
 * 行が 1 件も書かれていなければ、この検査は何も言っていないのと同じになる。
 * 走査の前に「行が書かれていること」と「複数種類のイベントが出ていること」
 * を確かめている。経路を増やすときもここを一緒に見ること。
 */

const ORIGIN = "http://localhost:8787";

/** 送り込む値。どれも `audit_logs` に現れてはいけない。 */
const SECRETS = {
  sessionToken: "session-token-leakprobe-aaaaaaaa",
  emailLocalPart: "leakprobe",
  otpCode: "135791",
  clientSecret: "client-secret-leakprobe-cccccccc",
  authorizationCode: "authcode-leakprobe-dddddddd",
  accessToken: "accesstoken-leakprobe-eeeeeeee",
  rawIp: "198.51.100.77",
} as const;

const EMAIL = `${SECRETS.emailLocalPart}@example.com`;
const user = aUser({ email: EMAIL });
const SESSION_ID = "ses_leakprobe";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Origin: ORIGIN, "CF-Connecting-IP": SECRETS.rawIp, ...extra };
}

const cookie = `u18_session=${SECRETS.sessionToken}`;

function json(path: string, body: unknown, extra: Record<string, string> = {}) {
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", ...extra }),
    body: JSON.stringify(body),
  });
}

function form(path: string, fields: Record<string, string>) {
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams(fields).toString(),
  });
}

describe("監査ログに秘密が残らない", () => {
  let rows: unknown[];

  beforeAll(async () => {
    await resetDatabase();
    const db = createIdentityDatabase(env.IDENTITY_DB);

    await db
      .insert(users)
      .values({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        primaryEmail: user.email,
        emailVerified: true,
      })
      .run();

    // 本物と同じく、DB にはハッシュだけを入れる。平文はこちらが握っている。
    await new DrizzleSessionRepository(db).create({
      id: SESSION_ID,
      userId: user.id,
      tokenHash: await new Sha256TokenHasher().hash(SECRETS.sessionToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      authMethod: "email_otp",
      userAgent: "vitest",
      ipHash: null,
    });

    // ログインを 1 回**成功させる**。
    //
    // 失敗だけ通していると、metadata が一番豊かになる成功側（session.issue /
    // otp.verify）を 1 行も走査しないまま通ってしまう。正しいコードは
    // メールでしか届かないので、ハッシュだけこちらで作って行を直接入れる。
    const challengeCode = "246802";
    await db
      .insert(emailChallenges)
      .values({
        id: newId("emc"),
        userId: user.id,
        email: EMAIL,
        codeHash: await new Sha256TokenHasher().hash(challengeCode),
        purpose: "login",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        maxAttempts: 5,
        lastSentAt: new Date(),
      })
      .run();

    const loggedIn = await json("/api/auth/email/verify", {
      email: EMAIL,
      code: challengeCode,
      purpose: "login",
    });
    expect(loggedIn.status, "ログインの成功経路を通せていない").toBe(200);

    // --- 秘密を含むリクエストを本物の経路へ通す ---
    await json("/api/auth/email/start", { email: EMAIL, purpose: "login" });
    await json("/api/auth/email/verify", {
      email: EMAIL,
      code: SECRETS.otpCode,
      purpose: "login",
    });
    await SELF.fetch("http://localhost/api/me", { headers: headers({ Cookie: cookie }) });
    await SELF.fetch(`http://localhost/api/me/sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: headers({ Cookie: cookie }),
    });
    await json("/api/auth/logout", {}, { Cookie: cookie });
    await form("/oauth/token", {
      grant_type: "authorization_code",
      client_id: "cli_audit_test",
      client_secret: SECRETS.clientSecret,
      code: SECRETS.authorizationCode,
      redirect_uri: "https://rp.example/callback",
    });
    await form("/oauth/revoke", {
      client_id: "cli_audit_test",
      client_secret: SECRETS.clientSecret,
      token: SECRETS.accessToken,
    });

    rows = await db.select().from(auditLogs).all();
  });

  it("走査する行がある（この検査が空振りしていない）", () => {
    expect(
      rows.length,
      "audit_logs が空。経路が記録していないか、resetDatabase の順序が違う",
    ).toBeGreaterThan(0);

    const events = new Set(rows.map((row) => (row as { event: string }).event));
    expect(events.size, `出たイベントが少なすぎる: ${[...events].join(", ")}`).toBeGreaterThan(1);
  });

  it.each(Object.entries(SECRETS))("%s が行に現れない", (name, secret) => {
    const found = rows.filter((row) => JSON.stringify(row).includes(secret));

    expect(
      found.map((row) => (row as { event: string }).event),
      `${name} を含む監査ログがある`,
    ).toEqual([]);
  });

  it("メールアドレスは伏せ字で記録される", () => {
    // `otp.verify` は metadata に伏せ字のアドレスを入れている。
    // 伏せ字そのものが無くなると「アドレスを一切残さない」のか
    // 「記録自体が消えた」のか分からなくなるので、存在も確かめる。
    const masked = rows.filter((row) => JSON.stringify(row).includes("@example.com"));

    expect(masked.length, "伏せ字のアドレスが 1 件も無い").toBeGreaterThan(0);
    for (const row of masked) {
      expect(JSON.stringify(row)).toContain("*");
    }
  });

  it("IP はハッシュで記録され、生の値は残らない", () => {
    // 現状 ipHash を持つのは session.issue の成功だけ（#122）。
    // 「1 件も無い」になったら、上のログイン成功経路が壊れたか、
    // issue-session.use-case.ts から ipHash が外れたかのどちらか。
    const withIp = rows.filter((row) => (row as { ipHash: string | null }).ipHash !== null);

    expect(withIp.length, "ipHash を持つ行が 1 件も無い").toBeGreaterThan(0);
    for (const row of withIp) {
      expect((row as { ipHash: string }).ipHash).not.toBe(SECRETS.rawIp);
    }
  });
});
