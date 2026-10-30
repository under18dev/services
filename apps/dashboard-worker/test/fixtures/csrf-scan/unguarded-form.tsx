import { CSRF_FIELD_NAME } from "../../../src/presentation/http/csrf";

/**
 * **走査が「見つける」側の見本。** CSRF の hidden input を持たない form。
 *
 * `CSRF_FIELD_NAME` を import して**別の用途に使っている**。
 * 走査が「ファイルの中にこの名前が出てくるか」だけを見ているなら、
 * **これを守られていると誤判定する。** 判定は `name={CSRF_FIELD_NAME}`
 * （実際に描いているか）を見ること。
 */
export const FIELD_NAME_FOR_SOMETHING_ELSE = CSRF_FIELD_NAME;

export const UnguardedForm = () => (
  <form method="post" action="/account/example">
    <button type="submit">送信</button>
  </form>
);
