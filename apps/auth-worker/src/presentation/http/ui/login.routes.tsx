import { pageSecurityHeaders, UI_STYLESHEET } from "@u18/web-ui";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Context } from "hono";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  readSessionCookie,
} from "../session-cookie";
import type { AppBindings } from "../types";
import { LOGIN_ISLAND_PATH, STYLESHEET_PATH } from "./asset-paths";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf, rotateCsrfToken } from "./csrf";
import { LoginPage, type LoginMode, type LoginView } from "./login-page";
import { LOGIN_ISLAND_JS } from "./generated/login-island.bundle";
import { enforceIpRateLimit } from "../rate-limit";
import {
  loginUrlWithReturnTo,
  RETURN_TO_FIELD,
  RETURN_TO_PARAM,
  sanitizeReturnTo,
} from "./return-to";

/**
 * Auth UI のルート（仕様書 14-1 の決定 4 / #36）。
 *
 * ログイン画面を auth-worker 自身から配信する。セッション Cookie を発行する
 * ホストと同一オリジンでなければならないため、別フロントエンドには出さない。
 *
 * 画面は `hono/jsx` のサーバーレンダリングで作り、`navigator.credentials` を
 * 呼ぶ Passkey の部分だけ `hono/jsx/dom` のアイランドにしている。
 * **メール OTP の経路は JS 無しで完結する**（通常の form POST）。認証基盤の
 * ログイン画面が JS の読み込み失敗で丸ごと使えなくなるのを避けるため。
 */
export const uiRoutes = new Hono<AppBindings>();

/**
 * 画面を描く。
 *
 * CSRF トークンの用意をここに集約し、各ハンドラが忘れられないようにする。
 */
function renderLogin(
  c: Context<AppBindings>,
  view: LoginView,
  returnTo: string | null,
  status: ContentfulStatusCode = 200,
  mode: LoginMode = "login",
): Response | Promise<Response> {
  return c.html(
    <LoginPage view={view} csrfToken={ensureCsrfToken(c)} returnTo={returnTo} mode={mode} />,
    status,
  );
}

/**
 * ログイン後の戻り先を読む。
 *
 * **必ず `sanitizeReturnTo` を通す。** クエリからも form からも、利用者（あるいは
 * 利用者にリンクを踏ませた第三者）が任意の文字列を入れられる。素通しすると、
 * u18 のログイン画面から外部サイトへ飛ばすオープンリダイレクトになる
 * （ui/return-to.ts）。
 */
function readReturnTo(c: Context<AppBindings>, form?: FormData): string | null {
  const raw = form === undefined ? c.req.query(RETURN_TO_PARAM) : field(form, RETURN_TO_FIELD);
  return sanitizeReturnTo(raw);
}

/** 壊れた本文で 500 にしない。`formData()` は不正な本文で投げる。 */
async function readForm(c: Context<AppBindings>): Promise<FormData> {
  try {
    return await c.req.raw.formData();
  } catch {
    return new FormData();
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * CSRF 検証に落ちたときの応答。
 *
 * 理由は書かない（トークンが古いのか Origin が違うのかを攻撃者に教えない）。
 * 新しいトークンを載せた入力画面へ戻し、正規の利用者はやり直せるようにする。
 */
function rejectCsrf(
  c: Context<AppBindings>,
  returnTo: string | null,
  /**
   * どちらの画面から来たか。**既定を `login` にしない。**
   *
   * 既定に落とすと、**新規登録で失敗した人がログイン画面に戻されたうえで
   * 「操作を受け付けられませんでした」と言われる。** 自分が何をしようと
   * していたのか分からなくなり、やり直す先も変わってしまう。
   *
   * 省略できないようにして、足した経路が黙って `login` に落ちるのを防ぐ。
   */
  mode: LoginMode,
): Response | Promise<Response> {
  return renderLogin(
    c,
    { kind: "email", email: "", error: "操作を受け付けられませんでした。もう一度お試しください。" },
    returnTo,
    403,
    mode,
  );
}

/**
 * form 経路の IP レート制限。
 *
 * **JSON の 429 をそのまま返さない。** form 送信の応答は画面なので、
 * 生の JSON が出ると利用者には何が起きたか分からない。`enforceIpRateLimit`
 * が立てた `Retry-After` はコンテキストに載っているので、本文だけ
 * 画面に差し替える。
 *
 * **入口ごとに守りが違う状態を残さない。** 同じ `StartEmailOtpUseCase` を
 * 呼ぶ入口が form と JSON の 2 つあり、鍵が掛かっていたのは JSON 側だけ
 * だった。`signup` は未登録のアドレスへ送るので、1 IP から宛先を変えながら
 * 無制限に送れていた（`login` は登録済みにしか送らないので無害だったが、
 * **無害である理由が `shouldSend` の実装に依存している**ので同じく掛ける）。
 */
async function enforceFormRateLimit(
  c: Context<AppBindings>,
  scope: Parameters<typeof enforceIpRateLimit>[1],
  view: LoginView,
  returnTo: string | null,
  mode: LoginMode,
): Promise<Response | Promise<Response> | null> {
  const limited = await enforceIpRateLimit(c, scope);
  if (limited === null) return null;
  return renderLogin(c, view, returnTo, 429, mode);
}

uiRoutes.get("/login", pageSecurityHeaders, async (c) => {
  const returnTo = readReturnTo(c);
  const token = readSessionCookie(c);
  if (token !== null) {
    const container = c.get("container");
    const result = await container.useCases.getSession.execute({ sessionToken: token });
    if (result.ok && result.value !== null) {
      const user = await container.repositories.users.findById(result.value.userId);
      if (user !== null) {
        const props = user.snapshot();
        // ログイン済みでも自動で戻り先へ飛ばさない。黙って飛ばすと、
        // 「どのアカウントで認可しようとしているか」が利用者に見えないまま
        // 同意画面へ進む。切り替える手段を出したうえで本人に選ばせる。
        return renderLogin(
          c,
          {
            kind: "signed_in",
            displayName: props.displayName,
            username: props.username,
          },
          returnTo,
        );
      }
    }
  }

  return renderLogin(c, { kind: "email", email: "", error: null }, returnTo);
});

/**
 * 1 段目: 確認コードの送信。
 *
 * purpose は `login` に固定する。`signup` を同じ form から選べるようにすると、
 * 「login では送られないが signup では送られる」という差が観測でき、
 * アカウントの有無が分かってしまう。新規登録の導線は別画面で扱う。
 */
uiRoutes.post("/login/start", pageSecurityHeaders, async (c) => {
  const form = await readForm(c);
  const returnTo = readReturnTo(c, form);
  if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) return rejectCsrf(c, returnTo, "login");

  // **CSRF の後、入力を読む前に掛ける。** CSRF に落ちる要求で枠を消費させると、
  // 攻撃者が正規の利用者を締め出せる。
  const throttled = await enforceFormRateLimit(
    c,
    "email_start",
    {
      kind: "email",
      email: field(form, "email").trim(),
      error: "ただいま混み合っています。しばらくしてからお試しください。",
    },
    returnTo,
    "login",
  );
  if (throttled !== null) return throttled;

  const email = field(form, "email").trim();

  const result = await c.get("container").useCases.startEmailOtp.execute({
    email,
    purpose: "login",
  });

  if (!result.ok) {
    // 形式不正だけは指摘してよい。送信先として成立していないという話で、
    // アカウントの有無とは無関係（StartEmailOtpUseCase の判断に合わせる）。
    const message =
      result.error.code === "invalid_input"
        ? "メールアドレスの形式をご確認ください。"
        : "ただいま混み合っています。しばらくしてからお試しください。";
    return renderLogin(c, { kind: "email", email, error: message }, returnTo, 400);
  }

  // 成功しても「送った」とは言わない。未登録のアドレスでも同じこの画面を返す。
  // ここで描画せずリダイレクトすると、メールアドレスをクエリに載せることになる
  // （アクセスログと Referer に残る）。POST の応答としてそのまま描く。
  return renderLogin(c, { kind: "code", email, error: null }, returnTo);
});

/**
 * 2 段目: コードの検証とセッション発行。
 *
 * **失敗の理由で応答を変えない。** 不一致・期限切れ・試行上限・形式不正を
 * すべて同じ文言・同じステータスに畳む。たとえば試行上限だけ 429 にすると、
 * 「そのアドレス宛にはコードが発行されていた」＝登録済み、と分かる（仕様書 9）。
 */
uiRoutes.post("/login/verify", pageSecurityHeaders, async (c) => {
  const form = await readForm(c);
  const returnTo = readReturnTo(c, form);
  if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) return rejectCsrf(c, returnTo, "login");

  // **CSRF の後、入力を読む前に掛ける。** CSRF に落ちる要求で枠を消費させると、
  // 攻撃者が正規の利用者を締め出せる。
  const throttled = await enforceFormRateLimit(
    c,
    "email_verify",
    {
      kind: "code",
      email: field(form, "email").trim(),
      error: "ただいま混み合っています。しばらくしてからお試しください。",
    },
    returnTo,
    "login",
  );
  if (throttled !== null) return throttled;

  const email = field(form, "email").trim();
  const code = field(form, "code").trim();

  const failure = (): Response | Promise<Response> =>
    renderLogin(
      c,
      {
        kind: "code",
        email,
        error: "確認コードを確認できませんでした。もう一度お試しください。",
      },
      returnTo,
      400,
    );

  // 形式チェックも同じ失敗に畳む。ここだけ別応答にすると差が手掛かりになる。
  if (!/^\d{6}$/.test(code)) return failure();

  const result = await c.get("container").useCases.verifyEmailOtp.execute({
    email,
    code,
    purpose: "login",
    userAgent: c.req.header("User-Agent") ?? null,
    // 生 IP はここから先へ出さない。保存されるのはハッシュだけ（仕様書 9 Privacy）。
    ip: c.req.header("CF-Connecting-IP") ?? null,
  });
  if (!result.ok) return failure();

  c.header(
    "Set-Cookie",
    buildSessionCookie(c.env, result.value.token, result.value.session.expiresAt),
    { append: true },
  );
  // 権限が変わるタイミングで CSRF トークンも入れ替える。ログイン前に
  // 攻撃者が固定した値をログイン後も使い回させない（セッション固定と同じ考え方）。
  rotateCsrfToken(c);

  // 303 でやり直し不能にする。POST の結果をそのまま描くと、再読み込みで
  // 使用済みの OTP が再送され、利用者には失敗としか見えない。
  //
  // 戻り先は `sanitizeReturnTo` を通した値だけ（`/oauth/authorize` で始まる
  // 相対パス）。それ以外は null に落ちてログイン済み画面へ行くので、
  // ここが外部サイトへのリダイレクタになることはない（ui/return-to.ts）。
  return c.redirect(returnTo ?? "/login", 303);
});

/**
 * 新規登録（§6.1 / §8.1）。
 *
 * ## なぜログインと別の画面なのか
 *
 * `/login/start` の JSDoc が書いているとおり、`purpose` を同じ form から
 * 選べるようにすると「login では送られないが signup では送られる」という
 * 差が観測でき、**アカウントの有無が分かってしまう**。別の入口にすれば、
 * どちらの画面も「その purpose において送られる条件」を満たす場合だけ
 * 送る、という 1 種類の振る舞いになる。
 *
 * ## 既に登録済みのアドレスで登録を試みた場合
 *
 * `StartEmailOtpUseCase` は `purpose === "signup"` のとき**未登録の
 * アドレスにだけ**送る（`shouldSend`）。応答は送った場合と変わらないので、
 * ここから登録済みかどうかは読めない。
 *
 * 万一コードを持っている場合（別経路で登録された等）に検証まで通れば、
 * `VerifyEmailOtpUseCase.createUser` が既存ユーザーを返すので、
 * **既存アカウントへのログインとして成立する**。アドレスの所有は
 * 確認済みなので、これで問題ない。
 */
uiRoutes.get("/signup", pageSecurityHeaders, (c) =>
  // ログイン済みかどうかは見ない。**登録画面はログイン済みでも開ける**
  // ようにしておく。別のアカウントを作りたい場合に行き止まりにしない。
  renderLogin(c, { kind: "email", email: "", error: null }, readReturnTo(c), 200, "signup"),
);

uiRoutes.post("/signup/start", pageSecurityHeaders, async (c) => {
  const form = await readForm(c);
  const returnTo = readReturnTo(c, form);
  if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) return rejectCsrf(c, returnTo, "signup");

  // **CSRF の後、入力を読む前に掛ける。** CSRF に落ちる要求で枠を消費させると、
  // 攻撃者が正規の利用者を締め出せる。
  const throttled = await enforceFormRateLimit(
    c,
    "email_start",
    {
      kind: "email",
      email: field(form, "email").trim(),
      error: "ただいま混み合っています。しばらくしてからお試しください。",
    },
    returnTo,
    "signup",
  );
  if (throttled !== null) return throttled;

  const email = field(form, "email").trim();

  const result = await c.get("container").useCases.startEmailOtp.execute({
    email,
    purpose: "signup",
  });

  if (!result.ok) {
    // ログイン側と同じ判断。形式不正だけは指摘してよい（送信先として
    // 成立していないという話で、アカウントの有無とは無関係）。
    const message =
      result.error.code === "invalid_input"
        ? "メールアドレスの形式をご確認ください。"
        : "ただいま混み合っています。しばらくしてからお試しください。";
    return renderLogin(c, { kind: "email", email, error: message }, returnTo, 400, "signup");
  }

  return renderLogin(c, { kind: "code", email, error: null }, returnTo, 200, "signup");
});

uiRoutes.post("/signup/verify", pageSecurityHeaders, async (c) => {
  const form = await readForm(c);
  const returnTo = readReturnTo(c, form);
  if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) return rejectCsrf(c, returnTo, "signup");

  // **CSRF の後、入力を読む前に掛ける。** CSRF に落ちる要求で枠を消費させると、
  // 攻撃者が正規の利用者を締め出せる。
  const throttled = await enforceFormRateLimit(
    c,
    "email_verify",
    {
      kind: "code",
      email: field(form, "email").trim(),
      error: "ただいま混み合っています。しばらくしてからお試しください。",
    },
    returnTo,
    "signup",
  );
  if (throttled !== null) return throttled;

  const email = field(form, "email").trim();
  const code = field(form, "code").trim();

  const failure = (): Response | Promise<Response> =>
    renderLogin(
      c,
      {
        kind: "code",
        email,
        error: "確認コードを確認できませんでした。もう一度お試しください。",
      },
      returnTo,
      400,
      "signup",
    );

  if (!/^\d{6}$/.test(code)) return failure();

  const result = await c.get("container").useCases.verifyEmailOtp.execute({
    email,
    code,
    purpose: "signup",
    userAgent: c.req.header("User-Agent") ?? null,
    ip: c.req.header("CF-Connecting-IP") ?? null,
  });
  if (!result.ok) return failure();

  c.header(
    "Set-Cookie",
    buildSessionCookie(c.env, result.value.token, result.value.session.expiresAt),
    { append: true },
  );
  rotateCsrfToken(c);

  // 戻り先が無ければアカウント画面へ送る。**ログインと違って `/login` へ
  // 戻さない** —— いま作ったばかりのアカウントで、利用者が次にやることは
  // 自分の情報を確かめるかパスキーを足すことなので、そこへ着地させる。
  return c.redirect(returnTo ?? "/account", 303);
});

/**
 * ログイン済み画面からのログアウト。
 *
 * `/api/auth/logout` は 204 を返す JSON API なので、form 送信で使うと
 * ブラウザがその場に留まり画面が更新されない。UI 用にリダイレクトする
 * 入口を別に置く。失効処理そのものは同じ UseCase を呼ぶ。
 */
uiRoutes.post("/login/logout", pageSecurityHeaders, async (c) => {
  const form = await readForm(c);
  const returnTo = readReturnTo(c, form);
  if (!isValidCsrf(c, field(form, CSRF_FIELD_NAME))) return rejectCsrf(c, returnTo, "login");

  // どの経路でも Cookie は必ず落とす。サーバー側の失効に失敗しても、
  // ブラウザに使えないトークンを残さない（auth.routes.ts と同じ方針）。
  c.header("Set-Cookie", buildClearedSessionCookie(c.env), { append: true });
  rotateCsrfToken(c);

  const token = readSessionCookie(c);
  if (token !== null) {
    await c.get("container").useCases.logout.execute({ sessionToken: token, allDevices: false });
  }

  // 戻り先は保持したままログイン画面へ戻す。認可の途中で「別のアカウントで
  // ログインし直す」を選んだ利用者が、ログイン後に元の認可要求へ戻れるように
  // するため。ここで戻り先を捨てると、アプリ側からやり直すしかなくなる。
  return c.redirect(loginUrlWithReturnTo(returnTo), 303);
});

/**
 * 静的アセット。
 *
 * Workers Assets ではなく通常のルートで返す。理由は scripts/build-client.mjs の
 * コメントと README を参照。
 *
 * `Cache-Control` を短くしているのは、URL に内容ハッシュを含めていないため。
 * デプロイ後に古い JS が残る窓を 5 分に抑える。長く持たせたくなったら、
 * 先にファイル名へハッシュを入れること。
 */
const ASSET_CACHE_CONTROL = "public, max-age=300";

uiRoutes.get(STYLESHEET_PATH, (c) =>
  c.body(UI_STYLESHEET, 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": ASSET_CACHE_CONTROL,
  }),
);

uiRoutes.get(LOGIN_ISLAND_PATH, (c) =>
  c.body(LOGIN_ISLAND_JS, 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": ASSET_CACHE_CONTROL,
  }),
);
