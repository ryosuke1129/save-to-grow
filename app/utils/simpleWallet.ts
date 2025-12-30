import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const STORAGE_KEY = "save_to_grow_wallet_sk";

// ウォレットの取得（なければnull）
export const getLocalWallet = (): Keypair | null => {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;

  try {
    // 文字列から秘密鍵を復元
    const secretKey = bs58.decode(stored);
    return Keypair.fromSecretKey(secretKey);
  } catch (e) {
    console.error("Failed to load wallet", e);
    return null;
  }
};

// 新しいウォレットを作成して保存
export const createLocalWallet = (): Keypair => {
  const keypair = Keypair.generate();
  // 秘密鍵をBase58文字列にして保存
  const secretKeyStr = bs58.encode(keypair.secretKey);
  localStorage.setItem(STORAGE_KEY, secretKeyStr);
  return keypair;
};

// ウォレットを削除（ログアウト的な挙動）
export const clearLocalWallet = () => {
  localStorage.removeItem(STORAGE_KEY);
};