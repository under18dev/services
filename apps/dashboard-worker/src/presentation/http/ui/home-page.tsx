import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  getButtonClasses,
} from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { GRANTS_PATH, PASSKEYS_PATH, PROFILE_PATH, SESSIONS_PATH } from "./asset-paths";
import {
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_TITLE_CLASS,
  LIST_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import { ITEM_BODY_ATTR, ITEM_TITLE_ATTR } from "./island-hooks";

/**
 * ダッシュボードのホーム（`/account`、#308）。
 *
 * **以前はここがプロフィールとパスキーの本体だった。** いまは各ページへの
 * 導線と件数だけを置く。
 *
 * ## 数を出す理由
 *
 * 「パスキー 0 本」は**それ自体が伝えたい状態**である。1 本も無いと、
 * メール OTP しか手段が無く、受信箱を失うと復旧できない。一覧を開かないと
 * 分からない形にすると、**危ない状態の人ほど気づかない。**
 *
 * ## 間隔は入れ物が持つ
 *
 * パネルの間隔を `style` 属性（margin-top）で付けていて、**本番で枠線が
 * 密着していた**（#320）。この画面には `style-src 'self'` の CSP が
 * 掛かっており、`style` 属性は `style-src-attr` が無ければ `style-src`
 * へ落ちる（CSP3）ので、ブラウザが属性ごと捨てる。
 * **間隔は `KiwaShell` の本文カラム（`gap-8`）が持つ。**
 *
 * ## 「未読」や「お知らせ」をまだ置かない
 *
 * 置く中身が無い。**空の枠を先に作ると、埋まっていないことが画面から
 * 読めなくなる**（#306 で踏んだ「API はあるのに入口が無い」の逆向き）。
 *
 * ## この画面はアイランドを読まない
 *
 * 取り消しの操作が無いので `scripts` を渡していない。それでも一覧の
 * クラスを `island-classes.ts` から取っているのは、**他の画面の一覧と
 * 同じ見た目にする**ためである（あちらはアイランドが作り直す）。
 */

export type HomePageProps = {
  readonly displayName: string;
  readonly passkeyCount: number;
  readonly sessionCount: number;
  readonly grantCount: number;
};

type Tile = { readonly href: string; readonly value: number; readonly label: string };
type Link = { readonly href: string; readonly label: string; readonly meta: string };

const LINKS: readonly Link[] = [
  { href: PROFILE_PATH, label: "プロフィール", meta: "表示名・ユーザー名・メールアドレス" },
  { href: SESSIONS_PATH, label: "ログイン中の端末", meta: "身に覚えのない端末を切る" },
  { href: GRANTS_PATH, label: "連携アプリ", meta: "アクセスを許可したアプリと、その権限" },
];

export const HomePage: FC<HomePageProps> = ({
  displayName,
  passkeyCount,
  sessionCount,
  grantCount,
}) => {
  const tiles: readonly Tile[] = [
    { href: PASSKEYS_PATH, value: passkeyCount, label: "パスキー" },
    { href: SESSIONS_PATH, value: sessionCount, label: "ログイン中の端末" },
    { href: GRANTS_PATH, value: grantCount, label: "連携アプリ" },
  ];

  return (
    <AccountShell
      title="ホーム"
      heading={`こんにちは、${displayName} さん`}
      lead="u18 Identity のアカウントと、連携しているアプリを管理できます。"
      current="home"
    >
      <div class="grid gap-4 sm:grid-cols-3">
        {tiles.map((tile) => (
          <Card key={tile.href}>
            <CardContent>
              <a class="flex flex-col gap-1" href={tile.href}>
                <span class="text-3xl leading-none font-medium tabular-nums">{tile.value}</span>
                <span class="text-sm text-foreground-muted">{tile.label}</span>
              </a>
            </CardContent>
          </Card>
        ))}
      </div>

      {passkeyCount === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>パスキーを登録してください</CardTitle>
            <CardDescription>
              いまログインできる手段はメールに届くコードだけです。受信箱を使えなくなると、
              アカウントに入れなくなります。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a class={getButtonClasses("outline", "sm")} href={PASSKEYS_PATH}>
              パスキーの設定へ
            </a>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>アカウント</CardTitle>
          <CardDescription>登録情報の確認と、ログイン手段の管理。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul class={LIST_CLASS}>
            {LINKS.map((link, index) => (
              <li key={link.href}>
                {index > 0 && <Separator class="my-3" />}
                <div class={ITEM_BODY_CLASS} {...{ [ITEM_BODY_ATTR]: "" }}>
                  <div class={ITEM_TITLE_CLASS} {...{ [ITEM_TITLE_ATTR]: "" }}>
                    <a href={link.href} class="underline-offset-4 hover:underline">
                      {link.label}
                    </a>
                  </div>
                  <p class={ITEM_META_CLASS}>{link.meta}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </AccountShell>
  );
};
