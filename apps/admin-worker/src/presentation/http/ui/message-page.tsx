import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  KiwaShell,
  getButtonClasses,
} from "@u18/web-ui/kiwa";
import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { KIWA_STYLESHEET_PATH } from "./asset-paths";
import type { AppBindings } from "../types";

/**
 * ログイン前・失敗時に出す汎用の 1 枚（#443）。
 *
 * ## サイドバーを出さない
 *
 * `KiwaShell` に `current` を渡さない——**`nav` が空でも渡すと
 * チェックボックス・モバイルバーまで描かれる**ので、`nav={[]}` と
 * 合わせて「`current` 自体を渡さない」ことでサイドバーの DOM ごと
 * 消す（`shell.tsx` の `current !== undefined` 分岐）。
 *
 * まだログインしていない・承認されていない人の画面なので、押しても
 * 行ける先が無いナビを出さない。
 *
 * ## 理由は書かない。次にすることだけ書く
 *
 * `message` は「次に何をすればいいか」までを含めた 1 文にすること。
 * **失敗の内部事情（`fail()` の `reason` など）はここに渡さない** ——
 * 画面に出すと攻撃者に何を直せばよいか教える、という既存の方針を
 * 維持する（`app.ts` の `fail()` を参照）。
 */
export type MessagePageProps = {
  readonly title: string;
  readonly message: string;
  readonly actionHref: string;
  readonly actionLabel: string;
};

/**
 * 一覧の取得そのものが失敗したときの応答（nfc / clients / users / audit
 * の各 routes.tsx が共有する）。**行き先は「いま見ていたページ」自身**
 * ——押し直せばもう一度試せる、という以上の案内をここでは持たない。
 */
export function serviceUnavailable(c: Context<AppBindings>): Response | Promise<Response> {
  return c.html(
    <MessagePage
      title="しばらくしてからお試しください"
      message="しばらくしてからもう一度お試しください。"
      actionHref={c.req.path}
      actionLabel="再読み込み"
    />,
    503,
  );
}

/**
 * CSRF 検証に落ちたときの応答（nfc / clients / users / audit の各
 * routes.tsx が共有する、#443）。
 *
 * **運用者の立っている指示（2026-10-31）—— 「人がブラウザで到達しうる
 * 経路は全部 Kiwa UI で作り込む」を受けて、`c.text(..., 403)` から
 * 切り替えた。** 以前は「フォーム POST の失敗は稀な経路で、フルページの
 * 再構築コストに見合わない」として素のテキストに留めていたが、
 * `MessagePage` はもともとデータの再取得を要らない作りなので、
 * **再構築コストという理由自体が成立していなかった。**
 *
 * **行き先は `returnTo`——フォームが置かれていたページ**（例: `/nfc`）。
 * `c.req.path` を使わないのは、POST 先（`/nfc/:cardId/disable` など）に
 * は GET のハンドラが無く、そこへ `<a href>` で戻ると 404 するため。
 */
export function csrfRejected(
  c: Context<AppBindings>,
  returnTo: string,
): Response | Promise<Response> {
  return c.html(
    <MessagePage
      title="操作を確認できませんでした"
      message="操作を確認できませんでした。ページを再読み込みしてから、もう一度お試しください。"
      actionHref={returnTo}
      actionLabel="ページに戻る"
    />,
    403,
  );
}

/**
 * 操作ごとの権限ガード（#190）に落ちたときの応答。
 *
 * **理由を出さない。** 「どのビットが足りないか」を出すと、権限の内訳を
 * 外から探る手がかりになる——`fail()` の既存方針と同じ。**次の一手だけ
 * 置く**（ホームへ戻る）。`serviceUnavailable` / `csrfRejected` と同じ
 * `MessagePage` に寄せる——`c.json({ error: "forbidden" }, 403)` を
 * そのまま人の目に触れる経路に残さない（運用者の指示「人がブラウザで
 * 到達しうる経路は全部 Kiwa UI で作り込む」）。
 *
 * **行き先はホーム（`/`）。** 押しても戻れる元のページ（例: `/nfc`）は
 * 権限が無い本人には結局また 403 になるので、`csrfRejected` の
 * 「いたページへ戻す」とは違い、確実に開けるホームへ送る。
 */
export function forbiddenPermission(c: Context<AppBindings>): Response | Promise<Response> {
  return c.html(
    <MessagePage
      title="この操作の権限がありません"
      message="この操作には権限が必要です。管理者に依頼してください。"
      actionHref="/"
      actionLabel="ホームへ戻る"
    />,
    403,
  );
}

export const MessagePage: FC<MessagePageProps> = ({ title, message, actionHref, actionLabel }) => (
  <KiwaShell
    title={title}
    nav={[]}
    brandHref="/login"
    stylesheet={KIWA_STYLESHEET_PATH}
    heading={title}
  >
    <Card>
      <CardHeader>
        <CardTitle>{message}</CardTitle>
      </CardHeader>
      <CardContent>
        <a href={actionHref} class={getButtonClasses("outline")}>
          {actionLabel}
        </a>
      </CardContent>
    </Card>
  </KiwaShell>
);
