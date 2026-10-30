import { ACCOUNT_HOME_PATH, accountNavFor } from "@u18/contracts";
import type { AccountNavCurrent } from "@u18/contracts";
import { KiwaShell } from "@u18/web-ui/kiwa";
import type { Child, FC } from "hono/jsx";
import { KIWA_STYLESHEET_PATH, LOGIN_PATH } from "./asset-paths";

/**
 * この Worker の画面の外枠（#332）。
 *
 * **`dashboard-shell.tsx` の置き換えである。** 中身は `KiwaShell`
 * （`@u18/web-ui/kiwa`）で、ここは**この Worker にしか言えない 4 つ**を
 * 埋めているだけ:
 *
 *  - `stylesheet` —— **Worker ごとに違う。** 自分で配信しているものを
 *    指す（借りない理由は `asset-paths.ts` の #211 の節）
 *  - `nav` / `brandHref` —— `@u18/contracts` の並び。**nfc-worker も
 *    同じものを渡す**ので、片方にだけ項目を足した状態が作れない
 *  - `loginHref` —— **auth-worker が配信している。** 接頭辞を付けると
 *    この Worker へ戻ってきて 404 になる
 *
 * **外枠そのものを持たないこと。** 2 つの Worker が同じサイドバーを
 * 出す以上、形はあちら 1 つにある。
 */

export type AccountShellProps = {
  readonly title: string;
  readonly current?: AccountNavCurrent;
  readonly heading: string;
  readonly lead?: string;
  readonly scripts?: readonly string[];
  readonly hasRevokeActions?: boolean;
  /**
   * 管理の節を出すか（#333）。
   *
   * **必須にしてある。既定値を置かない。** 既定を置くと、次に足した画面
   * だけ渡し忘れた状態が作れる —— このリポジトリが繰り返し踏んでいる形で
   * （`signInRequired` を 1 箇所に置いた理由と同じ）、**渡し忘れても
   * 落ちない。** 必須なら `tsc` が落とすので、**忘れることが型の上で
   * できない。**
   *
   * **値は 1 リクエストに 1 つだけ**（`account.routes.tsx` の
   * `navFlags`）。画面ごとに取りに行くと、同じ応答の中でサイドバーと
   * 本文が違う判断を持ちうる。
   */
  readonly isAdmin: boolean;
  readonly children?: Child;
};

export const AccountShell: FC<AccountShellProps> = ({
  title,
  current,
  heading,
  lead,
  scripts,
  hasRevokeActions,
  isAdmin,
  children,
}) => (
  <KiwaShell
    title={title}
    nav={accountNavFor(isAdmin)}
    brandHref={ACCOUNT_HOME_PATH}
    stylesheet={KIWA_STYLESHEET_PATH}
    loginHref={LOGIN_PATH}
    {...(current === undefined ? {} : { current })}
    heading={heading}
    {...(lead === undefined ? {} : { lead })}
    {...(scripts === undefined ? {} : { scripts })}
    {...(hasRevokeActions === undefined ? {} : { hasRevokeActions })}
  >
    {children}
  </KiwaShell>
);
