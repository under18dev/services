import type { PasskeySummary } from "@u18/contracts";
import { Card, CardContent, CardFooter, Separator } from "@u18/web-ui/kiwa";
import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { ISLAND_PATH } from "./asset-paths";
import { formatDateTime } from "./format";
import {
  EMPTY_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_TITLE_CLASS,
  LIST_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
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

export type PasskeysPageProps = {
  readonly passkeys: readonly PasskeySummary[];
  /** 管理の節を出すか（#333）。`AccountShell` が必須にしている。 */
  readonly isAdmin: boolean;
};

export const PasskeysPage: FC<PasskeysPageProps> = ({ passkeys, isAdmin }) => (
  <AccountShell
    isAdmin={isAdmin}
    title="パスキー"
    heading="パスキー"
    lead="この一覧にある認証器でログインできます。身に覚えのないものがあれば削除してください。"
    current="passkeys"
    scripts={[ISLAND_PATH]}
    hasRevokeActions
  >
    <Card>
      <CardContent>
        {passkeys.length === 0 ? (
          // 形も文言もアイランドが作る側と揃える（`grants-page.tsx` を参照）。
          <p class={EMPTY_CLASS} {...{ [EMPTY_ATTR]: "" }}>
            登録されているパスキーはありません。
          </p>
        ) : (
          <ul class={LIST_CLASS} {...{ [EMPTY_TEXT_ATTR]: "登録されているパスキーはありません。" }}>
            {passkeys.map((passkey, index) => (
              <li key={passkey.id} data-passkey-id={passkey.id}>
                {index > 0 && <Separator class="my-3" />}
                <div class={ITEM_BODY_CLASS} {...{ [ITEM_BODY_ATTR]: "" }}>
                  <div class={ITEM_TITLE_CLASS} {...{ [ITEM_TITLE_ATTR]: "" }}>
                    {passkeyTitle(passkey)}
                  </div>
                  <p class={ITEM_META_CLASS}>
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
      </CardContent>
      {/*
        **一覧の外に置く。** 中に入れると 0 件のとき「ありません」の表示へ
        差し替わって消える —— **1 本も無い人こそ登録したい。**
      */}
      <CardFooter data-passkey-register />
    </Card>
  </AccountShell>
);
