import type { AuditEvent, AuditLogger } from "../../application/ports/audit-log.port";
import type { IpHasher } from "../../application/ports/crypto.port";

/**
 * 1 回の呼び出しについて、入口だけが知っていること。
 *
 * **生 IP がこの型に入る。** ここから先へ持ち出さないこと —— 保存も
 * ログ出力もハッシュ化してから行う（仕様書 9 Privacy）。
 *
 * `waitUntil` も同じ性質（`ExecutionContext` を持っているのは入口だけ）
 * なのでここに置いている。無い経路——Cron の `scheduled`、一部のテスト——
 * では省略してよく、そのとき副作用は応答前に待つ側へ倒れる（#126）。
 */
export type RequestContext = {
  /** `CF-Connecting-IP`。取れなければ null。 */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** `ExecutionContext.waitUntil`。応答後へ副作用を逃がすのに使う（#126）。 */
  readonly waitUntil?: ((task: Promise<unknown>) => void) | undefined;
};

/**
 * 監査ログに「いつ・どこから」を足す（#122）。
 *
 * ## なぜ UseCase の引数ではなく装飾で足すのか
 *
 * `audit_logs` には `ip_hash` / `user_agent` の列があり `DrizzleAuditLogger`
 * の配線もあったが、**呼び出し側がどこからも渡していなかった。** その結果、
 * 発信元は `sessions.ip_hash` にしか残らず、**失敗したログイン試行の出どころが
 * 分からない** —— ランブック 5.2 / 5.3 が監査ログから辿る前提で書かれている、
 * まさにその情報が欠けていた。しかもセッション行は 30 日で消える。
 *
 * 各 UseCase の command に `ip` を足して回る案は採らない。理由は 2 つ。
 *
 * 1. **生 IP が Application 層に広がる。** 監査のためだけに、20 以上の
 *    UseCase が「保存してはいけない値」を受け取ることになる。いまは
 *    `IssueSessionUseCase` だけが生 IP を見ており、そこに閉じている。
 * 2. **足し忘れが起きる。** 新しい UseCase が 1 つ増えるたびに、誰も
 *    気づかないまま「発信元の無いイベント」が 1 種類増える。#122 自体が
 *    その形で生まれている（#88 の再送上限、#96 の `user_emails` に続く 3 件目）。
 *
 * 装飾なら、**リクエスト由来の監査ログは配線した時点で全部に乗る。**
 *
 * ## ハッシュ化の失敗を飲み込む
 *
 * `UnconfiguredIpHasher` は非 development で `IP_HASH_PEPPER` が無いと投げる。
 * ここで素通しすると、**pepper の設定漏れが認証の停止になる** —— 監査の
 * ためだけの計算が、認証経路を道連れにするということ。`AuditLogger.record()`
 * が「失敗しても投げない」契約である以上（docs/architecture.md 4.1）、
 * その内側の計算も同じ強度で飲み込む必要がある。
 */
export class RequestScopedAuditLogger implements AuditLogger {
  /**
   * ハッシュ化は 1 リクエストにつき 1 回。
   *
   * 1 本のリクエストが複数のイベントを書くことがある（OTP 検証 →
   * セッション発行で 2 件）。毎回ハッシュし直す理由が無い。
   */
  private hashed: Promise<string | null> | null = null;

  constructor(
    private readonly inner: AuditLogger,
    private readonly ipHasher: IpHasher,
    private readonly request: RequestContext,
  ) {}

  async record(event: AuditEvent): Promise<void> {
    // 呼び出し側が明示した値を優先する。リクエストの発信元と、イベントが
    // 指している対象（例: 他端末のセッション）は別物でありうる。
    await this.inner.record({
      ...event,
      ipHash: event.ipHash ?? (await this.ipHash()) ?? undefined,
      userAgent: event.userAgent ?? this.request.userAgent ?? undefined,
    });
  }

  private ipHash(): Promise<string | null> {
    this.hashed ??= this.computeIpHash();
    return this.hashed;
  }

  private async computeIpHash(): Promise<string | null> {
    const ip = this.request.ip;
    if (ip === null) return null;

    try {
      return await this.ipHasher.hash(ip);
    } catch (cause) {
      // 生 IP はログにも出さない。ログも保存先である（仕様書 9 Privacy）。
      // `cause` に入るのは設定不備の理由だけで、IP は含まれない
      // （`UnconfiguredIpHasher`）。
      console.error("audit ip hashing failed", cause);
      return null;
    }
  }
}
