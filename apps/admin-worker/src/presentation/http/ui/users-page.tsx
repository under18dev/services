import type { UserAdminSummary } from "@u18/contracts";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  KiwaShell,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  getButtonClasses,
} from "@u18/web-ui/kiwa";
import {
  EMPTY_CLASS,
  FIELD_CLASS,
  INPUT_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  ITEM_TITLE_CLASS,
  LABEL_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * 利用者の管理（`admin.under18.dev/users`、#375 / #382 / #390 決定 16 ③）。
 *
 * **`/account/admin/users`（dashboard-worker、#375 / #387）から移した。**
 * 画面の中身はそのまま持ってきている。変わったのは呼び方
 * （`sessionToken` 経由の `IdentityAdminRPC` → `actorUserId` 経由の
 * `IdentityAdminDelegatedRPC`）と置き場所だけ。
 *
 * ## これは他人の個人情報を出す最初の admin-worker 画面である
 *
 * 移行元と同じ縛りを維持する。
 *
 * 1. **検索語を URL に載せない。** メールアドレスで引くので、クエリに
 *    置くと履歴・Referer・`csrf.ts` の拒否ログ（`pathname`）に残る。
 *    form POST の本文で渡す
 * 2. **`Cache-Control: no-store`。** 呼び出し側（`users.routes.tsx`）が付ける
 * 3. **JS を 1 行も要求しない。** 検索も続きの読み込みも form POST
 *
 * ## `isAdmin` 相当の分岐を持たない
 *
 * dashboard-worker 版は `AccountShell` に `isAdmin` を渡し、画面の内側で
 * 管理者かどうかの出し分けをしていた。admin-worker はセッションガード
 * （`app.ts`）が既に「承認済みの管理者である」ことを確かめたあとにしか
 * 画面へ来ないので、渡す理由が無い。
 *
 * ## 行内の操作はこの画面から消した（#489）
 *
 * 運用者の指示（#481、カード一覧について。`/users` にも同じ形が残って
 * いた）: 一覧からは 1 人ずつ操作できなくていい、詳細ページから
 * やる。**停止・停止の解除・ログイン中の端末を全部切るは
 * `/users/:userId`（#455）へ寄せた。** `POST /users/:userId/suspend` /
 * `/reinstate` / `/revoke-sessions` のルート自体は消していない——詳細
 * ページが使う（`cameFromDetail` で戻り先を振り分ける既存の仕組みは
 * そのまま。本体は `users.routes.tsx`）。
 *
 * **`/nfc`（#481）・`/clients`（#508）と同じ判断。** `/users` は選択・
 * 一括操作が要らない（利用者をまとめて止める場面が思い当たらない）ので、
 * 行内操作を外すだけで片付く。
 */

export type UsersPageProps = {
  readonly csrfToken: string;
  readonly users: readonly UserAdminSummary[];
  /** 続きがあるときだけ。**「次へ」の form に積む。** */
  readonly nextCursor: string | null;
  /** いま絞り込んでいる語。**再描画で入力欄に残す。** */
  readonly query?: string;
  readonly error?: string;
  /** 直前の操作が通ったときの 1 文。 */
  readonly notice?: string;
};

/**
 * `status` の見せ方。
 *
 * **`suspended` を「凍結」と言い切らない。** あの値は運営による凍結と
 * 本人の退会（#318）の両方で付く。区別は `audit_logs` の
 * `account.closed` が持っていて、**この行からは分からない。**
 */
const StatusBadge: FC<{ readonly status: UserAdminSummary["status"] }> = ({ status }) => {
  if (status === "active") return <Badge variant="success">有効</Badge>;
  if (status === "deleted") return <Badge variant="destructive">削除済み</Badge>;
  return <Badge variant="warning">停止中</Badge>;
};

/** 1 行ぶん。**操作は持たない**（#489）——停止・解除・端末の失効は詳細へ。 */
const UserRow: FC<{
  readonly user: UserAdminSummary;
}> = ({ user }) => (
  <TableRow>
    <TableCell class="whitespace-normal">
      <div class={ITEM_TITLE_CLASS}>
        {/*
          **行から詳細へ入る導線**（#455）。停止・解除・セッションの失効は
          詳細ページだけが持つ（#489）——一覧は「押す前に確かめる材料」を
          持たないので、確かめずに押せる場所を残さない。名前を入口に
          しているのは、運用者が探しているのが「この人」だからである
          （ID 列は文字列そのものを読む・コピーする場所なので、リンクに
          しない）。
        */}
        <a href={`/users/${user.id}`} class="underline underline-offset-4">
          {user.displayName}
        </a>
        {user.hasAdminFlag ? <Badge variant="outline-primary">管理者</Badge> : null}
        {user.emailVerified ? null : <Badge variant="outline">メール未確認</Badge>}
      </div>
      <p class={ITEM_META_CLASS}>@{user.username}</p>
    </TableCell>
    {/*
      **メールアドレスをリンクにしない。** `mailto:` は押した先が
      利用者の端末のメールクライアントで、**管理画面から誤って本人へ
      送る導線**になる。問い合わせ対応では既にメールの画面を開いている。
    */}
    <TableCell class="whitespace-normal">
      <span class={ITEM_RAW_CLASS}>{user.primaryEmail}</span>
    </TableCell>
    <TableCell>
      <StatusBadge status={user.status} />
    </TableCell>
    <TableCell>{formatDateTime(user.createdAt)}</TableCell>
    {/*
     **内部 ID を出す。** 停止やセッションの失効の宛先がこれになる。
     */}
    <TableCell class="whitespace-normal">
      <span class={ITEM_RAW_CLASS}>{user.id}</span>{" "}
      {/* コピー用（#470）。JS が外すまでは存在しない。 */}
      <button type="button" data-copy={user.id} hidden class="text-xs underline">
        コピー
      </button>
    </TableCell>
  </TableRow>
);

export const UsersPage: FC<UsersPageProps> = ({
  csrfToken,
  users,
  nextCursor,
  query,
  error,
  notice,
}) => (
  <KiwaShell
    title="利用者"
    nav={ADMIN_NAV_GROUPS}
    current="users"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="利用者"
    lead="表示名を押すと詳細が開き、停止・停止の解除・ログイン中の端末を全部切るはそこから行います。この画面は検索・並べ替えが主な役目です。"
    scripts={[ISLAND_PATH]}
  >
    {error === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS}>{error}</p>
        </CardContent>
      </Card>
    )}
    {notice === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS}>{notice}</p>
        </CardContent>
      </Card>
    )}

    <Card>
      <CardHeader>
        <CardTitle>探す</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action="/users/search" class={ITEM_BODY_CLASS}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>メールアドレスか、ユーザー名</span>
            {/*
              **完全一致で引く。** 部分一致を持たないのは、索引から外れて
              全表走査になるうえ、**管理者が思っていない行まで拾う**ため
              （契約の `listUsersDelegatedInputSchema`）。
            */}
            <input
              class={INPUT_CLASS}
              type="text"
              name="query"
              maxlength={320}
              value={query ?? ""}
              autocomplete="off"
            />
          </label>
          <p class={ITEM_META_CLASS}>
            完全に一致するものだけが出ます。空のまま押すと、新しい順に表示します。
          </p>
          <div>
            <button type="submit" class={getButtonClasses("outline")}>
              探す
            </button>
          </div>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>
          {query === undefined || query === "" ? "新しい順" : `「${query}」に一致する利用者`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/*
          **0 件なら表を描かない。** ヘッダ行だけが残る表は「列はあるのに
          中身が無い」と読め、取得に失敗したようにも見える。
        */}
        {users.length === 0 ? (
          <p class={EMPTY_CLASS}>一致する利用者はいません。</p>
        ) : (
          <>
            {/*
              絞り込み欄（#470）。**`hidden` で描く——JS が無ければ存在しない
              ものとして読める。JS がこれを外して使えるようにする。
            */}
            <input
              type="text"
              data-filter="users-table"
              hidden
              placeholder="絞り込む"
              aria-label="利用者の一覧を絞り込む"
              class={`${INPUT_CLASS} mb-2`}
            />
            <Table id="users-table" data-sortable>
              <TableHeader>
                <TableRow>
                  <TableHead data-sort="text">利用者</TableHead>
                  <TableHead data-sort="text">メールアドレス</TableHead>
                  <TableHead data-sort="text">状態</TableHead>
                  <TableHead data-sort="date">登録</TableHead>
                  <TableHead data-sort="text">ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <UserRow user={user} />
                ))}
              </TableBody>
            </Table>
          </>
        )}
        {nextCursor === null ? null : (
          /*
            **続きも form POST。** `?cursor=...` にすると、絞り込みの語を
            一緒に運ぶために**検索語まで URL へ出る。**
          */
          <form method="post" action="/users/search">
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <input type="hidden" name="cursor" value={nextCursor} />
            <input type="hidden" name="query" value={query ?? ""} />
            <button type="submit" class={getButtonClasses("ghost")}>
              続きを読む
            </button>
          </form>
        )}
      </CardContent>
    </Card>
  </KiwaShell>
);
