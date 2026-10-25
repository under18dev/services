/**
 * scope を利用者に伝わる言葉にする。
 *
 * ## なぜ Worker をまたいで共有するのか
 *
 * 同じ scope が 2 つの画面に出る —— **許可を求める**同意画面
 * （auth-worker）と、**許可を取り消す**連携アプリ画面（dashboard-worker）。
 *
 * 文言が食い違うと、利用者は「同意したもの」と「取り消そうとしているもの」が
 * 同じだと確信できない。`profile` を同意画面で「表示名とユーザー名の参照」、
 * 取り消し画面で「プロフィール」と書いたら、**後者を読んで「これは別の何かだ」
 * と思う余地がある。** 取り消しをためらわせるのは、この画面の目的に反する。
 *
 * 未知の scope はコードをそのまま出す。「その他」などに畳むと、**何を許可して
 * いるか分からないものが画面から消える。**
 */
const SCOPE_LABELS: Record<string, string> = {
  openid: "あなたが u18 のアカウントにログインしていることの確認",
  profile: "表示名とユーザー名の参照",
  email: "メールアドレスと確認状況の参照",
};

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}
