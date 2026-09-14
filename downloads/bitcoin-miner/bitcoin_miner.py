#!/usr/bin/env python3
"""Small, explicit Bitcoin Core RPC miner.

This is intended for regtest/testnet experimentation and learning.  CPU mining
on Bitcoin mainnet is not economically useful; ASIC hardware is required there.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from typing import Any


def dsha256(data: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def compact_size(n: int) -> bytes:
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def script_num(n: int) -> bytes:
    """Minimal CScript number encoding, used for the coinbase height."""
    if n == 0:
        return b""
    negative = n < 0
    value = abs(n)
    out = bytearray()
    while value:
        out.append(value & 0xFF)
        value >>= 8
    if out[-1] & 0x80:
        out.append(0x80 if negative else 0)
    elif negative:
        out[-1] |= 0x80
    return bytes(out)


def push_data(data: bytes) -> bytes:
    if len(data) < 0x4C:
        return bytes([len(data)]) + data
    if len(data) <= 0xFF:
        return b"\x4c" + bytes([len(data)]) + data
    raise ValueError("coinbase data push is too large")


def bits_to_target(bits: int) -> int:
    exponent = bits >> 24
    mantissa = bits & 0x007FFFFF
    if exponent <= 3:
        return mantissa >> (8 * (3 - exponent))
    return mantissa << (8 * (exponent - 3))


def merkle_root(raw_hashes: list[bytes]) -> bytes:
    if not raw_hashes:
        return b"\x00" * 32
    level = raw_hashes[:]
    while len(level) > 1:
        if len(level) & 1:
            level.append(level[-1])
        level = [dsha256(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return level[0]


class RpcError(RuntimeError):
    pass


class BitcoinRpc:
    def __init__(self, url: str, user: str | None, password: str | None, cookie_file: str | None):
        self.url = url
        if cookie_file:
            cookie = open(cookie_file, "r", encoding="utf-8").read().strip()
            self.auth = base64.b64encode(cookie.encode()).decode()
        elif user is not None and password is not None:
            self.auth = base64.b64encode(f"{user}:{password}".encode()).decode()
        else:
            self.auth = None
        self.counter = 0

    def call(self, method: str, params: list[Any] | None = None) -> Any:
        self.counter += 1
        body = json.dumps({"jsonrpc": "1.0", "id": self.counter, "method": method, "params": params or []}).encode()
        request = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"})
        if self.auth:
            request.add_header("Authorization", f"Basic {self.auth}")
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            raise RpcError(f"RPC HTTP error {exc.code}: {exc.read().decode(errors='replace')}") from exc
        except urllib.error.URLError as exc:
            raise RpcError(f"RPC connection failed: {exc.reason}") from exc
        if payload.get("error"):
            error = payload["error"]
            raise RpcError(f"RPC {error.get('code')}: {error.get('message')}")
        return payload["result"]


def make_coinbase(template: dict[str, Any], script_pubkey: bytes) -> bytes:
    height = int(template["height"])
    aux = b"".join(bytes.fromhex(v) for _, v in sorted(template.get("coinbaseaux", {}).items()))
    tag = b"codex-cpu-miner"
    script_sig = push_data(script_num(height)) + tag + aux
    if not 2 <= len(script_sig) <= 100:
        raise ValueError("coinbase scriptSig must be between 2 and 100 bytes")
    value = int(template["coinbasevalue"])
    tx = bytearray()
    tx += struct.pack("<I", 1)
    tx += b"\x01"  # one coinbase input
    tx += b"\x00" * 32 + struct.pack("<I", 0xFFFFFFFF)
    tx += compact_size(len(script_sig)) + script_sig
    tx += struct.pack("<I", 0xFFFFFFFF)
    tx += b"\x01"  # one output
    tx += struct.pack("<q", value)
    tx += compact_size(len(script_pubkey)) + script_pubkey
    tx += struct.pack("<I", 0)
    return bytes(tx)


def mine_template(template: dict[str, Any], coinbase: bytes, start_nonce: int = 0) -> tuple[int, bytes, int]:
    tx_hashes = [dsha256(coinbase)]
    tx_hashes.extend(bytes.fromhex(tx["txid"])[::-1] for tx in template.get("transactions", []))
    root = merkle_root(tx_hashes)
    version = int(template["version"])
    previous = bytes.fromhex(template["previousblockhash"])[::-1]
    bits = int(template["bits"], 16) if isinstance(template["bits"], str) else int(template["bits"])
    target = bits_to_target(bits)
    timestamp = int(template.get("curtime", time.time()))
    prefix = struct.pack("<I", version) + previous + root + struct.pack("<I", timestamp) + struct.pack("<I", bits)
    attempts = 0
    for nonce in range(start_nonce, 0x100000000):
        digest = dsha256(prefix + struct.pack("<I", nonce))
        attempts += 1
        if int.from_bytes(digest, "little") <= target:
            return nonce, prefix + struct.pack("<I", nonce), attempts
    raise RuntimeError("nonce range exhausted; refresh the block template")


def benchmark(seconds: float) -> int:
    prefix = bytes(76)
    target_time = time.perf_counter() + seconds
    nonce = 0
    count = 0
    while time.perf_counter() < target_time:
        dsha256(prefix + struct.pack("<I", nonce))
        nonce = (nonce + 1) & 0xFFFFFFFF
        count += 1
    rate = count / max(seconds, 0.001)
    print(f"SHA-256d: {count:,} hashes in {seconds:.2f}s ({rate:,.0f} H/s)")
    return 0


def mine(args: argparse.Namespace) -> int:
    if args.network == "mainnet" and not args.allow_mainnet:
        raise SystemExit("mainnet mining is disabled by default; add --allow-mainnet explicitly")
    rpc = BitcoinRpc(args.rpc_url, args.rpc_user, args.rpc_password, args.cookie_file)
    if args.address:
        address_info = rpc.call("getaddressinfo", [args.address])
        script_hex = address_info.get("scriptPubKey", {}).get("hex")
        if not script_hex:
            raise SystemExit("Bitcoin Core did not return a scriptPubKey for that address")
        script_pubkey = bytes.fromhex(script_hex)
    else:
        script_pubkey = bytes.fromhex(args.script_pubkey)
    mined = 0
    print(f"Connected target: {args.rpc_url} ({args.network})")
    while args.max_blocks == 0 or mined < args.max_blocks:
        template = rpc.call("getblocktemplate", [{"rules": ["segwit"]}])
        coinbase = make_coinbase(template, script_pubkey)
        started = time.perf_counter()
        nonce, header, attempts = mine_template(template, coinbase)
        txs = coinbase + b"".join(bytes.fromhex(tx["data"]) for tx in template.get("transactions", []))
        block_hex = (header + txs).hex()
        result = rpc.call("submitblock", [block_hex])
        elapsed = max(time.perf_counter() - started, 0.001)
        block_hash = dsha256(header)[::-1].hex()
        if result is not None:
            print(f"Rejected block {block_hash}: {result}", file=sys.stderr)
        else:
            mined += 1
            print(f"Accepted block {block_hash} at height {template['height']} | nonce={nonce} | {attempts / elapsed:,.0f} H/s")
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Explicit CPU Bitcoin Core miner for regtest/testnet experiments")
    sub = p.add_subparsers(dest="command", required=True)
    b = sub.add_parser("benchmark", help="measure local SHA-256d speed")
    b.add_argument("--seconds", type=float, default=10.0)

    m = sub.add_parser("mine", help="mine a block from Bitcoin Core getblocktemplate")
    m.add_argument("--rpc-url", default="http://127.0.0.1:18443")
    m.add_argument("--rpc-user")
    m.add_argument("--rpc-password")
    m.add_argument("--cookie-file", help="Bitcoin Core .cookie file; preferable to putting a password in shell history")
    m.add_argument("--network", choices=["regtest", "signet", "testnet", "mainnet"], default="regtest")
    payout = m.add_mutually_exclusive_group(required=True)
    payout.add_argument("--script-pubkey", help="coinbase payout scriptPubKey as hex")
    payout.add_argument("--address", help="Bitcoin Core wallet address used as the payout destination")
    m.add_argument("--max-blocks", type=int, default=1, help="0 means keep mining")
    m.add_argument("--allow-mainnet", action="store_true")
    return p


def main() -> int:
    args = parser().parse_args()
    if args.command == "benchmark":
        return benchmark(args.seconds)
    return mine(args)


if __name__ == "__main__":
    raise SystemExit(main())
