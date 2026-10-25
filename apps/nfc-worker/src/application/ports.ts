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

/** 新規発行するカードの初期値。 */
export type NewCard = {
  readonly id: string;
  readonly claimCodeHash: string;
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
  // claimCodeHash は載せない。所有者本人にも返す必要がなく、
  // 返せばハッシュの総当たり対象を増やすだけになる。
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
   * 紐づけコードを単回消費して所有者を確定する。
   *
   * ハッシュの一致・状態・期限を WHERE 句に入れること。アプリ側で
   * 確かめてから UPDATE すると、同じコードを同時に投げた 2 人が
   * 両方成功しうる。
   */
  claim(
    cardId: string,
    claimCodeHash: string,
    newOwnerUserId: string,
    claimableSince: Date,
    now: Date,
  ): Promise<boolean>;

  /**
   * 所有権を手放し、新しい紐づけコードを設定する（移転の前半）。
   *
   * 現在の所有者のときだけ成功する。遷移先もここで消す —— 前の所有者が
   * 設定した URL を、次の所有者のカードがそのまま配信し続けないため。
   */
  release(
    cardId: string,
    ownerUserId: string,
    nextClaimCodeHash: string,
    now: Date,
  ): Promise<boolean>;
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

/** 紐づけコードの生成とハッシュ化。実装は Web Crypto に委ねる（仕様書 5.4）。 */
export interface ClaimCodeService {
  /** 人が転記できる長さの、十分にランダムなコードを作る。 */
  generate(): string;
  /** 保存・照合用のハッシュ。高エントロピーな乱数なので SHA-256 で足りる。 */
  hash(code: string): Promise<string>;
}
