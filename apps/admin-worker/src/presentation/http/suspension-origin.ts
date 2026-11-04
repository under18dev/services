import type { AuditLogEntryAdmin, SuspendReason } from "@u18/contracts";

/**
 * `status: "suspended"` が**どちらの理由で付いたか**の見分け（#455）。
 *
 * ## なぜ要るのか
 *
 * **`suspended` は 2 つの理由で付く** —— 運営による凍結と、本人の退会
 * （#318）。`UserAdminSummary.status` は 1 値なので、**行だけを見ても
 * 区別できない**（契約のコメントが「画面で『凍結されています』と
 * 言い切らないこと」と書いているのはこのため）。
 *
 * 取り違えたときに起きることが非対称である。凍結を退会と読み違えても
 * 「解除しそびれる」で済むが、**退会を凍結と読み違えると、辞めた人を
 * 『解除』して active に戻してしまう。** 運用でいちばん踏みやすいのが
 * ここで、だからこの判定を画面の中に埋めずに切り出してある。
 *
 * ## 監査ログの 2 行を突き合わせる
 *
 * 区別を持っているのは `audit_logs` だけである。**直近 N 件の一覧から
 * 探さない** —— 停止が古ければ N 件の外へ出てしまい、「記録が無い」と
 * 「遠いだけ」が区別できなくなる。イベント名で 1 件ずつ引いて、
 * **新しいほうを採る。**
 *
 * 新しいほうを採るのは、同じ人に両方の記録が残りうるため ——
 * 一度凍結されて解除された人が、後から自分で退会することがある。
 * 「どちらの記録があるか」では決まらず、「最後に起きたのはどちらか」で
 * 決まる。
 */
export type SuspensionOrigin =
  /** 運営が止めた。`reason` は記録から読めたときだけ入る。 */
  | { readonly kind: "ops"; readonly reason: SuspendReason | null; readonly at: string }
  /** 本人が退会した（#318）。**解除してはいけない側。** */
  | { readonly kind: "self_closed"; readonly at: string }
  /** どちらの記録も見つからなかった。**断定しない。** */
  | { readonly kind: "unknown" }
  /** 監査ログを引けなかった。「記録が無い」とは別物として扱う。 */
  | { readonly kind: "unavailable" };

/**
 * 運営による停止の監査イベント名。
 *
 * **auth-worker の `AUDIT_EVENTS`（`application/ports/audit-log.port.ts`）
 * と同じ文字列を手で持っている。** 別 Worker なので import できず、
 * 契約（`@u18/contracts`）にも**わざと置かれていない** ——
 * `listAuditLogsDelegatedInputSchema` の `event` が「列挙はしない。
 * 登録簿は auth-worker の内部にあり、contracts へ持ち出すと二重管理に
 * なる」と書いている。`app.tsx` の `REQUIRED_ACR` と同じ複製である。
 *
 * **ずれたときは「判別できません」に落ちる。** auth-worker 側で名前が
 * 変わると、ここは 0 件を引いて `unknown` を返す —— 画面は断定せず、
 * 運用者は監査ログを自分で見に行くことになる。**間違った断定をするより
 * 弱い壊れ方**だが、黙って弱くなることに変わりはないので、名前を変える
 * ときはここも直すこと。
 */
export const OPS_SUSPENDED_EVENT = "ops.user.suspended";

/** 本人の退会（#318）。同上、auth-worker 側の登録簿と対で直すこと。 */
export const ACCOUNT_CLOSED_EVENT = "account.closed";

/**
 * 引けなかった塊は `null` で渡すこと。**空配列と同じに扱わない** ——
 * 「記録が無い」と「見に行けなかった」を混ぜると、運用者は
 * 「記録が無いなら運営が止めたのだろう」と読んでしまう。
 */
export function decideSuspensionOrigin(
  opsSuspended: readonly AuditLogEntryAdmin[] | null,
  accountClosed: readonly AuditLogEntryAdmin[] | null,
): SuspensionOrigin {
  // **片方だけ取れた状態でも断定しない。** 「新しいほうを採る」判定は
  // 両方が見えて初めて成り立つ（片方が欠けていると、見えているほうが
  // 最後とは限らない）。
  if (opsSuspended === null || accountClosed === null) return { kind: "unavailable" };

  const ops = opsSuspended[0];
  const closed = accountClosed[0];

  if (ops === undefined && closed === undefined) return { kind: "unknown" };
  if (closed === undefined) {
    return ops === undefined
      ? { kind: "unknown" }
      : { kind: "ops", reason: suspendReasonOf(ops), at: ops.createdAt };
  }
  if (ops === undefined) return { kind: "self_closed", at: closed.createdAt };

  return millisOf(closed.createdAt) > millisOf(ops.createdAt)
    ? { kind: "self_closed", at: closed.createdAt }
    : { kind: "ops", reason: suspendReasonOf(ops), at: ops.createdAt };
}

/**
 * 読めない日時は**いちばん古い**ものとして扱う。
 *
 * 例外にしないのは `format.ts` と同じ判断で、日時が 1 つ壊れているせいで
 * 画面全体が落ちると、確かめてから押すという目的そのものが果たせない。
 */
function millisOf(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * 停止の理由（`compromise` / `abuse`）を `metadata` から読む。
 *
 * **閉じた集合として確かめる。** `metadata` は `Record<string, unknown>`
 * で、イベントごとに形が違う（`audit-page.tsx` が生の JSON で出している
 * のと同じ事情）。知っている 2 値以外は `null` に落として、画面には
 * 理由を書かない —— 知らない文字列をそのまま出すと、**監査ログに入った
 * 値がそのまま画面の文言になる。**
 */
function suspendReasonOf(entry: AuditLogEntryAdmin): SuspendReason | null {
  const reason = entry.metadata?.["reason"];
  if (reason === "compromise" || reason === "abuse") return reason;
  return null;
}
