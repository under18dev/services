/**
 * UseCase の共通形。
 *
 * 失敗を例外ではなく値で返す。RPC 越しに Error のプロトタイプが保たれない
 * （仕様書 4.2）のと、呼び出し側に「失敗を扱い忘れる」余地を残さないため。
 */
export type UseCaseError = {
  readonly code: string;
  readonly message: string;
};

export type UseCaseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: UseCaseError };

export const ok = <T>(value: T): UseCaseResult<T> => ({ ok: true, value });

export const err = (code: string, message: string): UseCaseResult<never> => ({
  ok: false,
  error: { code, message },
});

export interface UseCase<Input, Output> {
  execute(input: Input): Promise<UseCaseResult<Output>>;
}
