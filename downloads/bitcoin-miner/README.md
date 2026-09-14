# Bitcoin CPU Miner (Bitcoin Core RPC)

Bitcoin Core の `getblocktemplate` を使い、明示的に起動したときだけCPUでブロックを探索して `submitblock` します。既定の接続先は regtest です。mainnetの採掘はASICが前提で、一般的なPCでは採算が合いません。

## ハッシュ速度を測る

```powershell
python .\bitcoin_miner.py benchmark --seconds 10
```

## regtestで試す

1. Bitcoin Coreをregtestで起動し、RPCを有効にする。
2. ウォレットの受取アドレスを用意する。
3. 次のように実行する。

```powershell
python .\bitcoin_miner.py mine `
  --rpc-url http://127.0.0.1:18443 `
  --rpc-user <rpc-user> `
  --rpc-password <rpc-password> `
  --address <Bitcoin Coreの受取アドレス> `
  --network regtest `
  --max-blocks 1
```

Bitcoin Coreのcookie認証を使う場合は、ユーザー名・パスワードの代わりに `--cookie-file` を指定できます。`--max-blocks 0` にすると継続実行します。停止は `Ctrl+C` です。

`--address` の代わりに `--script-pubkey <16進数>` を指定することもできます。

## 注意

- CPU採掘は学習・regtest向けです。Bitcoin mainnetでは専用ASICと電力・プール運用が必要です。
- このツールはバックグラウンド常駐、永続化、隠し実行を行いません。
- mainnetで実行するには、誤操作防止のため `--allow-mainnet` が必要です。
- `scriptPubKey` は自分が管理するアドレスのものだけを指定してください。
