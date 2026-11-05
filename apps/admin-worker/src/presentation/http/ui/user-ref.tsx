import type { UserRefAdmin } from "@u18/contracts";
import { Badge } from "@u18/web-ui/kiwa";
import { ITEM_META_CLASS, ITEM_RAW_CLASS } from "@u18/web-ui/kiwa/island-classes";
import type { FC } from "hono/jsx";

export type UserRefProps = {
  /** `null` は「そもそも所有者がいない」（未紐づけカードなど）。 */
  readonly id: string | null;
  readonly refs: ReadonlyMap<string, UserRefAdmin>;
};

/**
 * カードの所有者・監査ログの actor を名前で出す、唯一の出し方（#471）。
 *
 * **共有コンポーネントはこれ 1 つにする。** #472（カード詳細）・#473
 * （クライアント詳細）もこれを import する——2 つの実装が並ぶと、片方だけ
 * 直された表示が生まれる（`resolveUserRefs` と対になる、`route-permissions.ts`
 * の「判定は 1 箇所に集める」と同じ考え方）。
 *
 * ## 「解決できなかった」と「不明」は同じではない
 *
 * **「不明」と書かない。** `id` が `refs` に無いのは、名前が引けなかった
 * だけで、ID 自体は本物である——`<code>` に ID の先頭だけを出し、`title`
 * に全体を入れる。「不明」と書くと、行が存在しないのか名前が引けなかった
 * だけなのかを運用者が区別できなくなる（issue #471 の冒頭）。
 *
 * **`id === null`（所有者がいない）はこれとは別の状態である。** 「ID は
 * あるが名前が引けない」ではなく「ID 自体が無い」ので、`<code>` に何を
 * 出しても意味のある文字列にならない——ダッシュで示す。
 *
 * ## リンクにするのは解決できたときだけ
 *
 * 解決できなかった ID をリンクにすると、`/users/<id>` が存在しない行を
 * 開くことになり、行き止まりになる（運用者の指示「失敗した画面を
 * 行き止まりにしない」）。
 */
export const UserRef: FC<UserRefProps> = ({ id, refs }) => {
  if (id === null) return <span class={ITEM_META_CLASS}>—</span>;

  const ref = refs.get(id);
  if (ref === undefined) {
    const short = id.length <= 8 ? id : `${id.slice(0, 8)}…`;
    return (
      <code class={ITEM_RAW_CLASS} title={id}>
        {short}
      </code>
    );
  }

  return (
    <span class="inline-flex flex-wrap items-center gap-1.5">
      <a href={`/users/${ref.id}`} class="underline underline-offset-4">
        {ref.displayName} (@{ref.username})
      </a>
      {ref.status === "suspended" ? <Badge variant="warning">停止中</Badge> : null}
      {ref.status === "deleted" ? <Badge variant="destructive">削除済み</Badge> : null}
    </span>
  );
};
