import type { UserProfile } from "@u18/contracts";
import { Badge, Card, CardContent } from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { ISLAND_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import { ITEM_META_CLASS } from "./island-classes";

/**
 * プロフィール（`/account/profile`、#308）。
 *
 * **概要から切り出した。** 以前は `/account` がプロフィールとパスキーの
 * 2 節を持っていたが、サイドバーを置くと**どの項目が現在地か**を 1 つに
 * 決められない。1 画面 1 主題にする。
 *
 * ## 編集はアイランドが作る（#312）
 *
 * 表示名・ユーザー名の変更（`PATCH /api/me`）は **HTML の form では
 * 送れない**（form が出せるのは GET と POST だけ）。そのため
 * `account-island.ts` が JS で入力欄と保存ボタンを作る。
 *
 * **ここに描くのは「置き場所」だけ。** サーバーが入力欄まで描いて JS で
 * 有効化する形にすると、**読み込みに失敗したときだけ死んだ入力欄が残る**
 * （`<noscript>` も出ない —— あれは JS が無効なときにしか出ない）。
 * 取り消しのボタンをアイランドが作っているのと同じ理由である。
 *
 * **現在値は `<dd>` が正本。** アイランドは `data-profile-field` から読む。
 * `data-*` に同じ値をもう一度書くと、**表示と送信元が 2 箇所になる。**
 *
 * ## `<noscript>` を外枠に任せていない
 *
 * `AccountShell` が出せるのは「取り消しの操作には JS が要る」の 1 種類
 * だけで、この画面が言いたいのは**編集**の話である。外枠に種類を
 * 増やすと、どの画面が何を出すのかを外枠が知ることになる。
 */

export type ProfilePageProps = { readonly profile: UserProfile };

/** `<dt>` と `<dd>` の 1 組。**行の区切りは上の罫線が持つ。** */
const Fact: FC<{ readonly label: string; readonly children?: unknown }> = ({ label, children }) => (
  <div class="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 first:pt-0 sm:flex-row sm:gap-5">
    <dt class="shrink-0 text-sm text-foreground-muted sm:w-32">{label}</dt>
    <dd class="m-0 flex flex-wrap items-center gap-2 text-sm">{children as never}</dd>
  </div>
);

export const ProfilePage: FC<ProfilePageProps> = ({ profile }) => (
  <AccountShell
    title="プロフィール"
    heading="プロフィール"
    lead="u18 Identity に登録されているあなたの情報です。"
    current="profile"
    scripts={[ISLAND_PATH]}
  >
    <Card>
      <CardContent>
        <dl class="m-0">
          <Fact label="表示名">
            <span data-profile-field="displayName">{profile.displayName}</span>
          </Fact>
          <Fact label="ユーザー名">
            <span data-profile-field="username">{profile.username}</span>
          </Fact>
          <Fact label="メールアドレス">
            {profile.email}
            {/*
              未確認であることは黙っていない。この状態だと復旧経路が無い。
              **アクセント色（青）は使わない** —— 青は「問題なし」に読める。
              面も塗らない（`outline-destructive` は枠と文字だけ）。
            */}
            {!profile.emailVerified && <Badge variant="outline-destructive">未確認</Badge>}
          </Fact>
          <Fact label="登録日">{formatDateTime(profile.createdAt)}</Fact>
        </dl>
      </CardContent>
    </Card>
    {/*
      **見た目を持たない置き場所。** 囲いの `Card` ごとアイランドが作る ——
      見出しだけ先に描くと、JS が落ちたときに**中身の無い「変更する」**が
      残る。「押せないボタンを置かない」と同じ理由。
    */}
    <div data-profile-edit />
    <noscript>
      <p class={ITEM_META_CLASS}>
        表示名とユーザー名の変更には JavaScript が必要です。登録されている内容の表示は JavaScript
        無しでも行えます。
      </p>
    </noscript>
  </AccountShell>
);
