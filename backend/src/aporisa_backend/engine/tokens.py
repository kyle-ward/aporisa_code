"""Tokenizer access for the worker: encoding and exact, incremental byte-level decoding.

Uses the checkpoint's tokenizer.json directly (the same pipeline AutoTokenizer builds;
tests compare the two). Decoding maps every id to the exact bytes it stands for and feeds
them through an incremental UTF-8 decoder, so streaming costs O(1) per token and a token
that ends mid-character never produces a broken delta.
"""

from __future__ import annotations

import codecs
from pathlib import Path


def _byte_decoder() -> dict[str, int]:
    """Inverse of GPT-2's bytes_to_unicode table used by byte-level BPE."""
    printable = (
        list(range(ord("!"), ord("~") + 1))
        + list(range(ord("¡"), ord("¬") + 1))
        + list(range(ord("®"), ord("ÿ") + 1))
    )
    codes = printable[:]
    extra = 0
    for byte in range(256):
        if byte not in printable:
            printable.append(byte)
            codes.append(256 + extra)
            extra += 1
    return {chr(code): byte for byte, code in zip(printable, codes, strict=True)}


class Codec:
    def __init__(self, model_dir: Path):
        from tokenizers import Tokenizer

        self.tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.vocab_size = self.tokenizer.get_vocab_size(with_added_tokens=True)
        added = {
            index: token.content
            for index, token in self.tokenizer.get_added_tokens_decoder().items()
        }
        table = _byte_decoder()
        self.pieces: list[bytes] = []
        for index in range(self.vocab_size):
            if index in added:
                self.pieces.append(added[index].encode())
                continue
            token = self.tokenizer.id_to_token(index)
            self.pieces.append(bytes(table[ch] for ch in token) if token is not None else b"")

    def encode(self, text: str) -> list[int]:
        return self.tokenizer.encode(text, add_special_tokens=False).ids

    def token_id(self, text: str) -> int:
        ids = self.encode(text)
        if len(ids) != 1:
            raise ValueError(f"{text!r} is not a single token")
        return ids[0]

    def decode(self, ids: list[int]) -> str:
        return b"".join(self.piece(i) for i in ids).decode("utf-8", errors="replace")

    def piece(self, token: int) -> bytes:
        return self.pieces[token] if 0 <= token < self.vocab_size else b""

    def stream(self) -> TextStream:
        return TextStream(self)


class TextStream:
    """Incremental decoder: bytes of each token in, complete characters out."""

    def __init__(self, codec: Codec):
        self.codec = codec
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def push(self, token: int) -> str:
        return self.decoder.decode(self.codec.piece(token))

    def flush(self) -> str:
        return self.decoder.decode(b"", final=True)
