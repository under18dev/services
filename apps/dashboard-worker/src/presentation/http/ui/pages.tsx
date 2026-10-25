import type { GrantListItem, PasskeySummary, SessionListItem, UserProfile } from "@u18/contracts";
import { Layout } from "@u18/web-ui";
import type { Child, FC } from "hono/jsx";

/**
 * アカウント管理の画面（仕様書 §1.3「アカウント UI」/ §2.2「設定 UI」）。
 *
 * ## JS を 1 行も要求しない
 *
 * 表示だけに絞っている。失効・削除といった書き込み操作は、既存の
 * JSON API（Origin 検証つき）をアイランドから叩く形で後続に回す。
 *
 * **form POST を並べない理由**は、書き込み経路が 2 本になると
 * 2 つを同期させ続ける必要が出るため。本リポジトリで繰り返し出ている
 * 「経路が違うと効かない」（#141 / #151 / #164）がそのまま再現する。
 *
 * ## 新しい CSS クラスを足していない
 *
 * スタイルシートは auth-worker が `/ui/u18.css` で配信している。
 * こちらの都合でクラスを増やすと 2 箇所を同期させることになるので、
 * 既存の `.identity`（枠付きのボックス）`.scopes`（項目を縦に並べる）
 * `.lead` `.notice` `.links` だけで組む。
 */

/** ISO 8601 を「2026-10-25」まで落とす。時刻まで見せる理由が無い。 */
function toDate(iso: string): string {
  return iso.split("T")[0] ?? iso;
}

/** どの画面からも他の画面へ行けるようにする。1 箇所に置いて書き忘れを防ぐ。 */
const AccountNav: FC<{ readonly current: string }> = ({ current }) => (
  <p class="links">
    {[
      ["/account", "プロフィール"],
      ["/account/sessions", "ログイン中の端末"],
      ["/account/passkeys", "パスキー"],
      ["/account/grants", "連携アプリ"],
      ["/account/nfc", "NFC カード"],
    ].map(([href, label]) =>
      href === current ? (
        <strong key={href}>{label}</strong>
      ) : (
        <a key={href} href={href}>
          {label}
        </a>
      ),
    )}
  </p>
);

const AccountLayout: FC<{
  readonly title: string;
  readonly current: string;
  readonly children?: Child;
}> = ({ title, current, children }) => (
  <Layout title={title}>
    <h2>{title}</h2>
    {children}
    <AccountNav current={current} />
  </Layout>
);

// ---------------------------------------------------------------- プロフィール

const STATUS_LABEL: Readonly<Record<UserProfile["status"], string>> = {
  active: "有効",
  suspended: "停止中",
  deleted: "削除済み",
};

export const ProfilePage: FC<{ readonly profile: UserProfile }> = ({ profile }) => (
  <AccountLayout title="プロフィール" current="/account">
    <ul class="scopes">
      <li class="identity">
        <strong>{profile.displayName}</strong>
        <span>@{profile.username}</span>
      </li>
      <li class="identity">
        <strong>{profile.email}</strong>
        <span>{profile.emailVerified ? "確認済み" : "未確認"}</span>
      </li>
      <li class="identity">
        <strong>アカウント</strong>
        <span>
          {STATUS_LABEL[profile.status]} ・ {toDate(profile.createdAt)} 作成
        </span>
      </li>
    </ul>
    <p class="notice">
      表示名とユーザー名の変更は、現在このページからは行えません。
      <code>PATCH /account/api/me</code> から操作してください。 ユーザー名の変更はログインから 5
      分以内に限られます。
    </p>
  </AccountLayout>
);

// -------------------------------------------------------------- セッション一覧

export const SessionsPage: FC<{ readonly sessions: readonly SessionListItem[] }> = ({
  sessions,
}) => (
  <AccountLayout title="ログイン中の端末" current="/account/sessions">
    {sessions.length === 0 ? (
      <p class="lead">ログイン中の端末はありません。</p>
    ) : (
      <ul class="scopes">
        {sessions.map((session) => (
          <li class="identity" key={session.sessionId}>
            <strong>{session.current ? "この端末" : (session.userAgent ?? "不明な端末")}</strong>
            {session.current && session.userAgent !== null ? (
              <span>{session.userAgent}</span>
            ) : null}
            <span>
              {toDate(session.createdAt)} ログイン ・ 最終 {toDate(session.lastSeenAt)} ・{" "}
              {toDate(session.expiresAt)} まで
            </span>
          </li>
        ))}
      </ul>
    )}
    <p class="notice">
      身に覚えのない端末があれば失効させてください。失効は
      <code>DELETE /account/api/me/sessions/:id</code> から行えます。
    </p>
  </AccountLayout>
);

// ------------------------------------------------------------------ パスキー

export const PasskeysPage: FC<{ readonly passkeys: readonly PasskeySummary[] }> = ({
  passkeys,
}) => (
  <AccountLayout title="パスキー" current="/account/passkeys">
    {passkeys.length === 0 ? (
      <p class="lead">
        パスキーは登録されていません。登録すると、メールを使わずにログインできます。
      </p>
    ) : (
      <ul class="scopes">
        {passkeys.map((passkey) => (
          <li class="identity" key={passkey.id}>
            <strong>{passkey.label ?? "名称未設定"}</strong>
            <span>
              {passkey.deviceType ?? "種別不明"} ・ {toDate(passkey.createdAt)} 登録
              {passkey.lastUsedAt === null
                ? " ・ 未使用"
                : ` ・ 最終 ${toDate(passkey.lastUsedAt)}`}
            </span>
          </li>
        ))}
      </ul>
    )}
    <p class="notice">
      最後の 1 本も削除できます。メールでのログインが残るためです。 削除はログインから 5
      分以内に限られます。
    </p>
  </AccountLayout>
);

// ---------------------------------------------------------------- 連携アプリ

export const GrantsPage: FC<{ readonly grants: readonly GrantListItem[] }> = ({ grants }) => (
  <AccountLayout title="連携アプリ" current="/account/grants">
    {grants.length === 0 ? (
      <p class="lead">連携しているアプリはありません。</p>
    ) : (
      <ul class="scopes">
        {grants.map((grant) => (
          <li class="identity" key={grant.clientId}>
            {/* logoUrl は表示しない。外部ホストの画像を読むと、この画面を
                開いた事実が第三者へ渡る（同意画面が img-src を絞っているのと
                同じ理由）。 */}
            <strong>{grant.clientName}</strong>
            <span>{toDate(grant.grantedAt)} 許可</span>
            <span>{grant.scopes.join(" ")}</span>
          </li>
        ))}
      </ul>
    )}
    <p class="notice">
      許可の取り消しは <code>DELETE /account/api/me/grants/:clientId</code> から行えます。
    </p>
  </AccountLayout>
);
