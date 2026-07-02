# 番号マスキング通話転送アプリ

## はじめに — デプロイ手順

> **前提条件**: Node.js 18 以上・npm がインストールされていること。

### 1. VCR CLI のインストール

```sh
npm install -g @vonage/vcr
```

インストールを確認します：

```sh
vcr --version
```

---

### 2. VCR の認証設定

```sh
vcr configure
```

プロンプトに従い、Vonage API キーとシークレットを入力します。  
（[Vonage ダッシュボード](https://dashboard.nexmo.com) の「API Settings」で確認できます。）

---

### 3. Vonage アプリケーションと番号の準備

1. [Vonage ダッシュボード](https://dashboard.nexmo.com) でアプリケーションを作成します。
2. **Voice** 機能を有効にします（Answer URL・Event URL は VCR が自動設定するため空白で構いません）。
3. 取得済みの TF 番号（フリーダイヤルなど）をアプリケーションにリンクします。
4. `vcr.yml` の `application-id` を作成したアプリケーション ID に変更します：

```yaml
application-id: YOUR_APPLICATION_ID
```

---

### 4. アプリケーションキーの生成

```sh
vcr app generate-keys --app-id YOUR_APPLICATION_ID
```

このコマンドで `private.key` が生成されます。VCR が Vonage API へのアクセスに使用します。

> **補足**: リージョンは `vcr configure` で設定した値が使用されます。別のリージョンを指定する場合は `--region` フラグを追加してください（例: `--region aws.euw1`）。

---

### 5. シークレットの設定

管理ダッシュボード用の API キーを設定します（任意の文字列で構いません）：

```sh
vcr secret create --name ADMIN_API_KEY --value YOUR_SECRET_KEY
```

---

### 6. 転送先番号とマッピングの設定

**転送先番号**（すべての通話を転送する先）を `vcr.yml` に設定します：

```yaml
- name: DESTINATION_NUMBER
  value: "+819000000000"   # 実際の転送先番号に変更してください
```

**TF番号 → 050番号のマッピング**を `number-mapping.csv` に設定します。  
各行に `TF番号,050番号` の形式で記載します：

```csv
+81120000001,+815011112222
+81120000002,+815033334444
```

> **補足**: CSV は起動時に読み込まれます。ダッシュボードから一時的に変更することもできますが、
> 再起動すると CSV の内容に戻ります。永続的な変更は CSV ファイルを直接編集してください。

---

### 7. デプロイ

```sh
vcr deploy
```

デプロイが完了すると、アプリの URL が表示されます。  
その URL にブラウザからアクセスすると管理ダッシュボードが表示されます。

---

### 8. ダッシュボードへのアクセス

デプロイされた URL をブラウザで開き、手順 5 で設定した `ADMIN_API_KEY` でサインインします。

- **通話履歴タブ**: リアルタイムで通話ログを確認できます。
- **マッピングタブ**: TF番号と050番号のマッピングを確認・一時変更できます。

---

## 免責事項

このサンプルコードは参考目的のみで提供されています。  
動作保証・本番対応・セキュリティ保証はありません。  
実際の運用前に必ず自身で検証・テスト・強化を行ってください。

---

## 概要

Vonage Cloud Runtime (VCR) 上で動作する Node.js/Express サービスです。  
着信番号に基づいて通話を転送し、管理ダッシュボードでリアルタイムに通話状況を確認できます。  
すべての電話番号は下4桁のみ表示（例：`***6361`）し、PII を保護します。

---

## Vonage ダッシュボード設定

1. Vonage ダッシュボードでアプリケーションを作成し、番号をリンクします。
2. `vcr.yml` の `application-id` を作成したアプリケーション ID に変更します。
3. Voice の **Answer URL** と **Event URL** は VCR SDK が自動登録するため、手動設定は不要です。
4. Voice の「**署名付き Webhook を使用**」はダッシュボードの Voice 詳細設定で有効化できます（任意）。

---

## 転送先番号の変更

`number-mapping.csv` を E.164 形式で編集します：

```
+81363283114,+817023696361
```

マッピングが存在しない番号への着信はフォールバックメッセージを再生し、転送しません。

---

## セキュリティ設計

### Webhook 認証

Vonage は Webhook リクエストの `Authorization` ヘッダーに **RS256 署名の JWT** を付与します（`Bearer` プレフィックスなし）。  
アプリはこの JWT をデコードし、`api_application_id` クレームが自アプリの ID と一致することを検証します。  
リクエストは Vonage のインフラ内部からのみ到達するため、RS256 署名の完全検証は不要です。

### 管理 API 認証

`/_/mappings` および `/_/debug/*` エンドポイントは `ADMIN_API_KEY` による認証が必要です：

- `x-admin-api-key: <key>` ヘッダー
- `Authorization: Bearer <key>` ヘッダー
- `?adminKey=<key>` クエリパラメータ（SSE 接続用）

### PII マスキング

すべてのレスポンス・ログ・ダッシュボード表示において、電話番号は下4桁のみ表示されます（例：`***6361`）。

### デバッグエンドポイント

`/_/debug/recent-events` は本番環境では `ENABLE_DEBUG_ROUTES=false`（デフォルト）で無効化されます。  
`/_/debug/live`（SSE）と `/_/debug/live-state` は管理認証のみで常時利用可能です。

---

## VCR シークレット設定

デプロイ前に以下のシークレットを作成してください：

```sh
vcr secret create --name ADMIN_API_KEY --value YOUR_ADMIN_API_KEY
```

`vcr.yml` での参照：

```yaml
environment:
  - name: ADMIN_API_KEY
    secret: ADMIN_API_KEY
  - name: ENABLE_DEBUG_ROUTES
    value: "false"
secrets:
  - ADMIN_API_KEY
```

---

## セキュリティ改善履歴

| 項目 | 内容 |
|------|------|
| Webhook 認証 | VCR プラットフォームが発行する RS256 JWT の `api_application_id` クレーム検証 |
| 管理 API 保護 | `ADMIN_API_KEY` による全管理エンドポイントの認証 |
| PII マスキング | 全出力で電話番号を下4桁のみ表示 |
| シークレット管理 | VCR ネイティブシークレットを使用（コードへの平文記載なし） |
| デバッグ制御 | `ENABLE_DEBUG_ROUTES` フラグによる本番での無効化 |
| SSE バッファリング対策 | `X-Accel-Buffering: no` ヘッダーで nginx プロキシ経由の SSE を有効化 |
| プロキシ対応 | `trust proxy: true` で VCR の nginx 経由でも正しく HTTPS 検出 |
| NCCO eventUrl 形式 | `eventUrl` を配列形式で指定（Vonage 仕様準拠） |

---

## デプロイ

```sh
vcr deploy
```

詳細は [VCR デプロイガイド](https://developer.vonage.com/vcr/guides/deploying) を参照してください。

---

## ライセンス

このプロジェクトは MIT ライセンスのもとで提供されています。詳細は LICENSE ファイルを参照してください。
