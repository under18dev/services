import { pageSecurityHeaders } from "@u18/web-ui";
import type { AdminCardListViewDelegated, RpcErrorCode, UserRefAdmin } from "@u18/contracts";
import type { Context, Hono } from "hono";
import { CSRF_FIELD_NAME, ensureCsrfToken, isValidCsrf } from "./csrf";
import { isAllowedOrigin, isJsonRequest } from "./origin";
import { csrfRejected, MessagePage, serviceUnavailable } from "./ui/message-page";
import { cardTapUrl } from "./nfc-tap-url";
import { resolveUserRefs } from "./user-refs";
import { CardDetailPage, type DayWindow } from "./ui/card-detail-page";
import {
  NfcPage,
  type BulkActionKind,
  type BulkConfirmState,
  type BulkIneligibleRow,
  type BulkResultState,
} from "./ui/nfc-page";
import type { AppBindings } from "./types";

/**
 * NFC カードの管理画面（`admin.under18.dev/nfc`、#382 / #390 決定 16 ③）。
 *
 * **`/account/nfc/admin`（nfc-worker、#377 / #389 / #398）から移した。**
 * 呼び方だけが変わった——セッション Cookie 経由の UseCase ではなく、
 * `NfcAdminDelegatedRPC`（Service Binding）を呼ぶ。
 *
 * ## `actorUserId` は `c.get("session").sub`
 *
 * **検証しない。** セッションガード（`app.ts`）が既に「ログイン済み・
 * 承認リストにある」ことを確かめたあとにしかここへ来ない。
 * `NfcAdminDelegatedRpcContract` の trust boundary の説明を参照。
 *
 * ## JavaScript を要求しない
 *
 * 移行元と同じ理由。**admin-worker にはまだ島が無い**ので、新しく
 * 作らず form POST + PRG で完結させる。
 *
 * ## 枚数の上限はここにも書かない
 *
 * `MAX_ISSUE_COUNT` は nfc-worker 側（`issue-cards.use-case.ts`）が
 * 持っている。ここで同じ値を書き写すと、片方だけ変えられる形を作る
 * ——入力の上限チェックは delegated RPC 側に任せ、ここは「失敗したら
 * 理由を出す」だけにする。
 */

/** 発行の直後に「何枚出したか」を運ぶクエリ名。移行元と同じ理由（ID は運ばない）。 */
const ISSUED_COUNT_PARAM = "issued";

/** batch 一括無効化の直後に「何枚止めたか」を運ぶクエリ名（#427）。 */
const BATCH_DISABLED_COUNT_PARAM = "batch_disabled";

/** batch 一括復帰の直後に「何枚戻したか」を運ぶクエリ名（#436）。 */
const BATCH_REINSTATED_COUNT_PARAM = "batch_reinstated";

const TARGET_URL_REASON_LABEL: Readonly<Record<string, string>> = {
  not_absolute: "URL は https:// から始まる絶対 URL で入力してください。",
  too_long: "URL が長すぎます。短いものをお使いください。",
  not_https: "https:// の URL だけを設定できます。",
  has_credentials: "URL にユーザー名やパスワードを含めることはできません。",
  non_default_port: "ポート番号付きの URL は設定できません。",
  private_host: "このホスト名は設定できません（内部向けのアドレスです）。",
  blocked_host: "このホスト名は設定できません。",
};

/** `c.req.json()` の戻り値を安全に触るための絞り込み。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * `POST /nfc/cards`（#461）の失敗を HTTP ステータスへ訳す。
 *
 * **`invalid_input` は 400。** 枚数が範囲外・`actorUserId` の形が
 * 想定と違う、のどちらもここに畳まれる——`scripts/nfc-burn.py` は
 * 応答本文（`{"error": "..."}`）をそのまま表示するので、コード名が
 * 読めれば足りる。
 */
function statusForIssueFailure(code: RpcErrorCode): 400 | 403 | 503 {
  if (code === "invalid_input") return 400;
  if (code === "forbidden" || code === "unauthenticated") return 403;
  return 503;
}

function issuedCountFromQuery(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return null;
  return parsed;
}

/** `ISSUED_COUNT_PARAM` と違い 0 を許す——該当なしで一括無効化が実行されうる。 */
function batchDisabledCountFromQuery(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/** `batchDisabledCountFromQuery` と同じ理由で 0 を許す。 */
function batchReinstatedCountFromQuery(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * `?batch=` をトリムする。**空文字は「絞り込み無し」に畳む。** `?batch=`
 * だけ付いた URL を「空文字という名前のロット」として扱わないため
 * （issue #481「バッチ名なしの行はリンクにしない」と同じ線引き）。
 */
function batchFromQuery(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `?batch=` を付けた戻り先を組み立てる。`ui/nfc-page.tsx` の
 * `withBatchQuery` と同じ考え方——フォームの `action` 側とルート側の
 * 両方が必要とするので、どちらも素の文字列を直書きせずこの形にする。
 */
function withBatchQueryParam(path: string, batch: string | null): string {
  return batch === null ? path : `${path}?batch=${encodeURIComponent(batch)}`;
}

/**
 * 一覧の再取得＋所有者の名前解決（#471）。何箇所もの描き直し
 * （通常表示・エラー・batch 無効化／復帰の確認・選択一括の確認／結果）が
 * 同じ形で必要とするので、ここへまとめる——**バラバラに書くと、どれか
 * 1 箇所だけ `userRefs` を渡し忘れた行が「—」のまま残る**（他は名前が
 * 出るのにここだけ出ない、という気づきにくい崩れ方をする）。
 *
 * **`batch` は打ち切りの前に効く（#481）。** `listAllCards` に素通しする
 * だけで、`MAX_ADMIN_LIST` の 500 枚より後ろに並んでいたロットも見える。
 *
 * **取得できなければ `null`。** `serviceUnavailable` を返すかどうかは
 * 呼ぶ側が決める——ここでは判定しない。
 */
async function loadCardsForRender(
  c: Context<AppBindings>,
  batch: string | null,
): Promise<{
  readonly cards: readonly AdminCardListViewDelegated[];
  readonly truncated: boolean;
  readonly tapUrls: readonly string[];
  readonly userRefs: ReadonlyMap<string, UserRefAdmin>;
} | null> {
  const container = c.get("container");
  const session = c.get("session");
  const result = await container.nfcCards.listAllCards(batch === null ? undefined : { batch });
  if (!result.ok) return null;

  const tapUrls = result.value.cards
    .filter((card) => card.status === "issued")
    .map((card) => cardTapUrl(container.env.SHORT_URL_ORIGIN, card.cardId));

  const userRefs = await resolveUserRefs(
    container.identityAdmin,
    session.sub,
    result.value.cards.map((card) => card.ownerUserId),
  );

  return { cards: result.value.cards, truncated: result.value.truncated, tapUrls, userRefs };
}

/** `?days=` を 3 択へ丸める。不正値・未指定は既定の 30（`nfc-analytics.routes.tsx` と同じ形）。 */
function resolveDays(raw: string | undefined): DayWindow {
  if (raw === "90") return 90;
  if (raw === "180") return 180;
  return 30;
}

/** 存在しない `cardId` を行き止まりにしない（`users.routes.tsx` の `userNotFound` と同じ形）。 */
function cardNotFound(c: Context<AppBindings>): Response | Promise<Response> {
  return c.html(
    <MessagePage
      title="そのカードは見つかりません"
      message="ID が違うか、すでにありません。一覧から探し直してください。"
      actionHref="/nfc"
      actionLabel="NFC カードの一覧へ戻る"
    />,
    404,
  );
}

/**
 * カード 1 枚の詳細・タップ履歴を取ってページを描く。GET 本体
 * （`registerNfcCardDetailRoutes`）と、操作失敗後の描き直し
 * （`renderCardDetailPageWithError`）が共有する。
 */
async function fetchAndRenderCardDetail(
  c: Context<AppBindings>,
  cardId: string,
  days: DayWindow,
  error: string | undefined,
): Promise<Response> {
  const session = c.get("session");
  const container = c.get("container");

  const cardResult = await container.nfcCards.getCard({ actorUserId: session.sub, cardId });
  if (!cardResult.ok) {
    c.header("Cache-Control", "no-store");
    return cardResult.error.code === "not_found" ? cardNotFound(c) : serviceUnavailable(c);
  }

  // `cardTapHistory`（Service Binding 越しの呼び出し）は reject しうる
  // ——`ok: false` と違い、通信そのものが落ちる経路（`app.tsx` の `/` が
  // `Promise.allSettled` を使う理由と同じ）。`resolveUserRefs` は reject
  // しない（3b の指摘）が、`Promise.all` に混ぜると `cardTapHistory` の
  // reject がこちらごと巻き込む——`.catch` で先に畳んでおく。
  const [tapHistoryResult, ownerRefs] = await Promise.all([
    container.nfcCards
      .cardTapHistory({ actorUserId: session.sub, cardId, days })
      .catch((): null => null),
    resolveUserRefs(container.identityAdmin, session.sub, [cardResult.value.ownerUserId]),
  ]);
  const tapHistory =
    tapHistoryResult !== null && tapHistoryResult.ok ? tapHistoryResult.value : null;

  c.header("Cache-Control", "no-store");
  return c.html(
    <CardDetailPage
      csrfToken={ensureCsrfToken(c)}
      card={cardResult.value}
      days={days}
      tapHistory={tapHistory}
      ownerRefs={ownerRefs}
      {...(error === undefined ? {} : { error })}
    />,
    error === undefined ? 200 : 400,
  );
}

/**
 * 操作のフォームが「詳細から来た」と申告しているか
 * （`users.routes.tsx` の `cameFromDetail` と同じ形）。
 */
function cameFromDetail(form: FormData): boolean {
  return form.get("from")?.toString() === "detail";
}

/** 操作のあとの戻り先。詳細から来たときだけ詳細へ戻す。 */
function redirectTargetOf(form: FormData, cardId: string): string {
  return cameFromDetail(form) ? `/nfc/${encodeURIComponent(cardId)}` : "/nfc";
}

/**
 * 1 回の選択一括操作で受け付ける上限（#481）。**`getUsersByIdsDelegatedInputSchema`
 * の `userIds`（最大 100）と同じ理由**——「選べるだけ選んで 1 リクエストで
 * 流し込む」口にしないため。超えたら拒否して、そう言う。
 */
const BULK_SELECT_LIMIT = 100;

/** `card_id` を重複・空文字を除いて取り出す。 */
function uniqueCardIdsFrom(form: FormData): string[] {
  const seen = new Set<string>();
  for (const value of form.getAll("card_id")) {
    const id = value.toString().trim();
    if (id !== "") seen.add(id);
  }
  return [...seen];
}

/**
 * 選択の中身を「効くもの」と「効かないもの（理由つき）」へ分ける。
 *
 * **確認画面を描くときと、実行する直前の 2 回、同じ関数で分け直す**
 * （issue #481 への追記と同じ設計）。確認してから実行するまでの間に
 * 誰か（運営自身の別タブも含む）が状態を変えていても、実行直前の
 * もう 1 回が追従する——確認画面の内訳をそのまま信用しない。
 */
function categorizeForDisable(
  selected: readonly string[],
  cardsById: ReadonlyMap<string, AdminCardListViewDelegated>,
): {
  readonly eligibleCardIds: readonly string[];
  readonly ineligible: readonly BulkIneligibleRow[];
} {
  const eligibleCardIds: string[] = [];
  const ineligible: BulkIneligibleRow[] = [];
  for (const cardId of selected) {
    const card = cardsById.get(cardId);
    if (card === undefined) {
      ineligible.push({ cardId, reason: "見つかりません（絞り込みの外、または既に削除済み）" });
      continue;
    }
    if (card.status === "disabled") {
      ineligible.push({ cardId, reason: "既に無効化済みです" });
      continue;
    }
    eligibleCardIds.push(cardId);
  }
  return { eligibleCardIds, ineligible };
}

/** `categorizeForDisable` の対（#481）。`disabled` のカードだけが対象。 */
function categorizeForReinstate(
  selected: readonly string[],
  cardsById: ReadonlyMap<string, AdminCardListViewDelegated>,
): {
  readonly eligibleCardIds: readonly string[];
  readonly ineligible: readonly BulkIneligibleRow[];
} {
  const eligibleCardIds: string[] = [];
  const ineligible: BulkIneligibleRow[] = [];
  for (const cardId of selected) {
    const card = cardsById.get(cardId);
    if (card === undefined) {
      ineligible.push({ cardId, reason: "見つかりません（絞り込みの外、または既に削除済み）" });
      continue;
    }
    if (card.status !== "disabled") {
      ineligible.push({ cardId, reason: "無効化されていません" });
      continue;
    }
    eligibleCardIds.push(cardId);
  }
  return { eligibleCardIds, ineligible };
}

/**
 * カード 1 枚の詳細（`admin.under18.dev/nfc/:cardId`、#472）。
 *
 * **`registerNfcAnalyticsRoutes`（`/nfc/analytics`）より後に登録すること。**
 * 先に登録すると `:cardId` が `analytics` を吸ってしまい、解析画面が
 * 「カードが見つかりません」になる——Hono は登録順に照合する
 * （`users.routes.tsx:310` 付近に同じ罠の記述がある。`app.tsx` の
 * 登録順と `nfc.routes.test.ts` の「吸われていないこと」のテストを参照）。
 */
export function registerNfcCardDetailRoutes(app: Hono<AppBindings>): void {
  app.get("/nfc/:cardId", pageSecurityHeaders, async (c) => {
    const cardId = c.req.param("cardId");
    const days = resolveDays(c.req.query("days"));
    return fetchAndRenderCardDetail(c, cardId, days, undefined);
  });
}

export function registerNfcRoutes(app: Hono<AppBindings>): void {
  app.get("/nfc", pageSecurityHeaders, async (c) => {
    const batch = batchFromQuery(c.req.query("batch"));
    return renderNfcPage(c, batch, {
      issuedCount: issuedCountFromQuery(c.req.query(ISSUED_COUNT_PARAM)),
      batchDisabledCount: batchDisabledCountFromQuery(c.req.query(BATCH_DISABLED_COUNT_PARAM)),
      batchReinstatedCount: batchReinstatedCountFromQuery(
        c.req.query(BATCH_REINSTATED_COUNT_PARAM),
      ),
    });
  });

  app.post("/nfc", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/nfc");
    }

    const session = c.get("session");
    const count = Number(form.get("count")?.toString() ?? "");
    const rawBatch = form.get("batch")?.toString().trim() ?? "";

    const container = c.get("container");
    const result = await container.nfcCards.issueCards({
      actorUserId: session.sub,
      count,
      batch: rawBatch === "" ? null : rawBatch,
    });

    if (!result.ok) {
      return renderNfcPage(
        c,
        batchFromQuery(c.req.query("batch")),
        { error: "枚数は 1〜200 の数で指定してください。" },
        400,
      );
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(`/nfc?${ISSUED_COUNT_PARAM}=${result.value.cards.length}`, 303);
  });

  /**
   * 機械向けの発行 API（#461、`scripts/nfc-burn.py` の退路）。
   *
   * **上の `POST /nfc` とは別の経路である。** あちらは HTML form を前提に
   * CSRF トークン（double-submit）で守り、PRG で `/nfc` へ戻るだけで
   * 発行した `cardId` を応答に載せない——`nfc-burn.py` のような機械は
   * 「タグが目の前にある 1 枚を発行して、その ID をその場で受け取る」
   * ことが要るので、どちらも満たせない（この関数の JSDoc と issue #461
   * を参照）。
   *
   * **CSRF トークンではなく Origin + Content-Type の 2 枚で守る。**
   * nfc-worker の `cards.routes.ts`（`/account/nfc/cards`、#433 で消えた
   * 発行経路）と同じ考え方——この JSON API には対応する HTML form が
   * 無いので、double-submit トークンを運ぶ場所が無い。
   *
   * **`pageSecurityHeaders` を付けない。** あれは HTML ページの CSP 等
   * ヘッダで、JSON 応答には意味を持たない（nfc-worker の JSON API も
   * 付けていない）。
   *
   * **セッション・承認の確認は `app.ts` の既存ガードに任せる。** この
   * ルートも「承認済みの管理者」だけが到達する非公開経路の 1 つで、
   * 専用の確認は持たない（issue #461 の指示どおり）。
   */
  app.post("/nfc/cards", async (c) => {
    if (!isAllowedOrigin(c) || !isJsonRequest(c)) {
      return c.json({ error: "forbidden" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const count = isRecord(body) && typeof body.count === "number" ? body.count : NaN;
    const batch =
      isRecord(body) && typeof body.batch === "string" && body.batch.trim() !== ""
        ? body.batch
        : null;

    const session = c.get("session");
    const container = c.get("container");
    const result = await container.nfcCards.issueCards({ actorUserId: session.sub, count, batch });

    if (!result.ok) {
      return c.json({ error: result.error.code }, statusForIssueFailure(result.error.code));
    }

    c.header("Cache-Control", "no-store");
    return c.json({ cards: result.value.cards }, 201);
  });

  app.post("/nfc/:cardId/disable", pageSecurityHeaders, async (c) => {
    const cardId = c.req.param("cardId");
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, form === null ? "/nfc" : redirectTargetOf(form, cardId));
    }

    const session = c.get("session");
    const container = c.get("container");
    const result = await container.nfcCards.disableCard({ actorUserId: session.sub, cardId });

    if (!result.ok) {
      const message = "そのカードは見つかりませんでした。";
      return cameFromDetail(form)
        ? fetchAndRenderCardDetail(c, cardId, 30, message)
        : renderNfcPage(c, batchFromQuery(c.req.query("batch")), { error: message }, 400);
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(redirectTargetOf(form, cardId), 303);
  });

  app.post("/nfc/:cardId/release", pageSecurityHeaders, async (c) => {
    const cardId = c.req.param("cardId");
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, form === null ? "/nfc" : redirectTargetOf(form, cardId));
    }

    const session = c.get("session");
    const container = c.get("container");
    const result = await container.nfcCards.releaseCard({ actorUserId: session.sub, cardId });

    if (!result.ok) {
      const message = "そのカードは見つかりませんでした。";
      return cameFromDetail(form)
        ? fetchAndRenderCardDetail(c, cardId, 30, message)
        : renderNfcPage(c, batchFromQuery(c.req.query("batch")), { error: message }, 400);
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(redirectTargetOf(form, cardId), 303);
  });

  /**
   * 無効化されたカードを `active` へ戻す（#427）。**`active` へ戻すだけで、
   * `issued`（手放す、上の `/release`）とはまとめない** —— 「戻したい」と
   * 「渡したい」は運営側の判断が違う場面なので、2 つのボタンを並べる
   * （`nfc-page.tsx` の `CardActions` を参照）。
   */
  app.post("/nfc/:cardId/reinstate", pageSecurityHeaders, async (c) => {
    const cardId = c.req.param("cardId");
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, form === null ? "/nfc" : redirectTargetOf(form, cardId));
    }

    const session = c.get("session");
    const container = c.get("container");
    const result = await container.nfcCards.reinstateCard({ actorUserId: session.sub, cardId });

    if (!result.ok) {
      const message = "そのカードは見つかりませんでした。";
      return cameFromDetail(form)
        ? fetchAndRenderCardDetail(c, cardId, 30, message)
        : renderNfcPage(c, batchFromQuery(c.req.query("batch")), { error: message }, 400);
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(redirectTargetOf(form, cardId), 303);
  });

  /**
   * 無効化された、所有者の無い（`issued` 由来の）カードを `issued` へ戻す
   * （#436、上の `/reinstate`（→ active）の対）。
   *
   * **`CardActions` が `card.ownerUserId === null` のときだけこちらを
   * 出す。** 上の `/reinstate` へ所有者の無いカードを渡すと、所有者の
   * 無いまま `active` になる壊れた行ができる——
   * `DelegatedReinstateCardToIssuedUseCase` の冒頭を参照。
   *
   * **ルートを分けているのは UI の見た目の整理のためで、不変条件そのもの
   * はここでは守られていない。** `:cardId/reinstate` を直接 POST された
   * 場合に所有者の無いカードが `active` にならないのは、`reinstateAsAdmin`
   * 自身の WHERE 句（`owner_user_id is not null`、#450 のレビューで追加）
   * が理由——Repository 層の不変条件であって、ルートを分けたことの効果
   * ではない（#450 レビューの指摘: コメントが「ルートを分けたから守られる」
   * と書いていたが、データ層を直さない限り成り立っていなかった）。
   */
  app.post("/nfc/:cardId/reinstate-to-issued", pageSecurityHeaders, async (c) => {
    const cardId = c.req.param("cardId");
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, form === null ? "/nfc" : redirectTargetOf(form, cardId));
    }

    const session = c.get("session");
    const container = c.get("container");
    const result = await container.nfcCards.reinstateCardToIssued({
      actorUserId: session.sub,
      cardId,
    });

    if (!result.ok) {
      const message = "そのカードは見つかりませんでした。";
      return cameFromDetail(form)
        ? fetchAndRenderCardDetail(c, cardId, 30, message)
        : renderNfcPage(c, batchFromQuery(c.req.query("batch")), { error: message }, 400);
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(redirectTargetOf(form, cardId), 303);
  });

  app.post("/nfc/:cardId/target", pageSecurityHeaders, async (c) => {
    const cardId = c.req.param("cardId");
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, form === null ? "/nfc" : redirectTargetOf(form, cardId));
    }

    const session = c.get("session");
    const targetUrl = form.get("targetUrl")?.toString().trim() ?? "";

    const container = c.get("container");
    const result = await container.nfcCards.updateCardTarget({
      actorUserId: session.sub,
      cardId,
      targetUrl,
    });

    if (!result.ok) {
      const message =
        TARGET_URL_REASON_LABEL[result.error.message] ?? "そのカードは見つかりませんでした。";
      return cameFromDetail(form)
        ? fetchAndRenderCardDetail(c, cardId, 30, message)
        : renderNfcPage(c, batchFromQuery(c.req.query("batch")), { error: message }, 400);
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(redirectTargetOf(form, cardId), 303);
  });

  /**
   * batch 単位で `issued`（未紐づけ）のカードを一括無効化する（#427
   * 「配布前の箱ごと盗難」）。**`active` は対象外**——理由は
   * `DelegatedBatchDisableCardsUseCase` の冒頭を参照。
   *
   * ## 2 段階の retype 確認
   *
   * **`target_batch` が空なら 1 段階目。** 入力されたバッチ名で対象
   * 枚数を数えるだけで、何も書き込まない。0 件ならエラーを出す。
   *
   * **`target_batch` があれば 2 段階目。** 再入力した `batch` が
   * `target_batch` と完全に一致したときだけ実際に無効化する。一致
   * しなければ、同じ確認画面へ理由を添えて差し戻す（`target_batch` は
   * 変えない——打ち直すのは利用者で、対象は動かさない）。
   *
   * **これは意図の確認であって、権限の確認ではない。** `target_batch`
   * は hidden に入っているだけなので、攻撃者には障害にならない——
   * 権限は CSRF（上のチェック）とセッションガード（`app.ts`）が持つ。
   */
  app.post("/nfc/batch-disable", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/nfc");
    }

    const session = c.get("session");
    const container = c.get("container");
    const typed = form.get("batch")?.toString().trim() ?? "";
    const targetBatch = form.get("target_batch")?.toString().trim() ?? "";

    if (targetBatch === "") {
      if (typed === "") {
        return renderNfcPage(
          c,
          batchFromQuery(c.req.query("batch")),
          { error: "バッチ名を入力してください。" },
          400,
        );
      }

      const counted = await container.nfcCards.countBatchIssuedCards({
        actorUserId: session.sub,
        batch: typed,
      });
      if (!counted.ok) {
        return serviceUnavailable(c);
      }
      if (counted.value.count === 0) {
        return renderNfcPage(
          c,
          batchFromQuery(c.req.query("batch")),
          { error: "そのバッチには未紐づけのカードがありません。" },
          400,
        );
      }

      return renderNfcPage(c, batchFromQuery(c.req.query("batch")), {
        batchDisable: { batch: typed, count: counted.value.count },
      });
    }

    if (typed !== targetBatch) {
      const counted = await container.nfcCards.countBatchIssuedCards({
        actorUserId: session.sub,
        batch: targetBatch,
      });
      if (!counted.ok) {
        return serviceUnavailable(c);
      }
      return renderNfcPage(
        c,
        batchFromQuery(c.req.query("batch")),
        {
          batchDisable: { batch: targetBatch, count: counted.value.count },
          batchDisableError: "入力が一致しません。もう一度バッチ名を入力してください。",
        },
        400,
      );
    }

    const result = await container.nfcCards.batchDisableCards({
      actorUserId: session.sub,
      batch: targetBatch,
    });
    if (!result.ok) {
      return renderNfcPage(
        c,
        batchFromQuery(c.req.query("batch")),
        { error: "しばらくしてからもう一度お試しください。" },
        400,
      );
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(`/nfc?${BATCH_DISABLED_COUNT_PARAM}=${result.value.cardIds.length}`, 303);
  });

  /**
   * batch 単位で一括無効化されたカードを一括で `issued` へ戻す（#436
   * 「一括で止められるのに一括で戻せない」）。**この一括操作で無効化
   * された行だけが対象**——理由は
   * `DelegatedReinstateBatchToIssuedCardsUseCase` の冒頭を参照。
   *
   * **2 段階の retype 確認は `/nfc/batch-disable` と同じ形にした。**
   * 止めるときと戻すときで確認の重さを変える理由が無い——`39` の指示
   * どおり「止めたときと同じ画面・同じ粒度で押せる」ことを優先した。
   */
  app.post("/nfc/batch-reinstate", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, "/nfc");
    }

    const session = c.get("session");
    const container = c.get("container");
    const typed = form.get("batch")?.toString().trim() ?? "";
    const targetBatch = form.get("target_batch")?.toString().trim() ?? "";

    if (targetBatch === "") {
      if (typed === "") {
        return renderNfcPage(
          c,
          batchFromQuery(c.req.query("batch")),
          { error: "バッチ名を入力してください。" },
          400,
        );
      }

      const counted = await container.nfcCards.countDisabledInBatch({
        actorUserId: session.sub,
        batch: typed,
      });
      if (!counted.ok) {
        return serviceUnavailable(c);
      }
      if (counted.value.count === 0) {
        return renderNfcPage(
          c,
          batchFromQuery(c.req.query("batch")),
          { error: "そのバッチには、一括無効化で止めたカードがありません。" },
          400,
        );
      }

      return renderNfcPage(c, batchFromQuery(c.req.query("batch")), {
        batchReinstate: { batch: typed, count: counted.value.count },
      });
    }

    if (typed !== targetBatch) {
      const counted = await container.nfcCards.countDisabledInBatch({
        actorUserId: session.sub,
        batch: targetBatch,
      });
      if (!counted.ok) {
        return serviceUnavailable(c);
      }
      return renderNfcPage(
        c,
        batchFromQuery(c.req.query("batch")),
        {
          batchReinstate: { batch: targetBatch, count: counted.value.count },
          batchReinstateError: "入力が一致しません。もう一度バッチ名を入力してください。",
        },
        400,
      );
    }

    const result = await container.nfcCards.reinstateBatchToIssuedCards({
      actorUserId: session.sub,
      batch: targetBatch,
    });
    if (!result.ok) {
      return renderNfcPage(
        c,
        batchFromQuery(c.req.query("batch")),
        { error: "しばらくしてからもう一度お試しください。" },
        400,
      );
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(`/nfc?${BATCH_REINSTATED_COUNT_PARAM}=${result.value.cardIds.length}`, 303);
  });

  /**
   * ID で 1 枚を直接開く（#481「打ち切りの外のカードに辿り着く経路」）。
   *
   * **`registerNfcRoutes`（ここ）の中で登録すること。** `/nfc/:cardId`
   * （`registerNfcCardDetailRoutes`）より前に登録しないと、`:cardId` が
   * `"open"` を吸ってしまう——`/nfc/analytics` と同じ登録順の罠
   * （`registerNfcCardDetailRoutes` の JSDoc、`app.tsx` の登録順を参照）。
   */
  app.get("/nfc/open", pageSecurityHeaders, async (c) => {
    const cardId = c.req.query("cardId")?.trim() ?? "";
    if (cardId === "") {
      return renderNfcPage(
        c,
        batchFromQuery(c.req.query("batch")),
        { error: "カード ID を入力してください。" },
        400,
      );
    }

    c.header("Cache-Control", "no-store");
    return c.redirect(`/nfc/${encodeURIComponent(cardId)}`, 303);
  });

  /**
   * 選択による一括無効化（#481 の本体）。**新しい一括 RPC を作らず、
   * 既存の 1 枚ずつの口（`disableCard`）をここで回す。** 1 枚ごとに
   * 監査ログが残り、#450 で入れた持ち主の確認などの守りもそのまま効く
   * ——一括用の口を新しく作ると、同じ守りをもう一度書くことになる
   * （issue #481 の指示）。
   *
   * ## 2 段階確認
   *
   * `confirmed` が無ければ 1 段階目——**書き込まず**、選択の内訳（効く・
   * 効かない、理由つき）だけを見せる。`confirmed=1` が付いていれば
   * 2 段階目——ただし**確認画面の内訳をそのまま信用せず、ここでもう一度
   * `categorizeForDisable` を呼ぶ**（状態が変わっていれば追従する）。
   *
   * ## 部分失敗を正直に出す
   *
   * 成功のリダイレクトに畳まない。`succeeded` / `failed`（理由つき）/
   * 最初から対象外だった `ineligible` を、すべて 200 のその場描画で返す。
   */
  app.post("/nfc/bulk-disable", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    const batch = batchFromQuery(c.req.query("batch"));

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, withBatchQueryParam("/nfc", batch));
    }

    const selected = uniqueCardIdsFrom(form);
    if (selected.length === 0) {
      return renderNfcPage(c, batch, { error: "カードを選んでください。" }, 400);
    }
    if (selected.length > BULK_SELECT_LIMIT) {
      return renderNfcPage(
        c,
        batch,
        { error: `一度に選べるのは ${BULK_SELECT_LIMIT} 枚までです。` },
        400,
      );
    }

    const loaded = await loadCardsForRender(c, batch);
    if (loaded === null) return serviceUnavailable(c);
    const cardsById = new Map(loaded.cards.map((card) => [card.cardId, card]));
    const { eligibleCardIds, ineligible } = categorizeForDisable(selected, cardsById);

    const confirmed = form.get("confirmed")?.toString() === "1";
    if (!confirmed) {
      if (eligibleCardIds.length === 0) {
        return renderNfcPage(
          c,
          batch,
          { error: "選んだ中に無効化できるカードがありません。" },
          400,
        );
      }
      return renderNfcPage(c, batch, {
        bulkConfirm: {
          action: "disable" satisfies BulkActionKind,
          selectedCardIds: selected,
          eligibleCardIds,
          ineligible,
        },
      });
    }

    const session = c.get("session");
    const container = c.get("container");
    const succeeded: string[] = [];
    const failed: BulkIneligibleRow[] = [];
    for (const cardId of eligibleCardIds) {
      const result = await container.nfcCards.disableCard({ actorUserId: session.sub, cardId });
      if (result.ok) {
        succeeded.push(cardId);
      } else {
        failed.push({ cardId, reason: "そのカードは見つかりませんでした。" });
      }
    }

    return renderNfcPage(c, batch, {
      bulkResult: { action: "disable", succeeded, failed, ineligible },
    });
  });

  /**
   * 選択による一括復帰（#481）。`categorizeForDisable` の対で、
   * `disabled` のカードだけが対象。
   *
   * **復帰は 1 つの操作ではない。** 持ち主がいるカードは `reinstateCard`
   * （`active` へ）、いないカードは `reinstateCardToIssued`（`issued`
   * へ）——契約が「まとめて 1 つの強い操作にしない」と明示している
   * （#422 / #436、`reinstateCard` の JSDoc を参照）。**選択の中身
   * （`card.ownerUserId`）を見てカードごとに呼び分ける。**
   */
  app.post("/nfc/bulk-reinstate", pageSecurityHeaders, async (c) => {
    const form = await c.req.formData().catch(() => null);
    const batch = batchFromQuery(c.req.query("batch"));

    if (form === null || !isValidCsrf(c, form.get(CSRF_FIELD_NAME)?.toString())) {
      c.header("Cache-Control", "no-store");
      return csrfRejected(c, withBatchQueryParam("/nfc", batch));
    }

    const selected = uniqueCardIdsFrom(form);
    if (selected.length === 0) {
      return renderNfcPage(c, batch, { error: "カードを選んでください。" }, 400);
    }
    if (selected.length > BULK_SELECT_LIMIT) {
      return renderNfcPage(
        c,
        batch,
        { error: `一度に選べるのは ${BULK_SELECT_LIMIT} 枚までです。` },
        400,
      );
    }

    const loaded = await loadCardsForRender(c, batch);
    if (loaded === null) return serviceUnavailable(c);
    const cardsById = new Map(loaded.cards.map((card) => [card.cardId, card]));
    const { eligibleCardIds, ineligible } = categorizeForReinstate(selected, cardsById);

    const confirmed = form.get("confirmed")?.toString() === "1";
    if (!confirmed) {
      if (eligibleCardIds.length === 0) {
        return renderNfcPage(c, batch, { error: "選んだ中に復帰できるカードがありません。" }, 400);
      }
      return renderNfcPage(c, batch, {
        bulkConfirm: {
          action: "reinstate" satisfies BulkActionKind,
          selectedCardIds: selected,
          eligibleCardIds,
          ineligible,
        },
      });
    }

    const session = c.get("session");
    const container = c.get("container");
    const succeeded: string[] = [];
    const failed: BulkIneligibleRow[] = [];
    for (const cardId of eligibleCardIds) {
      // **持ち主の有無でカードごとに呼び分ける。** `categorizeForReinstate`
      // の時点では `disabled` であることしか見ていない——実行直前の
      // `cardsById` が持つ `ownerUserId` を見て、1 枚ごとに正しい口を選ぶ。
      const card = cardsById.get(cardId);
      const result =
        card?.ownerUserId === null
          ? await container.nfcCards.reinstateCardToIssued({ actorUserId: session.sub, cardId })
          : await container.nfcCards.reinstateCard({ actorUserId: session.sub, cardId });
      if (result.ok) {
        succeeded.push(cardId);
      } else {
        failed.push({ cardId, reason: "そのカードは見つかりませんでした。" });
      }
    }

    return renderNfcPage(c, batch, {
      bulkResult: { action: "reinstate", succeeded, failed, ineligible },
    });
  });
}

/**
 * `NfcPage` の描き直しをまとめる入口。
 *
 * **6 状態（通常・エラー・batch 無効化／復帰の確認・選択一括の確認／結果）
 * がそれぞれ別関数で一覧をもう一度引いていた形だと、状態が増えるたびに
 * `cards` / `truncated` / `tapUrls` / `userRefs` / `batch` を渡し忘れる行が
 * 増える**（#481 で選択一括の 2 状態を足すときに実際に踏んだ）。ここへ
 * まとめ、呼び出し側は変わる値だけを渡す。
 *
 * **303 で戻さない呼び出しのためにある。** PRG は成功した操作のためのもの
 * で、失敗をクエリへ載せると文言を URL から差し替えられる
 * （`issuedCountFromQuery` と同じ理由）。
 */
async function renderNfcPage(
  c: Context<AppBindings>,
  batch: string | null,
  options: {
    readonly issuedCount?: number | null;
    readonly error?: string | null;
    readonly batchDisable?: { readonly batch: string; readonly count: number } | null;
    readonly batchDisableError?: string | null;
    readonly batchDisabledCount?: number | null;
    readonly batchReinstate?: { readonly batch: string; readonly count: number } | null;
    readonly batchReinstateError?: string | null;
    readonly batchReinstatedCount?: number | null;
    readonly bulkConfirm?: BulkConfirmState;
    readonly bulkResult?: BulkResultState;
  },
  status: 200 | 400 = 200,
): Promise<Response> {
  const loaded = await loadCardsForRender(c, batch);
  if (loaded === null) return serviceUnavailable(c);

  c.header("Cache-Control", "no-store");
  return c.html(
    <NfcPage
      cards={loaded.cards}
      truncated={loaded.truncated}
      tapUrls={loaded.tapUrls}
      userRefs={loaded.userRefs}
      csrfToken={ensureCsrfToken(c)}
      batch={batch}
      issuedCount={options.issuedCount ?? null}
      error={options.error ?? null}
      batchDisable={options.batchDisable ?? null}
      batchDisableError={options.batchDisableError ?? null}
      batchDisabledCount={options.batchDisabledCount ?? null}
      batchReinstate={options.batchReinstate ?? null}
      batchReinstateError={options.batchReinstateError ?? null}
      batchReinstatedCount={options.batchReinstatedCount ?? null}
      bulkConfirm={options.bulkConfirm ?? null}
      bulkResult={options.bulkResult ?? null}
    />,
    status,
  );
}
