#!/usr/bin/env bash
#
# デプロイした画面が参照しているアセットを、実際に取りに行く（#211）。
#
# ## なぜ本番で見るのか
#
# URL に内容ハッシュを入れたとき、**auth-worker の `/ui/u18.css` が 404 に
# なった。** その CSS を借りていた nfc-worker のカード画面は、何も変えて
# いないのにスタイルを失う。画面は描かれるので 500 にもならず、外形監視にも
# 出ない。**両側のテストは自分の Worker の内側に閉じていて、どちらも
# それを見られなかった。**
#
# ここで見るのは「URL が正しいか」ではなく、**ページに書いてある URL が
# 本番で引けるか**である。route の解決も、デプロイの順序も、キャッシュの
# 残りも、全部ひっくるめて外から 1 回通す。
#
# ## 副作用
#
# GET しか出さない。認証も要らない（ログイン画面は未ログインで 200）。
#
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <origin>" >&2
  exit 2
fi

base="${1%/}"
page_path="/login"
page_url="${base}${page_path}"

echo "GET ${page_url}"
page="$(curl -fsS --max-time 20 "$page_url")"

# **`|| true` が要る。** `set -e` の下で一致ゼロの grep を変数に取ると、
# 代入ごとスクリプトが落ちて、下の `::error::` に届かない（#231）。
hrefs="$(printf '%s' "$page" | grep -oE '(href|src)="[^"]*/ui/[^"]*"' || true)"
urls="$(printf '%s' "$hrefs" | sed -E 's/^(href|src)="//; s/"$//' | sort -u || true)"

if [ -z "$urls" ]; then
  echo "::error::${page_path} がアセットを 1 つも参照していません。抜き出し方が合っていないか、画面が壊れています。"
  exit 1
fi

failures=0
count=0

while IFS= read -r url; do
  [ -z "$url" ] && continue
  count=$((count + 1))

  # ハッシュが入っていること。**外れても画面は動く**（URL が固定に戻る
  # だけ）ので、ここが唯一それに気づく場所になる。外れたまま immutable で
  # 配信すると、内容を変えてもブラウザが 1 年古いものを使い続ける。
  if ! printf '%s' "$url" | grep -qE '\.[0-9a-f]{16}\.'; then
    echo "::error::${url} に内容ハッシュが入っていません（#211）。"
    failures=$((failures + 1))
    continue
  fi

  asset_url="${base}${url}"
  headers="$(curl -fsS -o /dev/null -D - --max-time 20 "$asset_url" || true)"
  status="$(printf '%s' "$headers" | head -n 1 || true)"

  if [ -z "$headers" ]; then
    echo "::error::${asset_url} を取得できませんでした（ページはこの URL を参照しています）。"
    failures=$((failures + 1))
    continue
  fi

  if ! printf '%s' "$headers" | grep -qi 'cache-control:.*immutable'; then
    echo "::error::${asset_url} に immutable が付いていません。URL にハッシュが入っている以上、付いているべきです。"
    echo "  ${status}"
    failures=$((failures + 1))
    continue
  fi

  echo "  OK ${url}"
done <<EOF
${urls}
EOF

if [ "$failures" -gt 0 ]; then
  echo "::error::${failures} 件のアセットが引けませんでした。"
  exit 1
fi

echo "${page_path} が参照する ${count} 件のアセットは、すべて本番から引けます。"
