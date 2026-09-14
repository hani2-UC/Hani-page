# Universal Bitcoin Miner — first release

汎用化したBitcoinプール採掘ソフトの初版です。プール接続とジョブ処理をハードウェアから分離し、CPU／CUDA／OpenCL／ASIC用バックエンドを追加できる構成にしています。

## 概要

このプログラムはBitcoinプールのStratum V1プロトコルに接続し、プールから受け取ったジョブを処理してshareを送信します。ネットワーク接続、TLS、ジョブ更新、difficulty更新、coinbase構築、merkle root計算、再接続などの処理と、nonceを探索するバックエンドを分離しています。

現在の初版で実装済みなのはCPUバックエンドです。`--backend auto` も安全のためCPUを選びます。CUDA／OpenCLは機種ごとのカーネル検証が必要で、未検証のコードを本番採掘として実行しないよう、現時点では明示的なセットアップエラーを返します。

## 現在の状態

- 実装済み：Stratum V1接続、TLS、subscribe／authorize、difficulty更新、job更新、coinbase構築、merkle root、share送信、再接続、CPUバックエンド
- 拡張ポイント：`Backend.search()` に準拠したCUDA／OpenCL／ASICバックエンド
- GPUについて：対象GPU、ドライバ、CUDA／OpenCLランタイムごとにハッシュ結果とshare送信を検証してから有効化してください

## 必要なもの

- Python 3.10以降
- Stratum V1に対応した採掘プールのアカウント
- プールが指定するURL、ポート、ユーザー名またはウォレット形式、worker名

外部パッケージはCPUバックエンドには必要ありません。TLS接続にはPython標準ライブラリの証明書検証を使用します。

## プール接続例

```powershell
python .\universal_miner.py `
  --pool stratum+ssl://pool.example:443 `
  --user wallet-address.worker1 `
  --password x `
  --backend cpu
```

TLSを使わないプールでは `stratum+tcp://host:port` を指定します。プールのURL、ウォレット形式、worker名、TLSポートは利用するプールの案内に合わせてください。

`--backend auto` はCPUを使います。GPUバックエンドを選ぶと、検証済みネイティブ実装がまだ含まれていないことを示すエラーで停止します。

## オプション

| オプション | 既定値 | 説明 |
|---|---:|---|
| `--pool` | なし | `stratum+tcp://` または `stratum+ssl://` のプールURL。ポート必須 |
| `--user` | なし | プールのユーザー名、または `wallet.worker` 形式 |
| `--password` | `x` | workerパスワード。プールの指定に合わせる |
| `--backend` | `auto` | `auto`、`cpu`、`cuda`、`opencl` |
| `--batch-size` | `250000` | 1回に探索するnonce数。小さくするとジョブ更新への応答が細かくなる |
| `--reconnect` | 有効 | 切断時に再接続する。`--no-reconnect` で無効化 |
| `--reconnect-delay` | `5.0` | 再接続までの秒数 |

## 動作の流れ

1. 指定されたプールへTCPまたはTLSで接続します。
2. `mining.subscribe` と `mining.authorize` を送信します。
3. プールのdifficulty、extranonce、job通知を受け取ります。
4. coinbaseとmerkle rootから80バイトのブロックヘッダーを組み立てます。
5. 選択したバックエンドでnonceを探索します。
6. 候補が見つかったら `mining.submit` でshareを送信します。
7. 切断・タイムアウト時は、既定では5秒待って再接続します。

## 安全上の注意

- 自分が管理するウォレットと、利用規約で採掘が許可されたプールだけを使ってください。
- パスワードやウォレット情報を設定ファイルへ保存せず、必要に応じて環境変数や安全な秘密管理を利用してください。
- TLS接続では証明書検証を無効化していません。証明書エラーを無視する設定は追加しないでください。
- このプログラムは隠し実行、自動起動、常駐化を行いません。
- Bitcoin mainnetのCPU採掘は、専用ASICより大幅に不利です。電力コストとプール手数料も考慮してください。
- GPUバックエンドを有効にする場合は、対象GPU、ドライバ、CUDA／OpenCLランタイムごとにハッシュ結果とshare送信を検証してください。

## 既知の制限

- 初版の実装はStratum V1のみです。Stratum V2やプール固有の拡張には対応していません。
- CPUバックエンドはPython実装のため、性能は学習・検証向けです。
- `cuda` と `opencl` は選択できますが、検証済みのGPUカーネルは同梱していません。
- プールごとに認証形式、worker名、TLS要件が異なるため、接続前にプールの公式ドキュメントを確認してください。
