import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { RateLimitPolicy } from "../src/domain/services/rate-limit-policy";
import { resetDatabase } from "./helpers";

/**
 * form 経路の IP レート制限。
 *
 * ## なぜ別の経路として見るのか
 *
 * **同じ `StartEmailOtpUseCase` を呼ぶ入口が 2 つあり、鍵が掛かっていたのは
 * JSON 側だけだった。** `/api/auth/email/start` は `enforceIpRateLimit` を
 * 通るが、`/signup/start` は通っていなかった。
 *
 * 影響が大きいのは **signup** 側である。`shouldSend` が
 * `purpose === "signup" ? user === null : user?.isActive === true` なので、
 * **signup は未登録のアドレスへ送る** —— 宛先を変えながら 1 IP から
 * 無制限に OTP メールを出せていた。
 *
 * `login` は登録済みアドレスにしか送らないので無害だったが、**無害である
 * 理由が `shouldSend` の実装に依存している**ので同じく掛ける。
 *
 * ランブック §13.2 が `RL_EMAIL_START` を 10 に置いた根拠は「1 通送るのに
 * 1 回」で、その根拠が form 側でそのまま迂回されていた。
 */

const BASE = "http://localhost";
const ORIGIN = "http://localhost:8787";

let ipCounter = 0;
const freshIp = (): string => `203.0.113.${(ipCounter += 1) % 250}`;

/** `/signup` を開いて Cookie と CSRF トークンを取る。 */
async function openPage(path: string): Promise<{ cookie: string; csrf: string }> {
  const response = await SELF.fetch(`${BASE}${path}`);
  const html = await response.text();
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) throw new Error("CSRF トークンが描画されていない");
  const cookie = response.headers
    .getSetCookie()
    .map((raw) => raw.split(";")[0] ?? "")
    .join("; ");
  return { cookie, csrf: match[1] };
}

function submit(
  path: string,
  fields: Record<string, string>,
  cookie: string,
  ip: string,
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": ip,
      Cookie: cookie,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(resetDatabase);

describe("form からの OTP 送信にも IP 制限が掛かる", () => {
  const { limit, periodSeconds } = RateLimitPolicy.email_start;

  it("宛先を変えても上限で止まる（メール爆撃を止める）", async () => {
    // **宛先を毎回変える。** use case 側の再送クールダウンはアドレス単位
    // なので、変えれば効かない。IP 制限でしか止まらない形を再現する。
    const ip = freshIp();
    const page = await openPage("/signup");

    for (let i = 0; i < limit; i += 1) {
      const response = await submit(
        "/signup/start",
        { email: `victim${i}@example.test`, csrf_token: page.csrf },
        page.cookie,
        ip,
      );
      expect(response.status, `${i + 1} 回目は通るはず`).toBe(200);
    }

    const blocked = await submit(
      "/signup/start",
      { email: "victim-last@example.test", csrf_token: page.csrf },
      page.cookie,
      ip,
    );
    expect(blocked.status).toBe(429);
  });

  it("429 は JSON ではなく画面で返す", async () => {
    // form 送信の応答は画面なので、生の JSON が出ると何が起きたか分からない。
    const ip = freshIp();
    const page = await openPage("/signup");
    for (let i = 0; i < limit; i += 1) {
      await submit(
        "/signup/start",
        { email: `x${i}@example.test`, csrf_token: page.csrf },
        page.cookie,
        ip,
      );
    }

    const blocked = await submit(
      "/signup/start",
      { email: "y@example.test", csrf_token: page.csrf },
      page.cookie,
      ip,
    );
    expect(blocked.headers.get("Content-Type")).toContain("text/html");
    const html = await blocked.text();
    expect(html).toContain("混み合っています");
    // 登録画面のまま返す（ログイン画面に飛ばさない）。
    expect(html).toContain('action="/signup/start"');
  });

  it("CSRF に落ちる要求は枠を消費しない（攻撃者が被害者を締め出せない）", async () => {
    /**
     * **制限は CSRF 判定の「後」に置く。** この順序がこのテストの対象である。
     *
     * クロスサイトから撃たれた form 送信は**被害者のブラウザから出る**ので、
     * 被害者の IP で届く。制限を CSRF より前に置くと、攻撃者はトークンを
     * 持たない要求を撃つだけで**被害者の枠を使い切り、締め出せる。**
     *
     * `/oauth/token` は逆に**クライアント認証より前**に置いている
     * （ランブック §13.2）。あちらは守りたい資源が照合の計算そのもので、
     * かつ「他人の枠」という概念が無い。原則としてはこう言える ——
     * **制限は高価な処理の前に、かつ「攻撃者の要求と被害者の要求を
     * 見分ける検査」の後ろに置く。**
     *
     * **この順序はこれまで偶然固定されていた。** `signup.ui.test.ts` の
     * CSRF テストが落ちることで気づける状態だったが、それはあの
     * ファイルが `CF-Connecting-IP` を設定せず全テストが既定の IP を
     * 共有していたからで、**IP を分けた瞬間に固定が消える。**
     * ここでは `freshIp()` を使って、偶然に頼らず order を固定する。
     */
    const ip = freshIp();
    const page = await openPage("/signup");

    // 上限の 2 倍を撃っても、すべて CSRF で落ちること。
    for (let i = 0; i < limit * 2; i += 1) {
      const response = await submit(
        "/signup/start",
        { email: `attacker${i}@example.test` },
        page.cookie,
        ip,
      );
      expect(response.status, `${i + 1} 回目は CSRF の 403 であるべき`).toBe(403);
    }

    // **被害者自身の正規の送信は、まだ通らなければならない。**
    // ここが 429 になるなら、攻撃者が被害者を締め出せている。
    const legit = await submit(
      "/signup/start",
      { email: "victim@example.test", csrf_token: page.csrf },
      page.cookie,
      ip,
    );

    expect(legit.status).toBe(200);
  });

  it("Retry-After が付く", async () => {
    const ip = freshIp();
    const page = await openPage("/signup");
    for (let i = 0; i < limit; i += 1) {
      await submit(
        "/signup/start",
        { email: `z${i}@example.test`, csrf_token: page.csrf },
        page.cookie,
        ip,
      );
    }

    const blocked = await submit(
      "/signup/start",
      { email: "w@example.test", csrf_token: page.csrf },
      page.cookie,
      ip,
    );
    expect(blocked.headers.get("Retry-After")).toBe(String(periodSeconds));
  });

  it("ログイン側の form にも掛かる", async () => {
    // いまは shouldSend のおかげで送信は起きないが、**無害である理由が
    // 実装に依存している**ので、入口ごとに守りを変えない。
    const ip = freshIp();
    const page = await openPage("/login");
    for (let i = 0; i < limit; i += 1) {
      await submit(
        "/login/start",
        { email: `a${i}@example.test`, csrf_token: page.csrf },
        page.cookie,
        ip,
      );
    }

    const blocked = await submit(
      "/login/start",
      { email: "b@example.test", csrf_token: page.csrf },
      page.cookie,
      ip,
    );
    expect(blocked.status).toBe(429);
  });

  it("別の IP は別の枠を持つ", async () => {
    const page = await openPage("/signup");
    const attacker = freshIp();
    for (let i = 0; i < limit; i += 1) {
      await submit(
        "/signup/start",
        { email: `c${i}@example.test`, csrf_token: page.csrf },
        page.cookie,
        attacker,
      );
    }

    const victim = await submit(
      "/signup/start",
      { email: "d@example.test", csrf_token: page.csrf },
      page.cookie,
      freshIp(),
    );
    expect(victim.status, "1 人が詰まらせても他を巻き込まない").toBe(200);
  });
});
