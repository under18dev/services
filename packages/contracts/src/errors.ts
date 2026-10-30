/**
 * Worker 間 RPC で共有するエラー契約。
 *
 * RPC 越しに Error のサブクラスを投げてもプロトタイプは保たれないため、
 * 失敗はこの判別可能ユニオンで「値として」返す。呼び出し側 (Infrastructure adapter) が
 * 自分の層のエラーへ翻訳する。
 */
export const RpcErrorCode = {
  /** 入力 DTO がスキーマ検証に失敗した。 */
  InvalidInput: "invalid_input",
  /** 呼び出し元に、この操作を行う権限がない。 */
  Forbidden: "forbidden",
  /** 認証情報 (セッション等) が無効・期限切れ。 */
  Unauthenticated: "unauthenticated",
  /** 対象リソースが存在しない。 */
  NotFound: "not_found",
  /** レート制限に達した。 */
  RateLimited: "rate_limited",
  /**
   * 再認証が要る（#11 / #75）。
   *
   * **`Forbidden` と分ける。** 呼び出し元の見せ方が違う —— こちらは
   * 「もう一度ログインすれば通る」であって、権限が無いわけではない。
   * 畳むと UI が「権限がありません」と出すしかなくなり、利用者は
   * 何をすれば進めるのか分からなくなる。
   */
  ReauthenticationRequired: "reauthentication_required",
  /**
   * 状態が衝突している（username の重複、管理者の最後の Passkey など）。
   *
   * **`InvalidInput` と分ける。** 入力の形は正しく、**いまの状態では
   * 通らない**という意味。利用者が直せるもの（別の username にする）と、
   * 直せないもの（管理者は Passkey を 1 本残す）の両方が入る。
   */
  Conflict: "conflict",
  /** 呼び出し先の内部エラー。詳細は呼び出し元へ漏らさない。 */
  Internal: "internal",
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

export type RpcError = {
  readonly code: RpcErrorCode;
  /** 人間向けの短い説明。機密情報・トークン・メールアドレスを含めないこと。 */
  readonly message: string;
};

export type RpcResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcError };

export const rpcOk = <T>(value: T): RpcResult<T> => ({ ok: true, value });

export const rpcErr = (code: RpcErrorCode, message: string): RpcResult<never> => ({
  ok: false,
  error: { code, message },
});

/**
 * アカウント API（`/account/*`）が `error` として返しうるコードの全体（#187）。
 *
 * ## なぜ契約側に置くか
 *
 * **UI がこれを網羅していることを型で強制できるようにするため。**
 *
 * ```ts
 * const MESSAGES: Record<AccountApiErrorCode, string> = { ... };
 * ```
 *
 * こう書いておけば、**ここへコードを 1 つ足した時点で UI がビルドで落ちる。**
 * 実行時に「知らないコードが来た」ではなく、変更した人の手元で
 * 「文言を書いていない」で止まる —— auth-worker の `AUDIT_EVENT_RETENTION`
 * （`Record<AuditEventName, AuditClassification>`）が区分の指定を
 * 強制しているのと同じ形である。
 *
 * ## `message` を通さない代わりの仕組みである
 *
 * auth-worker の `message` は英語で、利用者向けに書かれていない。
 * **文言は表示側の責務**にしたうえで、「表示側が知らないコードが増える」
 * という (A) 方式の唯一の弱点を、この網羅でふさぐ。
 *
 * `identity_unavailable` だけ `RpcErrorCode` に無い —— これは
 * dashboard-worker が「RPC が届かなかった」を表すために作る値で、
 * auth-worker から送られてくるものではない。
 */
export const ACCOUNT_API_ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  /** もう一度ログインすれば通る。`forbidden` と同じ 403 なので本文で分ける。 */
  "reauthentication_required",
  /** 入力の形は正しいが、いまの状態では通らない（409）。 */
  "conflict",
  "not_found",
  "invalid_input",
  /** auth-worker へ届かなかった。dashboard-worker 側で作る値。 */
  "identity_unavailable",
] as const;

export type AccountApiErrorCode = (typeof ACCOUNT_API_ERROR_CODES)[number];
