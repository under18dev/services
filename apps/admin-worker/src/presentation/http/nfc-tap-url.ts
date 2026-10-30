/**
 * NFC タグに焼く URL を組み立てる（#382）。
 *
 * **nfc-worker の `base-path.ts` の `cardTapUrl()` と同じもの。** 共有の
 * package に出していないのは、組み立てが `/c/<cardId>` という 1 行の
 * テンプレートリテラルで、依存関係を増やすほどの行数ではないため。
 *
 * **ホストを画面に直書きしない。** `env.SHORT_URL_ORIGIN` から組む——
 * 開発と本番で違ううえ、間違えて焼いたタグは配ったあとに直せない。
 */
export function cardTapUrl(shortUrlOrigin: string, cardId: string): string {
  return new URL(`/c/${cardId}`, shortUrlOrigin).toString();
}
