import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "./csrf";
import { scopeLabel } from "@u18/web-ui";
import { KiwaCardShell, getButtonClasses } from "@u18/web-ui/kiwa";
import { ITEM_META_CLASS } from "@u18/web-ui/kiwa/island-classes";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import { ErrorMessage, LINK_TEXT_CLASS } from "./page-parts";

/**
 * 同意画面（仕様書 1.1 / 7.1、#15）。
 *
 * ## JS を 1 行も使わない
 *
 * ログイン画面のメール OTP と同じく、通常の form POST だけで完結する。
 * 認可の可否を決める画面が JS の読み込み失敗で操作不能になるのは避けたい。
 * `KiwaCardShell` の `scripts` を渡さないので `<script>` は 1 つも出ない。
 *
 * ## 認可要求を hidden で持ち回す
 *
 * 「何を認可しようとしているか」（client_id / redirect_uri / scope /
 * state / nonce / code_challenge）だけを hidden で運ぶ。**この値は一切
 * 信用しない。** POST を受けたハンドラは `AuthorizeRequestUseCase` に
 * 全部を渡し直し、GET のときとまったく同じ検証を通す。改竄された値は
 * そこで落ちる。hidden field は「覚えておく」ためのものであって、
 * 「検証済みである」という印ではない。
 *
 * `prompt` と `max_age` は**運ばない**。これらは「どう対話を進めるか」を
 * 指示するパラメータで、同意画面が出ている時点でその指示は既に果たされて
 * いる。運ぶと `prompt=consent` が同意のたびに同意画面を要求し直して
 * 進めなくなり、`max_age=0` は毎回ログインへ戻る無限ループになる。
 *
 * ## 「許可」と「拒否」を同じ form の 2 つの submit にする
 *
 * 拒否も POST にするのは、CSRF トークンを通すため。拒否をリンク（GET）に
 * すると、攻撃者が被害者に踏ませるだけで認可を妨害できる。
 *
 * ## 見た目は Kiwa UI（#332 の P2）
 *
 * **この画面が手書き CSS（`styles.ts`）の最後の持ち主だった。** 移すときに
 * 気をつけたのは、**hidden の input と form の構造を 1 つも動かさないこと**
 * —— CSRF トークンも認可要求も hidden で運んでいるので、「見た目を直す」
 * 変更が認可の完走を壊せる場所である。class 以外は触っていない。
 */

/** `AuthorizeRequestUseCase` へ渡し直すために持ち回るパラメータ。 */
export type ConsentRequestFields = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly responseType: string;
  readonly scope: string;
  readonly state: string | null;
  readonly nonce: string | null;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
};

export type ConsentPageProps = {
  /** 画面に出すクライアント名。登録時に運用者が入れた値。 */
  readonly clientName: string;
  readonly displayName: string;
  readonly username: string;
  readonly scopes: readonly string[];
  readonly request: ConsentRequestFields;
  readonly csrfToken: string;
};

const Hidden: FC<{ name: string; value: string | null }> = ({ name, value }) =>
  value === null ? null : <input type="hidden" name={name} value={value} />;

export const ConsentPage: FC<ConsentPageProps> = ({
  clientName,
  displayName,
  username,
  scopes,
  request,
  csrfToken,
}) => (
  <KiwaCardShell title="アクセスの許可" stylesheet={KIWA_STYLESHEET_PATH}>
    <h2 class="text-xl">{clientName} へのアクセスを許可しますか？</h2>

    {/*
      どのアカウントで許可しようとしているかを必ず出す。複数アカウントを
      持つ利用者が、意図しないほうで認可してしまうのを防ぐ。

      **ログイン済み画面（`login-page.tsx` の `SignedIn`）と同じ形にする。**
      直前に「このアカウントです」と見せた枠が、同意の瞬間に別の見た目に
      なると、同じ事実を指していることが読み取りにくい。
    */}
    <p class="flex flex-col gap-0.5 rounded-lg border border-border bg-background-subtle px-3 py-2.5">
      <strong class="text-sm font-medium">{displayName}</strong>
      <span class="text-sm text-foreground-muted">@{username}</span>
    </p>

    <p class={ITEM_META_CLASS}>許可すると、このアプリは次の情報を受け取れるようになります。</p>
    {/*
      **箇条書きのまま残す。** 連携アプリ画面（dashboard の `grants-page.tsx`）は
      同じ `scopeLabel` を横並びの小さな文字で出しているが、あちらは「既に
      許可したもの」の一覧で、こちらは**これから許可するかどうかを決める
      本文**である。読み飛ばせる形にしない。

      `flex` を使わず `space-y-*` で間を空けているのは、`<li>` を flex item に
      すると中黒（`::marker`）の扱いがブラウザ任せになるため。手書き CSS の
      `.scopes`（`padding-left: 1.25rem` + `li { margin-bottom: 0.5rem }`）を
      そのまま写した形でもある。
    */}
    <ul class="list-disc space-y-2 pl-5 text-sm/relaxed text-foreground-muted">
      {scopes.map((scope) => (
        <li key={scope}>{scopeLabel(scope)}</li>
      ))}
    </ul>

    <form method="post" action="/oauth/consent" class="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
      <Hidden name="client_id" value={request.clientId} />
      <Hidden name="redirect_uri" value={request.redirectUri} />
      <Hidden name="response_type" value={request.responseType} />
      <Hidden name="scope" value={request.scope} />
      <Hidden name="state" value={request.state} />
      <Hidden name="nonce" value={request.nonce} />
      <Hidden name="code_challenge" value={request.codeChallenge} />
      <Hidden name="code_challenge_method" value={request.codeChallengeMethod} />

      {/*
        **「許可しない」を `variant="destructive"` にしない。** 赤い面は
        「危険な操作」を指すが、拒否は安全側の選択である。塗り分けるのは
        既定（青）と `secondary` の 2 つで、design.md の "No colorful UI."
        にも従う。
      */}
      <button type="submit" name="decision" value="allow" class={getButtonClasses()}>
        許可する
      </button>
      <button type="submit" name="decision" value="deny" class={getButtonClasses("secondary")}>
        許可しない
      </button>
    </form>

    {/*
      戻り先の URL（redirect_uri）はそのまま出さない。利用者が読んで判断できる
      情報ではないうえ、長い URL を画面に出すと「正しそうな文字列」を信じさせる
      手口に使われる。表示するのは運用者が登録したクライアント名だけにする。
    */}
    <p class={ITEM_META_CLASS}>
      このアプリを知らない場合は「許可しない」を選んでください。許可した内容は
      あとからアカウント設定で取り消せます。
    </p>
  </KiwaCardShell>
);

/**
 * 認可要求そのものが成立していないときのエラー画面。
 *
 * **ここでリダイレクトしないことに意味がある。** `client_id` が未知、
 * あるいは `redirect_uri` が未登録の段階で届いた宛先へエラーを返すと、
 * u18 が任意の宛先へのリダイレクタになる（RFC 6749 §4.1.2.1）。
 * 行き先が無いので、自前の画面で止める。
 *
 * 文面に `client_id` も `redirect_uri` も出さない。入力された文字列を
 * そのまま画面に戻すと、攻撃者が任意の文章を u18 のドメイン上に
 * 表示させられる（反射型のコンテンツ注入）。hono/jsx が自動エスケープ
 * するので HTML にはならないが、文章として読まれる被害は残る。
 */
export type AuthorizeErrorPageProps = {
  readonly reason: "invalid_client" | "invalid_redirect_uri" | "invalid_request";
};

const ERROR_MESSAGES: Record<AuthorizeErrorPageProps["reason"], string> = {
  invalid_client: "このアプリは u18 に登録されていないか、利用が停止されています。",
  invalid_redirect_uri:
    "このアプリの戻り先が u18 に登録されているものと一致しません。安全のため処理を中断しました。",
  invalid_request: "ログイン要求の内容が正しくありません。",
};

export const AuthorizeErrorPage: FC<AuthorizeErrorPageProps> = ({ reason }) => (
  <KiwaCardShell title="ログインを続行できません" stylesheet={KIWA_STYLESHEET_PATH}>
    <h2 class="text-xl">ログインを続行できません</h2>
    <ErrorMessage message={ERROR_MESSAGES[reason]} />
    <p class={ITEM_META_CLASS}>
      このページはアプリの設定に起因するものです。お手数ですが、アプリの提供元へ
      お問い合わせください。
    </p>
    {/*
      「アプリへ戻る」リンクは置かない。戻り先が検証できていないのがこの画面が
      出ている理由そのものなので、リンクにした時点でオープンリダイレクトになる。
    */}
    <p class={LINK_TEXT_CLASS}>
      <a href="/login">u18 のログイン画面へ</a>
    </p>
  </KiwaCardShell>
);
