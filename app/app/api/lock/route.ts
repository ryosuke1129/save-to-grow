import { NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const NETWORK_URL = process.env.NEXT_PUBLIC_SOLANA_NETWORK!;
const ADMIN_SECRET = JSON.parse(process.env.NEXT_PUBLIC_ADMIN_SECRET_KEY || "[]");

export async function POST(request: Request) {
  try {
    const body = await request.json();
    // ★ force を受け取れるように追加
    const { action, userId, amount, durationHours, lockId, userAddress, force } = body;

    // --- ロック作成 (Gas無料) ---
    if (action === 'create') {
      const now = new Date();
      const endsAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);
      
      // ★ リワード計算 (年利10% = 0.10 に変更)
      const apy = 0.10;
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
      const { data: lockData, error } = await supabase
        .from('box_locks')
        .select('*')
        .eq('id', lockId)
        .eq('user_id', userId)
        .single();

      if (error || !lockData) throw new Error("ロック情報が見つかりません");
      if (lockData.status !== 'active') throw new Error("既に解除済みです");

      // ★ 強制解除ロジック
      const isTimeOver = new Date() >= new Date(lockData.ends_at);
      
      // 期間中で、かつ強制解除フラグがない場合はエラー
      if (!isTimeOver && !force) {
        throw new Error("まだロック期間中です");
      }

      // ★ 期間中の強制解除ならリワードは0にする
      let finalRewardAmount = lockData.reward_amount;
      if (!isTimeOver && force) {
        finalRewardAmount = 0;
      }

      // 3. 運営ウォレットからリワード送金 (リワードがある場合のみ)
      if (finalRewardAmount > 0) {
        const connection = new Connection(NETWORK_URL, "confirmed");
        const adminWallet = Keypair.fromSecretKey(new Uint8Array(ADMIN_SECRET));
        const recipient = new PublicKey(userAddress);
        const rewardLamports = Math.floor(finalRewardAmount * LAMPORTS_PER_SOL);

        const adminBalance = await connection.getBalance(adminWallet.publicKey);
        if (adminBalance < rewardLamports) {
          throw new Error("運営ウォレットの残高不足によりリワードを付与できません");
        }

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

      return NextResponse.json({ success: true, reward: finalRewardAmount });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}