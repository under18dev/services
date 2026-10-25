import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { LOGIN_PATH } from "./asset-paths";
import { loginUrlWithReturnTo } from "@u18/contracts";

/**
 * 一覧を出せないときの画面。未ログインと、Identity に届かないときの 2 つ。
 *
 * ## ナビを出さない
 *
 * `AccountShell` に `current` を渡していない。**どのページへ行っても同じ
 * 状態なので、ナビを出すと押すたびに同じ画面へ戻る。**
 *
 * ## 内部の事情を書かない
 *
 * `identity_unavailable` の `detail`（RPC の例外メッセージなど）は画面に
 * 出さない。JSON の経路で `error` のコードしか返していないのと同じ理由で、
 * 構成を推測する材料を未認証の相手に渡さない。
 */

/**
 * ログインが必要な画面。
 *
 * **戻り先を載せる。** 素の `/login` へ送ると、ログインしたあと利用者が
 * 自分でこの画面まで辿り直すことになる。戻り先の検証は auth-worker の
 * `sanitizeReturnTo` が行うので（関門は 1 つ）、ここは渡すだけ。
 */
export const SignInRequiredPage: FC<{ readonly returnTo: string | null }> = ({ returnTo }) => (
  <AccountShell title="ログインが必要です">
    <section class="section">
      <h2>ログインが必要です</h2>
      <p class="section-lead">アカウント情報を表示するにはログインしてください。</p>
      <p class="links">
        <a href={returnTo === null ? LOGIN_PATH : loginUrlWithReturnTo(returnTo)}>ログイン画面へ</a>
      </p>
    </section>
  </AccountShell>
);

export const UnavailablePage: FC = () => (
  <AccountShell title="一時的に表示できません">
    <section class="section">
      <h2>一時的に表示できません</h2>
      <p class="section-lead">
        アカウント情報を取得できませんでした。しばらく待ってからもう一度お試しください。
      </p>
    </section>
  </AccountShell>
);
