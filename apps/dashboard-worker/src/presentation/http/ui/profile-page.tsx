import type { UserProfile } from "@u18/contracts";
import type { FC } from "hono/jsx";
import { ISLAND_PATH } from "./asset-paths";
import { DashboardShell } from "./dashboard-shell";
import { formatDateTime } from "./format";

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
 */

export type ProfilePageProps = { readonly profile: UserProfile };

export const ProfilePage: FC<ProfilePageProps> = ({ profile }) => (
  <DashboardShell
    title="プロフィール"
    heading="プロフィール"
    lead="u18 Identity に登録されているあなたの情報です。"
    current="profile"
    scripts={[ISLAND_PATH]}
  >
    <div class="panel">
      <div class="panel-body">
        <dl class="facts">
          <div>
            <dt>表示名</dt>
            <dd data-profile-field="displayName">{profile.displayName}</dd>
          </div>
          <div>
            <dt>ユーザー名</dt>
            <dd data-profile-field="username">{profile.username}</dd>
          </div>
          <div>
            <dt>メールアドレス</dt>
            <dd>
              {profile.email}
              {/*
                未確認であることは黙っていない。この状態だと復旧経路が無い。
                アクセント色（青）は使わない —— 青は「問題なし」に読める。
              */}
              {!profile.emailVerified && <span class="badge badge-warn">未確認</span>}
            </dd>
          </div>
          <div>
            <dt>登録日</dt>
            <dd>{formatDateTime(profile.createdAt)}</dd>
          </div>
        </dl>
      </div>
    </div>
    {/*
      **見た目を持たない置き場所。** 囲いの `panel` ごとアイランドが作る ——
      見出しだけ先に描くと、JS が落ちたときに**中身の無い「変更する」**が
      残る。「押せないボタンを置かない」と同じ理由。
    */}
    <div data-profile-edit />
    <noscript>
      <p class="notice">
        表示名とユーザー名の変更には JavaScript が必要です。登録されている内容の表示は JavaScript
        無しでも行えます。
      </p>
    </noscript>
  </DashboardShell>
);
