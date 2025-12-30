import { NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const NETWORK_URL = process.env.NEXT_PUBLIC_SOLANA_NETWORK!;
// 配布用ウォレットの秘密鍵 (配列形式の文字列)
const ADMIN_SECRET = JSON.parse(process.env.ADMIN_SECRET_KEY || "[]");

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, userId, amount, durationHours, lockId, userAddress } = body;

    // --- ロック作成 (Gas無料) ---
    if (action === 'create') {
      const now = new Date();
      // 終了時間を計算
      const endsAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);
      
      // リワード計算 (年利5% = 0.05)
      // リワード = 金額 * 0.05 * (時間 / 24 / 365)
      // ※ 簡易計算: 時間 / 8760時間
      const apy = 0.05;
      const reward = amount * apy * (durationHours / 8760);

      const { error } = await supabase.from('box_locks').insert([{
        user_id: userId,
        amount: amount,
        duration_hours: durationHours,
        reward_amount: reward,
        ends_at: endsAt.toISOString(),
        status: 'active'
      }]);

      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    // --- ロック解除 & リワード付与 ---
    if (action === 'unlock') {
      // 1. ロック情報を取得
      const { data: lockData, error } = await supabase
        .from('box_locks')
        .select('*')
        .eq('id', lockId)
        .eq('user_id', userId)
        .single();

      if (error || !lockData) throw new Error("ロック情報が見つかりません");
      if (lockData.status !== 'active') throw new Error("既に解除済みです");

      // 2. 時間チェック
      if (new Date() < new Date(lockData.ends_at)) {
        throw new Error("まだロック期間中です");
      }

      // 3. 運営ウォレットからリワードのみ送金
      const connection = new Connection(NETWORK_URL, "confirmed");
      const adminWallet = Keypair.fromSecretKey(new Uint8Array(ADMIN_SECRET));
      const recipient = new PublicKey(userAddress);
      const rewardLamports = Math.floor(lockData.reward_amount * LAMPORTS_PER_SOL);

      // 残高チェック
      const adminBalance = await connection.getBalance(adminWallet.publicKey);
      if (adminBalance < rewardLamports) {
        throw new Error("運営ウォレットの残高不足によりリワードを付与できません");
      }

      // 送金トランザクション
      if (rewardLamports > 0) {
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: adminWallet.publicKey,
            toPubkey: recipient,
            lamports: rewardLamports,
          })
        );
        await sendAndConfirmTransaction(connection, transaction, [adminWallet]);
      }

      // 4. ステータス更新 (解除済みにする)
      await supabase.from('box_locks').update({ status: 'claimed' }).eq('id', lockId);

      // 5. 履歴に記録
      await supabase.from('transaction_history').insert([{
        user_id: userId,
        type: 'Reward', // 'Reward'がない場合は 'Deposit' 等
        amount: lockData.reward_amount,
        gas: 0
      }]);

      return NextResponse.json({ success: true, reward: lockData.reward_amount });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}