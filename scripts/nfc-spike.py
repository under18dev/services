#!/usr/bin/env python3
"""PaSoRi RC-S300 と NTAG215 で、**書き込みまで通るか**を確かめる（#382 の前段）。

**本体を書く前に、これが通ることを確かめる。** 通らなければ道が変わる
（別のライブラリ、ベンダ固有の APDU、別の読み取り機）。

## なぜ spike が要るのか

運用者は NFC Tools で読み書きできることを確認しているが、**それは
「タグが書けること」であって「pyscard から RC-S300 経由で書けること」
ではない。** RC-S380 は独自 USB プロトコルで `nfcpy` が直接叩くが、
**RC-S300 は PC/SC 2.0 準拠**で、`nfcpy` 非対応という報告がある。

**このスクリプトを書いた側は、読み取り機もタグも持っていない。**
①〜④ のどれが落ちるかは、実機で走らせないと分からない。

## 使い方

    pip install pyscard
    python3 scripts/nfc-spike.py              # ①②④ だけ（読むだけ）
    python3 scripts/nfc-spike.py --write      # ③ も試す（タグを書き換える）

**`--write` は手元のタグを書き換える。** 配布に使わない 1 枚で試すこと。

## 落ちたときに見るもの

**生の APDU と応答をそのまま出す。** 「失敗した」だけでは次の手が決まらない。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nfc_ndef import decode_ndef_tlv, encode_ndef_tlv, to_pages  # noqa: E402

#: 確かめるために焼く URL。**本物と同じ形**にしてあるが、実在しないカード。
SPIKE_URL = "https://go.under18.dev/c/nfc_00000000000000000000"

#: Type 2 タグでユーザ領域が始まるページ。NTAG215 は 4 から。
FIRST_DATA_PAGE = 0x04

#: PC/SC の標準 APDU。**どれも「たぶんこう」である。実機で確かめる。**
GET_UID = [0xFF, 0xCA, 0x00, 0x00, 0x00]


def read_page(connection, page: int, length: int = 16) -> tuple[list[int], int, int]:
    """`FF B0` で読む。NTAG は 1 回の READ で 4 ページ（16 バイト）返す。"""
    return connection.transmit([0xFF, 0xB0, 0x00, page, length])


def write_page(connection, page: int, four: bytes) -> tuple[list[int], int, int]:
    """`FF D6` で 1 ページ（4 バイト）書く。"""
    if len(four) != 4:
        raise ValueError(f"1 ページは 4 バイト: {len(four)}")
    return connection.transmit([0xFF, 0xD6, 0x00, page, 0x04, *four])


def show(label: str, data: list[int], sw1: int, sw2: int) -> bool:
    ok = (sw1, sw2) == (0x90, 0x00)
    mark = "OK  " if ok else "NG  "
    body = bytes(data).hex(" ") if data else "(空)"
    print(f"    {mark} SW={sw1:02X}{sw2:02X}  {body}")
    if not ok:
        print(f"         ^ 90 00 以外。この応答をそのまま報告すること。")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="RC-S300 + NTAG215 の書き込み確認")
    parser.add_argument(
        "--write", action="store_true", help="③ 書き込みまで試す。**タグを書き換える**"
    )
    args = parser.parse_args()

    print("=== 焼くバイト列（ハードウェア無しで確かめ済み）===")
    tlv = encode_ndef_tlv(SPIKE_URL)
    print(f"  URL : {SPIKE_URL}")
    print(f"  TLV : {len(tlv)} バイト  {tlv.hex(' ')}")
    print(f"  ページ: {len(to_pages(tlv))} 枚（0x{FIRST_DATA_PAGE:02X} から）\n")

    # ---- ① 読み取り機を見つける ----
    print("=== ① pyscard が読み取り機を見つけるか ===")
    try:
        from smartcard.System import readers
    except ImportError:
        print("    NG  pyscard が入っていない: pip install pyscard")
        return 1

    available = readers()
    if not available:
        print("    NG  読み取り機が 1 台も見つからない。")
        print("        macOS は PC/SC が標準で入っているが、RC-S300 が PC/SC として")
        print("        見えていない可能性がある。ここで止まったら報告すること。")
        return 1
    for reader in available:
        print(f"    OK  {reader}")
    reader = available[0]
    print(f"    使う: {reader}\n")

    # ---- ② タグを 1 枚読む ----
    print("=== ② タグを 1 枚読めるか ===")
    print("    タグを読み取り機に載せてください…")
    try:
        connection = reader.createConnection()
        connection.connect()
    except Exception as error:  # noqa: BLE001 - 何が飛ぶか未知なので握って出す
        print(f"    NG  接続できない: {type(error).__name__}: {error}")
        return 1

    print("    UID:")
    if not show("uid", *read_uid(connection)):
        return 1

    print(f"    ページ 0x{FIRST_DATA_PAGE:02X} から 16 バイト:")
    data, sw1, sw2 = read_page(connection, FIRST_DATA_PAGE)
    if not show("read", data, sw1, sw2):
        print("        読めない。`FF B0` が通らないなら、ベンダ固有の APDU が要る。")
        return 1

    existing = None
    try:
        existing = decode_ndef_tlv(bytes(data))
    except ValueError:
        pass
    if existing is not None:
        print(f"    ** このタグには既に書き込みがある: {existing}")
        print("       本体では既定でスキップする（上書きすると前のカードが孤児になる）。")
    else:
        print("    （NDEF は入っていないか、読んだ範囲には無い）")

    if not args.write:
        print("\n=== ③ ④ は飛ばした（--write が無い）===")
        print("    **③ が本体である。** 配布に使わないタグで `--write` を試すこと。")
        return 0

    # ---- ③ 書く ----
    print("\n=== ③ NDEF を書けるか（**タグを書き換える**）===")
    pages = to_pages(tlv)
    for index, four in enumerate(pages):
        page = FIRST_DATA_PAGE + index
        print(f"    page 0x{page:02X} <- {four.hex(' ')}")
        if not show("write", *write_page(connection, page, four)):
            print("        書けない。ここが本体。この応答をそのまま報告すること。")
            print("        `FF D6` が通らないなら、RC-S300 向けの別の経路が要る。")
            return 1

    # ---- ④ 読み戻す ----
    print("\n=== ④ 読み戻して一致するか ===")
    read_back = bytearray()
    for index in range(0, len(pages), 4):
        data, sw1, sw2 = read_page(connection, FIRST_DATA_PAGE + index)
        if not show("read", data, sw1, sw2):
            return 1
        read_back.extend(data)

    try:
        decoded = decode_ndef_tlv(bytes(read_back))
    except ValueError as error:
        print(f"    NG  読み戻したものを解釈できない: {error}")
        print(f"        生: {bytes(read_back).hex(' ')}")
        return 1

    if decoded != SPIKE_URL:
        print(f"    NG  一致しない\n        書いた: {SPIKE_URL}\n        読んだ: {decoded}")
        return 1

    print(f"    OK  {decoded}")
    print("\n=== 4 段すべて通った。本体を書いてよい。===")
    return 0


def read_uid(connection) -> tuple[list[int], int, int]:
    return connection.transmit(GET_UID)


if __name__ == "__main__":
    raise SystemExit(main())
