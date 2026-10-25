import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "./csrf";
import { Layout } from "@u18/web-ui";
import { loginUrlWithReturnTo, RETURN_TO_FIELD } from "./return-to";

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

export type LoginView =
  /** 1 段目: メールアドレスの入力。 */
  | { readonly kind: "email"; readonly email: string; readonly error: string | null }
  /** 2 段目: 届いたコードの入力。 */
  | { readonly kind: "code"; readonly email: string; readonly error: string | null }
  /** 既にログインしている場合。 */
  | {
      readonly kind: "signed_in";
      readonly displayName: string;
      readonly username: string;
    };

export type LoginPageProps = {
  readonly view: LoginView;
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
}) => (
  <>
    <h2>ログイン</h2>
    <p class="lead">u18 のサービスで使うアカウントにログインします。</p>
    <ErrorMessage message={view.error} />

    <form method="post" action="/login/start">
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
  </>
);

const CodeStep: FC<LoginPageProps & { view: Extract<LoginView, { kind: "code" }> }> = ({
  view,
  csrfToken,
  returnTo,
}) => (
  <>
    <h2>確認コードの入力</h2>
    {/*
      「送信しました」と断定しない。登録されていないアドレスでも同じ画面を
      返すため、ここで断定すると応答の差がアカウントの有無を表してしまう。
    */}
    <p class="lead">
      ご入力のアドレスが登録されている場合、6 桁の確認コードをお送りしました。
      届いていない場合は迷惑メールもご確認ください。
    </p>
    <ErrorMessage message={view.error} />

    <form method="post" action="/login/verify">
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
    <form method="post" action="/login/logout">
      <CsrfField token={csrfToken} />
      <ReturnToField returnTo={returnTo} />
      <button type="submit" class="button button-secondary">
        ログアウトして別のアカウントでログイン
      </button>
    </form>
  </>
);

export const LoginPage: FC<LoginPageProps> = (props) => (
  <Layout
    title="ログイン"
    // Passkey のアイランドだけが JS を必要とする。ログイン済み画面と
    // コード入力画面には読み込ませない（不要な攻撃面を増やさない）。
    scripts={props.view.kind === "email" ? ["/ui/login-island.js"] : []}
  >
    {props.view.kind === "email" ? <EmailStep {...props} view={props.view} /> : null}
    {props.view.kind === "code" ? <CodeStep {...props} view={props.view} /> : null}
    {props.view.kind === "signed_in" ? <SignedIn {...props} view={props.view} /> : null}
  </Layout>
);
