import type { NfcCardEventName } from "../domain/services/retention-policy";
import type { SessionSummary } from "@u18/contracts";
import type { Card, CardStatus } from "../domain/entities/card";
import type { NfcFailure } from "../domain/errors";

export type { Clock } from "@u18/domain";

export type NfcOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: NfcFailure };

export const outcomeOk = <T>(value: T): NfcOutcome<T> => ({ ok: true, value });
export const outcomeErr = (failure: NfcFailure): NfcOutcome<never> => ({ ok: false, failure });

/**
 * Identity への問い合わせ Port。
 *
 * nfc-worker は Identity D1 を持たない（仕様書 4.1）。本人性の根拠は
 * すべてここを通る。
 *
 * **`getSession` しか置いていない。** プロフィール（`getUserProfile`）は
 * カードの所有者判定に要らず、要らないものを呼ぶと「NFC 側が侵害されたとき
 * に漏れる範囲」がメールアドレスまで広がる。必要になるまで足さない。
 */
export interface IdentityGateway {
  /** セッショントークンから userId を得る。無効なら `value` は null。 */
  getSession(sessionToken: string): Promise<NfcOutcome<SessionSummary | null>>;
}

/** カード発行の入力（#187）。カード ID は呼び出し側で生成しない。 */
export type IssueCardsInput = {
  /** 何枚発行するか。 */
  readonly count: number;
  /** ロット名。配布の単位を後から辿るのに使う。 */
  readonly batch: string | null;
};

/**
 * 発行結果。
 *
 * **#358 以降、ここに秘密は無い。** 紐づけコードを廃止したので、
 * 発行で出るのはカード ID だけ —— **タグに書く値そのもの**である。
 * 取りこぼしても `listCards` から引き直せる（以前は再発行しかなかった）。
 *
 * ただし **`issued` のカードは、ID を知っている人がタップすれば
 * その人のものになる。** 配布前の束を人目に晒さないことが、
 * #358 以降の唯一の運用上の守りである（`docs/runbook.md`）。
 */
export type IssuedCard = {
  readonly cardId: string;
};

/** 新規発行するカードの初期値。 */
export type NewCard = {
  readonly id: string;
  readonly batch: string | null;
};

/** 一覧・詳細で返す、所有者本人向けの表示用データ。 */
export type CardView = {
  readonly cardId: string;
  readonly status: CardStatus;
  readonly targetUrl: string | null;
  /** ISO 8601 (UTC)。 */
  readonly claimedAt: string | null;
  readonly transferCount: number;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
};

/**
 * 運営向けの一覧で返す表示用データ（#338 Step 3）。
 *
 * **`CardView` と別の型にしてある。** あちらは所有者本人が自分のカードを
 * 見るもので、**所有者の userId を含まない**（自分のものだと分かっている）。
 * こちらは全員のカードを見るので `ownerUserId` が要る。
 *
 * **同じ型に `ownerUserId?` を足さないこと。** 省略可能にすると、
 * 所有者向けの経路が**うっかり埋めても型が通る**。別の型なら、
 * 所有者向けの画面へ渡した時点で落ちる。
 */
export type AdminCardView = {
  readonly cardId: string;
  readonly status: CardStatus;
  /** 未紐づけなら null。 */
  readonly ownerUserId: string | null;
  readonly targetUrl: string | null;
  /** ロット名。配布の単位。 */
  readonly batch: string | null;
  /** ISO 8601 (UTC)。発行された時刻。 */
  readonly issuedAt: string;
  /** ISO 8601 (UTC)。 */
  readonly claimedAt: string | null;
  readonly disabledAt: string | null;
  /**
   * タップされた回数の合計（#394）。`resolvable` だったタップだけを数える。
   *
   * **所有者には見せない。** 運営向けの一覧（この型）にだけ乗せ、
   * `CardView`（所有者向け）には足さない——運用者の判断（#394）。
   */
  readonly tapCount: number;
};

/**
 * 運営向けの一覧の結果（#338 Step 3）。
 *
 * ## **打ち切ったことを値として返す**
 *
 * 件数の上限で切ったとき、**切ったこと自体を呼び出し側へ渡す。**
 * 「最初の N 件」を黙って返すと、運営は**全部を見たつもりで一部を見る。**
 * このリポジトリが繰り返し踏んでいる「検査の範囲が静かに狭まる」
 * （#96 / #122 / #332）の、画面版である。
 */
export type AdminCardList = {
  readonly cards: readonly AdminCardView[];
  /** 上限で打ち切ったか。true なら画面にそう出すこと。 */
  readonly truncated: boolean;
};

/**
 * カードの永続化 Port。
 *
 * ## 状態遷移を「条件付き UPDATE」として表現している理由
 *
 * `findById` して所有者を確かめてから `save` すると、2 つのリクエストが
 * 同時に来たときに両方が「確かめた」状態で書き込める。仕様書 7.3 が
 * 認可コードについて要求しているのと同じで、**遷移の前提条件を
 * WHERE 句に入れて、同時実行の片方だけを成功させる**。
 *
 * そのため各メソッドは「更新できたか」を boolean で返し、
 * 失敗の理由を返さない。理由が要る場面が無いうえ、理由を返すと
 * 「カードは存在したが所有者が違った」が呼び出し側へ漏れる。
 */
export interface CardRepository {
  /** カード ID で引く。存在しなければ null。 */
  findById(cardId: string): Promise<Card | null>;

  /** 所有者のカード一覧。無効化済みも含める（所有者には見せてよい）。 */
  listByOwner(ownerUserId: string): Promise<readonly Card[]>;

  /**
   * 全カードの一覧（運営向け、#338 Step 3）。
   *
   * **`limit + 1` 件まで取ること。** 呼び出し側が「上限で切れたか」を
   * 判定できるようにするためで、ちょうど `limit` 件返すと
   * 「ちょうど上限だった」と「それ以上ある」が区別できない。
   */
  listAll(limit: number): Promise<readonly Card[]>;

  /** 運営によるカード発行。HTTP では公開しない（管理者ロールが未実装のため）。 */
  issue(card: NewCard, now: Date): Promise<void>;

  /**
   * 遷移先を更新する。`ownerUserId` が現在の所有者で、かつ `active` の
   * ときだけ成功する。
   */
  updateTarget(cardId: string, ownerUserId: string, targetUrl: string, now: Date): Promise<boolean>;

  /** 無効化する。現在の所有者のときだけ成功する。 */
  disable(cardId: string, ownerUserId: string, reason: string, now: Date): Promise<boolean>;

  /**
   * 運営による無効化（#382「他人のカードへの操作」）。
   *
   * **`disable` との違いは `ownerUserId` を WHERE 句に持たないことだけ。**
   * 所有者を問わず、`active` であることだけを条件にする。所有者判定を
   * ここで外すのは、**管理者判定を UseCase の中だけに置く**という
   * `cards.routes.ts` の方針（判定をルートに書くと経路が増えたときに
   * 素通りする形を作る）を、Repository 層まで一貫させるため ——
   * 「誰のカードか」という条件自体を無くし、「管理者かどうか」の判定は
   * `AdminDisableCardUseCase` の `requireAdminUserId` だけに置く。
   */
  disableAsAdmin(cardId: string, reason: string, now: Date): Promise<boolean>;

  /**
   * 運営による遷移先の変更（#382「他人のカードへの操作」2 本目）。
   *
   * **`updateTarget` との違いは所有者を WHERE 句に持たないことだけ**で、
   * `disableAsAdmin` と同じ考え方。`active` であることは要求する ——
   * 無効化済みのカードの遷移先を書き換えても、タップは `redirect.routes.ts`
   * の `resolvable` 判定を通らないので、**遷移先の意味を持たない値を
   * 書き込むだけになる**（`UpdateCardTargetUseCase` の「無効化済みは
   * 所有者でも書き換えられない」と同じ理由）。
   */
  updateTargetAsAdmin(cardId: string, targetUrl: string, now: Date): Promise<boolean>;

  /**
   * 未紐づけのカードの所有者を確定する（#358）。
   *
   * **「まだ誰のものでもない」を WHERE 句に入れること。** アプリ側で
   * 確かめてから UPDATE すると、**同じカードを同時にタップした 2 人が
   * 両方成功する** —— 紐づけコードがあった頃は「同じ紙片を持つ 2 人」
   * という珍しい話だったが、**#358 以降は ID を知っていれば誰でも投げられる
   * ので、競合は起こしやすくなっている。**
   */
  claim(cardId: string, newOwnerUserId: string, now: Date): Promise<boolean>;

  /**
   * 所有権を手放して未紐づけへ戻す（移転の前半）。
   *
   * 現在の所有者のときだけ成功する。遷移先もここで消す —— 前の所有者が
   * 設定した URL を、次の所有者のカードがそのまま配信し続けないため。
   *
   * **#358 で紐づけコードを返さなくなった。** 手放したカードは
   * `issued` へ戻り、**次にタップした人のものになる。** 渡す相手に
   * 手渡しするまでの間が無防備なことは、`ReleaseCardUseCase` に書いてある。
   */
  release(cardId: string, ownerUserId: string, now: Date): Promise<boolean>;
}

/** カードに起きたことの記録（`nfc_card_events`）。 */
export interface CardEventRecorder {
  record(event: {
    readonly cardId: string;
    /** 登録簿で閉じてある。typo が黙って通ると調査で気づけない（#123 と同じ理由）。 */
    readonly event: NfcCardEventName;
    readonly actorUserId: string | null;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * 保持期限を過ぎた `nfc_card_events` の行を消す Port。
 *
 * **Identity 側の掃除からは触れない。** `u18-nfc` は別の D1 で、
 * auth-worker はその binding を持たない（持たせると nfc-worker の
 * 侵害時に届く範囲の話が逆転する）。したがって掃除もこの Worker が回す。
 */
export interface ExpiredEventPurger {
  /**
   * @param deadlines イベント名ごとの境界。ここに無い名前の行は消さない
   *   —— **知らないイベントを消すより、残して気づくほうがよい。**
   * @param limit 1 回で消す上限。
   */
  purge(deadlines: ReadonlyMap<string, Date>, limit: number): Promise<number>;
}

/**
 * カードのタップ回数の記録・集計 Port（#394）。
 *
 * **カードごと・日ごとの合計だけを持つ。誰がタップしたかは記録しない。**
 * `taps.ts`（`packages/nfc-db`）の冒頭にその理由がある。
 *
 * `CardEventRecorder` と別の Port にしてあるのは、こちらが「所有者の
 * 操作」ではなく「認証しない公開経路（`redirect.routes.ts`）からの
 * 集計」だからである——呼び出し元の信頼レベルが違う。
 */
export interface CardTapRecorder {
  /**
   * `resolvable` だったタップを 1 回記録する。
   *
   * **失敗してもリダイレクトを止めてはならない。** 呼び出し側
   * （`redirect.routes.ts`）がこれを `executionCtx.waitUntil` へ載せ、
   * 応答を返したあとに実行させる。実装自身も失敗を飲み込む
   * （`DrizzleCardEventRecorder` と同じ fail-open）。
   *
   * @param date UTC の日付文字列（`YYYY-MM-DD`）。
   */
  recordTap(cardId: string, date: string): Promise<void>;

  /**
   * 運営向け一覧の表示用。指定した `cardId` ごとの合計を返す
   * （行が無いカードは結果に含まれない。呼び出し側は 0 として扱うこと）。
   */
  totalsFor(cardIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

/**
 * 保持期限を過ぎた `nfc_card_taps` の行を消す Port（#394）。
 *
 * **`ExpiredEventPurger` と別にしてある。** あちらは `event` 名ごとに
 * 違う境界を持つが、こちらは単一の境界（`date` 列）しか無く、
 * `nfc_card_taps` には `id` も無い（複合主キー）ので削除の組み立て方も違う
 * （`infrastructure/persistence/drizzle-expired-tap.purger.ts`）。
 */
export interface ExpiredTapPurger {
  /**
   * @param deadline UTC の日付文字列。これより古い（文字列比較で小さい）
   *   `date` の行を消す。
   * @param limit 1 回で消す上限。
   */
  purge(deadline: string, limit: number): Promise<number>;
}
