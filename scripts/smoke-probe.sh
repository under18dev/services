#!/usr/bin/env bash
#
# デプロイ直後の Worker を外から 1 回叩いて、応答の中身まで確かめる（#66 / #97）。
#
# `wrangler deploy` の exit 0 はアップロードの成功しか示さない。起動を拒否する
# Worker でもデプロイ自体は成功するので、実際にリクエストを流さないと
# 「出したが動いていない」状態を検知できない。
#
# ## ステータスだけを見ないこと
#
# `--env production` を付け忘れたデプロイは ENVIRONMENT=development のまま
# 200 を返す。その 1 つの値で、メール送信の実プロバイダ強制・IP_HASH_PEPPER の
# 強制・Cookie の __Host- と Secure が同時に無効になる。ステータスだけ見る
# 検査はこれを素通りさせる。だから本文の検査を任意ではなく主役として扱う。
#
# ## 使い方
#
#   smoke-probe.sh <url> <expected-status> [検査...]
#
#   検査:
#     --jq <path> <expected>   JSON の値が一致するか（例: --jq .status ok）
#     --contains <substring>   本文に含まれるか（JSON でない応答用）
#
# 3 つの Worker すべてがこれを使う。curl とリトライを 1 箇所に置くのは、
# 複数箇所に写すと片方だけ直す事故が起きるため（実際 `|| echo 000` が
# 終了コードと連結して 000000 になる誤りを 1 箇所で踏んでいる）。
set -euo pipefail

url="${1:?usage: smoke-probe.sh <url> <expected-status> [checks...]}"
expected_status="${2:?expected status is required}"
shift 2

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

echo "Probing $url (expecting HTTP $expected_status)"

# デプロイ直後は伝播に数秒かかることがあるので数回試す。
# リダイレクトは追わない。追うと「どこに飛ばされたか」が応答から消える。
code=000
for attempt in 1 2 3 4 5; do
  # `|| echo 000` だと curl が -w で出した値と連結して 000000 等になりうる。
  # 失敗時は代入ごと置き換える。
  # **キャッシュを迂回する。** デプロイ直後の検証が前のデプロイの応答を
  # 読んだら、検査しているつもりで何も検査していないことになる。
  # いまのところ Worker の応答はエッジに載らない想定だが、**その想定が
  # 崩れたときに黙って無効になる**のがこの手の検査の壊れ方なので、
  # 要求側で迂回しておく（#125 で Discovery に max-age が付いた）。
  #
  # 中間プロキシがこの指示を無視することはある。**無視されても困る検査は、
  # 呼び出し側で URL を変えてキャッシュキーごと変えること**
  # （deploy.yml の Discovery の例）。
  code="$(curl -sS -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    -o "$body_file" -w '%{http_code}' --max-time 10 "$url")" || code=000
  [ "$code" = "$expected_status" ] && break
  echo "attempt $attempt: HTTP $code, retrying..."
  sleep 5
done

echo "--- response body ---"
cat "$body_file" || true
echo
echo "---------------------"

fail=0

if [ "$code" != "$expected_status" ]; then
  echo "::error::$url returned HTTP $code (expected $expected_status)."
  fail=1
fi

# ステータスが想定どおりでも本文の検査は必ず行う。想定外のステータスのときに
# 本文検査を飛ばすと、2 つ目以降の問題が次の実行まで見えない。
while [ $# -gt 0 ]; do
  case "$1" in
    --jq)
      path="${2:?--jq needs a path}"
      want="${3:?--jq needs an expected value}"
      if [ ! -s "$body_file" ]; then
        # 到達できなかった場合など。jq に空を食わせると空文字が返り、
        # 「値が空だった」と「本文が無かった」が区別できなくなる。
        got="<empty>"
      else
        got="$(jq -r "$path // \"<missing>\"" "$body_file" 2>/dev/null || echo "<not-json>")"
      fi
      if [ "$got" != "$want" ]; then
        echo "::error::$url: $path is \"$got\", expected \"$want\"."
        fail=1
      fi
      shift 3
      ;;
    --contains)
      want="${2:?--contains needs a substring}"
      if ! grep -qF -- "$want" "$body_file"; then
        echo "::error::$url: response body does not contain \"$want\"."
        fail=1
      fi
      shift 2
      ;;
    *)
      echo "::error::smoke-probe.sh: unknown check \"$1\"."
      exit 2
      ;;
  esac
done

[ "$fail" = "0" ] || exit 1
echo "Smoke probe passed."
