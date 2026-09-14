#!/usr/bin/env python3
"""Universal Stratum V1 miner.

The protocol and job-building code is hardware independent.  Backends expose
one small search() method, so CPU, CUDA, OpenCL, and ASIC adapters can be
added without changing pool logic.

This first implementation ships a real CPU backend.  GPU backends are
deliberately opt-in and report a clear setup error until their native runtime
is installed and validated on the target machine.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import select
import socket
import ssl
import struct
import sys
import time
from dataclasses import dataclass
from typing import Any, Optional


DIFF1_TARGET = 0x00000000FFFF0000000000000000000000000000000000000000000000000000


def sha256d(data: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def hash_value(digest: bytes) -> int:
    """Bitcoin's uint256 interpretation of a hash digest."""
    return int.from_bytes(digest, "little")


def difficulty_target(difficulty: float) -> int:
    if difficulty <= 0:
        raise ValueError("pool difficulty must be positive")
    return max(1, int(DIFF1_TARGET / difficulty))


def merkle_root(coinbase_hash: bytes, branches: list[str]) -> bytes:
    root = coinbase_hash
    for branch in branches:
        root = sha256d(root + bytes.fromhex(branch))
    return root


@dataclass(frozen=True)
class MiningJob:
    job_id: str
    prevhash: str
    coinb1: str
    coinb2: str
    merkle_branch: list[str]
    version: str
    nbits: str
    ntime: str
    clean_jobs: bool

    def header_prefix(self, extranonce1: str, extranonce2: str) -> bytes:
        coinbase = bytes.fromhex(self.coinb1 + extranonce1 + extranonce2 + self.coinb2)
        root = merkle_root(sha256d(coinbase), self.merkle_branch)
        prefix = self.version + self.prevhash + root.hex() + self.ntime + self.nbits
        header = bytes.fromhex(prefix)
        if len(header) != 76:
            raise ValueError(f"pool produced a {len(header)}-byte header prefix, expected 76")
        return header


class BackendError(RuntimeError):
    pass


class Backend:
    name = "backend"

    def search(self, prefix: bytes, target: int, start_nonce: int, stop_after: int) -> Optional[int]:
        raise NotImplementedError


class CpuBackend(Backend):
    name = "cpu"

    def __init__(self, batch_size: int = 250_000):
        self.batch_size = max(1_000, batch_size)

    def search(self, prefix: bytes, target: int, start_nonce: int, stop_after: int) -> Optional[int]:
        end = min(0x1_0000_0000, start_nonce + self.batch_size)
        for nonce in range(start_nonce, end):
            digest = sha256d(prefix + struct.pack("<I", nonce))
            if hash_value(digest) <= target:
                return nonce
        return None


class OptionalGpuBackend(Backend):
    def __init__(self, kind: str):
        self.name = kind
        self.kind = kind

    def search(self, prefix: bytes, target: int, start_nonce: int, stop_after: int) -> Optional[int]:
        package = "PyOpenCL" if self.kind == "opencl" else "CuPy/CUDA"
        raise BackendError(
            f"{self.kind} backend is not enabled in this build. Install {package} "
            "and add the validated native kernel for this GPU before using it for pool mining."
        )


def make_backend(kind: str, batch_size: int) -> Backend:
    if kind == "cpu":
        return CpuBackend(batch_size)
    if kind in {"cuda", "opencl"}:
        return OptionalGpuBackend(kind)
    if kind == "auto":
        # Safe default: never silently start a GPU runtime or consume all VRAM.
        return CpuBackend(batch_size)
    raise ValueError(f"unknown backend: {kind}")


class StratumClient:
    def __init__(self, url: str, user: str, password: str, user_agent: str = "universal-miner/0.1"):
        self.url = url
        self.user = user
        self.password = password
        self.user_agent = user_agent
        self.sock: socket.socket | ssl.SSLSocket | None = None
        self.rx = bytearray()
        self.next_id = 1
        self.extranonce1 = ""
        self.extranonce2_size = 4
        self.difficulty = 1.0
        self.target = difficulty_target(self.difficulty)
        self.job: MiningJob | None = None

    def _parse_url(self) -> tuple[bool, str, int]:
        raw = self.url
        tls = raw.startswith("stratum+ssl://") or raw.startswith("stratum+tls://")
        for prefix in ("stratum+ssl://", "stratum+tls://", "stratum+tcp://", "tcp://", "ssl://"):
            if raw.startswith(prefix):
                raw = raw[len(prefix):]
                break
        if ":" not in raw:
            raise ValueError("pool URL must include a port, e.g. stratum+tcp://pool.example:3333")
        host, port_text = raw.rsplit(":", 1)
        return tls, host, int(port_text)

    def connect(self) -> None:
        tls, host, port = self._parse_url()
        base = socket.create_connection((host, port), timeout=15)
        if tls:
            context = ssl.create_default_context()
            self.sock = context.wrap_socket(base, server_hostname=host)
        else:
            self.sock = base
        self.sock.setblocking(False)
        self.rx.clear()
        self.next_id = 1
        self.job = None
        self._request("mining.subscribe", [self.user_agent, "1.0"])

    def close(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None

    def _send(self, message: dict[str, Any]) -> int:
        if not self.sock:
            raise ConnectionError("not connected")
        wire = (json.dumps(message, separators=(",", ":")) + "\n").encode()
        self.sock.sendall(wire)
        return int(message["id"])

    def _request(self, method: str, params: list[Any]) -> int:
        request_id = self.next_id
        self.next_id += 1
        return self._send({"id": request_id, "method": method, "params": params})

    def poll(self, timeout: float = 0.0) -> list[dict[str, Any]]:
        if not self.sock:
            return []
        ready, _, _ = select.select([self.sock], [], [], timeout)
        if not ready:
            return []
        chunk = self.sock.recv(64 * 1024)
        if not chunk:
            raise ConnectionError("pool closed the connection")
        self.rx.extend(chunk)
        messages: list[dict[str, Any]] = []
        while b"\n" in self.rx:
            line, _, rest = self.rx.partition(b"\n")
            self.rx = bytearray(rest)
            if not line.strip():
                continue
            messages.append(json.loads(line.decode()))
        return messages

    def handle(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        if method == "mining.set_difficulty":
            self.difficulty = float(message["params"][0])
            self.target = difficulty_target(self.difficulty)
            print(f"pool difficulty: {self.difficulty:g}", flush=True)
            return
        if method == "mining.set_extranonce":
            self.extranonce1 = str(message["params"][0])
            self.extranonce2_size = int(message["params"][1])
            return
        if method == "mining.notify":
            p = message["params"]
            if len(p) < 9:
                raise ValueError("malformed mining.notify message")
            self.job = MiningJob(
                job_id=str(p[0]), prevhash=str(p[1]), coinb1=str(p[2]), coinb2=str(p[3]),
                merkle_branch=list(p[4]), version=str(p[5]), nbits=str(p[6]),
                ntime=str(p[7]), clean_jobs=bool(p[8]),
            )
            print(f"new job: {self.job.job_id} (clean={self.job.clean_jobs})", flush=True)
            return
        if "error" in message and message.get("error"):
            print(f"pool error: {message['error']}", file=sys.stderr, flush=True)
            return
        if "result" in message and message.get("id") == 2:
            if message["result"] is not True:
                raise BackendError("pool rejected mining.authorize")
            print("pool authorization accepted", flush=True)
            return
        if "result" in message and message.get("id") is not None:
            result = message["result"]
            if result is True:
                print("share accepted", flush=True)
            elif result is False:
                print("share rejected", file=sys.stderr, flush=True)

    def subscribe_and_authorize(self) -> None:
        deadline = time.monotonic() + 15
        subscribed = False
        authorized = False
        while time.monotonic() < deadline and not authorized:
            for message in self.poll(1.0):
                if message.get("id") == 1:
                    result = message.get("result")
                    if not isinstance(result, list) or len(result) < 3:
                        raise BackendError("pool returned an invalid mining.subscribe response")
                    self.extranonce1 = str(result[1])
                    self.extranonce2_size = int(result[2])
                    self._request("mining.authorize", [self.user, self.password])
                    subscribed = True
                elif message.get("id") == 2:
                    self.handle(message)
                    authorized = True
                else:
                    self.handle(message)
        if not subscribed:
            raise TimeoutError("timed out waiting for mining.subscribe")
        if not authorized:
            raise TimeoutError("timed out waiting for mining.authorize")

    def submit(self, job: MiningJob, extranonce2: str, nonce: int) -> None:
        if not self.sock:
            return
        self._request("mining.submit", [self.user, job.job_id, extranonce2, job.ntime, f"{nonce:08x}"])


def run(args: argparse.Namespace) -> int:
    backend = make_backend(args.backend, args.batch_size)
    print(f"backend: {backend.name}", flush=True)
    client = StratumClient(args.pool, args.user, args.password)
    extranonce_counter = 0
    hashes = 0
    started = time.monotonic()
    try:
        while True:
            try:
                client.connect()
                print(f"connected: {args.pool}", flush=True)
                client.subscribe_and_authorize()
                while True:
                    for message in client.poll(0.0):
                        client.handle(message)
                    if client.job is None:
                        for message in client.poll(1.0):
                            client.handle(message)
                        continue
                    job = client.job
                    extranonce2 = extranonce_counter.to_bytes(client.extranonce2_size, "big").hex()
                    extranonce_counter = (extranonce_counter + 1) % (1 << (8 * client.extranonce2_size))
                    prefix = job.header_prefix(client.extranonce1, extranonce2)
                    nonce = 0
                    while nonce < 0x1_0000_0000:
                        # Small batches let notify/set_difficulty messages interrupt work promptly.
                        found = backend.search(prefix, client.target, nonce, args.batch_size)
                        hashes += min(args.batch_size, 0x1_0000_0000 - nonce)
                        for message in client.poll(0.0):
                            client.handle(message)
                        if found is not None:
                            client.submit(job, extranonce2, found)
                            print(f"share candidate: job={job.job_id} nonce={found:08x}", flush=True)
                            break
                        if client.job is not job:
                            break
                        nonce += args.batch_size
                    elapsed = max(time.monotonic() - started, 0.001)
                    if hashes and int(hashes) % (args.batch_size * 4) < args.batch_size:
                        print(f"hashrate: {hashes / elapsed:,.0f} H/s", flush=True)
            except (ConnectionError, OSError, TimeoutError, BackendError, ValueError) as exc:
                print(f"miner stopped: {exc}", file=sys.stderr, flush=True)
                if not args.reconnect:
                    return 1
                time.sleep(args.reconnect_delay)
            finally:
                client.close()
    except KeyboardInterrupt:
        print("stopped", flush=True)
        return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Universal Bitcoin Stratum V1 miner")
    p.add_argument("--pool", required=True, help="stratum+tcp://host:port or stratum+ssl://host:port")
    p.add_argument("--user", required=True, help="pool username / wallet.worker")
    p.add_argument("--password", default="x", help="pool worker password")
    p.add_argument("--backend", choices=["auto", "cpu", "cuda", "opencl"], default="auto")
    p.add_argument("--batch-size", type=int, default=250_000)
    p.add_argument("--reconnect", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--reconnect-delay", type=float, default=5.0)
    return p


if __name__ == "__main__":
    raise SystemExit(run(build_parser().parse_args()))
