"use client";

import { useState, useEffect, useMemo } from "react";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import idl from "../app/idl.json";
import { supabase } from "../utils/supabaseClient"; 
import { useCountUp } from '../hooks/useCountUp';

// --- Metaplex (NFT) 関連のインポート ---
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, signerIdentity, generateSigner, percentAmount } from "@metaplex-foundation/umi";
import { createNft, updateV1, fetchMetadataFromSeeds, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { fromWeb3JsKeypair, fromWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { sha256 } from 'js-sha256';

// --- SolanaネットワークとプログラムIDの設定 ---
const NETWORK_URL = process.env.NEXT_PUBLIC_SOLANA_NETWORK!;
const PROGRAM_ID_STRING = process.env.NEXT_PUBLIC_PROGRAM_ID!;

if (!NETWORK_URL || !PROGRAM_ID_STRING) {
  throw new Error("Solana Network URL or Program ID is missing.");
}

const PROGRAM_ID = new PublicKey(PROGRAM_ID_STRING);
const connection = new Connection(NETWORK_URL, "confirmed");

// ★ NFTのメタデータURI設定 (実運用時はIPFS等のJSON URLに置き換えてください)
// 各JSONには "image": "GIF画像のURL" が記述されている必要があります
const METADATA_URIS = {
  default: "https://coffee-patient-mackerel-446.mypinata.cloud/ipfs/bafkreih33uv4usrp266elvpnkalj5eqte2s34ufdffxtgba3x2ybmfjd5y",   // 種 (0 SOL)
  growing: "https://coffee-patient-mackerel-446.mypinata.cloud/ipfs/bafkreiequjkraokootfvtevagfam35b5eittmhrbdszk75lcwn7rykcgmq",  // 成長中 (> 0 SOL)
  legendary: "https://coffee-patient-mackerel-446.mypinata.cloud/ipfs/bafkreihk67v2decygyuevd2l2uk2b24yxkxyno54wgzc7wasp72yuikjxy" // レジェンド (>= 5 SOL)
};

const getDeterministicMintKeypair = (userPubkey: PublicKey): Keypair => {
  // "box-nft-seed" という文字列とユーザーのアドレスを混ぜてハッシュ化
  const seed = sha256.digest("box-nft-seed" + userPubkey.toString());
  // そのハッシュ値（32byte）を元にKeypairを復元
  return Keypair.fromSeed(new Uint8Array(seed));
};

// --- ユーティリティ ---
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function retryRPC<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0 && JSON.stringify(error).includes("429")) {
      console.warn(`RPC Limit hit (429), retrying in ${delay}ms...`);
      await sleep(delay);
      return retryRPC(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

// --- 型定義 ---
type TxType = "Deposit" | "Withdraw" | "Initialize"; 

interface VaultRecord {
  id: string;
  type: TxType;
  amount: number;
  gas: number;
  date: string; 
}

interface TransferRecord {
  id: string;
  destination: string;
  amount: number;
  fee: number;
  date: string;
}

class SimpleWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
  async signTransaction(tx: Transaction) { tx.partialSign(this.payer); return tx; }
  async signAllTransactions(txs: Transaction[]) { return txs.map((t) => { t.partialSign(this.payer); return t; }); }
}

export default function DepositSection() {
  const [mounted, setMounted] = useState(false); 
  const [activeTab, setActiveTab] = useState<'box' | 'transfer' | 'nft'>('box');

  const [email, setEmail] = useState("");
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(false);

  const [myWallet, setMyWallet] = useState<Keypair | null>(null);
  const [nftMintAddress, setNftMintAddress] = useState<string | null>(null); // ★ NFTのアドレス管理

  const [balance, setBalance] = useState<string>("0");
  const [rewardBalance, setRewardBalance] = useState<string>("0");
  const [walletBalance, setWalletBalance] = useState<number>(0);
  
  const [loading, setLoading] = useState(false); 
  const [actionLoading, setActionLoading] = useState(false); 
  
  const [isInitialized, setIsInitialized] = useState(false);
  
  const [amountInput, setAmountInput] = useState<string>("");
  const [transferAmountInput, setTransferAmountInput] = useState<string>("");
  const [recipientAddress, setRecipientAddress] = useState<string>("");
  const [isCopied, setIsCopied] = useState(false);

  const [vaultHistory, setVaultHistory] = useState<VaultRecord[]>([]);
  const [transferHistory, setTransferHistory] = useState<TransferRecord[]>([]);

  // --- Effects ---
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) {
          checkWalletExistence(session.user.id);
          fetchVaultHistory(session.user.id);
          fetchTransferHistory(session.user.id);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        checkWalletExistence(session.user.id);
        fetchVaultHistory(session.user.id);
        fetchTransferHistory(session.user.id);
      } else {
        setMyWallet(null);
        setNftMintAddress(null);
        setWalletBalance(0);
        setBalance("0");
        setRewardBalance("0");
        setVaultHistory([]);
        setTransferHistory([]);
        setIsInitialized(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    const channelVault = supabase
      .channel('vault_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transaction_history', filter: `user_id=eq.${session.user.id}` }, () => fetchVaultHistory(session.user.id))
      .subscribe();
      
    const channelTransfer = supabase
      .channel('transfer_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transfer_history', filter: `user_id=eq.${session.user.id}` }, () => fetchTransferHistory(session.user.id))
      .subscribe();

    return () => { 
        supabase.removeChannel(channelVault); 
        supabase.removeChannel(channelTransfer);
    };
  }, [session]);

  useEffect(() => {
    if (myWallet) {
      fetchWalletBalance();
      setTimeout(() => fetchVault(), 500);
    }
  }, [myWallet]);

  // --- Logic Functions ---
  const fetchVaultHistory = async (userId: string) => {
      const { data } = await supabase.from('transaction_history').select('*').eq('user_id', userId).order('created_at', { ascending: false });
      if (data) {
          const formatted: VaultRecord[] = data.map((item: any) => ({
              id: item.id,
              type: item.type as TxType,
              amount: Number(item.amount),
              gas: Number(item.gas),
              date: new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }));
          setVaultHistory(formatted);
      }
  };

  const fetchTransferHistory = async (userId: string) => {
      const { data } = await supabase.from('transfer_history').select('*').eq('user_id', userId).order('created_at', { ascending: false });
      if (data) {
          const formatted: TransferRecord[] = data.map((item: any) => ({
              id: item.id,
              destination: item.destination,
              amount: Number(item.amount),
              fee: Number(item.fee),
              date: new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }));
          setTransferHistory(formatted);
      }
  };

  const addVaultHistory = async (type: TxType, amount: number, gas: number) => {
      if (!session) return;
      await supabase.from('transaction_history').insert([{ user_id: session.user.id, type, amount, gas }]);
      fetchVaultHistory(session.user.id);
  };

  const addTransferHistory = async (destination: string, amount: number, fee: number) => {
    if (!session) return;

    // 修正: 分割代入で error を受け取る
    const { error } = await supabase
        .from('transfer_history')
        .insert([{ 
            user_id: session.user.id, 
            destination, 
            amount, 
            fee 
        }]);

    // エラーがあればログに出してアラートを表示
    if (error) {
        console.error("履歴保存エラー:", error);
        alert(`履歴の保存に失敗しました: ${error.message}`);
        return;
    }

    fetchTransferHistory(session.user.id);
};

  const checkWalletExistence = async (userId: string) => {
    setLoading(true);
    try {
      const { data } = await supabase.from('user_wallets').select('*').eq('user_id', userId).single();
      if (data) {
        const secretKeyArray = JSON.parse(data.secret_key);
        const kp = Keypair.fromSecretKey(new Uint8Array(secretKeyArray));
        setMyWallet(kp);
        
        // 【変更】DBの値に関係なく、計算でNFTアドレスを復元してセット
        const mintKeypair = getDeterministicMintKeypair(kp.publicKey);
        setNftMintAddress(mintKeypair.publicKey.toString());
        
      } else { 
        setMyWallet(null);
        setNftMintAddress(null);
      }
    } catch (error) { setMyWallet(null); } finally { setLoading(false); }
  };

  const createNewWallet = async () => {
    if (!session) return;
    setLoading(true); 
    try {
        const newKeypair = Keypair.generate();
        const secretKeyString = JSON.stringify(Array.from(newKeypair.secretKey));
        const { error: insertError } = await supabase.from('user_wallets').insert([{ user_id: session.user.id, public_key: newKeypair.publicKey.toString(), secret_key: secretKeyString }]);
        if (insertError) throw insertError;
        setMyWallet(newKeypair);
        alert("新しいウォレットを作成しました！");
    } catch (error) { console.error(error); alert("ウォレットの作成に失敗しました"); } finally { setLoading(false); }
  };

  const deleteWallet = async () => {
    if (!session || !myWallet) return;
    if (!confirm("【警告】本当に削除しますか？")) { return; }
    setLoading(true);
    try {
        const userId = session.user.id;

        // 1. 履歴データの削除 (外部キー制約回避のため先に削除推奨)
        const { error: txError } = await supabase.from('transaction_history').delete().eq('user_id', userId);
        if (txError) throw new Error(`履歴削除エラー(Tx): ${txError.message}`);

        const { error: trError } = await supabase.from('transfer_history').delete().eq('user_id', userId);
        if (trError) throw new Error(`履歴削除エラー(Transfer): ${trError.message}`);

        // 2. ウォレットの削除
        const { error: walletError, count } = await supabase
            .from('user_wallets')
            .delete({ count: 'exact' }) // 削除件数を取得
            .eq('user_id', userId);

        if (walletError) throw new Error(`ウォレット削除エラー: ${walletError.message}`);
        
        // 念のため削除件数を確認（RLS設定ミスだとエラーなしで0件になることがあるため）
        if (count === 0) {
            console.warn("削除対象が見つかりませんでした (RLSポリシーを確認してください)");
        }

        // 3. ローカルステートの初期化
        setMyWallet(null); 
        setNftMintAddress(null);
        setWalletBalance(0); 
        setBalance("0"); 
        setRewardBalance("0");
        setVaultHistory([]); 
        setTransferHistory([]); 
        setIsInitialized(false);
        
        alert("ウォレットを削除しました。");
    } catch (e: any) { 
        console.error("Delete failed:", e); 
        alert(`削除に失敗しました: ${e.message}`); 
    } finally { 
        setLoading(false); 
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}`, }, });
    if (error) { alert(error.message); } else { alert("ログインリンクを送信しました！メールを確認してください"); }
    setAuthLoading(false);
  };

  const handleLogout = async () => { await supabase.auth.signOut(); };

  // --- Solana Helpers ---
  const getProvider = () => {
    if (!myWallet) return null;
    const walletWrapper = new SimpleWallet(myWallet);
    return new AnchorProvider(connection, walletWrapper as any, { commitment: "confirmed" });
  };
  const getVaultPda = () => {
    if (!myWallet) return null;
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), myWallet.publicKey.toBuffer()], PROGRAM_ID);
    return pda;
  };
  const getRewardPda = () => {
    if (!myWallet) return null;
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("reward"), myWallet.publicKey.toBuffer()], PROGRAM_ID);
    return pda;
  };

  const fetchVault = async () => {
    const provider = getProvider(); const vaultPda = getVaultPda(); const rewardPda = getRewardPda();
    if (!provider || !vaultPda || !rewardPda) return;
    try {
      const program = new Program(idl as any, provider) as any;
      const vaultAccount = (await retryRPC(() => program.account.vault.fetch(vaultPda))) as any;
      setBalance(vaultAccount.balance.toString());
      try {
        const rewardAccount = (await retryRPC(() => program.account.rewardBox.fetch(rewardPda))) as any;
        setRewardBalance(rewardAccount.balance.toString());
      } catch (e) { setRewardBalance("0"); }
      setIsInitialized(true);
    } catch (e) { setBalance("0"); setRewardBalance("0"); setIsInitialized(false); }
  };

  const fetchWalletBalance = async () => {
    if (!myWallet) return;
    try {
      const bal = await retryRPC(() => connection.getBalance(myWallet.publicKey));
      setWalletBalance(bal / LAMPORTS_PER_SOL);
    } catch (e) { console.error(e); }
  };

  // --- ★ Dynamic NFT Logic (Metaplex) ---
  
  // Umiインスタンスの作成
  const createUmiInstance = (wallet: Keypair) => {
    const umi = createUmi(NETWORK_URL)
      .use(mplTokenMetadata());
    
    // Web3.jsのKeypairをUmiのSignerに変換して登録
    const signer = createSignerFromKeypair(umi, fromWeb3JsKeypair(wallet));
    umi.use(signerIdentity(signer));
    
    return umi;
  };

  // NFT発行 (初期化時)
  const mintGrowNft = async (wallet: Keypair) => {
  const umi = createUmiInstance(wallet);
  
  // 計算でアドレスを特定
  const mintWeb3Keypair = getDeterministicMintKeypair(wallet.publicKey);
  const mint = createSignerFromKeypair(umi, fromWeb3JsKeypair(mintWeb3Keypair));

  // ★ 1. 既に存在するかチェック (重要: これがないと「Already exists」エラーになります)
  const account = await umi.rpc.getAccount(mint.publicKey);
  if (account.exists) {
      console.log("NFT already minted. Skipping.");
      return mint.publicKey.toString();
  }

  console.log("Minting NFT...", mint.publicKey.toString());

  // ★ 2. skipPreflight: true を追加
  // これにより「Simulation failed」エラーを無視して強制実行します
  await createNft(umi, {
    mint,
    name: "Grow Box NFT",
    symbol: "GROW",
    uri: METADATA_URIS.default,
    sellerFeeBasisPoints: percentAmount(0),
  }).sendAndConfirm(umi, { 
      send: { skipPreflight: true } // ← ここが魔法の解決策
  });

  return mint.publicKey.toString();
};

  // NFT更新 (入出金時)
  const updateNftMetadata = async (wallet: Keypair, mintAddr: string, currentBal: number) => {
    const umi = createUmiInstance(wallet);
    const mintPublicKey = fromWeb3JsPublicKey(new PublicKey(mintAddr));

    // 残高に基づいてURIを決定
    let targetUri = METADATA_URIS.default;
    if (currentBal >= 5) targetUri = METADATA_URIS.legendary;
    else if (currentBal > 0) targetUri = METADATA_URIS.growing;

    console.log("Checking NFT Update...", targetUri);

    try {
        // ★ここを try...catch で囲むのがポイント！
        // メタデータを取得しようとする
        const initialMetadata = await fetchMetadataFromSeeds(umi, { mint: mintPublicKey });

        // メタデータが見つかった場合のみ、更新が必要かチェック
        if (initialMetadata.uri !== targetUri) {
            console.log("Updating NFT Metadata to:", targetUri);
            await updateV1(umi, {
                mint: mintPublicKey,
                data: { ...initialMetadata, uri: targetUri },
            }).sendAndConfirm(umi, { send: { skipPreflight: true } }); // ここにも skipPreflight を念のため
        }
    } catch (e: any) {
        // ★メタデータが見つからない場合（AccountNotFoundError）はここでキャッチ
        console.warn("NFTのメタデータが見つかりませんでした。更新をスキップします。", e.message);
        // エラーを握りつぶすので、画面には赤いエラーが出なくなります
    }
  };


  // --- Actions ---
  
  const initializeVault = async () => {
    if (!myWallet || !session) return;
    const provider = getProvider(); const vaultPda = getVaultPda(); const rewardPda = getRewardPda();
    if (!provider || !vaultPda || !rewardPda) return;
    try {
      setActionLoading(true);
      const preBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey));
      const program = new Program(idl as any, provider) as any;
      
      // 1. Vault初期化
      await program.methods.initialize().accounts({ vault: vaultPda, rewardBox: rewardPda, user: myWallet.publicKey, systemProgram: SystemProgram.programId }).signers([myWallet]).rpc();
      
      // 2. ★ NFT発行 (Mint)
      const mintAddress = await mintGrowNft(myWallet);
      
      // 3. DBにMintアドレス保存
      // await supabase.from('user_wallets').update({ nft_mint: mintAddress }).eq('user_id', session.user.id);
      setNftMintAddress(mintAddress);

      // 履歴保存 & 更新
      const postBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey));
      const gas = (preBalance - postBalance) / LAMPORTS_PER_SOL;
      await addVaultHistory("Initialize", 0, gas); 
      await fetchVault(); await fetchWalletBalance();
      
      setActiveTab('nft');
    } catch (e) { console.error(e); alert("初期化またはNFT発行エラー"); } finally { setActionLoading(false); }
  };

  const deposit = async () => {
    if (!myWallet) return;
    const provider = getProvider(); const vaultPda = getVaultPda(); const rewardPda = getRewardPda();
    if (!provider || !vaultPda || !rewardPda) return;
    const val = parseFloat(amountInput);
    if (isNaN(val) || val <= 0) { alert("有効な金額を入力してください"); return; }
    try {
      setActionLoading(true);
      const preBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey));
      const program = new Program(idl as any, provider) as any;
      const amount = new BN(Math.floor(val * LAMPORTS_PER_SOL)); 
      
      // 1. 入金
      await program.methods.deposit(amount).accounts({ vault: vaultPda, rewardBox: rewardPda, user: myWallet.publicKey, systemProgram: SystemProgram.programId }).signers([myWallet]).rpc({ skipPreflight: true });
      
      const postBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey));
      const diff = preBalance - postBalance;
      const inputLamports = Math.floor(val * LAMPORTS_PER_SOL);
      const gas = (diff - inputLamports) / LAMPORTS_PER_SOL;
      await addVaultHistory("Deposit", val, gas); 
      await fetchVault(); await fetchWalletBalance();
      setAmountInput("");

      // 2. ★ NFT更新 (新残高に基づいて)
      // fetchVaultが完了してbalanceステートが更新されるのを待つか、計算値を使う
      // ここでは簡易的に 現在のbalance + 入金額 で判定
      // 注意: balanceは文字列のLamports
      const currentVaultSol = (Number(balance) + inputLamports) / LAMPORTS_PER_SOL;
      if (nftMintAddress) {
          updateNftMetadata(myWallet, nftMintAddress, currentVaultSol);
      }

    } catch (e: any) { console.error(e); alert("入金エラー"); } finally { setActionLoading(false); }
  };

  const withdraw = async () => {
    if (!myWallet) return;
    const provider = getProvider(); const vaultPda = getVaultPda(); const rewardPda = getRewardPda();
    if (!provider || !vaultPda || !rewardPda) return;
    const val = parseFloat(amountInput);
    if (isNaN(val) || val <= 0) { alert("有効な金額を入力してください"); return; }
    try {
      setActionLoading(true);
      const preBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey));
      const program = new Program(idl as any, provider) as any;
      const amount = new BN(Math.floor(val * LAMPORTS_PER_SOL));
      
      // 1. 出金
      await program.methods.withdraw(amount).accounts({ vault: vaultPda, rewardBox: rewardPda, user: myWallet.publicKey, systemProgram: SystemProgram.programId }).signers([myWallet]).rpc({ skipPreflight: true });
      
      const postBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey));
      const actualReceived = postBalance - preBalance;
      const expectedReceived = Math.floor(val * LAMPORTS_PER_SOL);
      const gas = (expectedReceived - actualReceived) / LAMPORTS_PER_SOL;
      await addVaultHistory("Withdraw", val, gas); 
      await fetchVault(); await fetchWalletBalance();
      setAmountInput("");

      // 2. ★ NFT更新
      const currentVaultSol = (Number(balance) - expectedReceived) / LAMPORTS_PER_SOL;
      if (nftMintAddress) {
          updateNftMetadata(myWallet, nftMintAddress, currentVaultSol > 0 ? currentVaultSol : 0);
      }

    } catch (e: any) { console.error(e); alert("出金エラー"); } finally { setActionLoading(false); }
  };

  const transfer = async () => {
    if (!myWallet) return;
    const val = parseFloat(transferAmountInput);
    if (isNaN(val) || val <= 0) { alert("有効な金額を入力してください"); return; }
    const estimatedFee = 0.000005; 
    if (walletBalance < val + estimatedFee) { alert(`残高不足です。`); return; }
    let recipientPubkey;
    try { recipientPubkey = new PublicKey(recipientAddress); } catch(e) { alert("無効なアドレスです"); return; }
    
    try {
      setActionLoading(true);
      const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: myWallet.publicKey, toPubkey: recipientPubkey, lamports: Math.floor(val * LAMPORTS_PER_SOL), }));
      const signature = await connection.sendTransaction(transaction, [myWallet]);
      await connection.confirmTransaction(signature, "confirmed");
      alert(`送金完了: ${val} SOL`);
      await addTransferHistory(recipientAddress, val, estimatedFee);
      setRecipientAddress("");
      setTransferAmountInput("");
      await fetchWalletBalance();
    } catch (e: any) { 
        console.error(e);
        const msg = e.message || JSON.stringify(e);
        if (msg.includes("insufficient funds")) { alert("エラー: 手数料を支払うための残高が足りません。"); } 
        else { alert(`送金エラー: ${msg}`); }
    } finally { setActionLoading(false); }
  };

  const copyAddress = async () => {
    if (!myWallet) return;
    const address = myWallet.publicKey.toString();
    let success = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try { 
            await navigator.clipboard.writeText(address); 
            success = true;
        } catch (err) {}
    } else {
        const textArea = document.createElement("textarea");
        textArea.value = address;
        textArea.style.position = "fixed"; textArea.style.left = "0"; textArea.style.top = "0"; textArea.style.opacity = "0"; textArea.style.pointerEvents = "none"; 
        document.body.appendChild(textArea);
        textArea.focus(); textArea.select();
        try { document.execCommand('copy'); success = true; } catch (e) {} finally { document.body.removeChild(textArea); }
    }

    if (success) {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 1000);
    } else {
        alert("コピーに失敗しました。");
    }
  };

  // const handleResetRewards = async () => { 
  //     setActionLoading(true); 
  //     await fetchVault(); 
  //     setActionLoading(false); 
  // };

  const solVaultBalance = useMemo(() => Number(balance) / LAMPORTS_PER_SOL, [balance]);
  const rewardPoints = useMemo(() => Number(rewardBalance) / LAMPORTS_PER_SOL, [rewardBalance]);

  const animatedWalletBalance = useCountUp(walletBalance, 800); // 0.8秒かけて変化
  const animatedVaultBalance = useCountUp(solVaultBalance, 800);
  const animatedReward = useCountUp(rewardPoints, 800);
  
  // GIF表示ロジック (アプリ内の表示用)
  const gifData = useMemo(() => {
    if (solVaultBalance >= 5) return { src: "/images/gif-reward.gif", alt: "Reward Max", label: "Legendary Tree" };
    if (solVaultBalance > 0) return { src: "/images/gif-deposited.gif", alt: "Growing", label: "Growing Tree" };
    return { src: "/images/gif-default.gif", alt: "Waiting", label: "Sprout" };
  }, [solVaultBalance]);

  const shortAddress = useMemo(() => {
      if (!myWallet) return "";
      const addr = myWallet.publicKey.toString();
      return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
  }, [myWallet]);

  if (!mounted) return null;

  if (!session) {
    return (
      <div className="w-full max-w-md mx-auto bg-white p-8 mt-20 border-2 border-black font-sans text-center">
        <h1 className="text-3xl font-black mb-2 text-black">Web3 Wallet</h1>
        <p className="text-sm text-gray-500 mb-8 font-bold">まずはウォレットにログインしましょう</p>
        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          <input type="email" placeholder="メールアドレスを入力" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full h-12 px-4 border-2 border-black focus:outline-none font-bold" required />
          <button type="submit" disabled={authLoading} className="w-full h-12 bg-black text-white font-extrabold hover:bg-gray-800 transition-colors disabled:opacity-50"> {authLoading ? "リンクを送信中..." : "ログインリンクを送信する"} </button>
        </form>
      </div>
    );
  }

  if (loading) {
     return <div className="w-full h-screen flex flex-col items-center justify-center bg-white font-sans"><h1 className="text-2xl font-black text-black mb-4 animate-pulse">Loading Wallet...</h1></div>;
  }

  if (!myWallet) {
    return (
        <div className="w-full max-w-5xl mx-auto bg-white p-6 md:p-12 animate-fade-in font-sans min-h-[600px] flex flex-col justify-center relative">
            <div className="absolute top-4 right-4 md:top-8 md:right-8"><div className="text-right"><p className="text-[10px] text-gray-400 font-bold mb-1">{session.user.email}</p><button onClick={handleLogout} className="text-xs font-bold text-gray-400 hover:text-red-500 transition-colors underline">Logout</button></div></div>
            <div className="flex flex-col items-center w-full max-w-md mx-auto my-8">
                <div className="mb-8"><span className="text-6xl text-gray-300 font-light">+</span></div>
                <h2 className="text-2xl font-black text-black mb-4">Welcome to Web3 Wallet</h2>
                <p className="text-base font-bold mb-12 leading-relaxed text-gray-500 text-center">まだウォレットがありません。<br/>アプリ専用のウォレットを作成して<br/>資産形成を始めましょう</p>
                <button onClick={createNewWallet} className="w-full h-14 bg-black text-white text-lg font-extrabold hover:bg-gray-800 transition-colors duration-200">ウォレットを新規作成</button>
            </div>
        </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto bg-white p-6 md:p-12 animate-fade-in font-sans min-h-[600px] flex flex-col relative">
      <div className="absolute top-4 right-4 md:top-8 md:right-8">
        <div className="text-right"><p className="text-[10px] text-gray-400 font-bold mb-1">{session.user.email}</p><button onClick={handleLogout} className="text-xs font-bold text-gray-400 hover:text-red-500 transition-colors underline">Logout</button></div>
      </div>

      <div className="mb-6 text-left"><h1 className="text-4xl font-black tracking-tight text-black mb-2">Web3 Wallet</h1></div>

      <div className="w-full bg-white border-2 border-black p-5 mb-8 max-w-3xl mx-auto">
        <div className="flex justify-between items-end mb-2"><p className="text-xs font-black font-bold uppercase">WALLET残高</p><div className="text-right"><p className="text-2xl font-mono font-bold text-black">{animatedWalletBalance.toFixed(6)} <span className="text-sm text-gray-400">SOL</span></p></div></div>
        <button onClick={copyAddress} className={`w-full text-left border border-black py-2 px-3 font-mono text-xs text-gray-500 flex justify-between items-center group transition-colors duration-200 ${isCopied ? 'bg-[#EEFF77]' : 'bg-white hover:bg-gray-50'}`}>
            <span>{shortAddress}</span><span className={`text-black font-bold ${isCopied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>{isCopied ? 'COPIED!' : 'COPY'}</span>
        </button>
      </div>

      <div className="flex w-full max-w-3xl mx-auto mb-8 border-b-2 border-gray-100 gap-2 md:gap-8">
        <button onClick={() => setActiveTab('box')} className={`flex-1 pb-2 text-center text-lg font-black transition-colors ${activeTab === 'box' ? 'border-b-4 border-black text-black' : 'text-gray-300 hover:text-gray-500'}`}>Box</button>
        <button onClick={() => setActiveTab('nft')} className={`flex-1 pb-2 text-center text-lg font-black transition-colors ${activeTab === 'nft' ? 'border-b-4 border-black text-black' : 'text-gray-300 hover:text-gray-500'}`}>NFT</button>
        <button onClick={() => setActiveTab('transfer')} className={`flex-1 pb-2 text-center text-lg font-black transition-colors ${activeTab === 'transfer' ? 'border-b-4 border-black text-black' : 'text-gray-300 hover:text-gray-500'}`}>送金</button>
      </div>

      <div className="w-full max-w-3xl mx-auto">
        
        {/* === Tab 1: Box (入出金のみ) === */}
        {activeTab === 'box' && (
            <div className="flex flex-col gap-6">
                {!isInitialized ? (
                     <div className="flex flex-col items-center justify-center h-full border-2 border-dashed border-gray-300 p-6 rounded min-h-[300px]">
                        <p className="text-gray-400 font-bold mb-4">Grow Boxが未開設です</p>
                        <button onClick={initializeVault} disabled={actionLoading || walletBalance < 0.01} className="w-full max-w-xs h-14 bg-black text-white text-lg font-extrabold hover:bg-gray-800 transition-colors duration-200 disabled:opacity-30"> {walletBalance < 0.01 ? "残高不足 (要SOL)" : "Boxを開設する"} </button>
                        <p className="text-xs text-gray-400 mt-2">※開設と同時にNFTが発行されます</p>
                     </div>
                ) : (
                    <>
                        <div className="text-center w-full bg-white border-2 border-black p-6">
                            <p className="text-xs font-black font-bold uppercase tracking-[0.1em] mb-3">Grow Box残高</p>
                            <div className="flex items-baseline justify-center"><span className="text-6xl font-black tracking-tighter text-black leading-none font-mono">{animatedVaultBalance.toFixed(2)}</span><span className="text-2xl font-bold ml-2 text-gray-500">SOL</span></div>
                        </div>
                        <div className="flex flex-col gap-2">
                            <div className="relative w-full mb-2">
                                <input type="number" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} className="w-full h-14 pl-4 pr-12 text-xl font-bold border-2 border-black focus:outline-none transition-colors font-mono" placeholder="0"/>
                                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-sm">SOL</span>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <button onClick={deposit} disabled={actionLoading || walletBalance < parseFloat(amountInput)} className="h-14 bg-black text-white font-extrabold hover:bg-gray-800 transition-colors duration-200 disabled:opacity-30">入金</button>
                                <button onClick={withdraw} disabled={actionLoading || solVaultBalance < parseFloat(amountInput)} className="h-14 bg-white text-black font-extrabold border-2 border-black hover:bg-gray-50 transition-colors duration-200 disabled:opacity-30 disabled:border-gray-300 disabled:text-gray-300">出金</button>
                            </div>
                        </div>
                        <div className="w-full mt-4">
                            <p className="text-xs font-black font-bold mb-2 uppercase tracking-wider text-left">Grow Box入出金履歴</p>
                            <div className="w-full h-[300px] overflow-y-auto bg-white border-2 border-black p-2 space-y-2">
                                {vaultHistory.length === 0 ? (
                                    <div className="h-full flex items-center justify-center text-gray-300 font-bold text-sm">履歴はありません</div>
                                ) : (
                                    vaultHistory.map((record) => (
                                        <div key={record.id} className="bg-white p-3 border border-gray-200 flex justify-between items-center hover:border-black transition-colors">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-8 h-8 flex items-center justify-center text-[10px] font-bold border border-black ${record.type === "Deposit" ? "bg-black text-white" : record.type === "Withdraw" ? "bg-white text-black" : "bg-gray-100 text-black"}`}>
                                                    {record.type === "Deposit" ? "IN" : record.type === "Withdraw" ? "OUT" : "INI"}
                                                </div>
                                                <div className="flex flex-col text-left"><span className="text-[10px] font-mono text-gray-400">{record.date}</span><span className="text-[10px] font-bold text-gray-600">Gas: {record.gas.toFixed(6)}</span></div>
                                            </div>
                                            <span className="font-mono font-bold text-sm text-black">{record.amount} <span className="text-[10px] text-gray-400">SOL</span></span>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
        )}

        {/* === Tab 2: NFT (キャラクター表示) === */}
        {activeTab === 'nft' && (
            <div className="flex flex-col items-center">
                {!isInitialized ? (
                    <div className="flex flex-col items-center justify-center min-h-[300px] text-center">
                        <p className="text-gray-400 font-bold mb-4">NFTを発行するには<br/>Grow Boxを開設してください</p>
                        <button onClick={() => setActiveTab('box')} className="text-sm border-b-2 border-black pb-1 font-bold">Boxタブへ移動</button>
                    </div>
                ) : (
                    <>
                        <div className="mb-6 relative group cursor-default text-center w-full border-2 border-black p-8">
                            <div className="w-[200px] h-[150px] mx-auto flex items-center justify-center overflow-hidden mb-4">
                                <img 
                                    src={gifData.src} 
                                    alt={gifData.alt} 
                                    className="w-full h-full object-contain" 
                                />
                            </div>
                            <p className="text-xs text-black font-bold uppercase tracking-widest">My Grow Box NFT</p>
                            {/* 発行済みNFTのアドレス表示 */}
                            {nftMintAddress && <p className="text-[10px] font-mono text-gray-400 mt-2">Mint: {nftMintAddress}</p>}
                        </div>

                        <div className="w-full flex justify-between items-end mb-2">
                            <p className="text-xs font-black font-bold uppercase tracking-[0.1em]">リワード</p>
                            {/* <button onClick={handleResetRewards} disabled={actionLoading} className="text-[10px] font-bold border border-black px-2 py-0.5 hover:bg-black hover:text-white transition-colors">リセット</button> */}
                        </div>

                        <div className="text-center w-full bg-white border-2 border-black p-6 mb-6">
                            <div className="flex items-baseline justify-center">
                                <span className="text-3xl font-black tracking-tighter text-black leading-none font-mono">{animatedReward.toFixed(2)}</span>
                                <span className="text-sm font-bold ml-1 text-gray-500">Points</span>
                            </div>
                        </div>
                        
                        <p className="text-xs text-gray-400 text-center leading-relaxed">
                            このNFTはGrow Boxの残高に応じて見た目が変化します。<br/>
                            5 SOL以上預けると"何か"に進化します。
                        </p>
                    </>
                )}
            </div>
        )}

        {/* === Tab 3: Transfer === */}
        {activeTab === 'transfer' && (
            <div className="flex flex-col gap-8">
                {/* 送金フォーム (1つの枠内にまとめる) */}
                <div>
                  {/* 見出しを枠の外へ */}
                  <p className="text-xs font-black font-bold uppercase mb-2">WALLETから送金</p>
                  
                  {/* 枠線の中身 */}
                  <div className="bg-white border-2 border-black p-6">
                      <div className="flex flex-col gap-5">
                          {/* 金額入力欄 */}
                          <div>
                              <p className="text-[10px] font-bold text-black mb-1">送金金額</p>
                              <div className="relative w-full">
                                  <input 
                                      type="number" 
                                      value={transferAmountInput} 
                                      onChange={(e) => setTransferAmountInput(e.target.value)} 
                                      className="w-full h-14 pl-4 pr-16 text-2xl font-black border-2 border-black focus:outline-none font-mono tracking-tight" 
                                      placeholder="0" 
                                  />
                                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 font-black text-lg">SOL</span>
                              </div>
                          </div>

                          {/* アドレス入力 & 送信ボタン */}
                          <div>
                              <p className="text-[10px] font-bold text-black mb-1">送金先アドレス</p>
                              <div className="flex flex-col md:flex-row gap-3">
                                  <input 
                                      type="text" 
                                      value={recipientAddress} 
                                      onChange={(e) => setRecipientAddress(e.target.value)} 
                                      className="flex-1 h-14 pl-4 text-sm font-mono border-2 border-black focus:outline-none bg-gray-50" 
                                      placeholder="ウォレットアドレスを入力" 
                                  />
                                  <button 
                                      onClick={transfer} 
                                      disabled={actionLoading || !transferAmountInput || !recipientAddress || parseFloat(transferAmountInput) <= 0 || walletBalance < parseFloat(transferAmountInput)}
                                      className="h-14 px-8 bg-black text-white text-sm font-bold transition-colors hover:bg-gray-800 disabled:opacity-30 whitespace-nowrap"
                                  >
                                      送金
                                  </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* 履歴エリア (ここは変更なし) */}
                <div className="flex flex-col h-[400px]">
                    <div className="flex justify-between items-end mb-2">
                        <p className="text-xs font-black font-bold uppercase tracking-wider">SOL 送金履歴</p>
                    </div>
                    <div className="flex-1 overflow-y-auto bg-white border-2 border-black p-2 space-y-2">
                        {transferHistory.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-gray-300 font-bold text-sm">送信履歴はありません</div>
                        ) : (
                            transferHistory.map((record) => (
                                <div key={record.id} className="bg-white p-4 border border-gray-200 hover:border-black transition-colors">
                                    <div className="flex justify-between items-center mb-1">
                                        <div className="flex items-center gap-2"><span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5">SEND</span><span className="text-xs font-mono text-gray-400">{record.date}</span></div>
                                        <span className="font-mono font-bold text-xl text-black text-red-500">-{record.amount} <span className="text-sm text-gray-400">SOL</span></span>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <div className="flex flex-col"><span className="text-[10px] text-gray-400 font-bold">TO:</span><span className="text-xs font-mono text-gray-600 break-all">{record.destination}</span></div>
                                        <div className="text-right min-w-[80px]"><span className="text-[10px] text-gray-400 font-bold block">GAS</span><span className="text-xs font-mono text-gray-600">{record.fee.toFixed(6)}</span></div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        )}
      </div>

      <div className="text-right mt-12 pt-4 border-t border-gray-100 max-w-3xl mx-auto w-full">
        <button onClick={deleteWallet} className="text-xs font-bold text-gray-300 hover:text-red-600 transition-colors">Delete Wallet</button>
      </div>
    </div>
  );
}