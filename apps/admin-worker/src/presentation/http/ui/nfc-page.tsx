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
};

/**
 * カード 1 行ぶんの操作（Actions 列）。
 *
 * **`active` のカードにだけ無効化・遷移先の書き換えを出す。** 出しても
 * 必ず失敗する入口を描かない（移行元と同じ判断）。
 *
 * **所有者の付け替え（release）は無い。** 優先度が低いと判断されて
 * おり（運用者の指示）、裏側の delegated RPC にもまだ無い。
 */
const CardActions: FC<{ readonly card: AdminCardViewDelegated; readonly csrfToken: string }> = ({
  card,
  csrfToken,
}) =>
  card.status !== "active" ? null : (
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

export const NfcPage: FC<NfcPageProps> = ({
  cards,
  truncated,
  tapUrls,
  csrfToken,
  issuedCount,
  error,
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

    <Card>
      <CardHeader>
        <CardTitle>この画面からできないこと</CardTitle>
        <CardDescription>
          他の人のカードの所有者の付け替え（release）は、まだこの画面からは行えません。 裏側の RPC
          にもまだありません——優先度が低いと判断されています。
        </CardDescription>
      </CardHeader>
    </Card>
  </KiwaShell>
);
