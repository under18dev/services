import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "./csrf";
import { Layout } from "@u18/web-ui";
import { LOGIN_ISLAND_PATH, STYLESHEET_PATH } from "./asset-paths";
import { loginUrlWithReturnTo, RETURN_TO_FIELD, signupUrlWithReturnTo } from "./return-to";

/**
 * ログイン画面（仕様書 6.1 / 8.1、決定 14-1 の 4）。
 *
 * ## 表示から「アカウントの有無」を漏らさない
 *
 * `StartEmailOtpUseCase` は未登録のアドレスでも成功と同じ応答を返す。
 * UI 側で「送信しました」「そのアドレスは登録されていません」と書き分けると
 * その設計が台無しになるので、ここでは常に**条件付きの文言**だけを出す
 * （仕様書 9 Privacy）。コード検証の失敗も、理由を問わず 1 種類の文言に畳む。
 * 文言を増やしたくなったら、まずそれが列挙の材料にならないかを確かめること。
 *
 * ## JS 無しで完結するのはメール OTP の経路
 *
 * この画面の form は通常の POST で、JS を 1 行も必要としない。
 * `navigator.credentials` を呼ぶ Passkey のボタンだけがアイランド
 * （ui/client/login-island.tsx）で、JS が落ちればそこだけが代替表示に戻る。
 */

/**
 * 「すべての端末からログアウト」ボタンの name/value。
 *
 * **描くほうと読むほうで同じ名前を使う。** `CSRF_FIELD_NAME` を csrf.ts に
 * 置いているのと同じ理由で、片方だけ直されると**ボタンが黙って「この端末
 * だけ」に戻る** —— 押しても何も言われず、他の端末は生きたままになる。
 */
export const LOGOUT_ALL_FIELD = "all";
export const LOGOUT_ALL_VALUE = "true";

export type LoginView =
  /** 1 段目: メールアドレスの入力。 */
  | {
      readonly kind: "email";
      readonly email: string;
      readonly error: string | null;
      /**
       * 直前の操作が終わったことだけを伝える文言。
       *
       * **呼び出し側が任意の文字列を渡せるが、クエリの値をそのまま入れない
       * こと。** いまの唯一の出どころは `/login?logout=all` で、見ているのは
       * `"all"` という固定値だけ、文言はサーバー側の定数である。ここを
       * 「クエリの文字列を表示する」形にすると、攻撃者が選んだ文を自分の
       * ログイン画面に出せるようになる（偽の案内を読ませる経路）。
       */
      readonly notice?: string | null;
    }
  /** 2 段目: 届いたコードの入力。 */
  | { readonly kind: "code"; readonly email: string; readonly error: string | null }
  /** 既にログインしている場合。 */
  | {
      readonly kind: "signed_in";
      readonly displayName: string;
      readonly username: string;
    };

/**
 * ログインか新規登録か。
 *
 * **画面を分けるのではなく、同じ画面の mode として持つ。** 文言の肝は
 * 「アカウントの有無を漏らさない」ことで（上記）、それをログイン用と
 * 登録用に書き分けると**片方だけ条件付きでない文言に直される**余地が
 * 生まれる。form の action と見出しだけが変わる。
 */
export type LoginMode = "login" | "signup";

export type LoginPageProps = {
  readonly view: LoginView;
  /** 既定は `login`。省略時に登録扱いにならないよう、広いほうを既定にしない。 */
  readonly mode?: LoginMode;
  readonly csrfToken: string;
  /**
   * ログイン後の戻り先（`/oauth/authorize?...`）。無ければ null。
   *
   * **ここへ届く前に `sanitizeReturnTo` を通っていること。** この
   * コンポーネントは検証せず、受け取った値を hidden と data 属性に
   * そのまま載せる。検証を描画側にも置くと「どちらかが通したから大丈夫」
   * という曖昧さが生まれるので、関門は 1 つに保つ（ui/return-to.ts）。
   */
  readonly returnTo: string | null;
};

const CsrfField: FC<{ token: string }> = ({ token }) => (
  <input type="hidden" name={CSRF_FIELD_NAME} value={token} />
);

/**
 * 戻り先を form に載せる。
 *
 * クエリではなく hidden にするのは、2 段目の form（コード入力）が POST で
 * あって、クエリを引き継ぐ経路が無いため。`null` なら要素自体を出さないので、
 * 認可フロー以外のログインでは HTML が 1 バイトも変わらない。
 */
const ReturnToField: FC<{ returnTo: string | null }> = ({ returnTo }) =>
  returnTo === null ? null : <input type="hidden" name={RETURN_TO_FIELD} value={returnTo} />;

const ErrorMessage: FC<{ message: string | null }> = ({ message }) =>
  message === null ? null : (
    // role="alert" で読み上げへ届ける。文言そのものは中立に保つこと。
    <p class="error" role="alert">
      {message}
    </p>
  );

const EmailStep: FC<LoginPageProps & { view: Extract<LoginView, { kind: "email" }> }> = ({
  view,
  csrfToken,
  returnTo,
  mode = "login",
}) => (
  <>
    <h2>{mode === "signup" ? "新規登録" : "ログイン"}</h2>
    <p class="lead">
      {mode === "signup"
        ? "メールアドレスだけで登録できます。パスワードはありません。"
        : "u18 のサービスで使うアカウントにログインします。"}
    </p>
    <ErrorMessage message={view.error} />
    {view.notice === undefined || view.notice === null ? null : (
      // 完了の知らせはエラーではないので role="status"（控えめに読み上げる）。
      <p class="notice" role="status">
        {view.notice}
      </p>
    )}

    <form method="post" action={`/${mode}/start`}>
      <CsrfField token={csrfToken} />
      <ReturnToField returnTo={returnTo} />
      <label class="field" for="email">
        <span>メールアドレス</span>
        <input
          id="email"
          type="email"
          name="email"
          value={view.email}
          required
          autocomplete="email"
          autocapitalize="off"
          spellcheck={false}
          maxlength={254}
          placeholder="you@example.com"
        />
      </label>
      <button type="submit" class="button">
        確認コードを送る
      </button>
      <p class="notice">確認コードをメールでお送りします。</p>
    </form>

    {/*
      新規登録ではパスキーの経路を出さない。**まだ認証器が登録されていない
      のだから押しても失敗するだけ**で、失敗の文言が「このアドレスには
      パスキーが無い」と読まれれば列挙の材料にもなる。登録後に
      アカウント画面から追加する（§14.1 決定 2）。
    */}
    {mode === "signup" ? (
      <p class="links">
        <a href={loginUrlWithReturnTo(returnTo)}>すでにアカウントをお持ちの方</a>
      </p>
    ) : (
      <>
        <div class="separator">または</div>

        {/*
      アイランドのマウント先。JS が読み込めなかった場合はこの中身が残るので、
      行き止まりにならないよう代替の案内を置いておく。
      「パスキーが登録されていません」とは書かない（列挙の材料になる）。
    */}
        {/*
      戻り先はアイランドへ data 属性で渡す。インライン `<script>` で
      グローバル変数に入れる手もあるが、`script-src 'self'` の CSP に
      引っかかり `'unsafe-inline'` が要る。CSP を緩めるくらいなら属性で渡す
      （ui/page-headers.ts）。
    */}
        <div id="passkey-island" data-return-to={returnTo ?? undefined}>
          <p class="notice">
            パスキーをお使いの場合は、この端末で JavaScript を有効にするとご利用いただけます。
            上のメールアドレスでのログインは JavaScript 無しでも行えます。
          </p>
        </div>
        <p class="links">
          <a href={signupUrlWithReturnTo(returnTo)}>アカウントをお持ちでない方</a>
        </p>
      </>
    )}
  </>
);

const CodeStep: FC<LoginPageProps & { view: Extract<LoginView, { kind: "code" }> }> = ({
  view,
  csrfToken,
  returnTo,
  mode = "login",
}) => (
  <>
    <h2>確認コードの入力</h2>
    {/*
      「送信しました」と断定しない。登録されていないアドレスでも同じ画面を
      返すため、ここで断定すると応答の差がアカウントの有無を表してしまう。
    */}
    <p class="lead">
      {mode === "signup"
        ? "ご入力のアドレスがまだ登録されていない場合、6 桁の確認コードをお送りしました。"
        : "ご入力のアドレスが登録されている場合、6 桁の確認コードをお送りしました。"}
      届いていない場合は迷惑メールもご確認ください。
    </p>
    <ErrorMessage message={view.error} />

    <form method="post" action={`/${mode}/verify`}>
      <CsrfField token={csrfToken} />
      <ReturnToField returnTo={returnTo} />
      {/*
        メールアドレスは hidden で持ち回す。クエリに載せるとアクセスログや
        Referer に残るため（OTP やトークンをクエリに載せないのと同じ理由）。
      */}
      <input type="hidden" name="email" value={view.email} />
      <label class="field" for="code">
        <span>確認コード</span>
        <input
          id="code"
          class="code-input"
          type="text"
          name="code"
          required
          inputmode="numeric"
          pattern="[0-9]{6}"
          maxlength={6}
          autocomplete="one-time-code"
          autofocus
        />
      </label>
      <button type="submit" class="button">
        ログイン
      </button>
    </form>

    <div class="links">
      <form method="post" action="/login/start" class="inline-form">
        <CsrfField token={csrfToken} />
        <ReturnToField returnTo={returnTo} />
        <input type="hidden" name="email" value={view.email} />
        <button type="submit" class="link-button">
          確認コードを再送する
        </button>
      </form>
      {" / "}
      <a href={returnTo === null ? "/login" : loginUrlWithReturnTo(returnTo)}>
        別のメールアドレスを使う
      </a>
    </div>
  </>
);

const SignedIn: FC<LoginPageProps & { view: Extract<LoginView, { kind: "signed_in" }> }> = ({
  view,
  csrfToken,
  returnTo,
}) => (
  <>
    <h2>ログイン済みです</h2>
    <p class="identity">
      <strong>{view.displayName}</strong>
      <span>@{view.username}</span>
    </p>
    {/*
      ここで自動的にどこかへリダイレクトしない。戻り先を決めるのは
      `/oauth/authorize` の同意画面（#15）の責務で、今はまだ戻り先が無い。
      黙って飛ばすと「既にセッションがある」ことが利用者に見えなくなるので、
      明示して切り替え手段を出す。
    */}
    <p class="lead">別のアカウントでログインする場合は、いったんログアウトしてください。</p>
    {/*
      2 つのボタンを**同じ form**に置く。別の form に分けると CSRF トークンと
      戻り先を 2 組持つことになり、片方だけ直される余地ができる。送る値が
      違うだけなので、submit の `name`/`value` で分ける。
    */}
    <form method="post" action="/login/logout">
      <CsrfField token={csrfToken} />
      <ReturnToField returnTo={returnTo} />
      <button type="submit" class="button button-secondary">
        ログアウトして別のアカウントでログイン
      </button>
      {/*
        **全端末のログアウトを JS 無しで届かせるのはここだけである**（#208）。
        `DELETE /account/api/me/sessions/:id` はアイランド経由、
        `POST /api/auth/logout?all=true` は 204 を返す JSON API で form からは
        使えない。アカウント画面は dashboard-worker にあり、auth-worker の
        CSRF トークンを持てないので、置き場所はこの画面になる。

        **個別のセッション指定は足さない。** それをやると
        `DELETE .../sessions/:id` と二重になり、§14.1 決定 16 で
        「書き込み経路を 1 本に保つ」として避けたものがそのまま戻る。
        「全部切る」は粒度が違うので別物として扱う。
      */}
      <button
        type="submit"
        name={LOGOUT_ALL_FIELD}
        value={LOGOUT_ALL_VALUE}
        class="button button-danger"
      >
        すべての端末からログアウト
      </button>
      <p class="notice">
        身に覚えのない端末がある場合は、すべての端末からログアウトしてください。
        この端末も含めて、いますぐ使えなくなります。
      </p>
    </form>
  </>
);

export const LoginPage: FC<LoginPageProps> = (props) => (
  <Layout
    title={props.mode === "signup" ? "新規登録" : "ログイン"}
    // Passkey のアイランドだけが JS を必要とする。ログイン済み画面と
    // コード入力画面には読み込ませない（不要な攻撃面を増やさない）。
    stylesheet={STYLESHEET_PATH}
    // 新規登録画面もアイランドを出さないので読み込まない。
    scripts={props.view.kind === "email" && props.mode !== "signup" ? [LOGIN_ISLAND_PATH] : []}
  >
    {props.view.kind === "email" ? <EmailStep {...props} view={props.view} /> : null}
    {props.view.kind === "code" ? <CodeStep {...props} view={props.view} /> : null}
    {props.view.kind === "signed_in" ? <SignedIn {...props} view={props.view} /> : null}
  </Layout>
);
