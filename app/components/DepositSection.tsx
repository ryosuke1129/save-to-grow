"use client";

import { useState, useEffect, useMemo } from "react";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import idl from "../app/idl.json";
import { supabase } from "../utils/supabaseClient"; 
import { useCountUp } from '../hooks/useCountUp';

// --- Metaplex (NFT) 関連 ---
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, signerIdentity, percentAmount } from "@metaplex-foundation/umi";
import { createNft, updateV1, fetchMetadataFromSeeds, mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { fromWeb3JsKeypair, fromWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { sha256 } from 'js-sha256';

const NETWORK_URL = process.env.NEXT_PUBLIC_SOLANA_NETWORK!;
const PROGRAM_ID_STRING = process.env.NEXT_PUBLIC_PROGRAM_ID!;

if (!NETWORK_URL || !PROGRAM_ID_STRING) throw new Error("Missing Env Vars");

const PROGRAM_ID = new PublicKey(PROGRAM_ID_STRING);
const connection = new Connection(NETWORK_URL, "confirmed");

// NFTメタデータ
const METADATA_URIS = {
  default: "https://coffee-patient-mackerel-446.mypinata.cloud/ipfs/bafkreih33uv4usrp266elvpnkalj5eqte2s34ufdffxtgba3x2ybmfjd5y",
  growing: "https://coffee-patient-mackerel-446.mypinata.cloud/ipfs/bafkreiequjkraokootfvtevagfam35b5eittmhrbdszk75lcwn7rykcgmq",
  legendary: "https://coffee-patient-mackerel-446.mypinata.cloud/ipfs/bafkreihk67v2decygyuevd2l2uk2b24yxkxyno54wgzc7wasp72yuikjxy"
};

const getDeterministicMintKeypair = (userPubkey: PublicKey): Keypair => {
  const seed = sha256.digest("box-nft-seed" + userPubkey.toString());
  return Keypair.fromSeed(new Uint8Array(seed));
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function retryRPC<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try { return await fn(); } catch (error: any) {
    if (retries > 0 && JSON.stringify(error).includes("429")) {
      await sleep(delay); return retryRPC(fn, retries - 1, delay * 2);
    } throw error;
  }
}

// 型定義
type TxType = "Deposit" | "Withdraw" | "Initialize" | "Reward"; 

interface VaultRecord { id: string; type: TxType; amount: number; gas: number; date: string; }
interface TransferRecord { id: string; destination: string; amount: number; fee: number; date: string; }
interface LockRecord { id: string; amount: number; duration_hours: number; ends_at: string; status: string; reward_amount: number; } // ★追加

class SimpleWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
  async signTransaction(tx: Transaction) { tx.partialSign(this.payer); return tx; }
  async signAllTransactions(txs: Transaction[]) { return txs.map((t) => { t.partialSign(this.payer); return t; }); }
}

export default function DepositSection() {
  const [mounted, setMounted] = useState(false); 
  // ★ 'lock' タブを追加
  const [activeTab, setActiveTab] = useState<'lock' | 'box' | 'transfer' | 'nft'>('nft');

  const [email, setEmail] = useState("");
  const [isEmailSent, setIsEmailSent] = useState(false);
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [myWallet, setMyWallet] = useState<Keypair | null>(null);
  const [nftMintAddress, setNftMintAddress] = useState<string | null>(null);
  
  const [balance, setBalance] = useState<string>("0"); // Box残高(Lamports)
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
  
  // ★ LockBox用のState
  const [activeLocks, setActiveLocks] = useState<LockRecord[]>([]);
  const [lockAmountInput, setLockAmountInput] = useState("");
  const [lockDuration, setLockDuration] = useState<number>(5 / 60); // デフォルト5分

  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) {
          checkWalletExistence(session.user.id);
          fetchVaultHistory(session.user.id);
          fetchTransferHistory(session.user.id);
          fetchLocks(session.user.id); // ★ロック情報の取得
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        checkWalletExistence(session.user.id);
        fetchVaultHistory(session.user.id);
        fetchTransferHistory(session.user.id);
        fetchLocks(session.user.id);
      } else {
        setMyWallet(null); setNftMintAddress(null); setWalletBalance(0); setBalance("0"); setRewardBalance("0");
        setVaultHistory([]); setTransferHistory([]); setActiveLocks([]); setIsInitialized(false);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // リアルタイム更新の設定などは省略せずそのまま維持推奨... (ここではスペース節約のため省略なしで記述)
  useEffect(() => {
    if (!session) return;
    const channelVault = supabase.channel('vault_changes').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transaction_history', filter: `user_id=eq.${session.user.id}` }, () => fetchVaultHistory(session.user.id)).subscribe();
    const channelTransfer = supabase.channel('transfer_changes').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transfer_history', filter: `user_id=eq.${session.user.id}` }, () => fetchTransferHistory(session.user.id)).subscribe();
    // ★ Lockの変更も監視
    const channelLocks = supabase.channel('lock_changes').on('postgres_changes', { event: '*', schema: 'public', table: 'box_locks', filter: `user_id=eq.${session.user.id}` }, () => fetchLocks(session.user.id)).subscribe();
    return () => { supabase.removeChannel(channelVault); supabase.removeChannel(channelTransfer); supabase.removeChannel(channelLocks); };
  }, [session]);

  useEffect(() => {
    if (myWallet) {
      fetchWalletBalance();
      setTimeout(() => fetchVault(), 500);
    }
  }, [myWallet]);

  // --- Logic Helpers ---
  const triggerHighlight = (id: string) => { setHighlightId(id); setTimeout(() => setHighlightId(null), 1200); };
  
  const fetchVaultHistory = async (userId: string) => { /* 既存のコード */
      const { data } = await supabase.from('transaction_history').select('*').eq('user_id', userId).order('created_at', { ascending: false });
      if (data) {
          setVaultHistory(data.map((item: any) => ({
              id: item.id, type: item.type as TxType, amount: Number(item.amount), gas: Number(item.gas),
              date: new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          })));
      }
  };
  const fetchTransferHistory = async (userId: string) => { /* 既存のコード */
      const { data } = await supabase.from('transfer_history').select('*').eq('user_id', userId).order('created_at', { ascending: false });
      if (data) {
          setTransferHistory(data.map((item: any) => ({
              id: item.id, destination: item.destination, amount: Number(item.amount), fee: Number(item.fee),
              date: new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          })));
      }
  };
  // ★ Lock情報の取得
  const fetchLocks = async (userId: string) => {
    const { data } = await supabase.from('box_locks').select('*').eq('user_id', userId).eq('status', 'active').order('ends_at', { ascending: true });
    if (data) setActiveLocks(data);
  };

  const addVaultHistory = async (type: TxType, amount: number, gas: number) => { /* 既存のコード */
      if (!session) return;
      const { data } = await supabase.from('transaction_history').insert([{ user_id: session.user.id, type, amount, gas }]).select();
      if (data && data[0]) triggerHighlight(data[0].id);
      fetchVaultHistory(session.user.id);
  };
  const addTransferHistory = async (destination: string, amount: number, fee: number) => { /* 既存のコード */
    if (!session) return;
    const { data, error } = await supabase.from('transfer_history').insert([{ user_id: session.user.id, destination, amount, fee }]).select();
    if (!error && data && data[0]) triggerHighlight(data[0].id);
    fetchTransferHistory(session.user.id);
  };

  const checkWalletExistence = async (userId: string) => {
    // 既にウォレットがロードされているなら、ローディング画面を出さない（画面リセット防止）
    if (!myWallet) {
        setLoading(true);
    }
    
    try {
      const { data } = await supabase.from('user_wallets').select('*').eq('user_id', userId).single();
      if (data) {
        const secretKeyArray = JSON.parse(data.secret_key);
        const kp = Keypair.fromSecretKey(new Uint8Array(secretKeyArray));
        setMyWallet(kp);
        const mintKeypair = getDeterministicMintKeypair(kp.publicKey);
        setNftMintAddress(mintKeypair.publicKey.toString());
      } else { 
        setMyWallet(null); 
        setNftMintAddress(null); 
      }
    } catch (error) { 
      setMyWallet(null); 
    } finally { 
      setLoading(false); 
    }
  };
  const createNewWallet = async () => { /* 既存のコード... */ 
      if (!session) return; setLoading(true);
      try {
          const newKeypair = Keypair.generate();
          const secretKeyString = JSON.stringify(Array.from(newKeypair.secretKey));
          await supabase.from('user_wallets').insert([{ user_id: session.user.id, public_key: newKeypair.publicKey.toString(), secret_key: secretKeyString }]);
          setMyWallet(newKeypair); alert("作成しました！");
      } catch(e) { console.error(e); } finally { setLoading(false); }
  };
  const deleteWallet = async () => { /* 既存のコード... */
      if (!session || !myWallet) return; if (!confirm("削除しますか？")) return; setLoading(true);
      try {
          await supabase.from('transaction_history').delete().eq('user_id', session.user.id);
          await supabase.from('transfer_history').delete().eq('user_id', session.user.id);
          await supabase.from('box_locks').delete().eq('user_id', session.user.id); // ロックも削除
          await supabase.from('user_wallets').delete().eq('user_id', session.user.id);
          setMyWallet(null); setNftMintAddress(null); setWalletBalance(0); setBalance("0"); setRewardBalance("0");
          setVaultHistory([]); setTransferHistory([]); setActiveLocks([]); setIsInitialized(false);
          alert("削除しました");
      } catch(e) { console.error(e); } finally { setLoading(false); }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault(); 
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ 
        email, 
        options: { emailRedirectTo: window.location.origin } 
    });
    
    if (error) {
        alert(error.message);
    } else {
        setIsEmailSent(true); // ★アラートではなく画面切り替え
    }
    setAuthLoading(false);
  };

  const handleLogout = async () => { await supabase.auth.signOut(); };

  // --- Solana Helpers (省略なし) ---
  const getProvider = () => { if (!myWallet) return null; return new AnchorProvider(connection, new SimpleWallet(myWallet) as any, { commitment: "confirmed" }); };
  const getVaultPda = () => { if (!myWallet) return null; return PublicKey.findProgramAddressSync([Buffer.from("vault"), myWallet.publicKey.toBuffer()], PROGRAM_ID)[0]; };
  const getRewardPda = () => { if (!myWallet) return null; return PublicKey.findProgramAddressSync([Buffer.from("reward"), myWallet.publicKey.toBuffer()], PROGRAM_ID)[0]; };

  const fetchVault = async () => {
    const provider = getProvider(); const vaultPda = getVaultPda(); const rewardPda = getRewardPda();
    if (!provider || !vaultPda || !rewardPda) return;
    try {
      const program = new Program(idl as any, provider) as any;
      const vaultAccount = (await retryRPC(() => program.account.vault.fetch(vaultPda))) as any;
      setBalance(vaultAccount.balance.toString());
      try { const rewardAccount = (await retryRPC(() => program.account.rewardBox.fetch(rewardPda))) as any; setRewardBalance(rewardAccount.balance.toString()); } catch (e) { setRewardBalance("0"); }
      setIsInitialized(true);
    } catch (e) { setBalance("0"); setRewardBalance("0"); setIsInitialized(false); }
  };
  const fetchWalletBalance = async () => { if (!myWallet) return; try { const bal = await retryRPC(() => connection.getBalance(myWallet.publicKey)); setWalletBalance(bal / LAMPORTS_PER_SOL); } catch (e) {} };

  // NFT Logic (省略) - 既存コードと同じ
  const createUmiInstance = (wallet: Keypair) => { const umi = createUmi(NETWORK_URL).use(mplTokenMetadata()); umi.use(signerIdentity(createSignerFromKeypair(umi, fromWeb3JsKeypair(wallet)))); return umi; };
  const mintGrowNft = async (wallet: Keypair) => {
      const umi = createUmiInstance(wallet); const mintWeb3Keypair = getDeterministicMintKeypair(wallet.publicKey); const mint = createSignerFromKeypair(umi, fromWeb3JsKeypair(mintWeb3Keypair));
      const account = await umi.rpc.getAccount(mint.publicKey); if (account.exists) return mint.publicKey.toString();
      await createNft(umi, { mint, name: "Grow Box NFT", symbol: "GROW", uri: METADATA_URIS.default, sellerFeeBasisPoints: percentAmount(0), }).sendAndConfirm(umi, { send: { skipPreflight: true } });
      return mint.publicKey.toString();
  };
  const updateNftMetadata = async (wallet: Keypair, mintAddr: string, currentBal: number) => {
      const umi = createUmiInstance(wallet); const mintPublicKey = fromWeb3JsPublicKey(new PublicKey(mintAddr));
      let targetUri = METADATA_URIS.default; if (currentBal >= 5) targetUri = METADATA_URIS.legendary; else if (currentBal > 0) targetUri = METADATA_URIS.growing;
      try { const initialMetadata = await fetchMetadataFromSeeds(umi, { mint: mintPublicKey });
          if (initialMetadata.uri !== targetUri) await updateV1(umi, { mint: mintPublicKey, data: { ...initialMetadata, uri: targetUri }, }).sendAndConfirm(umi, { send: { skipPreflight: true } });
      } catch (e) {}
  };

  // --- Computed Values ---
  const solVaultBalance = useMemo(() => Number(balance) / LAMPORTS_PER_SOL, [balance]);
  // ★ ロック中金額の計算
  const totalLockedAmount = useMemo(() => activeLocks.reduce((sum, lock) => sum + lock.amount, 0), [activeLocks]);
  const availableToWithdraw = solVaultBalance - totalLockedAmount;

  // --- Actions ---
  const initializeVault = async () => { /* 既存コード */
      if (!myWallet || !session) return; const provider = getProvider(); const vaultPda = getVaultPda(); const rewardPda = getRewardPda(); if (!provider || !vaultPda || !rewardPda) return;
      try { setActionLoading(true); const preBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey)); const program = new Program(idl as any, provider) as any;
          await program.methods.initialize().accounts({ vault: vaultPda, rewardBox: rewardPda, user: myWallet.publicKey, systemProgram: SystemProgram.programId }).signers([myWallet]).rpc();
          const mintAddress = await mintGrowNft(myWallet); setNftMintAddress(mintAddress);
          const postBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey)); await addVaultHistory("Initialize", 0, (preBalance - postBalance) / LAMPORTS_PER_SOL); await fetchVault(); await fetchWalletBalance(); setActiveTab('nft');
      } catch (e) { alert("初期化エラー"); } finally { setActionLoading(false); }
  };
  
  const deposit = async () => { /* 既存コード (NFT更新追加版) */
      if (!myWallet) return; const provider = getProvider(); const vaultPda = getVaultPda(); const rewardPda = getRewardPda(); if (!provider || !vaultPda || !rewardPda) return;
      const val = parseFloat(amountInput); if (isNaN(val) || val <= 0) { alert("金額不正"); return; }
      try { setActionLoading(true); const preBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey)); const program = new Program(idl as any, provider) as any;
          await program.methods.deposit(new BN(Math.floor(val * LAMPORTS_PER_SOL))).accounts({ vault: vaultPda, rewardBox: rewardPda, user: myWallet.publicKey, systemProgram: SystemProgram.programId }).signers([myWallet]).rpc({ skipPreflight: true });
          const postBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey));
          await addVaultHistory("Deposit", val, (preBalance - postBalance) / LAMPORTS_PER_SOL - val); await fetchVault(); await fetchWalletBalance(); setAmountInput("");
          const currentVaultSol = (Number(balance) + Math.floor(val * LAMPORTS_PER_SOL)) / LAMPORTS_PER_SOL;
          if (nftMintAddress) updateNftMetadata(myWallet, nftMintAddress, currentVaultSol);
      } catch (e) { alert("入金エラー"); } finally { setActionLoading(false); }
  };

  const withdraw = async () => {
      if (!myWallet) return; const provider = getProvider(); const vaultPda = getVaultPda(); const rewardPda = getRewardPda(); if (!provider || !vaultPda || !rewardPda) return;
      const val = parseFloat(amountInput); if (isNaN(val) || val <= 0) { alert("金額不正"); return; }
      
      // ★ 出金制限チェック
      if (val > availableToWithdraw) {
          alert(`出金可能額を超えています。\n(ロック中: ${totalLockedAmount} SOL)`);
          return;
      }

      try { setActionLoading(true); const preBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey)); const program = new Program(idl as any, provider) as any;
          await program.methods.withdraw(new BN(Math.floor(val * LAMPORTS_PER_SOL))).accounts({ vault: vaultPda, rewardBox: rewardPda, user: myWallet.publicKey, systemProgram: SystemProgram.programId }).signers([myWallet]).rpc({ skipPreflight: true });
          const postBalance = await retryRPC(() => connection.getBalance(myWallet.publicKey)); 
          const actualReceived = postBalance - preBalance; const expected = Math.floor(val * LAMPORTS_PER_SOL);
          await addVaultHistory("Withdraw", val, (expected - actualReceived) / LAMPORTS_PER_SOL); await fetchVault(); await fetchWalletBalance(); setAmountInput("");
          const currentVaultSol = (Number(balance) - expected) / LAMPORTS_PER_SOL;
          if (nftMintAddress) updateNftMetadata(myWallet, nftMintAddress, currentVaultSol > 0 ? currentVaultSol : 0);
      } catch (e) { alert("出金エラー"); } finally { setActionLoading(false); }
  };

  const transfer = async () => { /* 既存コード */
      if (!myWallet) return; const val = parseFloat(transferAmountInput); if (isNaN(val) || val <= 0) return; if (walletBalance < val + 0.000005) { alert("残高不足"); return; }
      try { setActionLoading(true); const recipientPubkey = new PublicKey(recipientAddress);
          const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: myWallet.publicKey, toPubkey: recipientPubkey, lamports: Math.floor(val * LAMPORTS_PER_SOL) }));
          await connection.confirmTransaction(await connection.sendTransaction(tx, [myWallet]), "confirmed");
          await addTransferHistory(recipientAddress, val, 0.000005); setRecipientAddress(""); setTransferAmountInput(""); await fetchWalletBalance();
      } catch (e: any) { alert(e.message); } finally { setActionLoading(false); }
  };

  // ★ LockBoxのアクション
  const handleLock = async () => {
    if (!session) return;
    const val = parseFloat(lockAmountInput);
    if (isNaN(val) || val <= 0) { alert("金額を入力してください"); return; }
    if (val > availableToWithdraw) { alert("Grow Box内の利用可能残高が足りません"); return; }

    if(!confirm(`${val} SOLをロックしますか？\n期間中は出金できません。`)) return;

    setActionLoading(true);
    try {
        const res = await fetch('/api/lock', {
            method: 'POST',
            body: JSON.stringify({
                action: 'create',
                userId: session.user.id,
                amount: val,
                durationHours: lockDuration
            })
        });
        if (!res.ok) throw new Error("ロックに失敗しました");
        
        alert("ロックしました！");
        setLockAmountInput("");
        fetchLocks(session.user.id);
    } catch (e: any) {
        alert(e.message);
    } finally {
        setActionLoading(false);
    }
  };

  const handleUnlock = async (lockId: string, force: boolean = false) => {
    if (!myWallet || !session) return;
    
    if (force) {
        if (!confirm("【警告】\nロック期間中ですが強制解除しますか？\n\n※強制解除の場合、リワード(利息)は受け取れません。\n※元本のみロックが解除され、出金可能になります。")) {
            return;
        }
    }

    setActionLoading(true);
    try {
        const res = await fetch('/api/lock', {
            method: 'POST',
            body: JSON.stringify({
                action: 'unlock',
                userId: session.user.id,
                lockId: lockId,
                userAddress: myWallet.publicKey.toString(),
                force: force // ★追加
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        if (force) {
            alert("強制解除しました。ロック枠が解放されました。");
        } else {
            alert(`ロック解除成功！ リワード: +${data.reward} SOL をWalletに受け取りました`);
        }
        
        fetchLocks(session.user.id);
        fetchVault();
        fetchWalletBalance();
    } catch (e: any) {
        alert(e.message);
    } finally {
        setActionLoading(false);
    }
  };

  // UI系フック
  const copyAddress = async () => { /* 既存コード */ if (!myWallet) return; const addr = myWallet.publicKey.toString(); try { await navigator.clipboard.writeText(addr); setIsCopied(true); setTimeout(() => setIsCopied(false), 1200); } catch(e) {} };
  const animatedWalletBalance = useCountUp(walletBalance, 800);
  const animatedVaultBalance = useCountUp(solVaultBalance, 800);
  const animatedReward = useCountUp(Number(rewardBalance) / LAMPORTS_PER_SOL, 800);
  const gifData = useMemo(() => { if (solVaultBalance >= 5) return { src: "/images/gif-reward.gif", alt: "Reward Max", label: "Legendary" }; if (solVaultBalance > 0) return { src: "/images/gif-deposited.gif", alt: "Growing", label: "Growing" }; return { src: "/images/gif-default.gif", alt: "Waiting", label: "Sprout" }; }, [solVaultBalance]);
  const shortAddress = useMemo(() => { if (!myWallet) return ""; const addr = myWallet.publicKey.toString(); return `${addr.slice(0, 8)}...${addr.slice(-8)}`; }, [myWallet]);

  if (!mounted) return null;
  // --- ログイン画面 ---
  if (!session) return (
    <div className="min-h-screen flex items-center justify-center bg-white font-sans px-4">
      <div className="w-full max-w-md bg-white border-2 border-black p-8 text-center">
        <h1 className="text-3xl font-black mb-2 tracking-tight">Web3 Wallet</h1>
        
        {!isEmailSent ? (
            // 送信前：フォームを表示
            <>
                <p className="text-sm text-gray-500 font-bold mb-8">ウォレットにログインしましょう</p>
                
                <form onSubmit={handleLogin} className="flex flex-col gap-4">
                    <input 
                        type="email" 
                        value={email} 
                        onChange={e => setEmail(e.target.value)} 
                        className="w-full h-12 border-2 border-black px-4 font-bold placeholder-gray-400 focus:outline-none transition-colors" 
                        required 
                        placeholder="メールアドレスを入力"
                    />
                    <button 
                        type="submit" 
                        disabled={authLoading}
                        className="w-full h-12 bg-black text-white font-bold hover:bg-gray-800 transition-colors disabled:opacity-50"
                    >
                        {authLoading ? "送信中..." : "ログインリンクを送信する"}
                    </button>
                </form>
            </>
        ) : (
            // 送信後：メッセージを表示
            <div className="py-10 animate-fade-in">
                <div className="mb-6 flex justify-center">
                    {/* チェックマークアイコン */}
                    <svg className="w-16 h-16 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
                    </svg>
                </div>
                <p className="text-base font-bold leading-loose text-gray-800">
                    この画面を閉じて<br/>
                    メールのログインリンクから<br/>
                    ログインしてください
                </p>
            </div>
        )}
      </div>
    </div>
  );
  if (loading) return <div className="h-screen flex items-center justify-center font-bold text-2xl animate-pulse">Wallet Loading...</div>;
  // --- ウォレット作成画面 ---
  if (!myWallet) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white font-sans relative p-6">
      {/* 右上のユーザー情報 */}
      <div className="absolute top-8 right-8 text-right">
        <p className="text-[10px] text-gray-400 font-bold mb-1">{session.user.email}</p>
        <button 
          onClick={handleLogout} 
          className="text-xs font-bold text-gray-400 hover:text-black transition-colors underline decoration-gray-400 underline-offset-2"
        >
          Logout
        </button>
      </div>

      {/* 中央のコンテンツ */}
      <div className="w-full max-w-md flex flex-col items-center text-center mt-[-40px]">
        {/* プラスアイコン */}
        <div className="mb-6">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 4V20M4 12H20" stroke="#E5E7EB" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
        </div>
        
        <h2 className="text-2xl font-black mb-6 tracking-tight">Welcome to Web3 Wallet</h2>
        
        <p className="text-gray-500 font-bold leading-loose mb-10 text-sm">
            まだウォレットがありません。<br/>
            アプリ専用のウォレットを作成して<br/>
            資産形成を始めましょう
        </p>

        <button 
            onClick={createNewWallet} 
            disabled={loading}
            className="w-full h-14 bg-black text-white font-bold text-lg hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
            {loading ? "作成中..." : "ウォレットを新規作成"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-5xl mx-auto bg-white p-4 md:p-6 font-sans min-h-[600px] flex flex-col relative">
      <div className="absolute top-4 right-4 md:top-8 md:right-8">
        <div className="text-right"><p className="text-[10px] text-gray-400 font-bold mb-1">{session.user.email?.split('@')[0]}</p><button onClick={handleLogout} className="text-xs font-bold text-gray-400 hover:text-red-500 transition-colors underline">ログアウト</button></div>
      </div>

      <div className="mb-6 text-left"><h1 className="text-4xl font-black tracking-tight text-black mb-2">Web3 Wallet</h1></div>

      <div className="w-full bg-white border-2 border-black p-5 mb-8 max-w-3xl mx-auto">
        <div className="flex flex-col mb-2">
            <p className="text-xs font-black font-bold mb-1 text-black tracking-wider text-left">Wallet残高</p>
            <p className="text-4xl font-mono font-black text-black tracking-tighter text-right">{animatedWalletBalance.toFixed(6)} <span className="text-lg text-gray-400 font-bold">SOL</span></p>
        </div>
        <button onClick={copyAddress} className={`w-full text-left border border-black py-2 px-3 font-mono text-xs text-gray-500 flex justify-between items-center group transition-colors duration-200 ${isCopied ? 'bg-[#EEFF77]' : 'bg-white hover:bg-gray-50'}`}>
            <span>{shortAddress}</span><span className={`text-black font-bold ${isCopied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>{isCopied ? 'COPIED!' : 'COPY'}</span>
        </button>
      </div>

      {/* タブ切り替え: LockBoxを左に追加 */}
      <div className="flex w-full max-w-2xl mx-auto mb-8 border-b-2 border-gray-100 gap-1 md:gap-8 overflow-x-auto">
        <button onClick={() => setActiveTab('nft')} className={`flex-1 pb-2 text-center text-lg font-bold whitespace-nowrap transition-colors ${activeTab === 'nft' ? 'border-b-4 border-black text-black' : 'text-gray-300 hover:text-gray-500'}`}>NFT</button>
        <button onClick={() => setActiveTab('box')} className={`flex-1 pb-2 text-center text-lg font-bold whitespace-nowrap transition-colors ${activeTab === 'box' ? 'border-b-4 border-black text-black' : 'text-gray-300 hover:text-gray-500'}`}>Box</button>
        <button onClick={() => setActiveTab('lock')} className={`flex-1 pb-2 text-center text-lg font-bold whitespace-nowrap transition-colors ${activeTab === 'lock' ? 'border-b-4 border-black text-black' : 'text-gray-300 hover:text-gray-500'}`}>Lock</button>
        <button onClick={() => setActiveTab('transfer')} className={`flex-1 pb-2 text-center text-lg font-bold whitespace-nowrap transition-colors ${activeTab === 'transfer' ? 'border-b-4 border-black text-black' : 'text-gray-300 hover:text-gray-500'}`}>送金</button>
      </div>

      <div className="w-full max-w-3xl mx-auto">

        {/* === Tab 1: NFT (既存) === */}
        {activeTab === 'nft' && (
             /* ... 既存のNFTタブの中身 (変更なし) ... */
             <div className="flex flex-col items-center">
                {!isInitialized ? (
                    <div className="flex flex-col items-center justify-center min-h-[300px] text-center">
                        <p className="text-gray-400 font-bold mb-4">NFTを発行するには<br/>Boxを開設してください</p>
                        <button onClick={() => setActiveTab('box')} className="text-sm border-b-2 border-black pb-1 font-bold">Boxタブへ移動</button>
                    </div>
                ) : (
                    <>
                        <div className="mb-6 relative group cursor-default text-center w-full border-2 border-black p-8">
                            <div className="w-[200px] h-[100px] mx-auto flex items-center justify-center overflow-hidden mb-4">
                                <img src={gifData.src} alt={gifData.alt} className="w-full h-full object-contain" />
                            </div>
                            <p className="text-xs text-black font-bold tracking-widest">My Box NFT</p>
                            {nftMintAddress && <p className="text-[10px] font-mono text-gray-400 mt-2">Mint: {nftMintAddress}</p>}
                        </div>
                        <div className="w-full flex justify-between items-end mb-2"><p className="text-xs font-black font-bold tracking-[0.1em]">リワード</p></div>
                        <div className="text-center w-full bg-white border-2 border-black p-6 mb-6">
                            <div className="flex items-baseline justify-center"><span className="text-3xl font-black tracking-tighter text-black leading-none font-mono">{animatedReward.toFixed(2)}</span><span className="text-sm font-bold ml-1 text-gray-500">Points</span></div>
                        </div>
                        <p className="text-xs text-gray-400 text-center leading-relaxed">このNFTはBoxの残高に応じて見た目が変化します。<br/>5 SOL以上預けると"何か"に進化します。</p>
                    </>
                )}
            </div>
        )}

        {/* === Tab 2: Box (既存) === */}
        {activeTab === 'box' && (
            <div className="flex flex-col gap-6">
                {!isInitialized ? (
                     <div className="flex flex-col items-center justify-center h-full border-2 border-dashed border-gray-300 p-6 rounded min-h-[300px]">
                        <p className="text-gray-400 font-bold mb-4">Boxが未開設です</p>
                        <button onClick={initializeVault} disabled={actionLoading || walletBalance < 0.01} className="w-full max-w-xs h-14 bg-black text-white text-lg font-extrabold hover:bg-gray-800 transition-colors duration-200 disabled:opacity-30"> {walletBalance < 0.01 ? "残高不足 (要SOL)" : "Boxを開設する"} </button>
                        <p className="text-xs text-gray-400 mt-2">※開設と同時にNFTが発行されます</p>
                     </div>
                ) : (
                    <>
                        <div className="text-center w-full bg-white border-2 border-black p-6">
                            <p className="text-xs font-black font-bold tracking-[0.1em] mb-3">Box残高</p>
                            <div className="flex items-baseline justify-center"><span className="text-5xl font-black tracking-tighter text-black leading-none font-mono">{animatedVaultBalance.toFixed(2)}</span><span className="text-2xl font-bold ml-2 text-gray-500">SOL</span></div>
                            {/* ★ロック中金額の表示を追加 */}
                            {totalLockedAmount > 0 && (
                                <p className="text-xs font-bold text-gray-400 mt-2">
                                    (ロック中: {totalLockedAmount.toFixed(2)} SOL / 出金可能: {availableToWithdraw.toFixed(2)} SOL)
                                </p>
                            )}
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
                            <p className="text-xs font-black font-bold mb-2 tracking-wider text-left">Box入出金履歴</p>
                            <div className="w-full h-[300px] overflow-y-auto bg-white border-2 border-black p-2 space-y-2">
                                {vaultHistory.length === 0 ? (
                                    <div className="h-full flex items-center justify-center text-gray-300 font-bold text-sm">履歴はありません</div>
                                ) : (
                                    vaultHistory.map((record) => (
                                        <div key={record.id} className={`p-3 border border-gray-200 flex justify-between items-center hover:border-black transition-colors duration-500 ${record.id === highlightId ? 'bg-[#EEFF77]' : 'bg-white'}`}>
                                            <div className="flex items-center gap-3">
                                                <div className={`w-8 h-8 flex items-center justify-center text-[10px] font-bold border border-black ${record.type === "Deposit" ? "bg-black text-white" : record.type === "Withdraw" ? "bg-white text-black" : "bg-gray-100 text-black"}`}>{record.type === "Deposit" ? "IN" : record.type === "Withdraw" ? "OUT" : "INI"}</div>
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

        {/* === Tab 3: LockSOL (New!) === */}
        {activeTab === 'lock' && (
            <div className="flex flex-col gap-6">
                 {!isInitialized ? (
                     <div className="flex flex-col items-center justify-center min-h-[300px] border-2 border-dashed border-gray-300 p-6 rounded">
                        <p className="text-gray-400 font-bold mb-4">まずはBoxを開設して入金してください</p>
                        <button onClick={() => setActiveTab('box')} className="text-sm font-bold border-b-2 border-black pb-1">Boxタブへ移動</button>
                     </div>
                ) : (
                    <>
                        {/* ロック入力エリア */}
                        <div className="w-full bg-white border-2 border-black p-6">
                          {/* タイトル削除 & 利率を枠内に移動 */}
                          {/* <div className="flex justify-between items-start mb-6">
                              <p className="text-xs text-gray-500 leading-relaxed">
                                  Box内のSOLを一時的にロックしてリワードを獲得します。<br/>
                                  <span className="font-bold text-red-500">ロック中は出金できません。</span>
                              </p>
                              <span className="bg-[#EEFF77] text-black text-[10px] font-black px-2 py-1 whitespace-nowrap ml-2">
                                  利率 5.0%
                              </span>
                          </div> */}

                          <div className="mb-4">
                              <p className="text-[10px] font-bold mb-1">ロックする金額 (ロック可能: {availableToWithdraw.toFixed(2)} SOL)</p>
                              <div className="relative w-full">
                                  <input 
                                      type="number" 
                                      value={lockAmountInput} 
                                      onChange={(e) => setLockAmountInput(e.target.value)} 
                                      className="w-full h-12 pl-4 pr-12 text-lg font-bold border-2 border-black focus:outline-none font-mono" 
                                      placeholder="0" 
                                  />
                                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold">SOL</span>
                              </div>
                          </div>

                          <div>
                            <p className="text-[10px] font-bold mb-2">ロック期間を選択</p>
                            <div className="grid grid-cols-4 gap-2 mb-6">
                                {[
                                    { label: '5分', value: 5 / 60 }, // 5分 = 5/60 時間
                                    { label: '1時間', value: 1 },
                                    { label: '12時間', value: 12 },
                                    { label: '24時間', value: 24 }
                                ].map((opt) => (
                                    <button 
                                        key={opt.label}
                                        onClick={() => setLockDuration(opt.value)}
                                        className={`h-10 text-sm font-bold border-2 border-black transition-all ${Math.abs(lockDuration - opt.value) < 0.001 ? 'bg-black text-white' : 'bg-white text-black hover:bg-gray-50'}`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                            <div className="flex justify-between items-start mb-6">
                                <p className="text-xs text-gray-500 leading-relaxed">
                                    Box内のSOLを一時的にロックしてリワードを獲得します。<br/>
                                    <span className="font-bold text-red-500">ロック中は出金できません。</span>
                                </p>
                                <span className="bg-[#EEFF77] text-black text-[10px] font-black px-2 py-1 whitespace-nowrap ml-2">
                                    利率 10.0%
                                </span>
                            </div>

                            <button 
                                onClick={handleLock} 
                                disabled={actionLoading || availableToWithdraw <= 0}
                                className="w-full h-14 bg-black text-white border-2 border-black font-bold hover:brightness-95 transition-all disabled:opacity-50 disabled:bg-gray-200"
                            >
                                ロックする
                            </button>
                          </div>
                        </div>

                        {/* アクティブなロック一覧 */}
                        <div className="w-full mt-4">
                            <p className="text-xs font-black font-bold mb-2 tracking-wider">ロック中のSOL</p>
                            <div className="space-y-3">
                                {activeLocks.length === 0 ? (
                                    <div className="text-center py-8 text-gray-300 font-bold text-sm bg-white border border-dashed border-gray-300">ロック中のSOLはありません</div>
                                ) : (
                                    activeLocks.map(lock => {
                                        const now = new Date();
                                        const ends = new Date(lock.ends_at);
                                        const isUnlockable = now >= ends;
                                        
                                        return (
                                            <div key={lock.id} className="bg-white border-2 border-black p-4 relative overflow-hidden">
                                                <div className="flex justify-between items-start mb-2">
                                                    <div>
                                                        <span className="text-2xl font-black font-mono block">{lock.amount.toFixed(2)} <span className="text-sm text-gray-400">SOL</span></span>
                                                        <span className="text-[10px] font-bold text-gray-400 bg-gray-100 px-1 py-0.5 rounded">
                                                            {lock.duration_hours < 1 
                                                                ? `${Math.round(lock.duration_hours * 60)}分ロック` 
                                                                : `${lock.duration_hours}時間ロック`}
                                                        </span>
                                                    </div>
                                                    <div className="text-right">
                                                        <span className="text-[10px] font-bold text-gray-400 block">獲得予定SOL</span>
                                                        <span className="text-sm font-mono font-bold bg-[#EEFF77] text-black">+{lock.reward_amount.toFixed(6)}</span>
                                                    </div>
                                                </div>

                                                <div className="flex justify-between items-end mt-4 pt-4 border-t border-gray-100">
                                                    <div className="text-[10px] font-mono text-black">
                                                        ロック終了: {ends.toLocaleString()}
                                                    </div>
                                                    {isUnlockable ? (
                                                        <button 
                                                            onClick={() => handleUnlock(lock.id)} 
                                                            className="bg-black text-white px-4 py-2 text-xs font-bold hover:bg-gray-800 animate-pulse"
                                                        >
                                                            ロック解除
                                                        </button>
                                                    ) : (
                                                        <button 
                                                            onClick={() => handleUnlock(lock.id, true)} // 強制解除フラグ true
                                                            className="flex items-center gap-1 text-gray-400 hover:text-red-500 transition-colors cursor-pointer group"
                                                            title="タップして強制解除"
                                                        >
                                                            <span className="text-xs font-bold group-hover:underline">ロック中</span>
                                                            <span className="block w-2 h-2 bg-red-500 rounded-full animate-pulse group-hover:bg-red-600"></span>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
        )}

        {/* === Tab 4: Transfer (既存) === */}
        {activeTab === 'transfer' && (
            /* ... 既存の送金タブの中身 ... */
            <div className="flex flex-col gap-8">
                <div>
                  <p className="text-xs font-black font-bold mb-2">Walletから送金</p>
                  <div className="bg-white border-2 border-black p-6">
                      <div className="flex flex-col gap-5">
                          <div>
                              <p className="text-[10px] font-bold text-black mb-1">送金金額</p>
                              <div className="relative w-full">
                                  <input type="number" value={transferAmountInput} onChange={(e) => setTransferAmountInput(e.target.value)} className="w-full h-14 pl-4 pr-16 text-2xl font-black border-2 border-black focus:outline-none font-mono tracking-tight" placeholder="0" />
                                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 font-black text-lg">SOL</span>
                              </div>
                          </div>
                          <div>
                              <p className="text-[10px] font-bold text-black mb-1">送金先アドレス</p>
                              <div className="flex flex-col md:flex-row gap-3">
                                  <input type="text" value={recipientAddress} onChange={(e) => setRecipientAddress(e.target.value)} className="w-full md:flex-1 h-14 pl-4 text-sm font-mono border-2 border-black focus:outline-none bg-gray-50" placeholder="ウォレットアドレスを入力" />
                                  <button onClick={transfer} disabled={actionLoading || !transferAmountInput || !recipientAddress || parseFloat(transferAmountInput) <= 0 || walletBalance < parseFloat(transferAmountInput)} className="h-14 px-8 bg-black text-white font-bold transition-colors hover:bg-gray-800 disabled:opacity-30 whitespace-nowrap">送金する</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex flex-col h-[400px]">
                    <div className="flex justify-between items-end mb-2"><p className="text-xs font-black font-bold tracking-wider">SOL 送金履歴</p></div>
                    <div className="flex-1 overflow-y-auto bg-white border-2 border-black p-2 space-y-2">
                        {transferHistory.length === 0 ? (<div className="h-full flex items-center justify-center text-gray-300 font-bold text-sm">送信履歴はありません</div>) : (
                            transferHistory.map((record) => (
                                <div key={record.id} className={`p-4 border border-gray-200 hover:border-black transition-colors duration-500 ${record.id === highlightId ? 'bg-[#EEFF77]' : 'bg-white'}`}>
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