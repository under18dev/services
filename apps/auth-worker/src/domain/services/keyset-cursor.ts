/**
 * `created_at` 降順の一覧をキーセット方式でめくるための、共通のカーソル表現
 * （#375、`listUsers` と `listAuditLogs` の両方が使う）。
 *
 * ## `OFFSET` を使わない理由は呼ぶ側（UseCase）に書いてある
 *
 * ここが持つのはカーソルの**符号化・復号**だけ。「1 件多く読んで続きの
 * 有無を決める」「`from` の組み立て」は各 UseCase の仕事のまま —— クエリの
 * 形は対象ごとに違う（`listUsers` は `query` で絞り、`listAuditLogs` は
 * `event` / `userId` で絞る）ので、ここへ寄せると抽象が漏れる。
 *
 * ## 中身を隠していない
 *
 * `<createdAt のミリ秒>:<id>` をそのまま渡す。base64 にしても復号できる
 * ので秘匿にはならず、「隠してあるから壊れない」と誤解させるだけである。
 * 入っているのは「その管理者が既に見た行の時刻と ID」で、改竄されても
 * 効くのは「どこから読むか」だけ —— 管理者でなければそもそも 1 行も
 * 返らない。
 *
 * **壊れたカーソルは黙って先頭から返さない。** 呼ぶ側が `invalid_input` に
 * すること —— 先頭へ戻すと、画面を送り続けても同じ行が出続ける
 * （終わらない一覧）。
 */

const SEPARATOR = ":";

export type Cursor = { readonly createdAt: Date; readonly id: string };

export function encodeCursor(row: { readonly createdAt: Date; readonly id: string }): string {
  return `${row.createdAt.getTime()}${SEPARATOR}${row.id}`;
}

export function decodeCursor(raw: string): Cursor | null {
  const index = raw.indexOf(SEPARATOR);
  if (index <= 0) return null;

  const at = Number(raw.slice(0, index));
  const id = raw.slice(index + 1);
  if (!Number.isSafeInteger(at) || at < 0 || id === "") return null;

  return { createdAt: new Date(at), id };
}

/**
 * 「続きがあるか」の決め方。**`limit + 1` 件読んだ結果に対して呼ぶこと。**
 *
 * 「ちょうど `limit` 件あったか」で決めると、件数が `limit` の倍数のとき
 * **最後に空のページが 1 回増える**（#375 のネガティブ確認で実際に
 * すり抜けた）。余分の 1 件が実在するかどうかで決める。
 */
export function nextCursorOf<T extends { readonly createdAt: Date; readonly id: string }>(
  overfetched: readonly T[],
  limit: number,
): string | null {
  const page = overfetched.slice(0, limit);
  const last = page.at(-1);
  return overfetched.length > limit && last !== undefined ? encodeCursor(last) : null;
}
