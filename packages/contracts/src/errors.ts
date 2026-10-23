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
  /** 呼び出し先の内部エラー。詳細は呼び出し元へ漏らさない。 */
  Internal: "internal",
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

export type RpcError = {
  readonly code: RpcErrorCode;
  /** 人間向けの短い説明。機密情報・トークン・メールアドレスを含めないこと。 */
  readonly message: string;
};

export type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcError };

export const rpcOk = <T>(value: T): RpcResult<T> => ({ ok: true, value });

export const rpcErr = (code: RpcErrorCode, message: string): RpcResult<never> => ({
  ok: false,
  error: { code, message },
});
