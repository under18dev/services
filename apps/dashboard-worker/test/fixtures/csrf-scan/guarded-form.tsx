import { CSRF_FIELD_NAME } from "../../../src/presentation/http/csrf";

/** **走査が「見逃す」側の見本。** hidden input を持つ form。 */
export const GuardedForm = ({ token }: { readonly token: string }) => (
  <form method="post" action="/account/example">
    <input type="hidden" name={CSRF_FIELD_NAME} value={token} />
    <button type="submit">送信</button>
  </form>
);
