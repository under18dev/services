-- #96 より前に作られた users 行には user_emails の写しが無い。
--
-- `user_emails_email_unique` は「相手の確認済みの行」が在ることを前提に二重所有を
-- 弾くので、写しの無いユーザーに対しては判定が常に素通りする。書く経路を足しただけ
-- では既存行がその穴を残したままになるため、ここで埋める。
--
-- `users_primary_email_unique` が無条件である以上、同じ primary_email を持つ users 行は
-- 存在しない。したがってこの INSERT が user_emails_email_unique に衝突することもない。
-- email_verified が立っていない行は verified_at を null のままにする —— 到達性を誰も
-- 確かめていないアドレスを確認済みとして記録すると、本来の持ち主を締め出す。
--
-- id は `uem_` + ランダム 16 バイト。接頭辞はログで種別を見分けるためのもので、
-- セキュリティ上の意味は持たせていない（packages/domain/src/identifier.ts）ので、
-- 生成器と符号化が違っても構わない。
INSERT INTO `user_emails` (`id`, `user_id`, `email`, `verified_at`, `is_primary`, `created_at`, `updated_at`)
SELECT
  'uem_' || lower(hex(randomblob(16))),
  `users`.`id`,
  `users`.`primary_email`,
  CASE WHEN `users`.`email_verified` = 1 THEN `users`.`updated_at` ELSE NULL END,
  1,
  `users`.`created_at`,
  `users`.`updated_at`
FROM `users`
WHERE NOT EXISTS (
  SELECT 1 FROM `user_emails`
  WHERE `user_emails`.`user_id` = `users`.`id`
    AND lower(`user_emails`.`email`) = lower(`users`.`primary_email`)
);
