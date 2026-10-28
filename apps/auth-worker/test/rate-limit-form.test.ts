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
 *
 * ## ここの `limit` は **miniflare に対してだけ**厳密である（#236）
 *
 * 下のテストは `RateLimitPolicy.email_start.limit` 本を撃って「そこまでは
 * 通り、次が 429」という形で書いてある。**本番では成り立たない。**
 * Cloudflare の Rate Limiting API は近似・コロ単位・非同期で、実測では
 * 同一 60 秒窓に **45 本**通った（ランブック §13.2）。
 *
 * **このファイルが固定しているのは「form 経路にも制限が掛かっていること」
 * と「429 を画面で返すこと」と「どの順序で判定するか」であって、上限の値
 * ではない。** とくに「`limit` 本までは 429 が 1 つも混ざらない」形の
 * assert は、**本番で同じ測り方をすると意味が変わる** —— 近似のせいで
 * `limit` を超えても混ざらないことがあり、通ったことが順序の証拠にならない。
 * 順序を見たいなら本番ではなくここで見ること。
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
