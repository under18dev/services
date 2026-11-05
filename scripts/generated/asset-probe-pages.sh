#!/usr/bin/env bash
#
# 自動生成——手で編集しない（#453）。
# `node scripts/generate-asset-probe-pages.mjs` で作り直す。
#
# page は各 apps/<worker>/test/route-inventory.ts の `PROBE_PAGES`、
# prefix は同じファイルの `ASSET_ROUTES` の共通ディレクトリから機械的に
# 求めている。Worker ごとにそのページ・prefix を選んだ理由は、手で
# 合わせる field ではなくこの生成物にも存在しないので、route-inventory.ts
# 側の JSDoc を読むこと。

probe_pages_for() {
  case "$1" in
    admin-worker) echo "/callback:/ui/" ;;
    auth-worker) echo "/login:/ui/" ;;
    dashboard-worker) echo "/account:/account/ui/" ;;
    *) echo "" ;;
  esac
}
