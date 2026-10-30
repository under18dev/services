-- 紐づけコードの廃止（#358）。
--
-- **列ごと落としている。** 残しても参照するコードが 1 行も無く、
-- 「使われていない列に秘密のハッシュが残っている」状態になるだけである。
--
-- **行があっても、この移行は採れる。** `DROP COLUMN` は行の有無に
-- 関係なく通る。**列を残して NULL 化する代案は、守りたいものを 1 つも
-- 守らない** —— 未登録の行は、列があってもなくても同じようにタップで
-- 取られる。それは #358 そのものの帰結であって、列とは独立である。
--
-- **配布済み・未登録のカードがあるときに何が変わるか**は、移行の話では
-- なく運用の話なので `docs/nfc-cards-operations.md` §2 にある。
--
-- SQLite の DROP COLUMN は 3.35 以降で、D1 は満たしている。

ALTER TABLE `nfc_cards` DROP COLUMN `claim_code_hash`;--> statement-breakpoint
ALTER TABLE `nfc_cards` DROP COLUMN `claim_code_issued_at`;
