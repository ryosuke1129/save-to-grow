const anchor = require("@coral-xyz/anchor");
const { SystemProgram } = anchor.web3;
const assert = require("assert");

describe("save-to-grow", () => {
  // 環境設定を読み込む
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SaveToGrow;

  // テストで使う変数
  let vaultPda; // 貯金箱のアドレス(PDA)
  let vaultBump;

  it("1. 貯金箱（Vault）を作成できる", async () => {
    // PDA（貯金箱のアドレス）を計算する
    // ルール: "vault" + ユーザーの公開鍵 = その人の貯金箱アドレス
    [vaultPda, vaultBump] = await anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    // initialize関数を呼び出す
    await program.methods
      .initialize()
      .accounts({
        vault: vaultPda,
        user: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // 正しくデータが作られたか確認
    const account = await program.account.vault.fetch(vaultPda);
    console.log("  Owner:", account.owner.toString());
    console.log("  Balance:", account.balance.toString());
    
    assert.ok(account.owner.equals(provider.wallet.publicKey));
  });

  it("2. お金を入金（Deposit）できる", async () => {
    const depositAmount = new anchor.BN(1000000000); // 1 SOL (lamports単位)

    // deposit関数を呼び出す
    await program.methods
      .deposit(depositAmount)
      .accounts({
        vault: vaultPda,
        user: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // 残高が増えているか確認
    const account = await program.account.vault.fetch(vaultPda);
    console.log("  New Balance:", account.balance.toString());

    assert.ok(account.balance.eq(depositAmount));
  });
});