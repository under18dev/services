import type {
  ArchiveReceipt,
  ArchiveRequest,
  ArchiveSink,
} from "../../application/ports/archive.port";
import type { Clock } from "../../application/ports/clock.port";
import type { RetentionTarget } from "../../domain/services/retention-policy";

/**
 * オブジェクトキー。
 *
 * `target/YYYY/MM/DD/<timestamp>-<rand>.ndjson`。日付でディレクトリを切るのは、
 * 復元のときに「いつの分が要るか」でプレフィックス一覧できるようにするため。
 * 全部を 1 階層に置くと、180 日分を数えるだけで全件 list することになる。
 *
 * ランダム接尾辞は衝突避け。Cron は 15 分おきだが、持ち越しがあると同じ
 * 実行の中で複数回書くことがあり、ミリ秒まで同じになりうる。**キーが
 * 衝突すると R2 は黙って上書きする**ので、退避済みの行が消える。
 */
function archiveKey(target: RetentionTarget, at: Date, suffix: string): string {
  const iso = at.toISOString();
  const [date] = iso.split("T");
  const [year, month, day] = (date ?? "").split("-");
  // `:` はキーに使えるが、ダウンロードしてファイルに落とすときに困る。
  return `${target}/${year}/${month}/${day}/${iso.replace(/[:.]/g, "-")}-${suffix}.ndjson`;
}

/**
 * 削除前の行を R2 へ退避する（#43 の残件）。
 *
 * ## NDJSON、非圧縮
 *
 * 1 行 1 レコードの JSON。gzip を掛けていないのは、**この経路から復元した
 * ことがまだ一度も無い**ため（docs/runbook.md 12.6）。復元手順が確立する
 * 前に圧縮を挟むと、「戻せない」ときの切り分けが 1 段増える。
 * `jq` でそのまま読めることを優先した。圧縮は後から足せる（キーの拡張子で
 * 旧形式と区別できる）。
 *
 * ## 書き込み先は Worker のバインディング
 *
 * S3 互換 API の認証情報は使わない。掃除は Cron で Worker の中を走るので、
 * `r2_buckets` バインディング経由なら認証情報そのものが要らない。
 * Secret を 1 つ増やさずに済むなら増やさない（docs/runbook.md 12.5）。
 */
export class R2ArchiveSink implements ArchiveSink {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly clock: Clock,
  ) {}

  async put({ target, rows }: ArchiveRequest): Promise<ArchiveReceipt> {
    const at = this.clock.now();
    const key = archiveKey(target, at, crypto.randomUUID().slice(0, 8));

    // 末尾の改行まで入れる。NDJSON を連結するときに行が溶けない。
    const body = new TextEncoder().encode(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const object = await this.bucket.put(key, body, {
      httpMetadata: { contentType: "application/x-ndjson" },
      // 中身を開かずに棚卸しできるようにする。R2 の list はメタデータを返す。
      customMetadata: {
        target,
        rowCount: String(rows.length),
        archivedAt: at.toISOString(),
      },
    });

    // **ここを省かないこと。** put が例外を投げなかったことは「書けた」と
    // 同義ではない。サイズまで照合して初めて、呼び出し側が削除してよい。
    if (object === null) {
      throw new Error(`archive write failed: ${key} (put returned null)`);
    }
    if (object.size !== body.byteLength) {
      throw new Error(
        `archive write is incomplete: ${key} (stored ${object.size} of ${body.byteLength} bytes)`,
      );
    }

    return { key, rowCount: rows.length, bytes: body.byteLength };
  }
}

/**
 * バケットが無い環境向けのダミー。
 *
 * `UnconfiguredEmailSender` / `UnconfiguredIpHasher` と同じ形で、組み立てでは
 * 投げず**退避しようとした時点**で投げる（#53）。
 *
 * **ただし結果は他の 2 つと違う。** メールや IP ハッシュは「その処理だけが
 * 失敗する」で済むが、こちらが投げると `audit_logs` の掃除が止まり、行が
 * 溜まり続ける。それでよい —— 退避できないまま消すよりは、溜まって
 * `retention sweep` の `failed` に出続けるほうが気づける。
 * 静かに素通しして削除を続ける実装にはしないこと。
 */
export class UnconfiguredArchiveSink implements ArchiveSink {
  constructor(private readonly reason: string) {}

  async put(_request: ArchiveRequest): Promise<ArchiveReceipt> {
    throw new Error(`archive sink is not configured: ${this.reason}`);
  }
}
