#!/usr/bin/env bash
#
# JS 無しの form 経路を、**ブラウザが送る形**で 1 本だけ本番へ通す。
#
# ## なぜ /health と Discovery では足りなかったか
#
# ログイン・新規登録・ログアウトのすべてが本番で壊れていたとき、CI は全部
# 緑だった（#226）。原因は `secureHeaders()` の既定 `Referrer-Policy:
# no-referrer` で、Fetch 仕様では**参照元を落とす設定のときナビゲーション
# 要求の `Origin` も `null` になる**。自分のページから出した form 送信が
# `Origin: null` で届き、Origin 検証に落ちていた。
#
# 単体テストが見逃したのは、テストが `Origin` を明示的に付けていたため。
# **「ブラウザが何を送るか」はこちらが書いていない部分で、そこを通す検査が
# 1 つも無かった。** 同じ形を #216（wrangler が何をするか）と #217
# （Cloudflare の route が何をするか）でも踏んでいる。
#
# ## 何を確かめるか
#
# GET /login で Cookie と hidden input を取り、**ブラウザと同じヘッダ**で
# POST する。`Origin: null` と `Sec-Fetch-Site: same-origin` の組み合わせは、
# 実ブラウザが上記の条件で実際に送るものである。
#
# ## 副作用を出さない
#
# 宛先には**形式不正の文字列**を使う。`StartEmailOtpUseCase` は
# `EmailAddress.tryCreate` が null を返した時点で `invalid_input` を返し、
# リポジトリにもレート制限にもメール送信にも触れない。したがって本番の
# D1 に行は増えず、誰にもメールは飛ばない。
#
# 切り分けはステータスではなく**文言**で行う:
#
#   CSRF を通った  -> 400「メールアドレスの形式をご確認ください。」
#   CSRF に落ちた  -> 403「操作を受け付けられませんでした。」
#
# ## 使い方
#
#   smoke-form-probe.sh <origin>        例: smoke-form-probe.sh https://auth.under18.dev
set -euo pipefail

base="${1:?usage: smoke-form-probe.sh <origin>}"
base="${base%/}"

# ブラウザが同一オリジンの form 送信で実際に送るヘッダ一式。
# `Sec-Fetch-*` は**禁止ヘッダ名**でスクリプトからは書けないので、
# ここで手で付けているのは「ブラウザの代役」であって抜け道ではない。
BROWSER_NAV=(
  -H 'Sec-Fetch-Mode: navigate'
  -H 'Sec-Fetch-Dest: document'
  -H 'Content-Type: application/x-www-form-urlencoded'
  -H 'Cache-Control: no-cache'
)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

jar="$work/jar"
head_file="$work/head"
body="$work/body"

fail=0
note() { echo "::error::$*"; fail=1; }

# --- 1) ログイン画面を取る ---------------------------------------------------
# デプロイ直後は伝播に数秒かかるので数回試す。
code=000
for attempt in 1 2 3 4 5; do
  code="$(curl -sS -c "$jar" -D "$head_file" -o "$body" -w '%{http_code}' \
    -H 'Cache-Control: no-cache' --max-time 10 "$base/login")" || code=000
  [ "$code" = "200" ] && break
  echo "attempt $attempt: GET /login -> HTTP $code, retrying..."
  sleep 5
done

if [ "$code" != "200" ]; then
  echo "::error::GET $base/login returned HTTP $code (expected 200)."
  exit 1
fi

# **原因そのものを名指しで押さえる。** 下の POST が通れば結果としては
# 足りているが、`no-referrer` に戻ったことを直接言えたほうが直す側が速い。
# **ヘッダ名の綴りに依存しない。** HTTP/2 は小文字で届くが、HTTP/1.1 は
# `Referrer-Policy` と大文字で届く。awk の `IGNORECASE` は gawk 拡張で、
# macOS の awk も ubuntu の mawk も無視する —— 本番が HTTP/2 なので CI では
# たまたま当たっていただけで、HTTP/1.1 の相手には**健全でも「ヘッダが無い」
# と報告していた**（`wrangler dev` に当てると再現する）。`grep -i` は POSIX。
#
# **`|| true` を外さない。** 代入文の終了コードはコマンド置換の終了コードで、
# ヘッダが無いと `grep` が 1 で終わる。`pipefail` がそれを拾い、`set -e` が
# **その場で**落とすので、下の「ヘッダが無い」分岐に届かない。デプロイは
# 赤くなるが理由が 1 行も出ず、当番は URL を手で叩き直すところから始める。
# awk 版が無言で済んでいたのは、awk が一致しなくても 0 で終わるため。
referrer_policy="$(tr -d '\r' < "$head_file" \
  | grep -i '^referrer-policy:' | head -1 \
  | cut -d: -f2- | tr 'A-Z' 'a-z' | tr -d '[:space:]' || true)"
if [ "$referrer_policy" = "no-referrer" ]; then
  note "$base/login sends 'Referrer-Policy: no-referrer'. Browsers then send 'Origin: null' on same-origin form posts and every form route breaks (#226)."
elif [ -z "$referrer_policy" ]; then
  note "$base/login sends no Referrer-Policy header."
fi

# --- 2) トークンを 2 系統から取り、食い違いを拾う ---------------------------
# ブラウザが POST に載せるのは **hidden input のほう**なので、そちらを使う。
# Cookie 側とも突き合わせる: 片方だけ更新される壊れ方だと全利用者が 403 に
# なるが、hidden input だけ見ていると「値はあった」で素通りする。
# ここも `|| true` が要る。hidden input が無いと `grep -o` が 1 で終わり、
# 下の「rendered no csrf_token hidden input」に届かずに無言で死ぬ。
# **ログイン画面そのものが壊れたときに一番読みたい 1 行**がそれである。
token="$(grep -o 'name="csrf_token" value="[^"]*"' "$body" | head -1 | sed 's/.*value="//; s/"$//' || true)"
cookie_token="$(awk -F'\t' '$6 ~ /(^|-)u18_csrf$/ {print $7}' "$jar" | head -1)"

if [ -z "$token" ]; then
  echo "::error::GET $base/login rendered no csrf_token hidden input; the form cannot be submitted at all."
  exit 1
fi
if [ -z "$cookie_token" ]; then
  echo "::error::GET $base/login set no CSRF cookie; double-submit cannot succeed."
  exit 1
fi
if [ "$token" != "$cookie_token" ]; then
  note "$base/login: the csrf_token hidden input and the CSRF cookie differ; every form post will be rejected."
fi

# --- 3) ブラウザの形で出す（本題） ------------------------------------------
# `Origin: null` + `Sec-Fetch-Site: same-origin` は、referrer policy が
# 参照元を落とすときに実ブラウザが送る組み合わせ。
post() {
  local origin="$1" site="$2" out="$3"
  curl -sS -b "$jar" -o "$out" -w '%{http_code}' --max-time 10 \
    "${BROWSER_NAV[@]}" -H "Origin: $origin" -H "Sec-Fetch-Site: $site" \
    --data-urlencode "csrf_token=$token" \
    --data-urlencode 'email=deploy-smoke-probe' \
    "$base/login/start" || echo 000
}

echo "Posting the login form the way a browser does (Origin: null, Sec-Fetch-Site: same-origin)"
same_body="$work/same"
same_code="$(post null same-origin "$same_body")"

echo "--- response body (same-origin) ---"
head -c 2000 "$same_body" || true
echo
echo "-----------------------------------"

if grep -qF '操作を受け付けられませんでした' "$same_body"; then
  note "$base/login/start rejected a same-origin form post as CSRF (HTTP $same_code). The no-JS login / signup / logout flows are broken in a real browser (#226)."
elif [ "$same_code" != "400" ]; then
  # 400 は「CSRF は通り、宛先の形式で弾かれた」。それ以外は想定外。
  note "$base/login/start returned HTTP $same_code for a malformed address (expected 400)."
elif ! grep -qF 'メールアドレスの形式をご確認ください' "$same_body"; then
  note "$base/login/start returned 400 but not the address-format message; the request did not reach the use case as expected."
else
  echo "Same-origin form post passed CSRF (HTTP 400, address-format message)."
fi

# --- 4) ネガティブ確認 -------------------------------------------------------
# **通ることだけを見る検査は、全部通す実装でも緑になる。** クロスサイトが
# 依然として弾かれることを同じ経路で確かめて、3) の合格に意味を持たせる。
echo "Posting the same form cross-site (must still be rejected)"
cross_body="$work/cross"
cross_code="$(post https://smoke-probe.invalid cross-site "$cross_body")"

if [ "$cross_code" != "403" ]; then
  note "$base/login/start returned HTTP $cross_code for a cross-site form post (expected 403). CSRF protection is not holding."
else
  echo "Cross-site form post rejected (HTTP 403)."
fi

[ "$fail" = "0" ] || exit 1
echo "Form smoke probe passed."
