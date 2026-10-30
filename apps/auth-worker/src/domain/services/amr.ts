import type { AuthMethod } from "../entities/session";

/**
 * `AuthMethod` を OIDC の `amr`（Authentication Method Reference、
 * RFC 8176）へ写す（#390 / 決定 8 の書き換え）。
 *
 * ## なぜ必要になったか
 *
 * **決定 8（管理者は Passkey のセッションでしか振る舞えない）は、いまは
 * auth-worker 自身が強制している** —— `User.actsAsAdminWith(authMethod)`
 * が `getSession` の中で毎回見ている（#337 / RR-5）。これは
 * dashboard-worker / nfc-worker のように、**auth-worker と同じ
 * セッション機構をそのまま読める Relying Party にしか効かない。**
 *
 * `admin.under18.dev`（#390）は別ホストの OIDC Relying Party で、
 * auth-worker の生のセッションを読めない。あちらが「この人は Passkey で
 * 入ったか」を確かめる手段が、ID Token の中以外に無い。
 *
 * **だから決定 8 の実装はここで終わらない。** auth-worker は
 * **材料（`amr`）を出す**ところまでで、**それを要求するかどうかは
 * 各 Relying Party の判断**になる。`admin.under18.dev` が要求し、
 * 一般的な第三者クライアントは要求しない、という違いがあってよい
 * （強制を外から持ち込めるようにする設計で、強制そのものを外すのではない）。
 *
 * ## 値の選び方
 *
 * RFC 8176 は WebAuthn / FIDO2 専用の値を定義していない。**最も近いのは
 * `"swk"`（software key）**で、多くの実装が Passkey（秘密鍵が認証器から
 * 出ない、かつ多くが OS 同期でソフトウェア的に扱われる）にこれを当てる。
 * メール OTP は標準値 `"otp"` がそのまま当たる。
 *
 * **ハードウェアキー（`"hwk"`）と区別していない。** いまの
 * `sessions.auth_method` は認証器の種別までは持たないため区別できない。
 * 区別が要るようになったら、まず `auth_method` の側を広げること —— ここだけ
 * 決め打ちで分けると、存在しない情報を捏造することになる。
 */
export function amrFor(authMethod: AuthMethod): readonly string[] {
  switch (authMethod) {
    case "passkey":
      return ["swk"];
    case "email_otp":
      return ["otp"];
  }
}

/**
 * u18 が定義する `acr`（Authentication Context Class Reference）。
 *
 * **1 つしか無い。** `acr_values` で要求できるのは「Passkey で認証した
 * ことを示す水準」だけで、「要求しない」が既定（= 水準を問わない）。
 * 新しい水準が要るようになったら、ここへ 1 行足す。
 *
 * **URI にしていない。** OIDC は `acr` の値を IdP が自由に決めてよいと
 * しており（RFC 8176 のような標準値の集合も無い）、このリポジトリの
 * scope 文字列（`"openid"` / `"admin"`）と同じ平文の慣習に揃えた。
 */
export const ACR_PASSKEY = "passkey";

/**
 * 実際の認証方式が、u18 の定義する `acr` を満たすか。
 *
 * **`amrFor` とは非対称である。** `amr` は「何で認証したか」を常に答える
 * （`email_otp` にも値がある）。`acr` は「定義した水準を満たしたか」だけを
 * 答えるので、満たさないときは `null`（claim を出さない）に倒す ——
 * 「u18 には acr という概念が無い」と「要求された水準に届かなかった」を
 * 区別しない。どちらであっても RP がすることは同じ（信用しない）。
 */
export function acrFor(authMethod: AuthMethod): string | null {
  return authMethod === "passkey" ? ACR_PASSKEY : null;
}
