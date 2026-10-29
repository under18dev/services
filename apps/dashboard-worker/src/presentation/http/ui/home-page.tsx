import type { FC } from "hono/jsx";
import { GRANTS_PATH, PASSKEYS_PATH, PROFILE_PATH, SESSIONS_PATH } from "./asset-paths";
import { DashboardShell } from "./dashboard-shell";

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
 * ## 「未読」や「お知らせ」をまだ置かない
 *
 * 置く中身が無い。**空の枠を先に作ると、埋まっていないことが画面から
 * 読めなくなる**（#306 で踏んだ「API はあるのに入口が無い」の逆向き）。
 */

export type HomePageProps = {
  readonly displayName: string;
  readonly passkeyCount: number;
  readonly sessionCount: number;
  readonly grantCount: number;
};

type Tile = { readonly href: string; readonly value: number; readonly label: string };

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
    <DashboardShell
      title="ホーム"
      heading={`こんにちは、${displayName} さん`}
      lead="u18 Identity のアカウントと、連携しているアプリを管理できます。"
      current="home"
    >
      <div class="cards cards-3">
        {tiles.map((tile) => (
          <div key={tile.href} class="panel">
            <a class="stat" href={tile.href}>
              <span class="stat-value">{tile.value}</span>
              <span class="stat-label">{tile.label}</span>
            </a>
          </div>
        ))}
      </div>

      {passkeyCount === 0 && (
        <div class="panel" style="margin-top:1.25rem">
          <div class="panel-header">
            <h2 class="panel-title">パスキーを登録してください</h2>
            <p class="panel-desc">
              いまログインできる手段はメールに届くコードだけです。受信箱を使えなくなると、
              アカウントに入れなくなります。
            </p>
          </div>
          <div class="panel-body">
            <a class="button button-secondary button-small" href={PASSKEYS_PATH}>
              パスキーの設定へ
            </a>
          </div>
        </div>
      )}

      <div class="panel" style="margin-top:1.25rem">
        <div class="panel-header">
          <h2 class="panel-title">アカウント</h2>
          <p class="panel-desc">登録情報の確認と、ログイン手段の管理。</p>
        </div>
        <div class="panel-body">
          <ul class="list">
            <li>
              <div class="item-main">
                <div class="item-title">
                  <a href={PROFILE_PATH}>プロフィール</a>
                </div>
                <p class="item-meta">表示名・ユーザー名・メールアドレス</p>
              </div>
            </li>
            <li>
              <div class="item-main">
                <div class="item-title">
                  <a href={SESSIONS_PATH}>ログイン中の端末</a>
                </div>
                <p class="item-meta">身に覚えのない端末を切る</p>
              </div>
            </li>
            <li>
              <div class="item-main">
                <div class="item-title">
                  <a href={GRANTS_PATH}>連携アプリ</a>
                </div>
                <p class="item-meta">アクセスを許可したアプリと、その権限</p>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </DashboardShell>
  );
};
