use anchor_lang::prelude::*;
use anchor_lang::system_program; // システムプログラム（送金用）を利用

// ★ご自身のProgram IDのままにしてください
declare_id!("5Y7L91KtvUumZo5fXLXtbCfpHRNYsLmV6kwsSBRUsvxT");

#[program]
pub mod save_to_grow {
    use super::*;

    // 1. 初期化（金庫とリワードBOXを作る）
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // Vaultの初期化
        let vault = &mut ctx.accounts.vault;
        vault.user = ctx.accounts.user.key();
        vault.balance = 0;
        vault.bump = ctx.bumps.vault;
        
        // ★リワード計算用に現在時刻を記録
        let clock = Clock::get()?;
        vault.last_update_time = clock.unix_timestamp;

        // ★リワードBoxの初期化
        let reward_box = &mut ctx.accounts.reward_box;
        reward_box.balance = 0;
        reward_box.bump = ctx.bumps.reward_box;

        Ok(())
    }

    // 2. 入金（リワード計算 → 入金）
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        // 先にリワードを更新
        update_rewards(
            &mut ctx.accounts.vault, 
            &mut ctx.accounts.reward_box
        )?;

        let vault = &mut ctx.accounts.vault;
        let user = &ctx.accounts.user;

        // ユーザーからVaultへSOLを移動
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: user.to_account_info(),
                to: vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        // 残高更新
        vault.balance += amount;
        Ok(())
    }

    // 3. 出金（リワード計算 → 出金）
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        // 先にリワードを更新
        update_rewards(
            &mut ctx.accounts.vault, 
            &mut ctx.accounts.reward_box
        )?;

        let vault = &mut ctx.accounts.vault;
        let user = &ctx.accounts.user;
        
        // Vaultから減らす
        **vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        // ユーザーへ増やす
        **user.to_account_info().try_borrow_mut_lamports()? += amount;

        // 残高更新
        vault.balance -= amount;
        Ok(())
    }

    // ★4. 送金機能（修正版）
    pub fn transfer(ctx: Context<TransferSol>, amount: u64) -> Result<()> {
        // 先にリワードを更新
        update_rewards(
            &mut ctx.accounts.vault, 
            &mut ctx.accounts.reward_box
        )?;

        let vault = &mut ctx.accounts.vault;
        
        // 【修正箇所】システムプログラムを使わず、直接残高を移動させる
        // 1. Vaultから減らす
        **vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        
        // 2. 送金先（Recipient）へ増やす
        **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += amount;

        // データ上の残高も更新
        vault.balance -= amount;

        Ok(())
    }
}

// --- ヘルパー関数: リワード計算ロジック ---
// 1分ごとに残高の1%をリワードBoxに加算する
fn update_rewards(vault: &mut Account<Vault>, reward_box: &mut Account<RewardBox>) -> Result<()> {
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;
    let last_update = vault.last_update_time;

    // 経過秒数
    let diff = current_time - last_update;

    // 1秒以上経過していたら計算
    if diff >= 1 {
        // リワード計算: 残高 * 0.01% * 経過秒数
        // 0.01% = 0.0001 = 1 / 10000
        
        // ※Solanaは整数演算なので、先に掛けてから割る
        let reward_amount = (vault.balance as u128 * diff as u128 / 10000) as u64;

        // リワード加算
        reward_box.balance += reward_amount;
        
        // 最終更新時刻を現在に更新
        vault.last_update_time = current_time;
    }

    Ok(())
}


// --- Account Structures ---

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 8 + 1 + 8, // 容量拡張: last_update_time(8byte)を追加
        seeds = [b"vault", user.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    // ★追加: リワード専用Box
    #[account(
        init,
        payer = user,
        space = 8 + 8 + 1, // discriminator + balance + bump
        seeds = [b"reward", user.key().as_ref()], // seedを変えて別の箱にする
        bump
    )]
    pub reward_box: Account<'info, RewardBox>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // ★追加: リワード計算のために必要
    #[account(
        mut,
        seeds = [b"reward", user.key().as_ref()],
        bump = reward_box.bump,
    )]
    pub reward_box: Account<'info, RewardBox>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump = vault.bump,
        has_one = user,
    )]
    pub vault: Account<'info, Vault>,

    // ★追加
    #[account(
        mut,
        seeds = [b"reward", user.key().as_ref()],
        bump = reward_box.bump,
    )]
    pub reward_box: Account<'info, RewardBox>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ★追加: 送金用コンテキスト
#[derive(Accounts)]
pub struct TransferSol<'info> {
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump = vault.bump,
        has_one = user,
    )]
    pub vault: Account<'info, Vault>,

    // ★追加
    #[account(
        mut,
        seeds = [b"reward", user.key().as_ref()],
        bump = reward_box.bump,
    )]
    pub reward_box: Account<'info, RewardBox>,

    #[account(mut)]
    pub user: Signer<'info>, // 実行者（Vaultの持ち主）
    
    /// CHECK: 任意の送金先アドレスなのでチェック不要だがSystemAccount推奨
    #[account(mut)] 
    pub recipient: SystemAccount<'info>, // ★送金先
    
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Vault {
    pub user: Pubkey,
    pub balance: u64,
    pub bump: u8,
    pub last_update_time: i64, // ★追加: 最終リワード更新時刻
}

// ★追加: リワードBOXのアカウント構造
#[account]
pub struct RewardBox {
    pub balance: u64, // 貯まったリワードポイント
    pub bump: u8,
}