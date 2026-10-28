#!/usr/bin/env bash
#
# Passkey ログインの **options 側**が本番で正しく出ること。
#
# ## なぜ本番で見るのか
#
# 仕様書 §13 は「Passkey ログインの**本番経路が未確認**」を残件として挙げて
# いる。認証器を伴う往復は機械では踏めないが、**options の発行だけは踏める** ——
# そして **RP ID の取り違えはそこに現れる。**
#
# RP ID は §14.1 決定 1 で**ゾーン**（`under18.dev`）に決めた。ホスト名
# （`auth.under18.dev`）にすると、**登録済みの Passkey が全部使えなくなる。**
# IdP のホスト名を変えたときに認証器を失わないためにゾーンにしてあるので、
# ここが変わったことに気づけないと、変えた日に全員が締め出される。
#
# あわせて 2 つ見る:
#
#  - `userVerification: required` —— 決定 8 が「Passkey は単体で所持 +
#    生体/PIN の 2 要素を満たす」と言う根拠そのもの。緩むと管理者の
#    Passkey 必須が意味を失う
#  - `allowCredentials` が**無い**こと —— 決定 13 が「構造的に列挙できない」
#    と書いている部分。入ると、応答からアカウントの実在が読める
#
# ## 副作用
#
# **`webauthn_challenges` に行が 1 つ増える。** 保持は 24 時間
# （`RetentionPolicy.webauthn_challenges`）で Cron が消す。個人情報は含まない
# （誰のログインかを問わない設計なので、行に `user_id` が入らない）。
#
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <origin>" >&2
  exit 2
fi

base="${1%/}"
url="${base}/api/auth/passkeys/login/options"

echo "POST ${url}"

body="$(curl -fsS --max-time 20 -X POST \
  -H "Origin: ${base}" \
  -H "Content-Type: application/json" \
  "$url")"

echo "--- response body ---"
echo "$body"
echo "---------------------"

fail=0

# **`|| true` を付ける。** 一致ゼロの grep を `set -e` の下で変数に取ると
# 代入ごと落ちて、下の `::error::` に届かない（#231）。
rp_id="$(printf '%s' "$body" | sed -n 's/.*"rpId":"\([^"]*\)".*/\1/p' || true)"
user_verification="$(printf '%s' "$body" | sed -n 's/.*"userVerification":"\([^"]*\)".*/\1/p' || true)"

if [ "$rp_id" != "under18.dev" ]; then
  echo "::error::rpId が \"${rp_id}\" です。ゾーン（under18.dev）でなければなりません（仕様書 §14.1 決定 1）。ホスト名にすると登録済みの Passkey が全部使えなくなります。"
  fail=1
fi

if [ "$user_verification" != "required" ]; then
  echo "::error::userVerification が \"${user_verification}\" です。required でなければなりません（決定 8）。緩むと「Passkey 単体で 2 要素」という根拠が失われます。"
  fail=1
fi

if printf '%s' "$body" | grep -q '"allowCredentials"'; then
  echo "::error::allowCredentials が応答に入っています。ログインの options は誰のログインかを問わない設計で、入れると応答からアカウントの実在が読めます（決定 13）。"
  fail=1
fi

if ! printf '%s' "$body" | grep -q '"challengeId":"wac_'; then
  echo "::error::challengeId が返っていません。challenge の行が作られていない可能性があります。"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "Passkey の options は本番で正しく出ています（rpId=${rp_id} / userVerification=${user_verification} / allowCredentials 無し）。"
