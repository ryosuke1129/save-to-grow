"use client";

import React, { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
// デフォルトのスタイルを読み込み
import "@solana/wallet-adapter-react-ui/styles.css";

export default function AppWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // 接続先ネットワーク（開発中は 'devnet' またはローカル）
  // 今回は一旦Devnet（テストネット）に設定しておきます
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);

  const wallets = useMemo(
    () => [
      // ここに特定のウォレットを追加できますが、
      // 最近はStandard規格で自動検出されるため空でも多くのウォレットが動きます
    ],
    [network]
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}