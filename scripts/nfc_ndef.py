#!/usr/bin/env python3
"""NTAG（Type 2）へ書く NDEF のバイト列を組む。**ここだけはハードウェア無しで確かめられる。**

## なぜ分けてあるか

読み取り機（Sony PaSoRi RC-S300）もタグも手元に無いので、**書き込みの経路は
検査できない。** バイト列の組み立てだけは純粋な計算なので、**ここは期待する
16 進をそのまま突き合わせられる。**

**間違えたときの戻し方が無い領域である** —— 500 枚焼いてから「NDEF の
長さが 1 バイトずれていた」と分かっても、タグは戻らない。

## 形（NFC Forum URI RTD）

    TLV:     03 <len> <ndef...> FE
    NDEF:    D1 01 <payload_len> 55 <prefix> <uri の残り>
             ^^ MB|ME|SR|TNF=1（well-known）
                ^^ type length = 1
                      ^^ 短レコードなので 1 バイト
                                  ^^ 'U' = URI レコード
                                        ^^ 接頭辞コード

`https://` は接頭辞コード **0x04** に畳める。49 バイトの URL が
**TLV 全体で 49 バイト**に収まる（NTAG215 のユーザ領域は 504 バイト）。

    python3 scripts/nfc_ndef.py        # 自己検査
"""

from __future__ import annotations

#: URI RTD の接頭辞コード。**使うのは `https://` だけ**だが、
#: 取り違えると別の URL が焼かれるので表で持つ。
URI_PREFIXES: dict[int, str] = {
    0x00: "",
    0x01: "http://www.",
    0x02: "https://www.",
    0x03: "http://",
    0x04: "https://",
}


def encode_uri_record(uri: str) -> bytes:
    """URI を 1 本の NDEF レコードにする（TLV は含まない）。"""
    # **長いほうの接頭辞を先に当てる。** `https://` より `https://www.` が
    # 先に一致しないと、`www.` が本体に残って 1 バイト損する。
    code, prefix = 0x00, ""
    for candidate_code, candidate in URI_PREFIXES.items():
        if candidate != "" and uri.startswith(candidate) and len(candidate) > len(prefix):
            code, prefix = candidate_code, candidate

    rest = uri[len(prefix) :].encode("utf-8")
    payload = bytes([code]) + rest
    if len(payload) > 0xFF:
        # 短レコード（SR=1）は payload length が 1 バイト。**焼く URL は
        # 49 バイトなので届かないが、黙って切り詰めない。**
        raise ValueError(f"URI が長すぎる（短レコードに収まらない）: {len(payload)} バイト")

    return bytes([0xD1, 0x01, len(payload), 0x55]) + payload


def encode_ndef_tlv(uri: str) -> bytes:
    """Type 2 タグのユーザ領域へ書く TLV 全体。"""
    record = encode_uri_record(uri)
    if len(record) > 0xFE:
        # 0xFF は「3 バイト長が続く」の印。**そこへ踏み込むなら形が変わる。**
        raise ValueError(f"NDEF が長すぎる（1 バイト長に収まらない）: {len(record)} バイト")
    return bytes([0x03, len(record)]) + record + bytes([0xFE])


def decode_uri_record(data: bytes) -> str:
    """焼いたものを読み戻して確かめるための逆変換。

    **符号化と対にして持つ。** 書いたバイト列を自分で読み直せないと、
    「読み戻して確かめる」が実装できない。
    """
    if len(data) < 5 or data[0] & 0x07 != 0x01 or data[3] != 0x55:
        raise ValueError(f"URI レコードではない: {data[:8].hex()}")
    payload_length = data[2]
    payload = data[4 : 4 + payload_length]
    if len(payload) != payload_length:
        raise ValueError("payload が足りない")
    prefix = URI_PREFIXES.get(payload[0])
    if prefix is None:
        raise ValueError(f"知らない接頭辞コード: {payload[0]:#04x}")
    return prefix + payload[1:].decode("utf-8")


def decode_ndef_tlv(data: bytes) -> str:
    """TLV から URI を取り出す。タグから読んだ生のページ列を渡してよい。"""
    if len(data) < 2 or data[0] != 0x03:
        raise ValueError(f"NDEF TLV ではない: {data[:4].hex()}")
    length = data[1]
    return decode_uri_record(data[2 : 2 + length])


def to_pages(data: bytes) -> list[bytes]:
    """Type 2 の 4 バイトページへ切る。**末尾は 0x00 で埋める。**

    埋めないと最後のページだけ短くなり、`FF D6` の書き込みが弾かれる。
    """
    padded = data + bytes((-len(data)) % 4)
    return [padded[i : i + 4] for i in range(0, len(padded), 4)]


def _self_test() -> int:
    failures: list[str] = []

    def check(label: str, actual, expected) -> None:
        if actual != expected:
            failures.append(f"{label}\n      実際: {actual!r}\n      期待: {expected!r}")

    url = "https://go.under18.dev/c/nfc_hdt62b396zy809mmqk3v"
    rest = b"go.under18.dev/c/nfc_hdt62b396zy809mmqk3v"

    # **期待する 16 進を手で組んで突き合わせる。** 実装どうしの往復だけだと、
    # 両方が同じように間違っていても通る。
    expected_record = bytes([0xD1, 0x01, 1 + len(rest), 0x55, 0x04]) + rest
    check("URI レコード", encode_uri_record(url), expected_record)
    check("レコード長", len(expected_record), 46)

    expected_tlv = bytes([0x03, len(expected_record)]) + expected_record + bytes([0xFE])
    check("TLV", encode_ndef_tlv(url), expected_tlv)
    check("TLV 長", len(expected_tlv), 49)
    check("NTAG215 に収まる", len(expected_tlv) <= 504, True)

    # 先頭バイトの意味を 1 つずつ。
    check("MB|ME|SR|TNF", expected_record[0], 0xD1)
    check("type length", expected_record[1], 0x01)
    check("payload length", expected_record[2], 42)
    check("type 'U'", expected_record[3], 0x55)
    check("接頭辞 https://", expected_record[4], 0x04)

    # 往復。
    check("レコードの往復", decode_uri_record(encode_uri_record(url)), url)
    check("TLV の往復", decode_ndef_tlv(encode_ndef_tlv(url)), url)

    # **長いほうの接頭辞が勝つこと。** `https://www.` を `https://` に
    # 取られると、`www.` が本体に残って 1 バイト損する。
    check("www. つき", encode_uri_record("https://www.example.com")[4], 0x02)
    check("www. つきの往復", decode_uri_record(encode_uri_record("https://www.example.com")),
          "https://www.example.com")
    check("http://", encode_uri_record("http://example.com")[4], 0x03)
    # 畳めないものは 0x00 で、本体がそのまま入る。
    check("畳めない", encode_uri_record("ftp://example.com")[4], 0x00)
    check("畳めないの往復", decode_uri_record(encode_uri_record("ftp://example.com")),
          "ftp://example.com")

    # ページ分割。**4 の倍数へ 0 詰めする。**
    pages = to_pages(encode_ndef_tlv(url))
    check("ページ数", len(pages), 13)  # 49 バイト → 52 バイト → 13 ページ
    check("全ページが 4 バイト", {len(p) for p in pages}, {4})
    check("先頭ページ", pages[0], bytes([0x03, 0x2E, 0xD1, 0x01]))
    check("埋めたぶんが 0", pages[-1][-3:], bytes(3))
    check("連結すると元に戻る", b"".join(pages)[: len(expected_tlv)], expected_tlv)

    # 長すぎるものは黙って切らない。
    try:
        encode_uri_record("https://" + "a" * 300)
        failures.append("長すぎる URI を通した")
    except ValueError:
        pass

    # 壊れた入力。
    for bad in [b"", b"\x00\x00", bytes([0xD1, 0x01, 0x05, 0x54, 0x04])]:
        try:
            decode_uri_record(bad)
            failures.append(f"壊れた入力を通した: {bad.hex()}")
        except ValueError:
            pass

    if failures:
        for failure in failures:
            print(f"  NG {failure}")
        print(f"\n自己検査: {len(failures)} 件が失敗")
        return 1
    print("自己検査: すべて通った")
    print(f"  焼く TLV: {len(expected_tlv)} バイト / NTAG215 のユーザ領域 504 バイト")
    print(f"  {encode_ndef_tlv(url).hex(' ')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_test())
