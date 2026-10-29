import type { UserProfile } from "@u18/contracts";
import type { FC } from "hono/jsx";
import { DashboardShell } from "./dashboard-shell";
import { formatDateTime } from "./format";

/**
 * プロフィール（`/account/profile`、#308）。
 *
 * **概要から切り出した。** 以前は `/account` がプロフィールとパスキーの
 * 2 節を持っていたが、サイドバーを置くと**どの項目が現在地か**を 1 つに
 * 決められない。1 画面 1 主題にする。
 *
 * ## いまは読むだけ
 *
 * 表示名・ユーザー名の変更（`PATCH /api/me`）は **HTML の form では
 * 送れない**（form が出せるのは GET と POST だけ）。JS を使うアイランドで
 * 足すまで、ここに操作は無い。**押せないボタンを置かない。**
 */

export type ProfilePageProps = { readonly profile: UserProfile };

export const ProfilePage: FC<ProfilePageProps> = ({ profile }) => (
  <DashboardShell
    title="プロフィール"
    heading="プロフィール"
    lead="u18 Identity に登録されているあなたの情報です。"
    current="profile"
  >
    <div class="panel">
      <div class="panel-body">
        <dl class="facts">
          <div>
            <dt>表示名</dt>
            <dd>{profile.displayName}</dd>
          </div>
          <div>
            <dt>ユーザー名</dt>
            <dd>{profile.username}</dd>
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
  </DashboardShell>
);
