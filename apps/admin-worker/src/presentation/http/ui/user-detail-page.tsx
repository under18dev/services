import type {
  AdminCardViewDelegated,
  AuditLogEntryAdmin,
  UserAdminSummary,
  UserRefAdmin,
} from "@u18/contracts";
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
  getButtonClasses,
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
import { UserRef } from "./user-ref";

/**
 * 利用者 1 人の詳細（`admin.under18.dev/users/:userId`、#455）。
 *
 * **停止・解除・セッションの失効は、この画面だけが持つ**（#489、
 * `/nfc`・#481 / `/clients`・#508 と同じ判断）。一覧（`users-page.tsx`）
 * には「押す前に確かめる材料」が無い——**その人がいまどういう状態で、
 * なぜ止まっているのか**は一覧の行からは読めない。この画面は、
 * 確かめた直後に押せる場所である。
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
  /**
   * 監査ログの `metadata.actorUserId`（実行した管理者）の名前解決
   * （#482、`resolveUserRefs` が束ねる）。
   *
   * **`entry.userId` ではなく `metadata.actorUserId` を引く。** この画面は
   * `listAuditLogs({ userId })` で絞り込んでいるので、`entry.userId` は
   * 常にこの利用者自身（対象）になり、実行者ではない——実行者は
   * `DelegatedManageUserUseCase` が `metadata.actorUserId` として
   * 埋め込んでいる（`entry.metadata` は生の JSON で出す方針のままなので、
   * この 1 キーだけを別枠で名前にする）。
   */
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
  /** 持っているカード。**引けなかったら `null`**（同上）。 */
  readonly cards: readonly AdminCardViewDelegated[] | null;
  /**
   * 「この人のカードをまとめて止める」の 2 段階確認（#486）。**非 null
   * なら確認待ちの状態**——`/nfc/bulk-disable`（#481）と同じ形。
   * `null` なら「対象を確認する」の通常フォームを出す。
   */
  readonly disableCardsConfirm: DisableCardsConfirmState;
  /** 実行結果（#486）。`/nfc` の `BulkResultState` と同じく、部分失敗を正直に出す。 */
  readonly disableCardsResult: DisableCardsResultState;
  readonly error?: string;
  readonly notice?: string;
};

/**
 * 「この人のカードをまとめて止める」の 2 段階確認（#486）。
 *
 * **`selectedCardIds` を持たない。** `/nfc/bulk-disable`（#481）の
 * `BulkConfirmState` と違い、ここに「選択」は無い——対象は
 * 「この利用者が持っているカード全部」で、`listCardsByOwner` の結果
 * そのものが母集団になる。**選択が無い以上、確認画面で枚数と内訳を
 * 出すことが唯一の歯止めになる**（issue #486 の指摘）。
 */
export type DisableCardsConfirmState = {
  readonly totalCount: number;
  readonly eligibleCount: number;
  readonly alreadyDisabledCount: number;
  /**
   * `eligibleCount` が 1 回の上限を超えていて、先頭の分だけが対象に
   * なる（`users.routes.tsx` の `BULK_SELECT_LIMIT` を参照）。**選択が
   * 無いのでエラーにして止めない**——実行すれば対象から外れ、
   * もう一度押すと次の分が対象になる（`disabled` が自然に除外する
   * ので、無限ループにはならない）。
   */
  readonly cappedAtLimit: boolean;
} | null;

export type DisableCardsFailureRow = { readonly cardId: string; readonly reason: string };

/** 実行結果（#486）。`/nfc` の `BulkResultState` と同じ形——成功のリダイレクトに畳まない。 */
export type DisableCardsResultState = {
  readonly succeeded: readonly string[];
  readonly failed: readonly DisableCardsFailureRow[];
} | null;

/**
 * `entry.metadata` から `actorUserId`（実行した管理者）を取り出す。
 *
 * **これ以上 `metadata` の形に踏み込まない。** 他のキーは生の JSON の
 * ままで出す——`audit-page.tsx` と同じ「イベントごとに形が違うので
 * 固定の表で組まない」方針を守りつつ、ここだけは複数のイベント
 * （`ops.user.suspended` / `reinstated` / `sessions_revoked`）が共通して
 * 持つキーなので、名前に変える価値がある。
 */
export function actorUserIdFromMetadata(metadata: Record<string, unknown> | null): string | null {
  if (metadata === null) return null;
  const value = metadata.actorUserId;
  return typeof value === "string" ? value : null;
}

/** 一覧（`users-page.tsx`）と同じ見せ方。**`suspended` を「凍結」と言い切らない。** */
const StatusBadge: FC<{ readonly status: UserAdminSummary["status"] }> = ({ status }) => {
  if (status === "active") return <Badge variant="success">有効</Badge>;
  if (status === "deleted") return <Badge variant="destructive">削除済み</Badge>;
  return <Badge variant="warning">停止中</Badge>;
};

/** ランブック §11.1 の表が区別している理由をそのまま値にする。ここだけ別の言い方にしない。 */
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
 * 停止・解除・セッションの失効。**この画面だけが持つ操作**（#489、
 * 一覧（`users-page.tsx`）からは外した）。
 *
 * ## `from=detail` を積む
 *
 * route（`/users/:userId/suspend` など）はこの画面専用ではない——
 * `cameFromDetail` / `redirectTargetOf`（`users.routes.tsx`）が戻り先を
 * 振り分ける既存の仕組みをそのまま使っているので、戻り先だけをフォームが
 * 申告する。積まないと、**確かめてから押した直後に一覧へ飛ばされ、
 * 結果を同じ画面で確かめられない。**
 *
 * ## 退会による停止でも「解除」を隠さない
 *
 * 間違いだったと分かったときに戻す手段自体は残す。**隠すと、取り消せる
 * はずの操作が取り消せなくなる。** 代わりに**上の節で警告を立て、
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
    // 戻せない（個人情報が落ちている）し、止めるものも残っていない。
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
              suspension.kind === "self_closed" ? DANGER_BUTTON_CLASS : getButtonClasses("outline")
            }
          >
            {suspension.kind === "self_closed" ? "それでも停止を解除する" : "停止を解除する"}
          </button>
        </form>
      )}
      {/*
        **停止とは別に置く。** 止めずに切りたいことがある——端末を
        失くした人の救済など。自分に対しても押せる。
      */}
      <form method="post" action={`/users/${user.id}/revoke-sessions`}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input type="hidden" name="from" value="detail" />
        <button type="submit" class={DANGER_BUTTON_CLASS}>
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
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map((card) => (
          <TableRow key={card.cardId}>
            {/*
              **カード ID 自体が `/nfc/:cardId`（カード詳細、#472）への
              リンク**（#488、指摘: 3b）。カードへの操作（無効化・復帰・
              遷移先の書き換え・手放させる）はこの画面に持ってこない——
              それらは詳細側の責務で、ここに同じフォームを並べると**同じ
              操作が 2 画面に散る**（#433 が `/account/*` から運営向けの
              画面を消した理由と同じ形）。以前は「カードの詳細へ」という
              別列のリンクだったが、ID 自体をリンクにしたので列ごと消した
              ——同じ行き先への導線が 2 つあると、どちらを押すべきか迷う。
              `/users` 一覧は逆に ID 列をリンクにしない（表示名のほうを
              リンクにし、ID はコピーだけの場所にする）——あちらには
              `displayName` という別の人間向けラベルがあるが、カードには
              ID 以外に識別子が無く、ID 自身がリンクと「読む・コピーする」
              の両方を兼ねる。
            */}
            <TableCell class={ITEM_RAW_CLASS}>
              <a
                href={`/nfc/${encodeURIComponent(card.cardId)}`}
                class="underline underline-offset-4"
              >
                {card.cardId}
              </a>{" "}
              {/* コピー用（#470）。JS が外すまでは存在しない（#488）。 */}
              <button type="button" data-copy={card.cardId} hidden class="text-xs underline">
                コピー
              </button>
            </TableCell>
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/**
 * 「この人のカードをまとめて止める」（#486）。
 *
 * **凍結（`UserActions` の「停止する」）とは別のフォーム・別の route。**
 * 「停止する」を押したら勝手にカードも止まる、にはしない——#422 / #436
 * と同じ判断で、弱い操作を 2 つ並べるほうが、強い操作を 1 つ作るより
 * 安全である。`user.status === "suspended"` のときだけ出す（止める
 * 意味があるのは停止中の人だけ——退会・運営凍結のどちらでも、本人が
 * いまログインできない以上、カードだけが生きている状態を望ましいと
 * 考える理由が無い）。
 */
const DisableCardsSection: FC<{
  readonly userId: string;
  readonly csrfToken: string;
  readonly confirm: DisableCardsConfirmState;
  readonly result: DisableCardsResultState;
}> = ({ userId, csrfToken, confirm, result }) => {
  const actionPath = `/users/${encodeURIComponent(userId)}/disable-cards`;

  if (result !== null) {
    return (
      <div class="flex flex-col gap-3 border-t border-border pt-4">
        <p class={ITEM_META_CLASS} role="status">
          <strong>{result.succeeded.length} 枚を無効化しました。</strong>
          {result.failed.length > 0 ? (
            <>
              {" "}
              / <strong>{result.failed.length} 枚失敗しました。</strong>
            </>
          ) : null}
        </p>
        {result.failed.length > 0 ? (
          <div>
            <p class={ITEM_META_CLASS}>失敗した内訳:</p>
            <ul class="flex flex-col gap-0.5 pl-1 text-sm text-destructive">
              {result.failed.map((row) => (
                <li key={row.cardId}>
                  <code class="font-mono text-xs">{row.cardId}</code> — {row.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (confirm !== null) {
    return (
      <div class="flex flex-col gap-3 border-t border-border pt-4">
        <p class={ITEM_META_CLASS} role="status">
          所持 <strong>{confirm.totalCount} 枚</strong>のうち、止められるのは{" "}
          <strong>{confirm.eligibleCount} 枚</strong>です（既に無効化済み{" "}
          {confirm.alreadyDisabledCount} 枚）。
        </p>
        {confirm.cappedAtLimit ? (
          <p class={ITEM_META_CLASS}>
            一度に止められる枚数には上限があります。実行後、もう一度このボタンを押すと残りに進みます。
          </p>
        ) : null}
        <form method="post" action={actionPath} class="flex flex-wrap items-center gap-3">
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
          <input type="hidden" name="confirmed" value="1" />
          <button type="submit" class={DANGER_BUTTON_CLASS}>
            本当に {confirm.eligibleCount} 枚を無効化する
          </button>
          <a
            href={`/users/${encodeURIComponent(userId)}`}
            class="text-sm text-foreground-muted underline underline-offset-4"
          >
            キャンセルする
          </a>
        </form>
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-2 border-t border-border pt-4">
      <p class={ITEM_META_CLASS}>
        この人のカードをまとめて止められます。押しても止まりません——まず対象の枚数を確認します。
      </p>
      <form method="post" action={actionPath}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <button type="submit" class={getButtonClasses("outline")}>
          対象を確認する
        </button>
      </form>
    </div>
  );
};

const AuditEntries: FC<{
  readonly entries: readonly AuditLogEntryAdmin[] | null;
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
}> = ({ entries, userRefs }) => {
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
          <TableHead>実行者</TableHead>
          <TableHead>詳細</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const actorUserId = actorUserIdFromMetadata(entry.metadata);
          return (
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
                **`entry.userId` ではない。** この画面は `userId` で絞り込んで
                いるので、`entry.userId` は常にこの利用者自身（対象）になる
                ——実行者は `metadata.actorUserId`（#482、型の JSDoc を参照）。
              */}
              <TableCell class="whitespace-normal">
                {actorUserId === null ? (
                  <span class={ITEM_META_CLASS}>—</span>
                ) : (
                  <UserRef id={actorUserId} refs={userRefs} />
                )}
              </TableCell>
              {/*
                **`metadata` は生の JSON でも出す**（`audit-page.tsx` と同じ
                理由）。イベントごとに形が違うので、固定の表に組むと
                新しいイベントのたびにこの画面も直すことになる——上の
                「実行者」列は `actorUserId` という 1 キーだけの特別扱いで、
                残りのキーは引き続きここにそのまま出す。コピーボタンも
                `audit-page.tsx` と同じ形で添える（#488）。
              */}
              <TableCell class="whitespace-normal">
                {entry.reason === null && entry.metadata === null ? (
                  <span class={ITEM_META_CLASS}>—</span>
                ) : (
                  <div class="flex items-start gap-2">
                    <div>
                      {entry.reason === null ? null : <p class={ITEM_META_CLASS}>{entry.reason}</p>}
                      {entry.metadata === null ? null : (
                        <pre class={ITEM_RAW_CLASS}>{JSON.stringify(entry.metadata)}</pre>
                      )}
                    </div>
                    {entry.metadata === null ? null : (
                      <button
                        type="button"
                        class="shrink-0 text-xs text-foreground underline underline-offset-4"
                        data-copy={JSON.stringify(entry.metadata)}
                        hidden
                      >
                        コピー
                      </button>
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
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
  userRefs,
  cards,
  disableCardsConfirm,
  disableCardsResult,
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
            <dd class={ITEM_RAW_CLASS}>
              {user.id} {/* コピー用（#470）。JS が外すまでは存在しない（#488）。 */}
              <button type="button" data-copy={user.id} hidden class="text-xs underline">
                コピー
              </button>
            </dd>
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
        <CardDescription>
          停止・停止の解除・ログイン中の端末を全部切るは、この画面で行います。
        </CardDescription>
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
        {/*
          **停止中の人だけに出す**（#486）。アカウントを止めても、NFC
          カードは別に明示的に止めないとタップされ続ける——所有者の
          生死を見ない設計のため（`ResolveCardUseCase`、ランブック §11
          ステップ 6）。凍結の操作とは別のフォーム（`DisableCardsSection`
          の冒頭を参照）。
        */}
        {user.status === "suspended" ? (
          <DisableCardsSection
            userId={user.id}
            csrfToken={csrfToken}
            confirm={disableCardsConfirm}
            result={disableCardsResult}
          />
        ) : null}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>この利用者の監査ログ</CardTitle>
        <CardDescription>新しい順です。続きは監査ログの画面で読めます。</CardDescription>
      </CardHeader>
      <CardContent>
        <AuditEntries entries={auditEntries} userRefs={userRefs} />
        {/*
          **`<a href="/audit?user_id=...">` にしない。** `/audit` の絞り込みは
          form POST の本文で渡す作りで（検索語を URL に残さないため）、
          GET のクエリを読むハンドラが無い。リンクに見せるために
          `<button>` へリンクの見た目を当てている。

          **見た目を Button コンポーネント相当に変えなかった理由（#535 の
          button/action 洗い出しで再確認済み）。** `audit.routes.tsx` を
          読み直し、`app.get("/audit", ...)` がいまも引数無しで
          `renderAuditPage` を呼ぶだけで、クエリ文字列を一切読まないことを
          実測で確認した——`GET /audit?user_id=...` を直接叩いても絞り込みは
          効かない。絞り込みが効く唯一の経路は `POST /audit/search` であり、
          ここはその POST を送るためのボタンなので、見た目だけ `<a>` 風の
          `<Button variant="link">` 相当にしても実体は変わらない。
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
