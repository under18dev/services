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
import type { AdminCardStatusDelegated, AdminCardViewDelegated } from "@u18/contracts";
import type { FC } from "hono/jsx";
import { CSRF_FIELD_NAME } from "../csrf";
import { ADMIN_NAV_GROUPS } from "./nav";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";

/**
 * NFC カードの管理画面（`admin.under18.dev/nfc`、#382 / #390 決定 16 ③）。
 *
 * **`/account/nfc/admin`（nfc-worker、#377）から移した。** 画面の中身
 * （一覧・発行・コピペ用 URL 一覧・無効化・遷移先の書き換え）はそのまま
 * 持ってきている。変わったのは呼び方（セッション Cookie 経由の UseCase
 * → `NfcAdminDelegatedRPC` 経由）と置き場所だけ。
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
 * ## 所有者は userId までしか出ない（移行元と同じ理由）
 *
 * 表示名もメールアドレスも引かない。nfc-worker は Identity D1 を
 * 持たず、`NfcAdminDelegatedRpcContract` もそれを返さない。
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

export type NfcPageProps = {
  readonly cards: readonly AdminCardViewDelegated[];
  readonly truncated: boolean;
  /** 焼く用の URL 一覧（`issued` のカードだけ、1 行に 1 本）。組み立てるのはルート側。 */
  readonly tapUrls: readonly string[];
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
};

/**
 * カード 1 行ぶんの操作（Actions 列）。
 *
 * **`active` のカードにだけ無効化・遷移先の書き換え・手放させるを出す。**
 * 出しても必ず失敗する入口を描かない（移行元と同じ判断）。
 *
 * ## 「手放させる」であって「付け替える」ではない（#422）
 *
 * 直接別の利用者へ付け替える入口は無い。押すと `issued`（未紐づけ）へ
 * 戻るだけで、次にタップした人のものになる——理由は delegated RPC 側の
 * `DelegatedReleaseCardUseCase` の冒頭を参照（NFC カードのセキュリティ
 * モデルがタップ＝物理的占有の証明であることを壊さないため）。
 *
 * **押す前に本人へ連絡すること。** 止める（無効化）と違い、本人の画面
 * からカードが消える操作で、本人には説明の付かない消え方をする
 * （`docs/nfc-cards-operations.md` §4 を参照）。
 *
 * ## `disabled` のカードには「復帰させる」だけを出す（#427）
 *
 * **`active` へ戻すだけ。** 手放す・遷移先を変えるとはまとめない——
 * 「戻したい」と「渡したい」は運営側の判断が違う場面で、1 操作に混ぜると
 * 復帰のつもりが次の拾得者へ渡る事故を作れる（delegated RPC 側の
 * `DelegatedReinstateCardUseCase` の冒頭を参照）。渡したい場合は、復帰
 * させたあとであらためて「手放させる」を押す——弱い操作を 2 つ並べる
 * ほうが、強い操作を 1 つ作るより安全という #422 と同じ判断。
 *
 * ## `issued` のカードにも単発の「無効化する」を出す（#427）
 *
 * **一括無効化（下のバッチ無効化フォーム）だけに「`issued` を無効化する」
 * 能力を持たせると、押し間違いで 1 枚だけ盗まれたカードを単発で止める
 * 口が無いまま、一括のほうが危ない操作になる。** `disableCard` の
 * WHERE 句を `active | issued` へ広げたのに合わせ、単発の行にも出す。
 */
const CardActions: FC<{ readonly card: AdminCardViewDelegated; readonly csrfToken: string }> = ({
  card,
  csrfToken,
}) => {
  if (card.status === "disabled") {
    return (
      <form method="post" action={`/nfc/${card.cardId}/reinstate`}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <button
          type="submit"
          class={getButtonClasses("outline", "sm")}
          aria-label={`${card.cardId} を復帰させる`}
        >
          復帰させる
        </button>
      </form>
    );
  }

  if (card.status === "issued") {
    return (
      <form method="post" action={`/nfc/${card.cardId}/disable`}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <button
          type="submit"
          class={DANGER_BUTTON_CLASS}
          aria-label={`${card.cardId} を無効化する`}
        >
          無効化する
        </button>
      </form>
    );
  }

  if (card.status !== "active") return null;

  return (
    <div class="flex flex-col gap-2">
      <form
        method="post"
        action={`/nfc/${card.cardId}/target`}
        class="flex flex-wrap items-center gap-1.5"
      >
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <input
          type="url"
          name="targetUrl"
          value={card.targetUrl ?? ""}
          class={`${INPUT_CLASS} w-56`}
          aria-label={`${card.cardId} の遷移先`}
          placeholder="https://example.com/"
        />
        <button type="submit" class={getButtonClasses("outline", "sm")}>
          書き換える
        </button>
      </form>
      <form method="post" action={`/nfc/${card.cardId}/release`}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <button
          type="submit"
          class={DANGER_BUTTON_CLASS}
          aria-label={`${card.cardId} を所有者から手放させる`}
        >
          手放させる
        </button>
      </form>
      <form method="post" action={`/nfc/${card.cardId}/disable`}>
        <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
        <button
          type="submit"
          class={DANGER_BUTTON_CLASS}
          aria-label={`${card.cardId} を無効化する`}
        >
          無効化する
        </button>
      </form>
    </div>
  );
};

export const NfcPage: FC<NfcPageProps> = ({
  cards,
  truncated,
  tapUrls,
  csrfToken,
  issuedCount,
  error,
  batchDisable,
  batchDisableError,
  batchDisabledCount,
}) => (
  <KiwaShell
    title="NFC カード"
    nav={ADMIN_NAV_GROUPS}
    current="nfc"
    brandHref="/"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading="NFC カード"
    lead="発行したカードの一覧と、タグに焼く URL を確認できます。他人のカードも無効化・遷移先の書き換えができます。"
    maxWidth="max-w-6xl"
  >
    <Alert>
      <AlertDescription>
        <strong>
          未紐づけのカードは、ID を知っている人がタップすると、その人のものになります。
        </strong>
        下の URL 一覧は配布物そのものと同じ扱いにしてください。画面を人目のある場所で開かない、
        共有しない、スクリーンショットを残さない。
      </AlertDescription>
    </Alert>

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
            {issuedCount} 枚発行しました。下の一覧に入っています。
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
          戻す手段はまだありません——実行前によく確かめてください。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {batchDisabledCount === null ? null : (
          <p class={`${ITEM_META_CLASS} mb-4`} role="status">
            {batchDisabledCount} 枚を無効化しました。
          </p>
        )}
        {batchDisable === null ? (
          <form method="post" action="/nfc/batch-disable" class="flex flex-col gap-4">
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
              バッチ「{batchDisable.batch}」には、未紐づけのカードが{" "}
              <strong>{batchDisable.count} 枚</strong>あります。
              本当に無効化する場合は、下にバッチ名をもう一度入力してください。
            </p>
            <form method="post" action="/nfc/batch-disable" class="flex flex-col gap-4">
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
            <a href="/nfc" class="text-sm text-foreground-muted underline underline-offset-4">
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

    {truncated && (
      <Alert>
        <AlertDescription>
          <strong>一覧は上限で打ち切られています。</strong>
          表示しているのは新しいほうから 500 枚で、これより古いカードは出ていません。
          <strong>上の URL 一覧も、表示できた範囲のものだけです。</strong>
        </AlertDescription>
      </Alert>
    )}

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>カード ID</TableHead>
                <TableHead>状態</TableHead>
                <TableHead>所有者</TableHead>
                <TableHead>遷移先</TableHead>
                <TableHead>ロット</TableHead>
                <TableHead>発行</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cards.map((card) => (
                <TableRow key={card.cardId}>
                  <TableCell class="font-mono text-xs">{card.cardId}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[card.status]}>{STATUS_LABEL[card.status]}</Badge>
                  </TableCell>
                  <TableCell class="font-mono text-xs break-all">
                    {card.ownerUserId ?? "—"}
                  </TableCell>
                  <TableCell class="max-w-xs font-mono text-xs break-all whitespace-normal">
                    {/* **リンクにしない**（冒頭を参照）。 */}
                    {card.targetUrl ?? "未設定"}
                  </TableCell>
                  <TableCell>{card.batch ?? "—"}</TableCell>
                  <TableCell class={ITEM_META_CLASS}>{toDate(card.issuedAt)}</TableCell>
                  <TableCell>
                    <CardActions card={card} csrfToken={csrfToken} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    )}
  </KiwaShell>
);
