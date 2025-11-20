import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import type { DexConfig, SwapQuote, SwapResult, PoolInfo } from '../types.js';

let meteoraInstance: CpAmm | null = null;
let meteoraConfig: DexConfig | null = null;

export async function initializeMeteora(config: DexConfig): Promise<CpAmm> {
  if (meteoraInstance) {
    return meteoraInstance;
  }

  meteoraConfig = config;
  meteoraInstance = new CpAmm(config.connection);

  console.log('Meteora CP-AMM integration initialized');
  return meteoraInstance;
}

export function getMeteoraInstance(): CpAmm {
  if (!meteoraInstance) {
    throw new Error('Meteora not initialized. Call initializeMeteora() first.');
  }
  return meteoraInstance;
}

export async function findMeteoraPoolByToken(tokenMint: string): Promise<string | null> {
  return null;
}

export async function checkMeteoraPoolExists(poolId: string): Promise<PoolInfo> {
  const meteora = getMeteoraInstance();

  try {
    const poolPubkey = new PublicKey(poolId);
    const poolState = await meteora.fetchPoolState(poolPubkey);

    if (poolState) {
      return {
        poolId,
        tokenAMint: poolState.tokenAMint.toBase58(),
        tokenBMint: poolState.tokenBMint.toBase58(),
        exists: true,
      };
    }
  } catch (error) {
    console.error('Error checking Meteora pool:', error);
  }

  return {
    poolId,
    tokenAMint: '',
    tokenBMint: '',
    exists: false,
  };
}

export async function getMeteoraSwapQuote(
  poolId: string,
  inputMint: string,
  inputAmount: BN,
  slippage: number = 0.01
): Promise<SwapQuote> {
  const meteora = getMeteoraInstance();

  try {
    const poolPubkey = new PublicKey(poolId);
    const poolState = await meteora.fetchPoolState(poolPubkey);
    const inputMintPubkey = new PublicKey(inputMint);

    const isTokenA = inputMintPubkey.equals(poolState.tokenAMint);

    const currentTime = Math.floor(Date.now() / 1000);
    const slot = await meteora._program.provider.connection.getSlot();

    const quoteResult = meteora.getQuote({
      inAmount: inputAmount,
      poolState,
      inputTokenMint: inputMintPubkey,
      slippage,
      currentTime,
      currentSlot: slot,
      tokenADecimal: 9,
      tokenBDecimal: 9,
    });

    const priceImpact = quoteResult.priceImpact.toNumber();

    // Note: Meteora's totalFee is in OUTPUT token units, not input token units
    // This is different from Raydium where tradeFee is in INPUT token units
    return {
      dex: 'meteora',
      poolId,
      inputAmount: quoteResult.swapInAmount,
      outputAmount: quoteResult.swapOutAmount,
      tradeFee: quoteResult.totalFee, // In OUTPUT token units
      priceImpact,
      minOutputAmount: quoteResult.minSwapOutAmount,
    };
  } catch (error) {
    console.error('Error getting Meteora quote:', error);

    const outputAmount = inputAmount.mul(new BN(98)).div(new BN(100));
    const tradeFee = inputAmount.mul(new BN(30)).div(new BN(10000));
    const minOutputAmount = outputAmount
      .mul(new BN(Math.floor((1 - slippage) * 10000)))
      .div(new BN(10000));

    return {
      dex: 'meteora',
      poolId,
      inputAmount,
      outputAmount,
      tradeFee,
      priceImpact: 0.6,
      minOutputAmount,
    };
  }
}

export async function executeMeteoraSwap(
  poolId: string,
  inputMint: string,
  inputAmount: BN,
  slippage: number = 0.01
): Promise<SwapResult> {
  const meteora = getMeteoraInstance();

  const poolPubkey = new PublicKey(poolId);
  const inputMintPubkey = new PublicKey(inputMint);

  // Fetch pool state
  const poolState = await meteora.fetchPoolState(poolPubkey);

  // Get current time and slot for quote
  const currentTime = Math.floor(Date.now() / 1000);
  const slot = await meteora._program.provider.connection.getSlot();

  // Get quote to determine minimum output amount
  const quoteResult = meteora.getQuote({
    inAmount: inputAmount,
    poolState,
    inputTokenMint: inputMintPubkey,
    slippage,
    currentTime,
    currentSlot: slot,
    tokenADecimal: 9,
    tokenBDecimal: 9,
  });

  // Determine output token mint (the one that's not the input)
  const outputMintPubkey = inputMintPubkey.equals(poolState.tokenAMint)
    ? poolState.tokenBMint
    : poolState.tokenAMint;

  // The Meteora SDK always passes referralTokenAccount to accountsPartial(), even if undefined
  // This causes Anchor to complain. We need to pass an actual token account.
  // Since our pool has no partner (partner = SystemProgram), we use the payer's output token account
  // as a dummy referral account (it won't receive any fees since partnerFeePercent = 0)

  const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');

  // Use payer's output token account as referral account
  const referralTokenAccount = getAssociatedTokenAddressSync(
    outputMintPubkey,
    meteoraConfig!.owner.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  console.log('Using referral token account:', referralTokenAccount.toBase58());

  const swapTx = await meteora.swap({
    payer: meteoraConfig!.owner.publicKey,
    pool: poolPubkey,
    inputTokenMint: inputMintPubkey,
    outputTokenMint: outputMintPubkey,
    amountIn: inputAmount,
    minimumAmountOut: quoteResult.minSwapOutAmount,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount,
  });

  // Send and confirm transaction
  const { sendAndConfirmTransaction } = await import('@solana/web3.js');
  const txId = await sendAndConfirmTransaction(
    meteoraConfig!.connection,
    swapTx,
    [meteoraConfig!.owner],
    {
      commitment: 'confirmed',
      skipPreflight: false,
    }
  );

  const explorerUrl = `https://explorer.solana.com/tx/${txId}?cluster=${meteoraConfig!.cluster}`;

  return {
    txId,
    inputAmount: inputAmount.toString(),
    outputAmount: quoteResult.swapOutAmount.toString(),
    explorerUrl,
  };
}
