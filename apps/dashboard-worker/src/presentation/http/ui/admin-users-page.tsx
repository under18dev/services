import type { UserAdminSummary } from "@u18/contracts";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@u18/web-ui/kiwa";
import {
  EMPTY_CLASS,
  FIELD_CLASS,
  INPUT_CLASS,
  ITEM_BODY_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  ITEM_TITLE_CLASS,
  LABEL_CLASS,
  LIST_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { AccountShell } from "./account-shell";
import { ADMIN_USERS_SEARCH_PATH } from "./asset-paths";
import { CSRF_FIELD_NAME } from "../csrf";
import { formatDateTime } from "./format";

/**
 * 利用者の管理（`/account/admin/users`、#375 / #382）。**管理者だけ。**
 *
 * ## これは他人の個人情報を出す最初の画面である
 *
 * `/account/*` の他の画面は、どれも**開いている本人のもの**しか出さない。
 * ここだけが違う。縛っていることが 3 つある。
 *
 * 1. **検索語を URL に載せない。** メールアドレスで引くので、クエリに
 *    置くと履歴・Referer・`csrf.ts` の拒否ログ（`pathname`）に残る。
 *    form POST の本文で渡す
 * 2. **`Cache-Control: no-store`** —— dashboard の `root.use("*")` が
 *    既定で付ける。**ここで上書きしないこと**
 * 3. **一覧に操作を置いていない。** いまは読むだけ。凍結やセッションの
 *    失効は、**取り消せるか・何が止まるか**を決めてから別の PR で足す
 *
 * ## 何ができないかを画面に書かない
 *
 * #382 が消そうとしているのが「この画面からはできません」という文言
 * なので、**同じものをここに新しく書かない。** 足りないものは issue に
 * 書いてある。
 *
 * ## JS を 1 行も要求しない
 *
 * 検索も続きの読み込みも form POST である。管理の画面こそ、JS が落ちた
 * ときに使えなくなって困る（障害対応で開く画面である）。
 */

export type AdminUsersPageProps = {
  readonly isAdmin: boolean;
  readonly csrfToken: string;
  readonly users: readonly UserAdminSummary[];
  /** 続きがあるときだけ。**「次へ」の form に積む。** */
  readonly nextCursor: string | null;
  /** いま絞り込んでいる語。**再描画で入力欄に残す。** */
  readonly query?: string;
  readonly error?: string;
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

const UserRow: FC<{ readonly user: UserAdminSummary }> = ({ user }) => (
  <li class={ITEM_BODY_CLASS}>
    <div class={ITEM_TITLE_CLASS}>
      <span>{user.displayName}</span>
      <StatusBadge status={user.status} />
      {user.hasAdminFlag ? <Badge variant="outline-primary">管理者</Badge> : null}
      {user.emailVerified ? null : <Badge variant="outline">メール未確認</Badge>}
    </div>
    <p class={ITEM_META_CLASS}>@{user.username}</p>
    {/*
      **メールアドレスをリンクにしない。** `mailto:` は押した先が
      利用者の端末のメールクライアントで、**管理画面から誤って本人へ
      送る導線**になる。問い合わせ対応では既にメールの画面を開いている。
    */}
    <p class={ITEM_RAW_CLASS}>{user.primaryEmail}</p>
    <p class={ITEM_META_CLASS}>登録 {formatDateTime(user.createdAt)}</p>
    {/*
      **内部 ID を出す。** 凍結やセッションの失効を足したときの宛先が
      これになるうえ、いまも `wrangler d1 execute` で調べるときに要る
      （この画面が SQL を置き換えきるまでの間、両方が使われる）。
    */}
    <p class={ITEM_RAW_CLASS}>{user.id}</p>
  </li>
);

export const AdminUsersPage: FC<AdminUsersPageProps> = ({
  isAdmin,
  csrfToken,
  users,
  nextCursor,
  query,
  error,
}) => (
  <AccountShell
    isAdmin={isAdmin}
    title="利用者"
    heading="利用者"
    lead="u18 に登録されている利用者を探します。"
    current="users"
  >
    {error === undefined ? null : (
      <Card>
        <CardContent>
          <p class={ITEM_META_CLASS}>{error}</p>
        </CardContent>
      </Card>
    )}

    <Card>
      <CardHeader>
        <CardTitle>探す</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action={ADMIN_USERS_SEARCH_PATH} class={ITEM_BODY_CLASS}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <label class={FIELD_CLASS}>
            <span class={LABEL_CLASS}>メールアドレスか、ユーザー名</span>
            {/*
              **完全一致で引く。** 部分一致を持たないのは、索引から外れて
              全表走査になるうえ、**管理者が思っていない行まで拾う**ため
              （契約の `listUsersInputSchema`）。
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
        {users.length === 0 ? (
          <p class={EMPTY_CLASS}>一致する利用者はいません。</p>
        ) : (
          <ul class={LIST_CLASS}>
            {users.map((user) => (
              <UserRow user={user} />
            ))}
          </ul>
        )}
        {nextCursor === null ? null : (
          /*
            **続きも form POST。** `?cursor=...` にすると、絞り込みの語を
            一緒に運ぶために**検索語まで URL へ出る。**
          */
          <form method="post" action={ADMIN_USERS_SEARCH_PATH}>
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
  </AccountShell>
);
