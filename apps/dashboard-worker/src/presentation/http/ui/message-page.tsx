import type { FC } from "hono/jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@u18/web-ui/kiwa";
import { AccountShell } from "./account-shell";
import { LOGIN_PATH } from "./asset-paths";
import { loginUrlWithReturnTo } from "@u18/contracts";

/**
 * 一覧を出せないときの画面。未ログインと、Identity に届かないときの 2 つ。
 *
 * ## 6 つの URL すべてから返る
 *
 * `account.routes.tsx` の共通ハンドラが使うので、**ダッシュボードの
 * どのページを開いても未ログインならこれが出る。**
 *
 * **そのせいで #342 のあいだ、ログインしている人には Kiwa、していない
 * 人には手書き CSS が出ていた。** `ui-pages.test.ts` が必ず Cookie を
 * 付けて取りに行っていたので、どの検査もその経路を見ていなかった
 * （いまは未認証でも「スタイルシートはちょうど 1 本」を見ている）。
 *
 * ## ナビを出さない
 *
 * `current` を渡していない。**どのページへ行っても同じ状態なので、
 * ナビを出すと押すたびに同じ画面へ戻る。**
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
/**
 * **`isAdmin` は渡さない（`false` を書く）。** この画面が出ている時点で
 * セッションが無いか死んでいるので、**管理者かどうかを決める材料が無い。**
 * 「分からないときは出さない」側に倒す —— 逆に倒すと、ログアウト後の
 * 画面に管理の節が残る。
 */
export const SignInRequiredPage: FC<{ readonly returnTo: string | null }> = ({ returnTo }) => (
  <AccountShell title="ログインが必要です" heading="ログインが必要です" isAdmin={false}>
    <Card>
      <CardHeader>
        <CardTitle>アカウント情報を表示するにはログインしてください。</CardTitle>
      </CardHeader>
      <CardContent>
        <a
          href={returnTo === null ? LOGIN_PATH : loginUrlWithReturnTo(returnTo)}
          class="text-sm text-foreground underline underline-offset-4"
        >
          ログイン画面へ
        </a>
      </CardContent>
    </Card>
  </AccountShell>
);

export const UnavailablePage: FC = () => (
  <AccountShell title="一時的に表示できません" heading="一時的に表示できません" isAdmin={false}>
    <Card>
      <CardHeader>
        <CardTitle>アカウント情報を取得できませんでした。</CardTitle>
        <CardDescription>しばらく待ってからもう一度お試しください。</CardDescription>
      </CardHeader>
    </Card>
  </AccountShell>
);
