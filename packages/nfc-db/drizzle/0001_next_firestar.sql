-- 紐づけコードの廃止（#358）。
--
-- **列ごと落としている。** 本番の `nfc_cards` は 0 行であることを
-- 2026-10-30 のバックアップで実測したうえでの判断で、残しても参照する
-- コードが無く、「使われていない列に秘密のハッシュが残っている」状態に
-- なるだけである。
--
-- **行があったら、この移行は採れない。** その場合は列を残したまま
-- NULL 化し、配布済みのカードについては運用で付け替えることになる
-- （`release` が既にある）。
--
-- SQLite の DROP COLUMN は 3.35 以降で、D1 は満たしている。

ALTER TABLE `nfc_cards` DROP COLUMN `claim_code_hash`;--> statement-breakpoint
ALTER TABLE `nfc_cards` DROP COLUMN `claim_code_issued_at`;
