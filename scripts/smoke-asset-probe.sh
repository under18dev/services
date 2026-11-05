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
# **ハッシュ付きアセットを配る Worker は 4 つある。** auth-worker
# （`/login`）、dashboard-worker（`/account`）、nfc-worker（`/account/nfc`）、
# admin-worker（`/callback`、#447）。**それぞれが自分でバンドルを生成し、
# 自分でハッシュを決めている。**
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
# ## ページの参照では足りないアセットもある（#479）
#
# admin-worker のアイランド（`/ui/admin-island.<hash>.js`）は `/audit`
# `/clients` `/nfc/analytics` というログイン後の画面だけが読む。
# `probe_pages_for` が未認証で引く `/callback` はそれを参照しないので、
# **ページの HTML から見つける今までのやり方では、この 1 ファイルだけ
# 本番から 1 度も引かれない**——配信ルートが丸ごと消えても、deploy は
# 緑のままになる（`apps/admin-worker/test/route-inventory.ts` の
# `EXTERNALLY_UNVERIFIABLE_ASSETS` に同じ注記がある）。
#
# `/health` が `assets`（配信中のパスの一覧）を返す Worker があれば、
# ページを経由せずそのパスを直接引く——ログインを要らない。`assets` を
# 返さない Worker では何もしない（この issue では admin-worker だけに
# 閉じる判断）。
#
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <origin> <worker-name> [page:prefix ...]" >&2
  echo "  worker-name: auth-worker / dashboard-worker / nfc-worker / admin-worker" >&2
  exit 2
fi

base="${1%/}"
worker="$2"
shift 2

# **Worker ごとに、自分のデプロイ直後に引くページと接頭辞**（`ページ:接頭辞`）。
#
# **一覧を 1 つにまとめて全ジョブで回さない。** `deploy.yml` では
# dashboard と nfc が `needs: deploy-auth-worker` なので、auth のジョブから
# `/account` を引くと
#
#   1. **まだデプロイされていない dashboard を引く。** その回で dashboard の
#      コードが変わっていても、見えるのは**前のデプロイ**である。緑でも
#      「いま載せたもの」を確かめていない
#   2. **auth 自身は無事なのに dashboard と nfc のデプロイが止まる。**
#      実際に 1 度起きた（#310 のマージ後、`--max-time 20` ちょうどで
#      タイムアウトし、両方 `skipped`。再実行で 3/3 成功。指摘: 66）
#
# だから**各ジョブが自分の Worker ぶんだけを引く。** 既存の他のスモークも
# その形で揃っている。
#
# **ここを変えたら `apps/<worker>/test/route-inventory.ts` の `PROBE_PAGES`
# も変えること。** `check-asset-probe-pages.mjs` が両者の一致を見ている ——
# あちらだけが「このページが本当にそのアセットを参照しているか」を
# レンダリングして確かめられる（workerd 上のテストからはこのファイルを
# 読めない。実測）。
#
# **ここで確かめられるのは「未認証で引いたときに参照されるもの」だけ。**
# dashboard の画面は未認証だと全部 401 でログイン導線を返すので、
# **アイランドはどのページを引いても外からは見えない**（本番で実測）。
# その旨は `route-inventory.ts` の `EXTERNALLY_UNVERIFIABLE_ASSETS` に
# 理由ごと書いてあり、ログイン後の参照は Worker 側のテストが確かめる。
#
# あちらは「アセットを配る Worker が全部ここに居るか」も突き合わせている。
#
# **`probe_pages_for` は手で書かない（#453）。** `node
# scripts/generate-asset-probe-pages.mjs` が、各 Worker の
# `test/route-inventory.ts` の `PROBE_PAGES`（page）と `ASSET_ROUTES`
# の共通ディレクトリ（prefix）から機械的に作り、
# `scripts/generated/asset-probe-pages.sh` へ書き出す。Worker ごとに
# そのページ・接頭辞を選んだ理由（admin-worker が `/callback` を引く
# 理由など）は、そちらの手作業をやめた代わりに route-inventory.ts の
# JSDoc だけに残っている——二重に書くと片方だけ直る。
#
# 生成物が古いまま commit されると黙って壊れる（#453 の issue 本体が
# 指摘する形そのもの）ので、`pnpm check:asset-probe-pages-gen` が CI で
# 作り直した内容と突き合わせている。
source "$(dirname "${BASH_SOURCE[0]}")/generated/asset-probe-pages.sh"

# ページが明示されていなければ、その Worker ぶんを引く。
if [ "$#" -eq 0 ]; then
  pages="$(probe_pages_for "$worker")"
  if [ -z "$pages" ]; then
    # **「ページが無い Worker」を黙って成功にしない。** アセットを配って
    # いるのに宣言が無い場合と、そもそも配っていない場合が、同じ「0 件」に
    # なる。どちらかは `check-asset-probe-pages.mjs` が知っているので、
    # ここでは**呼ばれ方が間違っている**として落とす。
    echo "::error::${worker} に対応するページが宣言されていません。probe_pages_for を見るか、呼び出し側の Worker 名を確かめてください。"
    exit 1
  fi
  # shellcheck disable=SC2086
  set -- $pages
fi

failures=0
checked=0

# **デプロイ直後、アセットの 200 だけ数回リトライする**（#494）。
#
# 内容ハッシュが変わるデプロイ（Tailwind の出力が変わる・JS の中身が
# 変わるなど、UI を触れば普通に起きる）では、`/callback` のような
# ページが新しい版から返ったのに、そのすぐ後に投げたアセットへの要求が
# 古い版へ届く瞬間がある——ページとアセットは別のリクエストで、同じ
# Edge に当たる保証が無い。実際に `24634cb` のデプロイでこれが起き、
# 本番は正常なのに admin-worker のジョブだけ赤くなった（#453 とは無関係）。
#
# 指数で間を空けて合計 30 秒（2 + 4 + 8 + 16）。**302 を成功として
# 許すのではなく、200 になるまで（または回数を使い切るまで）同じ
# 判定を繰り返すだけ**——`PUBLIC_PATHS` から配信ルートが丸ごと落ちる
# ような本物の事故は、30 秒待っても 200 にならないのでそのまま落ちる
# （#479 で塞いだ事故をここでまた通さない）。
#
# ページの取得（`/callback` 等）側にはリトライを足していない。**今回の
# 伝播の窓は「ページが返したハッシュのアセットがまだ無い」という、
# アセット側だけの時間差**で、ページを引き直しても別の Edge に
# 当たるだけで同じ問題を再現しうる——待つべきはアセットの伝播であって、
# ページの再取得ではない。
ASSET_RETRY_DELAYS=(2 4 8 16)

# 1 本のアセット URL を本番から引き、ハッシュが入っていること・
# immutable が付いていることを見る（#211）。呼ぶ側（ページの参照を
# 読む側／`/health` の宣言を読む側、#479）が共通して必要とするので、
# ここへまとめる——バラバラに書くと、片方だけ直す事故が起きる
# （このファイル冒頭の auth-worker の例と同じ形）。
#
# `$checked` は呼ぶ前に呼び出し側が増やすこと。「どこから見つけたか」
# （ページの参照／`/health` の宣言）で数え方を変えたくない。
verify_asset_url() {
  local url="$1"
  local context="$2"

  # 内容ハッシュが入っていること（#211）。入っていなければ immutable を
  # 付けてはいけないので、キャッシュの検査より先に見る。リトライしても
  # 変わらない種類の失敗なので、ここだけはリトライの外に置く。
  if ! printf '%s' "$url" | grep -qE '\.[0-9a-f]{16}\.'; then
    echo "::error::${url} に内容ハッシュが入っていません（#211）。参照元: ${context}"
    failures=$((failures + 1))
    return
  fi

  local asset_url="${base}${url}"
  local head_file status headers attempt
  attempt=0

  while :; do
    head_file="$(mktemp)"
    # **ページの取得と同じ理由で `-f` を使わない（かつステータス行を読む）。**
    # `-f` は 4xx/5xx でしか空応答にならない——302 は `-f` にとって
    # エラーではなく、`-L` も無いのでリダイレクト先を追わないぶん
    # そのヘッダがそのまま返る。それを下の immutable の検査だけに
    # 食わせると、「アセットが配られていない」のに「immutable が
    # 付いていません」という**的外れな理由**で落ちる（#479、302 を
    # 実際に引いて実測）。
    #
    # **`|| echo 000` を使わない。** curl は失敗時にも `-w` で `000` を
    # 出すので、連結されて `000000` になり得る（このファイルのページ取得側
    # と同じ事情）。
    if status="$(curl -sS -o /dev/null -D "$head_file" -w '%{http_code}' --max-time 20 "$asset_url" 2>/dev/null)"; then
      :
    else
      status="unreachable"
    fi
    headers="$(cat "$head_file")"
    rm -f "$head_file"

    [ "$status" = "200" ] && break
    [ "$attempt" -ge "${#ASSET_RETRY_DELAYS[@]}" ] && break

    echo "  ${asset_url} が ${status}（デプロイ直後の伝播待ちの可能性）。" \
      "${ASSET_RETRY_DELAYS[$attempt]}s 後に再試行します（参照元: ${context}）。"
    sleep "${ASSET_RETRY_DELAYS[$attempt]}"
    attempt=$((attempt + 1))
  done

  if [ "$status" = "unreachable" ] || [ -z "$headers" ]; then
    echo "::error::${asset_url} を取得できませんでした（${context} が参照しています）。"
    failures=$((failures + 1))
    return
  fi

  # **immutable より先に、200 であることを見る。** ステータスを見ずに
  # いきなりキャッシュヘッダを探すと、「配られていない」が「キャッシュの
  # 設定が無い」という別の理由として報告される——運用者が深夜に
  # `PUBLIC_PATHS` の 1 行の抜けを疑わず、キャッシュ設定を探して遠回り
  # することになる。しかも、いつか 302 応答に immutable を付ける変更が
  # 入れば、この検査はその瞬間から何も見なくなる（強い前提を弱い下流の
  # 検査に肩代わりさせない）。
  if [ "$status" != "200" ]; then
    echo "::error::${asset_url} が 200 ではありません（HTTP ${status}）。参照元: ${context}"
    echo "  アセットが配られていません。PUBLIC_PATHS から落ちていないか、"
    echo "  <script src>/<link href> のハッシュと配信ルートのハッシュがずれていないかを見てください。"
    failures=$((failures + 1))
    return
  fi

  if ! printf '%s' "$headers" | grep -qi 'cache-control:.*immutable'; then
    echo "::error::${asset_url} に immutable が付いていません。URL にハッシュが入っている以上、付いているべきです。"
    echo "  $(printf '%s' "$headers" | head -n 1)"
    failures=$((failures + 1))
    return
  fi

  echo "  OK ${url}"
}

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

    verify_asset_url "$url" "$page_path"
  done <<EOF
${urls}
EOF
done

# **`/health` が配信中のアセットを直接宣言していれば、それも直接引く**
# （#479）。ページの HTML に参照が無くても確かめられる——ログイン後の
# 画面だけが読むアイランドは、未認証の `PROBE_PAGES` からは見えない
# （`EXTERNALLY_UNVERIFIABLE_ASSETS` を参照）。配信パスそのものを
# 検査するので、ログインを要らない。
#
# **`assets` を持たない Worker では何もしない。** `"assets"` という文字列
# すら本文に無ければ、素通りする——他の Worker にこの口を揃えるかどうかは、
# この issue（#479）では決めない。
#
# **`jq` が無い環境で、検査が黙って消えることを許さない（3b のレビュー
# 指摘、実測）。** `jq` が入っていなければ `jq -r '.assets[]?'` は空文字列を
# 返し、`2>/dev/null || true` と合わせて**エラーにならず、検査自体が
# 0 件のまま走らなくなる。** しかも終わりの要約は「すべて本番から引けます」
# という、何も問題が無かったときと同じ文言を出す——**この PR が
# `verify_asset_url` で直した「見るべきものが出てこないのに合格に
# 化ける」のと、まったく同じ形の穴。**
#
# 見分け方は「本文に `"assets"` という文字列はあるのに、取り出せた件数が
# 0 件」かどうか。これなら `jq` が無い場合も、`jq` はあるが応答が壊れた
# JSON だった場合も、同じ 1 つの条件で拾える。
health_url="${base}/health"
health_body="$(curl -sS --max-time 20 "$health_url" 2>/dev/null || true)"
health_assets="$(printf '%s' "$health_body" | jq -r '.assets[]?' 2>/dev/null || true)"
health_checked=0

if printf '%s' "$health_body" | grep -q '"assets"'; then
  if [ -z "$health_assets" ]; then
    echo "::error::${health_url} の本文に \"assets\" が含まれていますが、1 件も取り出せませんでした。"
    echo "  jq がインストールされていないか、応答が壊れた JSON になっている可能性があります。"
    failures=$((failures + 1))
  else
    echo "GET ${health_url}  (assets を直接引く)"
    while IFS= read -r url; do
      [ -z "$url" ] && continue
      checked=$((checked + 1))
      health_checked=$((health_checked + 1))
      verify_asset_url "$url" "/health の assets"
    done <<EOF
${health_assets}
EOF
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "::error::${failures} 件の失敗がありました。"
  exit 1
fi

summary="${worker}: ${#} ページが参照する $((checked - health_checked)) 件"
if [ "$health_checked" -gt 0 ]; then
  summary="${summary}、/health が宣言する ${health_checked} 件"
fi
echo "${summary}のアセットは、すべて本番から引けます。"
