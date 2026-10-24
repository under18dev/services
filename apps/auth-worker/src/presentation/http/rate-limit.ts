import type { Context } from "hono";
import type { AuditEventName } from "../../application/ports/audit-log.port";
import type { RateLimitScope } from "../../domain/services/rate-limit-policy";
import { problem } from "./problem";
import type { AppBindings } from "./types";

/**
 * 送信元 IP。Cloudflare が付ける `CF-Connecting-IP` を正とする。
 *
 * 利用者が付けられる `X-Forwarded-For` は見ない。見ると、ヘッダを書き換える
 * だけでレート制限の鍵を変えられて制限が無意味になる。
 */
export function clientIp(c: Context<AppBindings>): string | null {
  return c.req.header("CF-Connecting-IP") ?? null;
}

/**
 * IP 単位のレート制限をかける（#21、仕様書 9 Abuse）。
 *
 * 超過していれば 429 の `Response` を、通ってよければ `null` を返す。
 * ルート側は `const limited = await enforceIpRateLimit(c, scope); if (limited) return limited;`
 * と書く。
 *
 * ## 本文を読む前に呼ぶこと
 *
 * 429 の出方でアカウントの有無が分かってはいけない（#21 受け入れ条件）。
 * 本文を見る前に返していれば、**そもそもアドレスを読んでいない**ので
 * 区別のしようがない。「読んでから判定しない」のが一番確実な担保になる。
 *
 * ## 生 IP を鍵にしない
 *
 * `IpHasher` でハッシュ化してから渡す（仕様書 9 Privacy）。鍵は Cloudflare 側へ
 * 送られるので、生のままだと保存しないだけで外へは出ていることになる。
 */
export async function enforceIpRateLimit(
  c: Context<AppBindings>,
  scope: RateLimitScope,
): Promise<Response | null> {
  const container = c.get("container");
  const ip = clientIp(c);

  // IP が取れない場合も**素通しせず**、全員で 1 つの枠を共有させる。
  // 素通しにすると、ヘッダが落ちる経路が 1 つ見つかった時点で制限が外れる。
  // 共有枠なら、本番で CF-Connecting-IP が欠け始めたときに「全体が詰まる」
  // という目に見える形で壊れる。静かに無防備になるよりよい。
  const key = ip === null ? "unknown-ip" : await container.services.ipHasher.hash(ip);

  const decision = await container.services.rateLimiter.consume(scope, key);
  if (decision.allowed) return null;

  // **`audit_logs` には書かない。** Workers のログへ出す。
  //
  // 弾かれたリクエスト 1 本ごとに D1 へ 1 行書くと、攻撃者は「弾かれること」を
  // そのまま D1 への書き込みに変換できる。レート制限が防ぐはずの資源枯渇
  // （脅威モデル D-2）を、レート制限自身が引き起こすことになる。
  // 毎秒数千の 429 がそのまま毎秒数千の INSERT になる。
  //
  // 代わりに observability（wrangler.jsonc で有効）へ構造化して出す。保持は
  // audit_logs の 180 日より短いが、**レート制限の超過は「今まさに起きている」
  // ことを見るための情報**で、半年後に遡る種類のものではない。
  // 追跡が要るときはハッシュ済み IP で Workers のログを引く（ランブック §13.5）。
  console.warn(
    JSON.stringify({
      // 出力先は違うが名前空間は監査イベントと同じなので、登録簿で縛る。
      // 別に持つと片方だけ改名する事故が起きる（audit-log.port.ts）。
      event: "rate_limit.exceeded" satisfies AuditEventName,
      scope,
      // 生 IP は出さない（仕様書 9 Privacy）。ログも保存先である。
      ipHash: ip === null ? null : key,
    }),
  );

  // Retry-After は窓の長さそのもの。残り時間は binding から取れない。
  c.header("Retry-After", String(decision.retryAfterSeconds));
  return problem(c, 429, "rate_limited", "too many requests");
}
