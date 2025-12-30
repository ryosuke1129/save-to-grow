# Save to Grow 🌱 - Web3 Gamified Savings App

**Save to Grow** は、Solanaブロックチェーンを活用したゲーミフィケーション貯金アプリです。
ユーザーは専用の「Box（金庫）」にSOLを預けることで、独自のNFTキャラクター（デジタルツリー）を育てることができます。預入残高に応じてNFTが進化し、時間の経過とともにリワードポイントが蓄積される仕組みを提供します。

*(ここに実際のスクリーンショットを貼ってください)*

## ✨ 主な機能

* **Emailログイン (Magic Link)**: ウォレットを持たないユーザーでも、メールアドレスだけで安全に利用開始可能（Supabase Auth）。
* **Embedded Wallet**: アプリ内でノンカストディアルなSolanaウォレットを自動生成・管理。
* **Box (Vault) 機能**:
* SOLの入金・出金。
* Anchorプログラムによるオンチェーン資産管理。


* **Dynamic NFT (成長するNFT)**:
* Boxの残高に応じてNFTのメタデータ（画像）が自動で進化します。
* **ステージ**: Sprout (0 SOL) → Growing (>0 SOL) → Legendary (≥5 SOL)。
* Metaplex (Umi) を使用したDeterministic Mint（計算によるアドレス生成）を採用。


* **リワードシステム**: 預入期間と金額に応じてオンチェーンでポイントが計算・付与されます。
* **UI/UX**:
* `useCountUp` による数値のアニメーション表示。
* Supabase Realtimeによる履歴の即時反映。



## 🛠 技術スタック

### Frontend

* **Framework**: Next.js 14 (App Router)
* **Language**: TypeScript
* **Styling**: Tailwind CSS
* **State Management**: React Hooks

### Blockchain (Solana)

* **Network**: Solana Devnet
* **Framework**: Anchor (Rust)
* **Client SDK**: `@solana/web3.js`, `@coral-xyz/anchor`
* **NFT Standard**: Metaplex (Umi, MPL Token Metadata)

### Backend / Infrastructure

* **Database & Auth**: Supabase (PostgreSQL, Authentication)
* **Hosting**: Vercel

## 🚀 ローカルでの実行方法

### 前提条件

* Node.js (v18以上推奨)
* npm または yarn
* Supabaseアカウント
* Solana CLI & Anchor (スマートコントラクトを変更する場合)

### 1. リポジトリのクローン

```bash
git clone https://github.com/your-username/save-to-grow.git
cd save-to-grow

```

### 2. 依存関係のインストール

```bash
# プロジェクトルート（またはappディレクトリ）にて
npm install

```

### 3. 環境変数の設定

`.env.local` ファイルを作成し、Supabaseのキーを設定します。

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

```

### 4. Supabaseのセットアップ (SQL)

SupabaseのSQLエディタで以下のクエリを実行し、テーブルを作成してください。

```sql
-- ウォレット管理テーブル
create table user_wallets (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  public_key text not null,
  secret_key text not null, -- 暗号化推奨
  nft_mint text,
  created_at timestamptz default now()
);

-- 入出金履歴テーブル
create table transaction_history (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  type text not null, -- 'Deposit', 'Withdraw', 'Initialize'
  amount numeric,
  gas numeric,
  created_at timestamptz default now()
);

-- 送金履歴テーブル
create table transfer_history (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  destination text not null,
  amount numeric,
  fee numeric,
  created_at timestamptz default now()
);

-- RLS (Row Level Security) の有効化
alter table user_wallets enable row level security;
alter table transaction_history enable row level security;
alter table transfer_history enable row level security;

-- ポリシー設定（開発用: 認証済みユーザーに全権限）
create policy "Allow all for authenticated" on user_wallets for all to authenticated using (true);
create policy "Allow all for authenticated" on transaction_history for all to authenticated using (true);
create policy "Allow all for authenticated" on transfer_history for all to authenticated using (true);

```

### 5. アプリの起動

```bash
npm run dev

```

`http://localhost:3000` にアクセスして確認します。

## 📦 スマートコントラクト (Anchor)

`programs/save_to_grow/src/lib.rs` にロジックが含まれています。

* **Initialize**: ユーザーごとのVault PDAとReward PDAを作成。
* **Deposit/Withdraw**: 資金の移動と同時に、経過時間に応じたリワード計算を実行。
* **Transfer**: アプリ内ウォレットから外部アドレスへの送金。

ビルドとデプロイ（Devnet）:

```bash
anchor build
anchor deploy --provider.cluster devnet

```

## 📂 ディレクトリ構成

```
.
├── app/                  # Next.js Pages & Layouts
├── components/
│   ├── DepositSection.tsx # メインUIロジック（Solana連携含む）
│   └── AppWalletProvider.tsx
├── hooks/
│   └── useCountUp.ts     # 数値アニメーション用フック
├── programs/             # Anchor Smart Contracts (Rust)
├── utils/
│   └── supabaseClient.ts # Supabase初期化
└── ...

```

## 📜 License

ISC License
