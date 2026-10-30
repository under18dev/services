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
