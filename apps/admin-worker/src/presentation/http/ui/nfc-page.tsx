import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyHeader,
  EmptyTitle,
  getButtonClasses,
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
  FIELD_CLASS,
  INPUT_CLASS,
  ITEM_META_CLASS,
  LABEL_CLASS,
} from "@u18/web-ui/kiwa/island-classes";
import type {
  AdminCardListViewDelegated,
  AdminCardStatusDelegated,
  UserRefAdmin,
} from "@u18/contracts";
import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { ISLAND_PATH, KIWA_STYLESHEET_PATH } from "./asset-paths";
import { UserRef } from "./user-ref";

/**
 * NFC カードの管理画面（`admin.under18.dev/nfc`、#382 / #390 決定 16 ③）。
 *
 * **`/account/nfc/admin`（nfc-worker、#377）から移した。** 画面の中身
 * （一覧・発行・コピペ用 URL 一覧）はそのまま持ってきている。変わったのは
 * 呼び方（セッション Cookie 経由の UseCase → `NfcAdminDelegatedRPC` 経由）
 * と置き場所だけ。
 *
 * ## 1 枚ずつの操作はこの画面から消した（#481）
 *
 * 運用者の指示「カード一覧からは 1 枚ずつ操作できなくていい。詳細ページ
 * からやる。代わりにソート・検索・選択 and 一括操作を」。カード ID は
 * `/nfc/:cardId`（#472）へのリンクになり、無効化・復帰・手放す・遷移先
 * の書き換えはあちらで行う。**`POST /nfc/:cardId/*` のルート自体は消して
 * いない**——詳細ページが使う。
 *
 * ## この画面は「未紐づけカードの鍵束」である（移行元と同じ理由）
 *
 * **#358 以降、`issued` のカードは ID を知っている人がタップすれば
 * その人のものになる。** 下の `<textarea>` はその ID を URL の形で
 * 並べたもので、配布物そのものと同じ扱いにしなければならない。
 *
 * ## 表が主役なので幅を広く取る（運用者の指摘）
 *
 * `maxWidth="max-w-6xl"` を渡す。`/account` 側の `max-w-3xl` に合わせる
 * 理由が無い——あちらは 1 カラムの設定画面、こちらは列の多い表である。
 *
 * ## 遷移先 URL をリンクにしない（移行元と同じ理由）
 *
 * `target_url` は**利用者が自由に入れた外部 URL** である。運営は
 * 全員のカードを見るので、ここをリンクにすると**一覧を開いただけで
 * 外部へ飛べる**——カードを奪った側が遷移先を変え、確認しに来た運営に
 * 踏ませる経路になる。
 *
 * ## 所有者は名前で出す（#471）
 *
 * **以前は `userId` の生の UUID までしか出なかった。** nfc-worker は
 * Identity D1 を持たず、`NfcAdminDelegatedRpcContract` も名前を返さない
 * ——そこで admin-worker 側が `auth-worker` の `getUsersByIds`（delegated
 * RPC）をまとめて叩き、`userRefs`（呼ぶ側が解決した `Map`）として渡す。
 * 表示は `ui/user-ref.tsx` の `UserRef` 1 つに集約してある——#472/#473 も
 * これを使う。
 *
 * ## `?batch=` は打ち切りの前に効く（#481）
 *
 * `/nfc/analytics` のバッチ別の表から「このロットの N 枚を見る」に
 * 辿り着く経路。クライアント側の絞り込み（`data-filter`）と違い、
 * `MAX_ADMIN_LIST`（500 枚）で打ち切られる前に絞るので、500 枚より後ろに
 * 並んでいたロットも見える。`truncated` の意味も「そのロットの中で」に
 * 変わる——画面の文言を書き分けている。
 *
 * ## インラインの `style` を書かない
 *
 * 本番の CSP は `style-src 'self'`。`style="..."` は破棄され、
 * ローカルでは効いて本番でだけ崩れる（#320）。
 */

const STATUS_LABEL: Readonly<Record<AdminCardStatusDelegated, string>> = {
  issued: "未紐づけ",
  active: "有効",
  disabled: "無効化済み",
};

/** 移行元（`cards-page.tsx` / `admin-page.tsx`）と同じ割り当て。**色で良し悪しを言わない。** */
const STATUS_VARIANT: Readonly<Record<AdminCardStatusDelegated, "secondary" | "destructive">> = {
  issued: "secondary",
  active: "secondary",
  disabled: "destructive",
};

/** ISO 8601 を「2026-10-25」まで落とす。時刻まで見せる理由が無い。 */
function toDate(iso: string): string {
  return iso.split("T")[0] ?? iso;
}

/** いま絞り込んでいるロットがあれば、フォームの宛先にそのまま引き継ぐ（#481）。 */
function withBatchQuery(path: string, batch: string | null): string {
  return batch === null ? path : `${path}?batch=${encodeURIComponent(batch)}`;
}

export type BulkActionKind = "disable" | "reinstate";

export type BulkIneligibleRow = { readonly cardId: string; readonly reason: string };

/**
 * 選択による一括操作の 2 段階確認（#481）。**非 null なら確認待ちの状態。**
 * `selectedCardIds` はチェックを入れた全部、`eligibleCardIds` はそのうち
 * 実際に効くもの——差分が `ineligible`（理由つき）。
 */
export type BulkConfirmState = {
  readonly action: BulkActionKind;
  readonly selectedCardIds: readonly string[];
  readonly eligibleCardIds: readonly string[];
  readonly ineligible: readonly BulkIneligibleRow[];
} | null;

/** 選択による一括操作の実行結果（#481）。**部分失敗を正直に出す**——成功のリダイレクトに畳まない。 */
export type BulkResultState = {
  readonly action: BulkActionKind;
  readonly succeeded: readonly string[];
  readonly failed: readonly BulkIneligibleRow[];
  readonly ineligible: readonly BulkIneligibleRow[];
} | null;

export type NfcPageProps = {
  readonly cards: readonly AdminCardListViewDelegated[];
  readonly truncated: boolean;
  /** 焼く用の URL 一覧（`issued` のカードだけ、1 行に 1 本）。組み立てるのはルート側。 */
  readonly tapUrls: readonly string[];
  /** 所有者の名前解決の結果（`user-refs.ts` の `resolveUserRefs`、#471）。 */
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
  readonly csrfToken: string;
  /** 直前の発行で出した枚数（PRG で戻ってきたとき）。 */
  readonly issuedCount: number | null;
  /** 発行またはカード操作に失敗したときの文言。 */
  readonly error: string | null;
  /**
   * batch 一括無効化の 2 段階確認（#427）。**非 null なら確認待ちの状態**
   * ——1 段階目（対象枚数を数えた）か、2 段階目で入力が一致しなかった
   * 直後。`null` なら通常の「バッチ名を入力する」フォームを出す。
   */
  readonly batchDisable: { readonly batch: string; readonly count: number } | null;
  /** 確認の再入力が一致しなかったときの文言。`batchDisable` とセットで使う。 */
  readonly batchDisableError: string | null;
  /** 直前の一括無効化で実際に止めた枚数（PRG で戻ってきたとき）。 */
  readonly batchDisabledCount: number | null;
  /**
   * batch 一括復帰の 2 段階確認（#436）。`batchDisable` と対称——非 null
   * なら確認待ちの状態、`null` なら通常の「バッチ名を入力する」フォーム。
   */
  readonly batchReinstate: { readonly batch: string; readonly count: number } | null;
  /** 確認の再入力が一致しなかったときの文言。`batchReinstate` とセットで使う。 */
  readonly batchReinstateError: string | null;
  /** 直前の一括復帰で実際に戻した枚数（PRG で戻ってきたとき）。 */
  readonly batchReinstatedCount: number | null;
  /** `?batch=` で絞り込んでいれば、そのロット名（#481）。トリム済み。 */
  readonly batch: string | null;
  readonly bulkConfirm: BulkConfirmState;
  readonly bulkResult: BulkResultState;
};

const BulkConfirmView: FC<{
  readonly confirm: NonNullable<BulkConfirmState>;
  readonly csrfToken: string;
  readonly batch: string | null;
  readonly truncated: boolean;
}> = ({ confirm, csrfToken, batch, truncated }) => {
  const actionPath = confirm.action === "disable" ? "/nfc/bulk-disable" : "/nfc/bulk-reinstate";
  const actionLabel = confirm.action === "disable" ? "無効化する" : "復帰させる";

  return (
    <div class="flex flex-col gap-4">
      <p class={ITEM_META_CLASS} role="status">
        選択 <strong>{confirm.selectedCardIds.length} 枚</strong>のうち、
        <strong>{confirm.eligibleCardIds.length} 枚</strong>に「{actionLabel}」が効きます。
      </p>

      {confirm.ineligible.length > 0 && (
        <div>
          <p class={ITEM_META_CLASS}>対象外 {confirm.ineligible.length} 枚（理由つき）:</p>
          <ul class="flex flex-col gap-0.5 pl-1 text-sm text-foreground-muted">
            {confirm.ineligible.map((row) => (
              <li key={row.cardId}>
                <code class="font-mono text-xs">{row.cardId}</code> — {row.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {batch !== null && truncated && (
        <p
          class="rounded-lg border border-destructive/40 bg-background-subtle px-3 py-2.5 text-sm text-destructive"
          role="alert"
        >
          このロットには他にも読み込めていないカードがあります。
          選択できるのは、いま画面に出ている分だけです。
        </p>
      )}

      <form
        method="post"
        action={withBatchQuery(actionPath, batch)}
        class="flex flex-wrap items-center gap-3"
      >
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input type="hidden" name="confirmed" value="1" />
        {confirm.selectedCardIds.map((cardId) => (
          <input type="hidden" name="card_id" value={cardId} key={cardId} />
        ))}
        <button
          type="submit"
          class={confirm.action === "disable" ? DANGER_BUTTON_CLASS : getButtonClasses("outline")}
        >
          本当に {confirm.eligibleCardIds.length} 枚を{actionLabel}
        </button>
        <a href="/nfc" class="text-sm text-foreground-muted underline underline-offset-4">
          キャンセルする
        </a>
      </form>
    </div>
  );
};

const BulkResultView: FC<{ readonly result: NonNullable<BulkResultState> }> = ({ result }) => {
  const actionLabel = result.action === "disable" ? "無効化" : "復帰";

  return (
    <div class="flex flex-col gap-3">
      <p class={ITEM_META_CLASS} role="status">
        {actionLabel}: <strong>{result.succeeded.length} 件成功</strong> /{" "}
        <strong>{result.failed.length} 件失敗</strong>
        {result.ineligible.length > 0 && <> / 対象外 {result.ineligible.length} 件</>}
      </p>

      {result.failed.length > 0 && (
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
      )}

      {result.ineligible.length > 0 && (
        <div>
          <p class={ITEM_META_CLASS}>最初から対象外だった内訳:</p>
          <ul class="flex flex-col gap-0.5 pl-1 text-sm text-foreground-muted">
            {result.ineligible.map((row) => (
              <li key={row.cardId}>
                <code class="font-mono text-xs">{row.cardId}</code> — {row.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <a href="/nfc" class="text-sm text-foreground-muted underline underline-offset-4">
        一覧へ戻る
      </a>
    </div>
  );
};

export const NfcPage: FC<NfcPageProps> = ({
  cards,
  truncated,
  tapUrls,
  userRefs,
  csrfToken,
  issuedCount,
  error,
  batchDisable,
  batchDisableError,
  batchDisabledCount,
  batchReinstate,
  batchReinstateError,
  batchReinstatedCount,
  batch,
  bulkConfirm,
  bulkResult,
}) => (
  <KiwaShell
    title="NFC カード"
    nav={ADMIN_NAV_GROUPS}
    current="nfc"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="NFC カード"
    lead="カード ID を押すと詳細が開き、無効化・復帰・遷移先の変更はそこから行います。この画面は検索・並べ替え・選択しての一括操作が主な役目です。"
    maxWidth="max-w-6xl"
    scripts={[ISLAND_PATH]}
  >
    <p class={ITEM_META_CLASS}>
      <a href="/nfc/analytics" class="underline underline-offset-4">
        解析を見る
      </a>
      （タップの時系列・バッチ別の集計・死蔵の検出など）
    </p>

    {batch !== null && (
      <Alert>
        <AlertDescription>
          <strong>
            絞り込み中: 「{batch}」の {cards.length} 枚だけを表示しています。
          </strong>{" "}
          <a href="/nfc" class="underline underline-offset-4">
            絞り込みを解除する
          </a>
        </AlertDescription>
      </Alert>
    )}

    <Alert>
      <AlertDescription>
        <strong>
          未紐づけのカードは、ID を知っている人がタップすると、その人のものになります。
        </strong>
        下の URL 一覧は配布物そのものと同じ扱いにしてください。画面を人目のある場所で開かない、
        共有しない、スクリーンショットを残さない。
      </AlertDescription>
    </Alert>

    {/*
      **探しに来た人がすぐ辿り着けるよう、一覧（検索・絞り込み・選択・
      一括操作）をここに置く。** 発行・バッチ名での一括操作は下へ下げた
      ——件数が増えるほど、そちらを全部スクロールしてからでないと一覧へ
      辿り着けない形になっていた（3b のレビュー）。
    */}
    <Card>
      <CardHeader>
        <CardTitle>カード ID で直接開く</CardTitle>
        <CardDescription>
          下の一覧が打ち切られている・絞り込みで隠れている場合でも、
          <strong>ID が分かっているカードを 1 枚だけ開きます。</strong>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="get" action="/nfc/open" class="flex flex-wrap gap-2">
          <input
            type="text"
            name="cardId"
            required
            maxlength={64}
            placeholder="nfc_xxxxxxxxxxxxxxxx"
            aria-label="開くカードの ID"
            autocapitalize="off"
            class={`${INPUT_CLASS} w-64`}
          />
          <button type="submit" class={getButtonClasses("outline")}>
            開く
          </button>
        </form>
      </CardContent>
    </Card>

    {truncated && (
      <Alert>
        <AlertDescription>
          {batch === null ? (
            <>
              <strong>一覧は上限で打ち切られています。</strong>
              表示しているのは新しいほうから 500 枚で、これより古いカードは出ていません。
            </>
          ) : (
            <>
              <strong>「{batch}」のカードは 500 枚で打ち切られています。</strong>
              このロットには他にも読み込めていないカードがあります——
              <strong>見つからない＝存在しない、ではありません。</strong>
            </>
          )}{" "}
          <strong>ここに無いカードは、上の「カード ID で直接開く」で ID を指定して開いてください。</strong>
        </AlertDescription>
      </Alert>
    )}

    <Card>
      <CardHeader>
        <CardTitle>選択して一括操作する</CardTitle>
        <CardDescription>
          下の一覧でチェックを入れたカードだけをまとめて操作します。
          <strong>いま画面に出ている行だけが対象です</strong>
          ——絞り込みで隠れている行・打ち切りの外にある行は選べません。
          遷移先の変更・手放すは 1 枚ずつ、カードの詳細から行ってください。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {bulkResult !== null ? (
          <BulkResultView result={bulkResult} />
        ) : bulkConfirm !== null ? (
          <BulkConfirmView
            confirm={bulkConfirm}
            csrfToken={csrfToken}
            batch={batch}
            truncated={truncated}
          />
        ) : (
          <form
            id="nfc-bulk-form"
            method="post"
            action={withBatchQuery("/nfc/bulk-disable", batch)}
            class="flex flex-col gap-3"
          >
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <output data-select-count="nfc-cards" class={ITEM_META_CLASS}>
              選択したカードに対して操作します。
            </output>
            <div class="flex flex-wrap gap-2">
              <button
                type="submit"
                formaction={withBatchQuery("/nfc/bulk-disable", batch)}
                class={DANGER_BUTTON_CLASS}
              >
                選択したカードを無効化する
              </button>
              <button
                type="submit"
                formaction={withBatchQuery("/nfc/bulk-reinstate", batch)}
                class={getButtonClasses("outline")}
              >
                選択したカードを復帰させる
              </button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>

    {cards.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>発行されたカードはありません。</EmptyTitle>
        </EmptyHeader>
      </Empty>
    ) : (
      <Card>
        <CardHeader>
          <CardTitle>すべてのカード</CardTitle>
          <CardDescription>{cards.length} 枚。発行の新しい順です。</CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            絞り込み欄（#470）。**`hidden` で描く——JS が無ければ存在しない
            ものとして読める。JS がこれを外して使えるようにする。
          */}
          <input
            type="text"
            data-filter="nfc-cards-table"
            hidden
            placeholder="この一覧から絞り込み"
            aria-label="カードの一覧を絞り込む"
            class={`${INPUT_CLASS} mb-2`}
          />
          <Table id="nfc-cards-table" data-sortable>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {/*
                    全選択（#481）。**`hidden` で描く**——素のチェックボックスは
                    連動して切り替える機能を持たず、JS が無ければ押しても
                    自分自身が on/off になるだけで何も起きない
                    （`ui/client/README.md` の「選択と一括操作」を参照）。
                  */}
                  <input
                    type="checkbox"
                    data-select-all="nfc-cards"
                    hidden
                    form="nfc-bulk-form"
                    aria-label="表示中を全選択"
                  />
                </TableHead>
                <TableHead data-sort="text">カード ID</TableHead>
                <TableHead data-sort="text">状態</TableHead>
                <TableHead data-sort="text">所有者</TableHead>
                <TableHead data-sort="text">遷移先</TableHead>
                <TableHead data-sort="text">ロット</TableHead>
                <TableHead data-sort="number">タップ数</TableHead>
                <TableHead data-sort="date">引き取り</TableHead>
                <TableHead data-sort="date">発行</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cards.map((card) => (
                <TableRow key={card.cardId}>
                  <TableCell>
                    {/*
                      選択そのものは JS を要求しない（#481）。チェックを
                      入れて上の送信ボタンを押せば、JS が無くても一括操作は
                      成立する——`form="nfc-bulk-form"` で、この行の外に
                      ある `<form>` と結びつける（テーブルの構造を崩さずに
                      選択の送信先をまとめるため）。
                    */}
                    <input
                      type="checkbox"
                      data-select="nfc-cards"
                      name="card_id"
                      value={card.cardId}
                      form="nfc-bulk-form"
                      aria-label={`${card.cardId} を選択`}
                    />
                  </TableCell>
                  <TableCell class="font-mono text-xs">
                    <a
                      href={`/nfc/${encodeURIComponent(card.cardId)}`}
                      class="underline underline-offset-4"
                    >
                      {card.cardId}
                    </a>{" "}
                    {/* コピー用（#470）。JS が外すまでは存在しない。 */}
                    <button type="button" data-copy={card.cardId} hidden class="text-xs underline">
                      コピー
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[card.status]}>{STATUS_LABEL[card.status]}</Badge>
                  </TableCell>
                  <TableCell class="whitespace-normal">
                    <UserRef id={card.ownerUserId} refs={userRefs} />
                  </TableCell>
                  <TableCell class="max-w-xs font-mono text-xs break-all whitespace-normal">
                    {/* **リンクにしない**（冒頭を参照）。 */}
                    {card.targetUrl ?? "未設定"}
                  </TableCell>
                  <TableCell>{card.batch ?? "—"}</TableCell>
                  <TableCell>{card.tapCount}</TableCell>
                  <TableCell class={ITEM_META_CLASS}>
                    {card.claimedAt === null ? "—" : toDate(card.claimedAt)}
                  </TableCell>
                  <TableCell class={ITEM_META_CLASS}>{toDate(card.issuedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    )}

    {/*
      **ここから下は、出番の少ない操作**（発行・ロット名での一括操作・
      焼く URL の書き出し）。探しに来た人が真っ先に見る一覧より後ろに
      下げてある（3b のレビュー）。
    */}
    <Card>
      <CardHeader>
        <CardTitle>カードを発行する</CardTitle>
        <CardDescription>
          空のカード ID を作ります。<strong>取り消せません。</strong>
          発行したぶんは下の URL 一覧にそのまま並びます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {issuedCount === null ? null : (
          <p class={`${ITEM_META_CLASS} mb-4`} role="status">
            {issuedCount} 枚発行しました。上の一覧に入っています。
          </p>
        )}
        {error === null ? null : (
          <p
            class="mb-4 rounded-lg border border-destructive/40 bg-background-subtle px-3 py-2.5 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}

        <form method="post" action="/nfc" class="flex flex-col gap-4">
          <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />

          <label class={FIELD_CLASS} for="issue-count">
            <span class={LABEL_CLASS}>枚数</span>
            <input
              id="issue-count"
              class={INPUT_CLASS}
              type="number"
              name="count"
              value="10"
              required
              min={1}
              max={200}
              inputmode="numeric"
            />
          </label>

          <label class={FIELD_CLASS} for="issue-batch">
            <span class={LABEL_CLASS}>ロット名（任意）</span>
            <input
              id="issue-batch"
              class={INPUT_CLASS}
              type="text"
              name="batch"
              maxlength={64}
              placeholder="2026-bunkasai"
              autocapitalize="off"
            />
          </label>
          <p class={ITEM_META_CLASS}>
            配布の単位です。あとから「どの束のカードか」を辿るのに使います。
          </p>

          <button type="submit" class={getButtonClasses()}>
            発行する
          </button>
          <p class={ITEM_META_CLASS}>
            1 回に 200 枚まで。
            <strong>
              発行したカードは、ID を知っている人がタップすればその人のものになります。
            </strong>
            配る直前に発行してください。
          </p>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>バッチを一括で無効化する</CardTitle>
        <CardDescription>
          配布前の箱ごと盗難など、<strong>未紐づけ（まだ誰のものでもない）のカードだけ</strong>
          をバッチ単位で止めます。<strong>誰かのカードは対象になりません。</strong>
          <strong>入力したロット全体に効きます——いま画面に出ていない分も含みます。</strong>
          上の「選択して一括操作する」（チェックを入れた行だけが対象）とは効く範囲が違います。
          戻すときは下の「バッチを一括で復帰させる」を使ってください ——
          <strong>このバッチの一括無効化で止めたカードだけ</strong>が対象です。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {batchDisabledCount === null ? null : (
          <p class={`${ITEM_META_CLASS} mb-4`} role="status">
            {batchDisabledCount} 枚を無効化しました。
          </p>
        )}
        {batchDisable === null ? (
          <form
            method="post"
            action={withBatchQuery("/nfc/batch-disable", batch)}
            class="flex flex-col gap-4"
          >
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <label class={FIELD_CLASS} for="batch-disable-name">
              <span class={LABEL_CLASS}>バッチ名</span>
              <input
                id="batch-disable-name"
                class={INPUT_CLASS}
                type="text"
                name="batch"
                required
                maxlength={64}
                autocapitalize="off"
                value={batch ?? undefined}
              />
            </label>
            <button type="submit" class={getButtonClasses("outline")}>
              対象を確認する
            </button>
          </form>
        ) : (
          <div class="flex flex-col gap-4">
            {batchDisableError === null ? null : (
              <p
                class="rounded-lg border border-destructive/40 bg-background-subtle px-3 py-2.5 text-sm text-destructive"
                role="alert"
              >
                {batchDisableError}
              </p>
            )}
            <p class={ITEM_META_CLASS} role="status">
              <strong>ロット名による一括無効化です（表示中の選択とは無関係）。</strong>{" "}
              バッチ「{batchDisable.batch}」には、未紐づけのカードが{" "}
              <strong>{batchDisable.count} 枚</strong>あります。
              本当に無効化する場合は、下にバッチ名をもう一度入力してください。
            </p>
            <form
              method="post"
              action={withBatchQuery("/nfc/batch-disable", batch)}
              class="flex flex-col gap-4"
            >
              <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
              <input type="hidden" name="target_batch" value={batchDisable.batch} />
              <label class={FIELD_CLASS} for="batch-disable-confirm">
                <span class={LABEL_CLASS}>確認のため、バッチ名をもう一度入力してください</span>
                <input
                  id="batch-disable-confirm"
                  class={INPUT_CLASS}
                  type="text"
                  name="batch"
                  required
                  maxlength={64}
                  autocapitalize="off"
                  placeholder={batchDisable.batch}
                />
              </label>
              <button type="submit" class={DANGER_BUTTON_CLASS}>
                {batchDisable.count} 枚を無効化する
              </button>
            </form>
            <a
              href={withBatchQuery("/nfc", batch)}
              class="text-sm text-foreground-muted underline underline-offset-4"
            >
              キャンセルする
            </a>
          </div>
        )}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>バッチを一括で復帰させる</CardTitle>
        <CardDescription>
          上の一括無効化で止めたカードを、<strong>同じバッチ単位</strong>で未紐づけへ戻します。
          <strong>単発の操作で個別に止めたカードは対象になりません。</strong>
          こちらも<strong>入力したロット全体</strong>に効きます——表示中の選択とは無関係です。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {batchReinstatedCount === null ? null : (
          <p class={`${ITEM_META_CLASS} mb-4`} role="status">
            {batchReinstatedCount} 枚を未紐づけへ戻しました。
          </p>
        )}
        {batchReinstate === null ? (
          <form
            method="post"
            action={withBatchQuery("/nfc/batch-reinstate", batch)}
            class="flex flex-col gap-4"
          >
            <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
            <label class={FIELD_CLASS} for="batch-reinstate-name">
              <span class={LABEL_CLASS}>バッチ名</span>
              <input
                id="batch-reinstate-name"
                class={INPUT_CLASS}
                type="text"
                name="batch"
                required
                maxlength={64}
                autocapitalize="off"
                value={batch ?? undefined}
              />
            </label>
            <button type="submit" class={getButtonClasses("outline")}>
              対象を確認する
            </button>
          </form>
        ) : (
          <div class="flex flex-col gap-4">
            {batchReinstateError === null ? null : (
              <p
                class="rounded-lg border border-destructive/40 bg-background-subtle px-3 py-2.5 text-sm text-destructive"
                role="alert"
              >
                {batchReinstateError}
              </p>
            )}
            <p class={ITEM_META_CLASS} role="status">
              <strong>ロット名による一括復帰です（表示中の選択とは無関係）。</strong>{" "}
              バッチ「{batchReinstate.batch}」の一括無効化で止めたカードが{" "}
              <strong>{batchReinstate.count} 枚</strong>あります。
              本当に戻す場合は、下にバッチ名をもう一度入力してください。
            </p>
            <form
              method="post"
              action={withBatchQuery("/nfc/batch-reinstate", batch)}
              class="flex flex-col gap-4"
            >
              <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
              <input type="hidden" name="target_batch" value={batchReinstate.batch} />
              <label class={FIELD_CLASS} for="batch-reinstate-confirm">
                <span class={LABEL_CLASS}>確認のため、バッチ名をもう一度入力してください</span>
                <input
                  id="batch-reinstate-confirm"
                  class={INPUT_CLASS}
                  type="text"
                  name="batch"
                  required
                  maxlength={64}
                  autocapitalize="off"
                  placeholder={batchReinstate.batch}
                />
              </label>
              <button type="submit" class={getButtonClasses("outline")}>
                {batchReinstate.count} 枚を未紐づけへ戻す
              </button>
            </form>
            <a
              href={withBatchQuery("/nfc", batch)}
              class="text-sm text-foreground-muted underline underline-offset-4"
            >
              キャンセルする
            </a>
          </div>
        )}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>タグに焼く URL</CardTitle>
        <CardDescription>
          {tapUrls.length === 0
            ? "未紐づけのカードがありません。"
            : `未紐づけ ${tapUrls.length} 枚ぶん。1 行に 1 枚です。`}
          <strong>紐づけ済みのカードは入っていません</strong>
          —— 混ぜると、誰かの手元にあるタグを上書きする形になり、焼いたあとで区別できません。
          {batch === null ? (
            <> 絞り込み（<code class="font-mono text-xs">?batch=</code>）とは無関係に、全件が対象です。</>
          ) : (
            <>
              {" "}
              <strong>いまの絞り込み「{batch}」のカードだけが対象です。</strong>
              他のロットぶんは、絞り込みを解除してから開いてください。
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tapUrls.length === 0 ? (
          <p class={ITEM_META_CLASS}>発行すると、ここに URL が並びます。</p>
        ) : (
          <>
            <textarea
              readonly
              rows={Math.min(tapUrls.length, 12)}
              aria-label="タグに焼く URL の一覧"
              class="w-full rounded-lg border border-border bg-background-subtle p-3 font-mono text-xs break-all"
            >
              {tapUrls.join("\n")}
            </textarea>
            <p class={`${ITEM_META_CLASS} mt-2`}>
              この欄を選択してコピーし、NFC の書き込みアプリへ貼り付けてください。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  </KiwaShell>
);
