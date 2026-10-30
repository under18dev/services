#!/usr/bin/env python3
"""カードを 1 枚発行して、目の前の NTAG215 に 1 枚焼く。これを Ctrl+C まで繰り返す（#382）。

運用者の指定（2026-10-30）:

> 60 枚ですがこれからも使っていきたいので、while で都度 id 作って
> ctrl+c で停止みたいにしたく

## **このスクリプトを書いた側は、読み取り機もタグも持っていない**

`scripts/nfc-spike.py` と同じ断り書きである。**実機で 1 度も走っていない。**
確かめてあるのは `--self-test` と `--dry-run` の範囲 —— **焼くバイト列の
組み立てと、`FF D6` で書いて `FF B0` で読み戻せば同じものが返る、という
往復だけ**である。読み取り機の側は 1 行も確かめていない。

**`nfcpy` ではなく `pyscard`（PC/SC）を使うという見込みも未検証である。**
RC-S300 は PC/SC 2.0 準拠という報告を根拠にしているが、運用者が確認したのは
「NFC Tools で読み書きできること」であって「pyscard から書けること」ではない。
**まず `nfc-spike.py --write` を通すこと。** ③ が落ちるなら、このスクリプトも
同じところで落ちる。

## 1 周 = 1 枚。まとめて発行しない

    while:
        ① タグが載るのを待つ
        ② 既に書き込まれていないか見る   既にあればスキップ（--force で上書き）
        ③ カードを 1 枚発行              ← **タグが目の前にあってから**
        ④ NDEF を書く
        ⑤ 読み戻して一致を確かめる
        ⑥ タグが外れるのを待って次へ
    Ctrl+C → 焼いた枚数・最後の cardId・**焼けなかった cardId** を出して終わる

**①→③ の順序が本体である。** 先に 60 枚発行してから焼くと、途中で止めるたびに
**発行済みで焼かれていないカード（孤児）**が D1 に残る —— `issued` のまま
一覧に並び続け、**対応する物理タグがどこにも無い。**

**③ と ④ の間で落ちたときだけ孤児が出る。避けられない。** そのときは
**その cardId を出してループを止める**（黙って次のタグへ行かない）。
運用者が `admin.under18.dev/nfc` から無効化できるようにするためで、
黙って続けると、どれが浮いているか後から分からなくなる。

## 使い方

    pip install pyscard

    # ⓪ 組み立てと読み戻しの往復を、タグを模したもので確かめる（pyscard も不要）
    python3 scripts/nfc-burn.py --self-test

    # ① 読み取り機もタグも無くても通る。API も叩かない
    python3 scripts/nfc-burn.py --dry-run

    # ② API まで確かめる。**本物のカードを 1 枚発行する（= 孤児を 1 枚作る）**
    python3 scripts/nfc-burn.py --dry-run --live-issue

    # ③ 本番。60 枚焼くなら --count 60 を付けてもよい（付けなければ Ctrl+C まで）
    export U18_SESSION_COOKIE='__Host-u18_session=...'
    python3 scripts/nfc-burn.py --batch bunkasai-2026 --count 60

**`--dry-run` は既定で API を叩かない。** 「発行」は取り消せない操作で、
**タグへ焼かれない 1 行を D1 に残す** ——「焼かないで試す」という名前の
フラグの既定にしてよい副作用ではない。セッションと権限まで通ったことを
確かめたいときだけ `--live-issue` を足すこと。**そのとき出たカードは孤児
なので、最後に出る cardId を控えて無効化すること。**

## セッションの渡し方

`U18_SESSION_COOKIE` に **`名前=値` の形のまま**入れる。

    export U18_SESSION_COOKIE='__Host-u18_session=...'

**値をこのファイルにも、コマンド履歴にも残さないこと。** `export` の前に
空白を 1 つ置けば（bash の `HISTCONTROL=ignorespace` / zsh の
`setopt histignorespace`）履歴に残らない。

取り方:

1. `https://auth.under18.dev` に **Passkey でログインする。**
   **メール OTP では駄目。** #337 以降、`isAdmin` は Passkey で張った
   セッションでしか立たない（仕様書 §14.1 決定 8、RR-5）。OTP で入ると
   403 が返る —— 401 ではないので「ログインしていない」と読まないこと。
2. DevTools → Application（Firefox なら Storage）→ Cookies →
   `https://auth.under18.dev`
3. `__Host-u18_session` の行の **Name と Value を `名前=値` の形に繋いで**
   環境変数へ入れる。**`Cookie: ` の接頭辞は要らない**（付いていても落とす）。

開発環境では Cookie 名が `u18_session`（`__Host-` なし）になる
（`packages/contracts/src/session-cookie.ts`）。`--api-origin` を
`http://localhost:8787` などに向けるときは、そちらの名前で入れること。

## **この発行経路は #390 の段取り 5 / 6 で消える（指揮役への申し送り）**

いま叩いているのは nfc-worker の JSON API:

    POST https://auth.under18.dev/account/nfc/cards

管理画面は **#412 で `admin.under18.dev/nfc` へ移った**（admin-worker の
`nfc.routes.tsx`）。#390 の段取りは **5 で NFC の管理を移し、6 で旧経路を
消す**と書いており、**「移したら消す」が明記されている。** この
`/account/nfc/cards` は消える前提で読むこと。

**消えたときに、向き先を `admin.under18.dev/nfc` へ替えるだけでは済まない。**
あちらは HTML フォームで、

- **CSRF トークンが要る。** `GET /nfc` を引いて hidden の値を拾い、Cookie と
  一緒に送り直すことになる（admin-worker の `csrf.ts`）。
- **`POST /nfc` は cardId を返さない。** 成功すると `303` で
  `/nfc?issued=<枚数>` へ飛ぶだけで、**出た ID が応答に無い。**
  一覧を引き直して差分を取ることになるが、**「発行の直後に一覧を引いて
  どれが出たか当てる」はこのスクリプトが避けている形そのもの**である
  （同時に誰かが発行していれば、一覧の側からは決められない）。

**つまり、段取り 5 を進めるときに決めるのは「スクリプトをどう直すか」では
なく「機械向けの発行の口をどこに置くか」である。** 選べるのは概ね 3 つ:

1. **admin-worker に JSON の発行エンドポイントを足す**（`Origin` と
   `Content-Type: application/json` の 2 枚で守る。いまの `cards.routes.ts`
   と同じ門番）。このスクリプトは `--api-origin` の既定値を替えるだけで済む。
2. **`POST /nfc` の応答に発行された cardId を載せる。** PRG の形を崩す。
   クエリには載せられない（`base-path.ts` の `CLAIM_CARD_PARAM` が
   「カード ID をログに出る場所へ置かない」として退けた形）ので、本文で返す
   ことになり、フォーム経由の画面遷移と両立させる作りが要る。
3. **`/account/nfc/cards` を機械用として残す。** #390 の「移したら消す」に
   正面から反する。**残すなら理由を書いて残すこと。**

**1 を薦める。** 2 は画面の都合とスクリプトの都合を 1 本の応答に混ぜる。
3 は #390 が「同じ機能が 2 箇所にある期間が長いほど、片方だけ直される」と
書いて避けた形そのものである。

## 前提にしていること（タグ側）

**タグが NDEF として初期化済みであること。** CC（ページ 3）は書かない ——
運用者は NFC Tools で既に読み書きできているので、工場出荷の NTAG215 が
そのまま NDEF 対応で載っている前提である。**白紙の（NDEF 未初期化の）
タグに当てると、④ は 90 00 を返すのに NFC Tools からは読めない、という
形で失敗しうる。** ⑤ の読み戻しはこのスクリプト自身の書き込みしか見ない
ので、そこまでは検出できない。**最初の 1 枚は NFC Tools でも読んで
確かめること。**
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# **`scripts/__pycache__/` を作らせない。** `nfc_ndef` を import するだけで
# `.pyc` が落ち、それがそのままコミットされて main に入ったことがある（#388）。
# `.gitignore` 側の手当てとは別に、**出さない**ほうを先に置く。
sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nfc_ndef import decode_ndef_tlv, encode_ndef_tlv, to_pages  # noqa: E402

#: セッション Cookie を受け取る環境変数。**値は絶対にここへ書かない。**
SESSION_ENV = "U18_SESSION_COOKIE"

#: 発行 API。`apps/nfc-worker/src/presentation/http/base-path.ts` の
#: `CARDS_BASE_PATH` と揃える。**段取り 5 / 6 で消える**（docstring を参照）。
DEFAULT_API_ORIGIN = "https://auth.under18.dev"
CARDS_PATH = "/account/nfc/cards"

#: タグへ焼く URL のホスト。`wrangler.jsonc` の `SHORT_URL_ORIGIN`（production）。
DEFAULT_SHORT_URL_ORIGIN = "https://go.under18.dev"

#: `redirect.routes.ts` の `GET /c/:cardId`。**`:cardId` は route の記法であって
#: 値ではない。** 実際にその文字列でいいのかという確認が来ている（2026-10-30）。
SHORT_URL_CARD_PREFIX = "/c/"

#: `@u18/domain` の `newCardId()`（`nfc_` + Crockford base32 20 文字）。
#: **`redirect.routes.ts` の `CARD_ID_PATTERN` より狭い。** あちらは無駄打ちの
#: 抑制が目的なので緩くてよいが、こちらは**焼く直前の最後の砦**なので実際の
#: 形で見る。間違った形を焼いたタグは回収できない。
CARD_ID_PATTERN = re.compile(r"^nfc_[0-9abcdefghjkmnpqrstvwxyz]{20}$")
CARD_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

#: Type 2 タグでユーザ領域が始まるページ。NTAG215 は 4 から。
FIRST_DATA_PAGE = 0x04

#: NTAG215 のユーザ領域。焼く TLV は 49 バイトなので 455 バイト余る。
NTAG215_USER_BYTES = 504

#: 1 回の READ で返るバイト数（4 ページ）。
READ_CHUNK_BYTES = 16

#: タグの載り・外れを見に行く間隔（秒）。
POLL_INTERVAL = 0.3

#: HTTP の待ち（秒）。発行は 1 枚ずつなので長く待つ理由が無い。
HTTP_TIMEOUT = 15


class BurnError(Exception):
    """タグへの書き込み・読み戻しが通らなかった。**cardId は既に発行済みである。**"""


class IssueError(Exception):
    """発行 API が通らなかった。**まだ何も発行されていない**（孤児は出ない）。"""


# ---------------------------------------------------------------- 発行（HTTP）


def read_session_cookie() -> str:
    """環境変数からセッション Cookie を読む。**値は返すだけで、決して出力しない。**"""
    raw = os.environ.get(SESSION_ENV, "").strip()
    if raw == "":
        raise SystemExit(
            f"{SESSION_ENV} が空です。\n"
            f"  export {SESSION_ENV}='__Host-u18_session=...'\n"
            "  （取り方はこのファイルの docstring を参照）"
        )

    # `Cookie: __Host-...` ごと貼られることがある。落として受ける。
    if raw.lower().startswith("cookie:"):
        raw = raw.split(":", 1)[1].strip()

    if "=" not in raw:
        # **値そのものを出さない。** 形が違うことだけ伝える。
        raise SystemExit(
            f"{SESSION_ENV} が `名前=値` の形になっていません。"
            " DevTools の Name と Value を `=` で繋いで入れてください。"
        )
    return raw


def origin_of(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def hint_for(status: int) -> str:
    if status == 401:
        return f"    → {SESSION_ENV} のセッションが切れているか、Cookie の名前が違います。"
    if status == 403:
        return (
            "    → 3 つのどれか。\n"
            "       ・管理者ではない（Passkey で入り直す。メール OTP では isAdmin が立たない）\n"
            "       ・Origin が送れていない\n"
            "       ・Content-Type が application/json になっていない"
        )
    return ""


def issue_card(api_origin: str, cookie: str, batch: str | None) -> str:
    """カードを **1 枚だけ** 発行して cardId を返す。

    **`count` は常に 1 である。** まとめて出せる API だが（上限 200、
    `MAX_ISSUE_COUNT`）、まとめて出した時点で「焼かれていないカード」が
    生まれる。この関数が呼ばれるのは、**タグが読み取り機に載っていることを
    確かめたあと**だけ。
    """
    url = urllib.parse.urljoin(api_origin, CARDS_PATH)
    payload = {"count": 1} if batch is None else {"count": 1, "batch": batch}
    body = json.dumps(payload).encode("utf-8")

    # **`Origin` は必須。** `origin.ts` の `isAllowedOrigin` は Origin が
    # 無ければ拒否し（fail-closed）、**リクエスト URL の origin と比べる**ので、
    # ここは固定値ではなく `--api-origin` から作る。
    # **`Content-Type: application/json` も必須。** どちらが欠けても 403 で、
    # 「認証が通っていない」と区別の付かない見た目になる。
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Origin": origin_of(url),
            "Cookie": cookie,
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            status = response.status
            text = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        # **応答本文をそのまま出す。** 載るのは `{"error":"forbidden"}` の類だけで
        # （`bodyFor()`）、秘密は入らない。
        detail = error.read().decode("utf-8", "replace")
        raise IssueError(
            f"{error.code} {error.reason}\n    応答: {detail}\n{hint_for(error.code)}"
        ) from error
    except urllib.error.URLError as error:
        raise IssueError(f"{url} へ届きません: {error.reason}") from error

    if status != 201:
        raise IssueError(f"201 ではなく {status} が返りました\n    応答: {text}")

    try:
        cards = json.loads(text)["cards"]
    except (ValueError, KeyError, TypeError) as error:
        raise IssueError(f"応答を解釈できません: {text}") from error

    if not isinstance(cards, list) or len(cards) != 1:
        raise IssueError(f"1 枚だけ返るはずが {cards!r} でした")

    card_id = cards[0].get("cardId") if isinstance(cards[0], dict) else None
    if not isinstance(card_id, str) or not CARD_ID_PATTERN.fullmatch(card_id):
        # **焼く直前の最後の砦。** 形の違うものを焼いたタグは回収できない。
        raise IssueError(f"cardId の形が想定と違います: {card_id!r}")

    return card_id


def card_tap_url(short_url_origin: str, card_id: str) -> str:
    """タグへ焼く URL。`base-path.ts` の `cardTapUrl()` と同じものを作る。"""
    return urllib.parse.urljoin(short_url_origin, f"{SHORT_URL_CARD_PREFIX}{card_id}")


# ---------------------------------------------------------------- タグ（PC/SC）


def apdu_text(apdu: list[int]) -> str:
    return bytes(apdu).hex(" ")


def transmit(connection, apdu: list[int], verbose: bool) -> tuple[list[int], int, int]:
    """APDU を 1 本投げる。**失敗したら生のまま出す。**

    `nfc-spike.py` と同じ方針。「書けませんでした」だけでは次の手が決まらない。
    """
    data, sw1, sw2 = connection.transmit(apdu)
    ok = (sw1, sw2) == (0x90, 0x00)
    if verbose or not ok:
        mark = "OK " if ok else "NG "
        shown = bytes(data).hex(" ") if data else "(空)"
        print(f"      {mark} > {apdu_text(apdu)}")
        print(f"          < SW={sw1:02X}{sw2:02X}  {shown}")
    return data, sw1, sw2


def read_bytes(connection, page: int, count: int, verbose: bool) -> bytes:
    """ページ `page` から `count` バイト読む。`FF B0` は 1 回 16 バイト返す。"""
    out = bytearray()
    while len(out) < count:
        offset_pages = len(out) // 4
        apdu = [0xFF, 0xB0, 0x00, page + offset_pages, READ_CHUNK_BYTES]
        data, sw1, sw2 = transmit(connection, apdu, verbose)
        if (sw1, sw2) != (0x90, 0x00):
            raise BurnError(
                f"ページ 0x{page + offset_pages:02X} を読めません（SW={sw1:02X}{sw2:02X}）"
            )
        out.extend(data)
    return bytes(out[:count])


def write_pages(connection, pages: list[bytes], verbose: bool) -> None:
    """`FF D6` で 1 ページ（4 バイト）ずつ書く。"""
    for index, four in enumerate(pages):
        page = FIRST_DATA_PAGE + index
        apdu = [0xFF, 0xD6, 0x00, page, 0x04, *four]
        _, sw1, sw2 = transmit(connection, apdu, verbose)
        if (sw1, sw2) != (0x90, 0x00):
            raise BurnError(
                f"ページ 0x{page:02X} に {four.hex(' ')} を書けません"
                f"（SW={sw1:02X}{sw2:02X}）\n"
                f"    ここまでに {index} ページ書いてあります。"
                "**このタグは中途半端な状態です。**"
            )


def existing_ndef(connection, verbose: bool) -> str | None:
    """既に書き込まれているか見る。URL まで読めれば返し、無ければ `None`。

    **`nfc-spike.py` のように 16 バイトだけ見ない。** 焼いた TLV は 49 バイトで、
    16 バイトでは URI レコードの途中までしか届かず、`decode_ndef_tlv()` は
    「payload が足りない」で落ちる —— **書き込み済みのタグが「空」に見える。**
    既定で上書きしないという約束が、そこで静かに破れる。

    **解釈できなくても、TLV の頭（0x03）があれば「書かれている」と見なす。**
    別のアプリが書いたものかもしれないが、**上書きしてよい根拠にはならない。**
    """
    head = read_bytes(connection, FIRST_DATA_PAGE, READ_CHUNK_BYTES, verbose)
    if head[0] != 0x03 or head[1] == 0x00:
        return None

    total = 2 + head[1] + 1  # 03 <len> <ndef...> FE
    if total > NTAG215_USER_BYTES:
        return "（長さの読めない書き込み）"

    full = head if total <= len(head) else read_bytes(connection, FIRST_DATA_PAGE, total, verbose)
    try:
        return decode_ndef_tlv(full)
    except ValueError:
        return f"（NDEF として解釈できない書き込み: {full[:8].hex(' ')} …）"


def pick_reader(pattern: str | None):
    try:
        from smartcard.System import readers
    except ImportError as error:
        raise SystemExit("pyscard が入っていません: pip install pyscard") from error

    available = readers()
    if not available:
        raise SystemExit(
            "読み取り機が 1 台も見つかりません。\n"
            "  RC-S300 が PC/SC として見えていない可能性があります。"
            " まず `python3 scripts/nfc-spike.py` を通してください。"
        )

    if pattern is None:
        chosen = available[0]
    else:
        matched = [r for r in available if pattern.lower() in str(r).lower()]
        if not matched:
            listed = "\n".join(f"    {r}" for r in available)
            raise SystemExit(f"`{pattern}` に合う読み取り機がありません:\n{listed}")
        chosen = matched[0]

    print(f"読み取り機: {chosen}")
    if len(available) > 1 and pattern is None:
        print(f"  （{len(available)} 台あります。選ぶなら --reader で）")
    return chosen


def wait_for_tag(reader, label: str):
    """タグが載るまで待つ。**Ctrl+C はここで効く**（`KeyboardInterrupt` は素通りする）。

    **握り潰した理由を 1 回だけ出す。** タグが載っていない間は毎回例外が飛ぶので
    黙って回すしかないが、**全部黙ると「載せても進まない」ときに手掛かりがゼロに
    なる** —— タグを模したもので試したときに、実際ここで `AttributeError` を
    延々と飲み込んで止まった。**繋がらない理由と、タグが無いことは、ここからは
    区別できない。** だから最初の 1 本だけ見せて、あとは黙る。
    """
    print(f"{label} タグを載せてください… (Ctrl+C で終了)")
    reported = False
    while True:
        connection = reader.createConnection()
        try:
            connection.connect()
            return connection
        except Exception as error:  # noqa: BLE001 - 種類は読み取り機依存
            if not reported:
                print(f"    （待っています: {type(error).__name__}: {error}）")
                reported = True
            time.sleep(POLL_INTERVAL)


def wait_for_removal(reader) -> None:
    """タグが外れるまで待つ。

    **これが無いと同じタグを 2 回処理する。** 既定（上書きしない）なら
    「既に書かれている」で弾かれて回り続けるだけだが、`--force` では
    **1 枚目のカードを孤児にしながら 2 枚目を焼く。**
    """
    print("    タグを外してください…")
    while True:
        connection = reader.createConnection()
        try:
            connection.connect()
            connection.disconnect()
        except Exception:  # noqa: BLE001 - 外れれば投げる
            return
        time.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------- 記録と報告


class Tally:
    """焼けたものと、**焼けなかったもの**を数える。"""

    def __init__(self) -> None:
        self.burned: list[tuple[str, str]] = []
        self.skipped = 0
        #: **発行済みだがタグに載っていないカード（孤児）。** D1 に `issued` の
        #: まま残るので、運用者が無効化できるように必ず出す。
        self.orphans: list[tuple[str, str]] = []

    def report(self) -> None:
        print("\n" + "=" * 60)
        print(f"焼けた枚数: {len(self.burned)}")
        if self.burned:
            print(f"最後に焼いた cardId: {self.burned[-1][0]}")
            print(f"            その URL: {self.burned[-1][1]}")
        if self.skipped:
            print(f"飛ばした枚数（既に書き込みがあった）: {self.skipped}")

        if not self.orphans:
            print("発行済みで焼けなかったカード: なし")
            return

        print("\n** 発行済みだが焼けていないカード（孤児） **")
        print("   D1 に `issued` のまま残ります。**対応する物理タグはありません。**")
        for card_id, reason in self.orphans:
            print(f"   - {card_id}    {reason}")
        print("\n   無効化してください:")
        print("     admin.under18.dev/nfc の一覧から、または")
        print("     POST https://auth.under18.dev/account/nfc/cards/<cardId>/disable")
        print('     { "reason": "unused" }')


def open_log(path: Path):
    """追記用に開く。**0600 で作る。**

    中身は cardId の一覧で、**未紐づけのカードは ID を知っている人のもの**
    （#358）。配布物そのものと同じ扱いになるファイルを、既定の権限で置かない。
    """
    exists = path.exists()
    handle = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a")
    if not exists:
        handle.write("# time\tcardId\turl\tstatus\n")
    return handle


def log_line(handle, card_id: str, url: str, status: str) -> None:
    if handle is None:
        return
    handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')}\t{card_id}\t{url}\t{status}\n")
    handle.flush()


# ---------------------------------------------------------------- 組み立ての確認


def show_plan(card_id: str, url: str, verbose: bool = True) -> list[bytes]:
    """焼くバイト列を組んで出す。**ここはハードウェア無しで確かめられる。**"""
    tlv = encode_ndef_tlv(url)
    if len(tlv) > NTAG215_USER_BYTES:
        raise BurnError(f"TLV が NTAG215 のユーザ領域に収まりません: {len(tlv)} バイト")
    pages = to_pages(tlv)
    if verbose:
        print(f"    cardId : {card_id}")
        print(f"    URL    : {url}  （{len(url)} バイト）")
        print(f"    TLV    : {len(tlv)} バイト  {tlv.hex(' ')}")
        print(
            f"    ページ : {len(pages)} 枚  "
            f"0x{FIRST_DATA_PAGE:02X}〜0x{FIRST_DATA_PAGE + len(pages) - 1:02X}"
            f"（ユーザ領域 {NTAG215_USER_BYTES} バイト中 {len(tlv)} バイト）"
        )
    return pages


def dry_run(args) -> int:
    """読み取り機もタグも無い状態で、**発行と URL の組み立てまで**を確かめる。"""
    print("=== --dry-run : タグには一切書きません ===\n")

    if args.live_issue:
        print(f"① 発行 API を叩きます（{args.api_origin}{CARDS_PATH}）")
        print("   ** 本物のカードが 1 枚出ます。タグに焼かないので、これは孤児です。 **")
        cookie = read_session_cookie()
        try:
            card_id = issue_card(args.api_origin, cookie, args.batch)
        except IssueError as error:
            print(f"   NG  {error}")
            return 1
        print(f"   OK  発行できました。**この cardId を無効化してください: {card_id}**\n")
    else:
        print("① 発行 API は叩いていません（--live-issue を足すと叩きます）")
        card_id = "nfc_" + "".join(secrets.choice(CARD_ID_ALPHABET) for _ in range(20))
        print("   手元で作った**偽物**の cardId を使います。D1 には存在しません。\n")

    print("② 焼くバイト列")
    pages = show_plan(card_id, card_tap_url(args.short_url_origin, card_id))

    print("\n③ 投げる APDU（**投げていません**）")
    for index, four in enumerate(pages):
        page = FIRST_DATA_PAGE + index
        print(f"    > {apdu_text([0xFF, 0xD6, 0x00, page, 0x04, *four])}")
    print("    読み戻し:")
    for offset in range(0, len(pages), 4):
        print(f"    > {apdu_text([0xFF, 0xB0, 0x00, FIRST_DATA_PAGE + offset, READ_CHUNK_BYTES])}")

    print("\n=== ここまでは確かめられます。**この先は実機でしか分かりません。** ===")
    print("    まず `python3 scripts/nfc-spike.py --write` を通すこと。")
    return 0


# ---------------------------------------------------------------- 自己検査


class FakeTag:
    """NTAG215 のふりをする。**`--self-test` のためだけにある。**

    実機が無くても、**`FF D6` で書いたものを `FF B0` で読み戻せば同じになる**
    という往復だけは確かめられる。ページの番号を 1 つずらす・読み戻す長さを
    間違える、は**どれもここで落ちる**（実機では「焼いたあとに気づく」）。

    **これは読み取り機の代わりではない。** 本物の RC-S300 が `FF D6` を
    受け付けるかどうかは、ここでは何も分からない。
    """

    #: ユーザ領域は 0x04 から。NTAG215 は 0x81 まで（504 バイト）。
    LAST_PAGE = FIRST_DATA_PAGE + NTAG215_USER_BYTES // 4 - 1

    def __init__(self, initial: bytes = b"") -> None:
        self.memory = bytearray(NTAG215_USER_BYTES)
        self.memory[: len(initial)] = initial

    def transmit(self, apdu: list[int]) -> tuple[list[int], int, int]:
        if apdu[:2] == [0xFF, 0xB0]:
            page, length = apdu[3], apdu[4]
            if page < FIRST_DATA_PAGE or page + length // 4 - 1 > self.LAST_PAGE:
                return [], 0x6A, 0x82
            start = (page - FIRST_DATA_PAGE) * 4
            return list(self.memory[start : start + length]), 0x90, 0x00

        if apdu[:2] == [0xFF, 0xD6]:
            page, length, body = apdu[3], apdu[4], apdu[5:]
            if length != 4 or len(body) != 4 or not FIRST_DATA_PAGE <= page <= self.LAST_PAGE:
                return [], 0x6A, 0x80
            start = (page - FIRST_DATA_PAGE) * 4
            self.memory[start : start + 4] = bytes(body)
            return [], 0x90, 0x00

        return [], 0x6D, 0x00

    def disconnect(self) -> None:
        pass


def self_test() -> int:
    """ハードウェア無しで確かめられるところを全部確かめる。"""
    failures: list[str] = []

    def check(label: str, actual, expected) -> None:
        if actual != expected:
            failures.append(f"{label}\n      実際: {actual!r}\n      期待: {expected!r}")

    card_id = "nfc_hdt62b396zy809mmqk3v"
    url = card_tap_url(DEFAULT_SHORT_URL_ORIGIN, card_id)

    check("焼く URL", url, "https://go.under18.dev/c/nfc_hdt62b396zy809mmqk3v")
    check("URL に `:cardId` が残っていない", ":" in url.removeprefix("https:"), False)
    check("cardId の形", bool(CARD_ID_PATTERN.fullmatch(card_id)), True)
    # **実際に出る形だけを通す。** `newCardId()` は `nfc_` + 20 文字ちょうど。
    for bad in ["nfc_short", "nfc_" + "a" * 21, "nfc_HDT62B396ZY809MMQK3V", "nfc_illou" + "a" * 11]:
        check(f"弾く: {bad}", bool(CARD_ID_PATTERN.fullmatch(bad)), False)

    # 白紙のタグ: 書いて、読み戻して、一致する。
    tag = FakeTag()
    check("白紙は空に見える", existing_ndef(tag, False), None)
    burn_one(tag, card_id, url, False)
    check("書いたあとは読める", existing_ndef(tag, False), url)

    # **16 バイトしか見ないと書き込み済みが「空」に見える**、が再発しないこと。
    # 焼いた TLV は 49 バイトなので、先頭 16 バイトでは URI レコードが切れる。
    head = read_bytes(tag, FIRST_DATA_PAGE, READ_CHUNK_BYTES, False)
    try:
        decode_ndef_tlv(head)
        failures.append("16 バイトだけで解釈できてしまった（この検査が無意味になっている）")
    except ValueError:
        pass

    # 読み戻しが食い違えば必ず落ちる。**ここが黙ると配ったあとに気づく。**
    tampered = FakeTag()
    burn_one(tampered, card_id, url, False)
    tampered.memory[10] ^= 0xFF
    try:
        burn_one_verify_only(tampered, url)
        failures.append("読み戻しの食い違いを見逃した")
    except BurnError:
        pass

    # 別のカードが焼いてあるタグは「書かれている」と見える（既定で上書きしない）。
    other = card_tap_url(DEFAULT_SHORT_URL_ORIGIN, "nfc_00000000000000000000")
    written = FakeTag(encode_ndef_tlv(other))
    check("既存の書き込みが見える", existing_ndef(written, False), other)

    # NDEF として解釈できないゴミも「書かれている」と見なす。
    garbage = FakeTag(bytes([0x03, 0x10]) + bytes(range(0x10)) + bytes([0xFE]))
    check("解釈できない書き込みも見逃さない", existing_ndef(garbage, False) is not None, True)

    # `Origin` はリクエスト URL の origin と一致していること（`isAllowedOrigin`）。
    check(
        "Origin",
        origin_of(urllib.parse.urljoin(DEFAULT_API_ORIGIN, CARDS_PATH)),
        DEFAULT_API_ORIGIN,
    )

    if failures:
        for failure in failures:
            print(f"  NG {failure}")
        print(f"\n自己検査: {len(failures)} 件が失敗")
        return 1
    print("自己検査: すべて通った")
    print("  **確かめたのは組み立てと読み戻しの往復だけ。**")
    print("  RC-S300 が FF D6 を受け付けるかは、ここでは何も分かっていない。")
    return 0


def burn_one_verify_only(connection, url: str) -> None:
    """読み戻しだけやり直す（`--self-test` 用）。"""
    pages = to_pages(encode_ndef_tlv(url))
    raw = read_bytes(connection, FIRST_DATA_PAGE, len(pages) * 4, False)
    try:
        decoded = decode_ndef_tlv(raw)
    except ValueError as error:
        raise BurnError(f"読み戻したものを解釈できません: {error}") from error
    if decoded != url:
        raise BurnError(f"読み戻しが一致しません: {decoded}")


# ---------------------------------------------------------------- 本体


def burn_one(connection, card_id: str, url: str, verbose: bool) -> None:
    """④ 書く → ⑤ 読み戻して一致を確かめる。**失敗は `BurnError`。**"""
    pages = show_plan(card_id, url, verbose=verbose)
    write_pages(connection, pages, verbose)

    # **必ず読み戻す。** 書けたつもりで書けていないのが一番高く付く ——
    # 配ったあとに分かっても、タグはもう手元に無い。
    raw = read_bytes(connection, FIRST_DATA_PAGE, len(pages) * 4, verbose)
    try:
        decoded = decode_ndef_tlv(raw)
    except ValueError as error:
        raise BurnError(f"読み戻したものを解釈できません: {error}\n    生: {raw.hex(' ')}") from error

    if decoded != url:
        raise BurnError(f"読み戻しが一致しません\n    書いた: {url}\n    読んだ: {decoded}")


def run(args) -> int:
    cookie = read_session_cookie()
    reader = pick_reader(args.reader)
    tally = Tally()
    handle = open_log(Path(args.log)) if args.log else None

    if args.batch is None:
        print("** --batch を付けていません。** ロット名が無いと、後から")
        print("   「どの配布分か」で辿れません（docs/nfc-cards-operations.md §1-2）。")
    if args.force:
        print("** --force : 書き込み済みのタグも上書きします。**")
        print("   上書きされたカードは孤児になり、**それを持っている人のカードが死にます。**")

    try:
        while args.count is None or len(tally.burned) < args.count:
            nth = len(tally.burned) + 1
            label = f"[{nth}/{args.count}]" if args.count else f"[{nth}]"

            # ---- ① タグを待つ ----
            connection = wait_for_tag(reader, label)

            # ---- ② 既に書かれていないか ----
            try:
                existing = existing_ndef(connection, args.verbose)
            except BurnError as error:
                # **まだ発行していないので孤児は出ない。** 次のタグへ行ってよい。
                print(f"    NG  読めません: {error}")
                wait_for_removal(reader)
                continue

            if existing is not None and not args.force:
                print(f"    飛ばします（既に書き込みがあります）: {existing}")
                print("    上書きすると、そのカードを持っている人のカードが死にます。")
                print("    本当に上書きするなら --force。")
                tally.skipped += 1
                wait_for_removal(reader)
                continue
            if existing is not None:
                print(f"    ** 上書きします（--force）。元の書き込み: {existing} **")

            # ---- ③ ここで初めて発行する ----
            try:
                card_id = issue_card(args.api_origin, cookie, args.batch)
            except IssueError as error:
                # **何も発行されていない。** 止めて理由を出す。
                print(f"    NG  発行できません: {error}")
                return 1

            url = card_tap_url(args.short_url_origin, card_id)

            # ---- ④⑤ 焼いて読み戻す。**ここから先の失敗は孤児になる** ----
            try:
                burn_one(connection, card_id, url, args.verbose)
            except BurnError as error:
                tally.orphans.append((card_id, str(error).splitlines()[0]))
                log_line(handle, card_id, url, "FAILED")
                print(f"    NG  {error}")
                # **黙って次へ行かない**（docs §1-1）。浮いたカードを 1 枚出した
                # まま続けると、どれが浮いているか後から分からなくなる。
                print("\n    **ここで止めます。** 上の cardId は発行済みで、")
                print("    どのタグにも載っていません。")
                return 1

            tally.burned.append((card_id, url))
            log_line(handle, card_id, url, "ok")
            print(f"    OK  {url}")

            # ---- ⑥ 外れるのを待って次へ ----
            if args.count is None or len(tally.burned) < args.count:
                wait_for_removal(reader)

    except KeyboardInterrupt:
        print("\n\nCtrl+C")
    finally:
        tally.report()
        if handle is not None:
            handle.close()
            print(f"\n記録: {args.log}（**cardId の一覧です。配布物と同じ扱いに。**）")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="カードを 1 枚発行して 1 枚焼く、を Ctrl+C まで繰り返す",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"セッションは環境変数 {SESSION_ENV} から読みます"
        " （export U18_SESSION_COOKIE='__Host-u18_session=...'）。",
    )
    parser.add_argument("--batch", help="ロット名。後から配布の単位で辿るのに使う")
    parser.add_argument("--count", type=int, help="この枚数で止まる。既定は Ctrl+C まで")
    parser.add_argument("--force", action="store_true", help="**書き込み済みのタグも上書きする**")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="読み取り機もタグも使わない。タグには一切書かない",
    )
    parser.add_argument(
        "--live-issue",
        action="store_true",
        help="--dry-run と一緒にだけ使う。**本物のカードを 1 枚発行する（孤児が 1 枚出る）**",
    )
    parser.add_argument("--reader", help="読み取り機の名前の一部。複数台あるとき")
    parser.add_argument("--log", help="焼いたものを追記する TSV。**0600 で作る**")
    parser.add_argument(
        "--api-origin", default=DEFAULT_API_ORIGIN, help=f"発行 API のホスト。既定 {DEFAULT_API_ORIGIN}"
    )
    parser.add_argument(
        "--short-url-origin",
        default=DEFAULT_SHORT_URL_ORIGIN,
        help=f"タグへ焼く URL のホスト。既定 {DEFAULT_SHORT_URL_ORIGIN}",
    )
    parser.add_argument("--verbose", action="store_true", help="通った APDU も全部出す")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="組み立てと読み戻しの往復を、タグを模したもので確かめる",
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if args.live_issue and not args.dry_run:
        parser.error("--live-issue は --dry-run と一緒にだけ使います（本番は常に発行します）")
    if args.count is not None and args.count < 1:
        parser.error("--count は 1 以上")

    if args.dry_run:
        return dry_run(args)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
