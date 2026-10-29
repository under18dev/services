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
# ## 1 ページでは足りない
#
# **ハッシュ付きアセットを配る Worker は 3 つある。** auth-worker
# （`/login`）、dashboard-worker（`/account`）、nfc-worker（`/account/nfc`）。
# **それぞれが自分でバンドルを生成し、自分でハッシュを決めている。**
#
# 以前はこの検査が `/login` だけを見ていた。つまり **auth-worker の
# ハッシュだけが本番で確かめられていて、dashboard-worker のほうは
# 誰も見ていなかった** —— 上に書いた失敗が、Worker 1 つ隣で再発できる
# 状態だった（dashboard は #195 以降 auth-worker の CSS を借りず、
# 自分で配信している）。
#
# **nfc-worker の `/account/nfc` は未ログインで 302 を返す**ので、
# ここからは参照を読めない。その 1 つだけは外から確かめられていない ——
# `scripts/check-asset-probe-pages.mjs` が、**確かめられていないことを
# 明示的に宣言させる**（黙って漏れないように）。
#
# ## 副作用
#
# GET しか出さない。認証も要らない。**ただし 200 とは限らない** ——
# `/account` は未ログインで **401 と一緒に画面を返す**（ログイン導線）。
# ページの取得に `curl -f` を使わないのはこのため。使うと 401 で落ち、
# 「アセットが引けない」ではなく「ページが取れない」になる。
#
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <origin> [page-path ...]" >&2
  exit 2
fi

base="${1%/}"
shift

# 既定のページと、**そのページが自分で配っているはずの接頭辞**（`ページ:接頭辞`）。
# **増やしたら scripts/check-asset-probe-pages.mjs も見ること。** あちらが
# 「アセットを配る Worker が全部ここに居るか」「接頭辞が実物と合っているか」を
# 突き合わせている。
if [ "$#" -eq 0 ]; then
  set -- /login:/ui/ /account:/account/ui/
fi

failures=0
checked=0

for spec in "$@"; do
  page_path="${spec%%:*}"
  own_prefix="${spec#*:}"
  if [ "$own_prefix" = "$page_path" ]; then
    # 接頭辞が付いていない（`ページ` だけ）。借用の検査ができないので落とす。
    # 省略を許すと、**付け忘れたページだけ静かに緩くなる。**
    echo "::error::${spec} に接頭辞がありません。\`ページ:接頭辞\` の形で渡すこと（例: /account:/account/ui/）。"
    failures=$((failures + 1))
    continue
  fi

  page_url="${base}${page_path}"
  echo "GET ${page_url}  (自前の接頭辞: ${own_prefix})"

  # **`-f` を付けない。** `/account` は未ログインで 401 と一緒に画面を返す
  # （ログイン導線）。`-f` だと 401 で落ち、「アセットが引けない」ではなく
  # 「ページが取れない」という別の失敗になる。
  body_file="$(mktemp)"
  # **`|| echo 000` を使わない。** curl は失敗時にも `-w` で `000` を出すので、
  # 連結されて `000000` になり、下の比較をすり抜ける。すり抜けた結果は
  # 「アセットを 1 つも参照していません」という**別の失敗の文言**になった
  # （実測）—— 到達できていないのに「画面が壊れています」と出る。
  if curl -sS -o "$body_file" -w '%{http_code}' --max-time 20 "$page_url" > "${body_file}.code" 2>/dev/null; then
    page_status="$(cat "${body_file}.code")"
  else
    page_status="unreachable"
  fi
  page="$(cat "$body_file")"
  rm -f "$body_file" "${body_file}.code"

  if [ "$page_status" = "unreachable" ]; then
    echo "::error::${page_url} に到達できませんでした（DNS / TLS / タイムアウト）。"
    failures=$((failures + 1))
    continue
  fi

  # 404 と 5xx だけ落とす。401 / 302 は「画面が出ている」側に数える。
  case "$page_status" in
    404 | 5*)
      echo "::error::${page_url} が ${page_status} を返しました。画面が出ていません。"
      failures=$((failures + 1))
      continue
      ;;
  esac

  hrefs="$(printf '%s' "$page" | grep -oE '(href|src)="[^"]*/ui/[^"]*"' || true)"
  urls="$(printf '%s' "$hrefs" | sed -E 's/^(href|src)="//; s/"$//' | sort -u || true)"

  if [ -z "$urls" ]; then
    # **ここを「参照が無いならよし」にしない。** 抜き出し方が合わなくなった
    # ときも、画面がスタイルを失ったときも、同じ「0 件」になる。区別できない
    # 以上、0 件は失敗として扱う。
    echo "::error::${page_url} (${page_status}) がアセットを 1 つも参照していません。抜き出し方が合っていないか、画面が壊れています。"
    failures=$((failures + 1))
    continue
  fi

  while IFS= read -r url; do
    [ -z "$url" ] && continue
    checked=$((checked + 1))

    # **自分で配っているか、隣から借りているか。**
    #
    # 中身が同じなら**ハッシュも同じ**になる（共有の `@u18/web-ui`）。
    # つまり dashboard のページが誤って `/ui/u18.<hash>.css`（auth 側の
    # パス）を参照しても、**auth が配っているので 200 で通る。** 借用は
    # それ自体では壊れず、**片方のハッシュが変わった瞬間に壊れる**
    # （#246 で実際に踏んだ）。
    #
    # だから「引けること」ではなく「**自分の接頭辞の下にあること**」を見る。
    # 接頭辞は厳密に比べる —— `/account/nfc/ui/...` は `/account/` で
    # 始まるので、緩く見ると dashboard が nfc のものを借りても通る。
    case "$url" in
      "${own_prefix}"*) ;;
      *)
        echo "::error::${page_path} が ${url} を参照しています。これは自分で配っているものではありません（自前は ${own_prefix} の下）。"
        echo "  中身が同じならハッシュも同じになるので、引けてしまいます。壊れるのは片方のハッシュが変わった瞬間です（#246）。"
        failures=$((failures + 1))
        continue
        ;;
    esac

    # 内容ハッシュが入っていること（#211）。入っていなければ immutable を
    # 付けてはいけないので、キャッシュの検査より先に見る。
    if ! printf '%s' "$url" | grep -qE '\.[0-9a-f]{16}\.'; then
      echo "::error::${url} に内容ハッシュが入っていません（#211）。参照元: ${page_path}"
      failures=$((failures + 1))
      continue
    fi

    asset_url="${base}${url}"
    headers="$(curl -fsS -o /dev/null -D - --max-time 20 "$asset_url" || true)"

    if [ -z "$headers" ]; then
      echo "::error::${asset_url} を取得できませんでした（${page_path} はこの URL を参照しています）。"
      failures=$((failures + 1))
      continue
    fi

    if ! printf '%s' "$headers" | grep -qi 'cache-control:.*immutable'; then
      echo "::error::${asset_url} に immutable が付いていません。URL にハッシュが入っている以上、付いているべきです。"
      echo "  $(printf '%s' "$headers" | head -n 1)"
      failures=$((failures + 1))
      continue
    fi

    echo "  OK ${url}"
  done <<EOF
${urls}
EOF
done

if [ "$failures" -gt 0 ]; then
  echo "::error::${failures} 件の失敗がありました。"
  exit 1
fi

echo "${#} ページが参照する ${checked} 件のアセットは、すべて本番から引けます。"
