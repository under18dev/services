import type { AdminCardViewDelegated, AuditLogEntryAdmin, UserAdminSummary } from "@u18/contracts";
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardDescription,
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
  DANGER_BUTTON_CLASS,
  EMPTY_CLASS,
  ITEM_ACTIONS_CLASS,
  ITEM_META_CLASS,
  ITEM_RAW_CLASS,
  ITEM_TITLE_CLASS,
  LABEL_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "../csrf";
import type { SuspensionOrigin } from "../suspension-origin";
import { ADMIN_NAV_GROUPS } from "./nav";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { formatDateTime } from "./format";

/**
 * 利用者 1 人の詳細（`admin.under18.dev/users/:userId`、#455）。
 *
 * **一覧（`users-page.tsx`）には「押す前に確かめる材料」が無かった。**
 * 凍結・解除・セッションの失効は一覧の行から押せるが、**その人が
 * いまどういう状態で、なぜ止まっているのか**は行からは読めない。
 * この画面は、同じ操作を**確かめた直後に押せる場所**へ置き直したもの。
 *
 * ## いちばん大事なのは「なぜ止まっているか」である
 *
 * `status` の `suspended` は、運営による凍結と本人の退会（#318）の
 * **両方で付く**（`UserAdminSummary.status` のコメント）。取り違えたとき
 * の被害が非対称で、**退会した人を「解除」すると、辞めた人のアカウントを
 * 勝手に復活させることになる。** 判定は `suspension-origin.ts` に出して
 * あり、ここはその結果を表示するだけである。
 *
 * ## メールアドレスを出す条件（`identity-admin.ts` の「メールアドレスを
 * 載せる」節）
 *
 * **他人のアドレスを出す画面なので、置き場所を縛る。**
 *
 * 1. **`Cache-Control: no-store`** —— 呼び出し側（`users.routes.tsx`）が付ける
 * 2. **URL に載せない** —— この画面が URL に持つのは `userId` だけで、
 *    アドレスは本文にしか出ない（`csrf.ts` は拒否のログに `pathname` を
 *    書く。アドレスが URL にあると、そこへ流れ込む）
 * 3. **検索はこの画面にない** —— 一覧の form POST から `userId` で来る
 *
 * ## タップ回数を出さない（#394 / #454）
 *
 * カードの表に「何回タップされたか」の列を作らない。`nfc_card_taps` は
 * 「誰が使ったか」を持たない設計で、**所有者ごとに数えると「この人が
 * 何回使ったか」になる。** 契約（`AdminCardViewDelegated`）にも項目が
 * 無いので、ここで足そうとしても渡す値が無い。
 *
 * ## 遷移先 URL をリンクにしない（`nfc-page.tsx` と同じ理由）
 *
 * `target_url` は利用者が自由に入れた外部 URL である。リンクにすると、
 * カードを奪った側が遷移先を変え、確認しに来た運営に踏ませる経路になる。
 */

export type UserDetailPageProps = {
  readonly csrfToken: string;
  /** いま開いている管理者の `userId`（`session.sub`）。**自分の行に停止を出さないため。** */
  readonly actorUserId: string;
  readonly user: UserAdminSummary;
  /**
   * `suspended` のときだけ意味を持つ。`active` / `deleted` では
   * `{ kind: "unknown" }` が渡るが、画面はそもそも節を出さない。
   */
  readonly suspension: SuspensionOrigin;
  /** 直近の監査ログ。**引けなかったら `null`**（空配列と区別する）。 */
  readonly auditEntries: readonly AuditLogEntryAdmin[] | null;
  /** 持っているカード。**引けなかったら `null`**（同上）。 */
  readonly cards: readonly AdminCardViewDelegated[] | null;
  readonly error?: string;
  readonly notice?: string;
};

/** 一覧（`users-page.tsx`）と同じ見せ方。**`suspended` を「凍結」と言い切らない。** */
const StatusBadge: FC<{ readonly status: UserAdminSummary["status"] }> = ({ status }) => {
  if (status === "active") return <Badge variant="success">有効</Badge>;
  if (status === "deleted") return <Badge variant="destructive">削除済み</Badge>;
  return <Badge variant="warning">停止中</Badge>;
};

/** 一覧（`users-page.tsx`）の停止フォームと同じ語。ここだけ別の言い方にしない。 */
const SUSPEND_REASON_LABEL = {
  compromise: "侵害の疑い（戻す前提）",
  abuse: "規約違反",
} as const;

/**
 * **この節がこの画面の主役である。**
 *
 * 4 つの状態を**同じ重さで書かない。** 「本人が退会した」だけが
 * 「解除してはいけない」を意味するので、そこだけ `Alert` で立てる。
 * 残りの 3 つは、断定できる／できないの差でしかない。
 */
const SuspensionReason: FC<{ readonly suspension: SuspensionOrigin }> = ({ suspension }) => {
  if (suspension.kind === "self_closed") {
    return (
      <Alert>
        <AlertDescription>
          <strong>本人が退会した結果の停止です（{formatDateTime(suspension.at)}）。</strong>
          運営が止めたわけではありません。
          <strong>解除すると、辞めた人のアカウントを本人の意思に反して戻すことになります。</strong>
        </AlertDescription>
      </Alert>
    );
  }

  if (suspension.kind === "ops") {
    return (
      <>
        <p>
          <strong>運営が停止しました。</strong>
          {suspension.reason === null
            ? "理由は記録から読み取れませんでした。"
            : `理由は「${SUSPEND_REASON_LABEL[suspension.reason]}」です。`}
        </p>
        <p class={ITEM_META_CLASS}>{formatDateTime(suspension.at)}</p>
      </>
    );
  }

  if (suspension.kind === "unavailable") {
    return (
      <p>
        <strong>いま監査ログを読めないため、理由を確かめられません。</strong>
        運営による停止か、本人の退会かが分かりません。
        <strong>解除する前に、もう一度このページを開いてください。</strong>
      </p>
    );
  }

  return (
    <p>
      <strong>どちらの理由による停止か分かりませんでした。</strong>
      運営による停止（<code class={ITEM_RAW_CLASS}>ops.user.suspended</code>）も、本人の退会（
      <code class={ITEM_RAW_CLASS}>account.closed</code>
      ）も記録に見つかりません。下の監査ログを確かめてから操作してください。
    </p>
  );
};

/**
 * 停止・解除・セッションの失効。**一覧の `UserActions` と同じ操作を、
 * 同じ POST 先へ出す。**
 *
 * ## `from=detail` を積む
 *
 * 同じ route（`/users/:userId/suspend` など）を一覧と共有しているので、
 * 戻り先だけをフォームが申告する。積まないと、**確かめてから押した
 * 直後に一覧へ飛ばされ、結果を同じ画面で確かめられない。**
 *
 * ## 退会による停止でも「解除」を隠さない
 *
 * 隠すと、**この画面のほうが一覧より弱くなる** ——一覧の行からは同じ
 * 操作が押せるので、隠しても防げず、「詳細を開くと操作が減る」という
 * 理由の説明できない差だけが残る。代わりに**上の節で警告を立て、
 * ボタンの文言を「それでも停止を解除する」に変える** ——押せること自体は
 * 残し、押すのが意識的な選択になるようにしてある。
 */
const UserActions: FC<{
  readonly user: UserAdminSummary;
  readonly csrfToken: string;
  readonly isSelf: boolean;
  readonly suspension: SuspensionOrigin;
}> = ({ user, csrfToken, isSelf, suspension }) => {
  if (user.status === "deleted") {
    // 一覧と同じ判断。戻せない（個人情報が落ちている）し、止めるものも残っていない。
    return <p class={ITEM_META_CLASS}>個人情報を削除済みのため、操作できません。</p>;
  }

  return (
    <div class={ITEM_ACTIONS_CLASS}>
      {user.status === "active" ? (
        isSelf ? (
          <p class={ITEM_META_CLASS}>自分のアカウントは停止できません。</p>
        ) : (
          <form method="post" action={`/users/${user.id}/suspend`}>
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <input type="hidden" name="from" value="detail" />
            {/*
              **理由を選ばせる。** `status` は 1 値なので、ランブック §11.1 が
              区別している「侵害の疑い」と「規約違反」は `audit_logs` にしか
              残らない。選ばせないと、後から戻してよいかを判断する材料が消える
              ——それはまさに、この画面の上の節が読んでいる記録である。
            */}
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="reason" value="compromise" required />{" "}
              {SUSPEND_REASON_LABEL.compromise}
            </label>
            <label class={ITEM_META_CLASS}>
              <input type="radio" name="reason" value="abuse" required />{" "}
              {SUSPEND_REASON_LABEL.abuse}
            </label>
            <button type="submit" class={DANGER_BUTTON_CLASS}>
              停止する
            </button>
          </form>
        )
      ) : (
        <form method="post" action={`/users/${user.id}/reinstate`}>
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <input type="hidden" name="from" value="detail" />
          <button
            type="submit"
            class={
              suspension.kind === "self_closed"
                ? DANGER_BUTTON_CLASS
                : "text-sm text-foreground underline underline-offset-4"
            }
          >
            {suspension.kind === "self_closed" ? "それでも停止を解除する" : "停止を解除する"}
          </button>
        </form>
      )}
      {/*
        **停止とは別に置く**（一覧と同じ）。止めずに切りたいことがある
        ——端末を失くした人の救済など。自分に対しても押せる。
      */}
      <form method="post" action={`/users/${user.id}/revoke-sessions`}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input type="hidden" name="from" value="detail" />
        <button type="submit" class="text-sm text-foreground underline underline-offset-4">
          ログイン中の端末を全部切る
        </button>
      </form>
    </div>
  );
};

/** 一覧（`nfc-page.tsx`）と同じ割り当て。**色で良し悪しを言わない。** */
const CARD_STATUS_LABEL = {
  issued: "未紐づけ",
  active: "有効",
  disabled: "無効化済み",
} as const;

const CARD_STATUS_VARIANT = {
  issued: "secondary",
  active: "secondary",
  disabled: "destructive",
} as const;

const OwnedCards: FC<{ readonly cards: readonly AdminCardViewDelegated[] | null }> = ({
  cards,
}) => {
  if (cards === null) {
    // **ここだけ取れなくても、本人の要約と監査ログは出ている。**
    // 塊ごとに独立して取っているので、この節だけが欠ける（`app.tsx` の
    // `/` と同じ形）。
    return (
      <p class={EMPTY_CLASS}>いまカードの一覧を取得できません。あとでもう一度開いてください。</p>
    );
  }

  if (cards.length === 0) {
    return <p class={EMPTY_CLASS}>この利用者が持っているカードはありません。</p>;
  }

  return (
    <Table id="owned-cards-table" data-sortable>
      <TableHeader>
        <TableRow>
          <TableHead data-sort="text">カード ID</TableHead>
          <TableHead data-sort="text">状態</TableHead>
          <TableHead data-sort="text">遷移先</TableHead>
          <TableHead data-sort="text">ロット</TableHead>
          <TableHead data-sort="date">発行</TableHead>
          <TableHead data-sort="date">引き取り</TableHead>
          <TableHead>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map((card) => (
          <TableRow key={card.cardId}>
            <TableCell class={ITEM_RAW_CLASS}>{card.cardId}</TableCell>
            <TableCell>
              <Badge variant={CARD_STATUS_VARIANT[card.status]}>
                {CARD_STATUS_LABEL[card.status]}
              </Badge>
            </TableCell>
            <TableCell class="max-w-xs font-mono text-xs break-all whitespace-normal">
              {/* **リンクにしない**（冒頭を参照）。 */}
              {card.targetUrl ?? "未設定"}
            </TableCell>
            <TableCell>{card.batch ?? "—"}</TableCell>
            <TableCell class={ITEM_META_CLASS}>{formatDateTime(card.issuedAt)}</TableCell>
            <TableCell class={ITEM_META_CLASS}>
              {card.claimedAt === null ? "—" : formatDateTime(card.claimedAt)}
            </TableCell>
            {/*
              **カードへの操作はこの画面に持ってこない。** 無効化・復帰・
              遷移先の書き換え・手放させるは `/nfc/:cardId`（カード詳細、
              #472）側の責務で、ここに同じフォームを並べると**同じ操作が
              2 画面に散る**（#433 が `/account/*` から運営向けの画面を
              消した理由と同じ形）。
            */}
            <TableCell>
              <a
                href={`/nfc/${encodeURIComponent(card.cardId)}`}
                class="text-sm text-foreground underline underline-offset-4"
              >
                カードの詳細へ
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const AuditEntries: FC<{ readonly entries: readonly AuditLogEntryAdmin[] | null }> = ({
  entries,
}) => {
  if (entries === null) {
    return <p class={EMPTY_CLASS}>いま監査ログを取得できません。あとでもう一度開いてください。</p>;
  }

  if (entries.length === 0) {
    return <p class={EMPTY_CLASS}>この利用者の記録はありません。</p>;
  }

  return (
    <Table id="audit-entries-table" data-sortable>
      <TableHeader>
        <TableRow>
          <TableHead data-sort="date">日時</TableHead>
          <TableHead data-sort="text">イベント</TableHead>
          <TableHead data-sort="text">結果</TableHead>
          <TableHead>詳細</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>{formatDateTime(entry.createdAt)}</TableCell>
            <TableCell class="whitespace-normal">
              <span class={ITEM_RAW_CLASS}>{entry.event}</span>
            </TableCell>
            <TableCell>
              {entry.outcome === "success" ? (
                <Badge variant="success">成功</Badge>
              ) : (
                <Badge variant="destructive">失敗</Badge>
              )}
            </TableCell>
            {/*
              **`metadata` は生の JSON で出す**（`audit-page.tsx` と同じ理由）。
              イベントごとに形が違うので、固定の表に組むと新しいイベントの
              たびにこの画面も直すことになる。
            */}
            <TableCell class="whitespace-normal">
              {entry.reason === null && entry.metadata === null ? (
                <span class={ITEM_META_CLASS}>—</span>
              ) : (
                <>
                  {entry.reason === null ? null : <p class={ITEM_META_CLASS}>{entry.reason}</p>}
                  {entry.metadata === null ? null : (
                    <pre class={ITEM_RAW_CLASS}>{JSON.stringify(entry.metadata)}</pre>
                  )}
                </>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

export const UserDetailPage: FC<UserDetailPageProps> = ({
  csrfToken,
  actorUserId,
  user,
  suspension,
  auditEntries,
  cards,
  error,
  notice,
}) => (
  <KiwaShell
    title="利用者の詳細"
    nav={ADMIN_NAV_GROUPS}
    current="users"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="利用者の詳細"
    lead="状態と記録を確かめてから、同じ画面で操作できます。"
    maxWidth="max-w-6xl"
    scripts={[ISLAND_PATH]}
  >
    {/*
      **一覧へ戻る導線を上にも置く。** サイドバーの「利用者」でも戻れるが、
      詳細から一覧へ戻るのは最も多い動きで、現在地の節が選ばれている
      サイドバーは「もう居る場所」に見える。
    */}
    <div>
      <a href="/users" class="text-sm text-foreground-muted underline underline-offset-4">
        ← 利用者の一覧へ戻る
      </a>
    </div>

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
        <CardTitle>
          <span class={ITEM_TITLE_CLASS}>
            <span>{user.displayName}</span>
            <StatusBadge status={user.status} />
            {user.hasAdminFlag ? <Badge variant="outline-primary">管理者</Badge> : null}
            {user.emailVerified ? null : <Badge variant="outline">メール未確認</Badge>}
          </span>
        </CardTitle>
        <CardDescription>@{user.username}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl class="grid gap-3 sm:grid-cols-2">
          <div>
            <dt class={LABEL_CLASS}>メールアドレス</dt>
            {/*
              **`mailto:` にしない**（一覧と同じ理由）。押した先が利用者の
              端末のメールクライアントで、管理画面から誤って本人へ送る導線に
              なる。
            */}
            <dd class={ITEM_RAW_CLASS}>{user.primaryEmail}</dd>
          </div>
          <div>
            <dt class={LABEL_CLASS}>利用者 ID</dt>
            {/* **操作の宛先はこれである**（username は本人が変えられる）。 */}
            <dd class={ITEM_RAW_CLASS}>{user.id}</dd>
          </div>
          <div>
            <dt class={LABEL_CLASS}>登録</dt>
            <dd class={ITEM_META_CLASS}>{formatDateTime(user.createdAt)}</dd>
          </div>
          <div>
            <dt class={LABEL_CLASS}>メールの確認</dt>
            <dd class={ITEM_META_CLASS}>{user.emailVerified ? "確認済み" : "未確認"}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>

    {user.status === "suspended" ? (
      <Card>
        <CardHeader>
          <CardTitle>なぜ停止しているか</CardTitle>
          <CardDescription>
            停止は<strong>運営による凍結</strong>と<strong>本人の退会</strong>
            の両方で起こります。状態だけでは区別できないので、監査ログから調べています。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SuspensionReason suspension={suspension} />
        </CardContent>
      </Card>
    ) : null}

    <Card>
      <CardHeader>
        <CardTitle>操作</CardTitle>
      </CardHeader>
      <CardContent>
        <UserActions
          user={user}
          csrfToken={csrfToken}
          isSelf={user.id === actorUserId}
          suspension={suspension}
        />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>持っているカード</CardTitle>
        <CardDescription>
          所有者がこの利用者になっている NFC カードです。
          {/*
            **何回タップされたかは出していない**ことを、画面にも書いておく。
            書かないと「出し忘れ」に見え、次に見た人が足したくなる。
          */}
          タップされた回数は、誰が使ったかを記録しない設計のため出していません。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <OwnedCards cards={cards} />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>この利用者の監査ログ</CardTitle>
        <CardDescription>新しい順です。続きは監査ログの画面で読めます。</CardDescription>
      </CardHeader>
      <CardContent>
        <AuditEntries entries={auditEntries} />
        {/*
          **`<a href="/audit?user_id=...">` にしない。** `/audit` の絞り込みは
          form POST の本文で渡す作りで（検索語を URL に残さないため）、
          GET のクエリを読むハンドラが無い。リンクに見せるために
          `<button>` へリンクの見た目を当てている。
        */}
        <form method="post" action="/audit/search" class="mt-3">
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <input type="hidden" name="user_id" value={user.id} />
          <button type="submit" class="text-sm text-foreground underline underline-offset-4">
            この利用者の記録を監査ログで開く
          </button>
        </form>
      </CardContent>
    </Card>
  </KiwaShell>
);
