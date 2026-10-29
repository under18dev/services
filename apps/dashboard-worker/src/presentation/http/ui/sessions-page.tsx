import type { SessionListItem } from "@u18/contracts";
import type { FC } from "hono/jsx";
import { DashboardShell } from "./dashboard-shell";
import { ISLAND_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import { summarizeUserAgent } from "./user-agent";

/**
 * ログイン中の端末（`/account/sessions`）。
 *
 * ## User-Agent は要約と原文の両方を出す
 *
 * 見出しは「Chrome / macOS」のような要約、その下に**元の文字列をそのまま**
 * 出す。この画面の用途は「身に覚えのない端末を見つけて切る」ことなので、
 * 拾い読みできる必要があり、同時に**要約が当たっているかを確かめる手段**も
 * 残っている必要がある（User-Agent は自己申告で、攻撃者は好きな値を送れる）。
 *
 * 要約だけだと確かめる手段が消え、原文だけだと 1 件が 2 行になって
 * 「どれが自分か」を見分ける作業そのものが重くなる。判定の詳細は
 * `user-agent.ts`。
 *
 * **エスケープは hono/jsx が行う。** User-Agent は利用者が自由に決められる
 * 値（攻撃者が自分で送れる）なので、`raw()` を使わないこと。
 *
 * ## IP アドレスは出ない
 *
 * `SessionListItem` に IP もそのハッシュも載っていない（contracts
 * `identity.ts`）。この Worker は DTO を加工せず渡すだけなので、
 * ここに出せる IP は最初から無い。
 */

/** 見出しに出す名前。要約できなければ元の文字列、それも無ければ「不明な端末」。 */
function titleFor(userAgent: string | null): string {
  if (userAgent === null || userAgent === "") return "不明な端末";
  return summarizeUserAgent(userAgent) ?? userAgent;
}

export type SessionsPageProps = {
  readonly sessions: readonly SessionListItem[];
};

export const SessionsPage: FC<SessionsPageProps> = ({ sessions }) => (
  <DashboardShell
    title="ログイン中の端末"
    heading="ログイン中の端末"
    current="sessions"
    scripts={[ISLAND_PATH]}
    hasRevokeActions
  >
    <div class="panel">
      <div class="panel-body">
        <p class="section-lead">
          現在ログインしているセッションの一覧です。身に覚えのないものがあればログアウトしてください。
        </p>
        {sessions.length === 0 ? (
          // 自分のセッションで見ている以上、普通は 0 件にならない。
          <p class="empty">表示できるセッションがありません。</p>
        ) : (
          // `data-*` はアイランドがボタンを付ける目印（`client/account-island.ts`）。
          // 空になったときの文言もここに置く —— アイランドに日本語を持たせない。
          <ul class="list" data-empty-text="表示できるセッションがありません。">
            {sessions.map((session) => (
              <li
                key={session.sessionId}
                data-session-id={session.sessionId}
                // 自分自身を切ったらサーバーが Cookie を落とすので、
                // アイランドはログイン画面へ送る必要がある。
                data-current={session.current ? "true" : "false"}
              >
                <div class="item-main">
                  <div class="item-title">
                    {titleFor(session.userAgent)}
                    {session.current && <span class="badge">このブラウザ</span>}
                  </div>
                  {/* 見出しが要約になったときだけ、原文を併記する。 */}
                  {session.userAgent !== null &&
                    titleFor(session.userAgent) !== session.userAgent && (
                      <p class="item-raw">{session.userAgent}</p>
                    )}
                  <p class="item-meta">
                    ログイン {formatDateTime(session.createdAt)}
                    {" / "}
                    最終アクセス {formatDateTime(session.lastSeenAt)}
                    {" / "}
                    期限 {formatDateTime(session.expiresAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  </DashboardShell>
);
