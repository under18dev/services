import type { PasskeySummary, UserProfile } from "@u18/contracts";
import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { formatDateTime } from "./format";

/**
 * アカウント概要（`/account`）。プロフィールと Passkey を出す。
 *
 * ## いまは読むだけ
 *
 * 表示名・ユーザー名の変更（`PATCH /api/me`）と Passkey の削除
 * （`DELETE /api/me/passkeys/:id`）は、**HTML の form では送れない**
 * （form が出せるのは GET と POST だけ）。JS を使うアイランドで足すので、
 * ここにはまだ操作が無い。
 *
 * **押せないボタンを置いていない。** 「効かないボタン」は、利用者には
 * 「壊れている」と区別がつかない。
 */

export type AccountPageProps = {
  readonly profile: UserProfile;
  readonly passkeys: readonly PasskeySummary[];
};

/**
 * Passkey の見出し。
 *
 * label が無いときに `deviceType` で代替しない。あれに入るのは
 * `platform` / `cross-platform` のような**実装側の語**で、画面に出しても
 * 利用者には何のことか分からない。種別は下の行に日本語で出す。
 */
function passkeyTitle(passkey: PasskeySummary): string {
  if (passkey.label !== null && passkey.label !== "") return passkey.label;
  return "名前のないパスキー";
}

/**
 * `deviceType` を利用者に伝わる言葉にする。
 *
 * WebAuthn の credential device type。知らない値はそのまま出す ——
 * 「その他」に畳むと、**知らない種別の認証器が登録されていること自体が
 * 画面から消える。**
 */
function deviceTypeLabel(deviceType: string): string {
  if (deviceType === "platform" || deviceType === "singleDevice") return "この端末に保存";
  if (deviceType === "cross-platform" || deviceType === "multiDevice") {
    return "他の端末・セキュリティキー";
  }
  return deviceType;
}

export const AccountPage: FC<AccountPageProps> = ({ profile, passkeys }) => (
  <AccountShell title="アカウント" current="overview">
    <section class="section">
      <h2>プロフィール</h2>
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
    </section>

    <section class="section">
      <h2>パスキー</h2>
      <p class="section-lead">
        この一覧にある認証器でログインできます。身に覚えのないものがあれば削除してください。
      </p>
      {passkeys.length === 0 ? (
        <p class="empty">登録されているパスキーはありません。</p>
      ) : (
        <ul class="list">
          {passkeys.map((passkey) => (
            <li key={passkey.id}>
              <div class="item-main">
                <div class="item-title">{passkeyTitle(passkey)}</div>
                <p class="item-meta">
                  {passkey.deviceType !== null &&
                    passkey.deviceType !== "" &&
                    `${deviceTypeLabel(passkey.deviceType)} / `}
                  登録 {formatDateTime(passkey.createdAt)}
                  {" / "}
                  {passkey.lastUsedAt === null
                    ? "未使用"
                    : `最終使用 ${formatDateTime(passkey.lastUsedAt)}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  </AccountShell>
);
