import type { PasskeySummary } from "@u18/contracts";
import type { FC } from "hono/jsx";
import { ISLAND_PATH } from "./asset-paths";
import { DashboardShell } from "./dashboard-shell";
import { formatDateTime } from "./format";
import { EMPTY_ATTR, EMPTY_TEXT_ATTR, ITEM_BODY_ATTR, ITEM_TITLE_ATTR } from "./island-hooks";

/**
 * パスキー（`/account/passkeys`、#308）。
 *
 * **登録ボタンはアイランドが作る**（#306）。サーバーは目印の `<div>` だけ
 * 描く —— JS が無い・読み込みに失敗した・認証器が使えない端末、のどれでも
 * 「押しても効かないボタン」が残らないようにするため。
 */

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
 * 知らない値はそのまま出す —— 「その他」に畳むと、**知らない種別の
 * 認証器が登録されていること自体が画面から消える。**
 */
function deviceTypeLabel(deviceType: string): string {
  if (deviceType === "platform" || deviceType === "singleDevice") return "この端末に保存";
  if (deviceType === "cross-platform" || deviceType === "multiDevice") {
    return "他の端末・セキュリティキー";
  }
  return deviceType;
}

export type PasskeysPageProps = { readonly passkeys: readonly PasskeySummary[] };

export const PasskeysPage: FC<PasskeysPageProps> = ({ passkeys }) => (
  <DashboardShell
    title="パスキー"
    heading="パスキー"
    lead="この一覧にある認証器でログインできます。身に覚えのないものがあれば削除してください。"
    current="passkeys"
    scripts={[ISLAND_PATH]}
    hasRevokeActions
  >
    <div class="panel">
      <div class="panel-body">
        {passkeys.length === 0 ? (
          <p class="empty" {...{ [EMPTY_ATTR]: "" }}>
            登録されているパスキーはありません。
          </p>
        ) : (
          <ul class="list" {...{ [EMPTY_TEXT_ATTR]: "登録されているパスキーはありません。" }}>
            {passkeys.map((passkey) => (
              <li key={passkey.id} data-passkey-id={passkey.id}>
                <div class="item-main" {...{ [ITEM_BODY_ATTR]: "" }}>
                  <div class="item-title" {...{ [ITEM_TITLE_ATTR]: "" }}>
                    {passkeyTitle(passkey)}
                  </div>
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
      </div>
      {/*
        **一覧の外に置く。** 中に入れると 0 件のとき `<p class="empty" {...{ [EMPTY_ATTR]: "" }}>` へ
        差し替わって消える —— **1 本も無い人こそ登録したい。**
      */}
      <div class="panel-footer" data-passkey-register />
    </div>
  </DashboardShell>
);
