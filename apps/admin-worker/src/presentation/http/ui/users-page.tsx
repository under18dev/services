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
} from "@u18/web-ui/kiwa";
import {
  EMPTY_CLASS,
  FIELD_CLASS,
  INPUT_CLASS,
  ITEM_ACTIONS_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  ITEM_TITLE_CLASS,
  LABEL_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
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
 */

export type UsersPageProps = {
  /**
   * いま開いている管理者の `userId`（`session.sub`）。**自分の行に
   * 停止を出さないため。**
   *
   * 守っているのはここではない（auth-worker が `conflict` を返す）。
   * **押せるのに断られる形にしない**ための表示上の配慮である。
   */
  readonly actorUserId: string;
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

/**
 * 1 行ぶんの操作。
 *
 * ## 停止には理由を選ばせる
 *
 * **`status` は `suspended` の 1 値しか持たない。** ランブック §11.1 の表が
 * 区別している「侵害の疑いによる緊急停止」と「規約違反による BAN」は、
 * **`audit_logs` にしか残らない。** 選ばせないと、後から「戻してよいのか」
 * を判断する材料が消える。
 *
 * ## 自分の行には停止を出さない
 *
 * 止めた瞬間に自分のセッションが死に、解除する人が居なくなる。
 * auth-worker も `conflict` で弾くが、**押せるのに断られる形にしない。**
 *
 * ## `deleted` には何も出さない
 *
 * 戻せない（個人情報が落ちている）し、止めるものも残っていない。
 */
const UserActions: FC<{
  readonly user: UserAdminSummary;
  readonly csrfToken: string;
  readonly isSelf: boolean;
}> = ({ user, csrfToken, isSelf }) => {
  if (user.status === "deleted") {
    return <p class={ITEM_META_CLASS}>個人情報を削除済みのため、操作できません。</p>;
  }

  return (
    <div class={ITEM_ACTIONS_CLASS}>
      {/*
        **操作ごとに別の `<form>` にする。** `nfc.routes.tsx` と同じ形
        （`/nfc/:cardId/disable` / `/nfc/:cardId/target`）——「どの操作か」を
        1 つの form の `action` フィールドで押し分けていた dashboard-worker
        版と違い、URL が操作を表す。
      */}
      {user.status === "active" ? (
        isSelf ? (
          <p class={ITEM_META_CLASS}>自分のアカウントは停止できません。</p>
        ) : (
          <form method="post" action={`/users/${user.id}/suspend`}>
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="reason" value="compromise" required />{" "}
              侵害の疑い（戻す前提）
            </label>
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="reason" value="abuse" required /> 規約違反
            </label>
            <button type="submit" class="text-sm text-destructive underline underline-offset-4">
              停止する
            </button>
          </form>
        )
      ) : (
        <form method="post" action={`/users/${user.id}/reinstate`}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <button type="submit" class="text-sm text-foreground underline underline-offset-4">
            停止を解除する
          </button>
        </form>
      )}
      {/*
        **停止とは別に置く。** 止めずに切りたいことがある（端末を失くした
        人の救済など）。自分に対しても押せる ——「全端末からログアウト」に
        あたるので、止めるのと違って困らない。
      */}
      <form method="post" action={`/users/${user.id}/revoke-sessions`}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <button type="submit" class="text-sm text-foreground underline underline-offset-4">
          ログイン中の端末を全部切る
        </button>
      </form>
    </div>
  );
};

const UserRow: FC<{
  readonly user: UserAdminSummary;
  readonly csrfToken: string;
  readonly isSelf: boolean;
}> = ({ user, csrfToken, isSelf }) => (
  <TableRow>
    <TableCell class="whitespace-normal">
      <div class={ITEM_TITLE_CLASS}>
        <span>{user.displayName}</span>
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
      <span class={ITEM_RAW_CLASS}>{user.id}</span>
    </TableCell>
    <TableCell class="whitespace-normal">
      <UserActions user={user} csrfToken={csrfToken} isSelf={isSelf} />
    </TableCell>
  </TableRow>
);

export const UsersPage: FC<UsersPageProps> = ({
  actorUserId,
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
    lead="u18 に登録されている利用者を探します。"
    maxWidth="max-w-6xl"
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
            <button type="submit" class="text-sm text-foreground underline underline-offset-4">
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>利用者</TableHead>
                <TableHead>メールアドレス</TableHead>
                <TableHead>状態</TableHead>
                <TableHead>登録</TableHead>
                <TableHead>ID</TableHead>
                {/*
                  **見出しを空にしない。** 読み上げで「列が 6 つある」と
                  分かっても、最後の列が何かは分からない。
                */}
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <UserRow user={user} csrfToken={csrfToken} isSelf={user.id === actorUserId} />
              ))}
            </TableBody>
          </Table>
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
            <button type="submit" class="text-sm text-foreground underline underline-offset-4">
              続きを読む
            </button>
          </form>
        )}
      </CardContent>
    </Card>
  </KiwaShell>
);
