import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CpAmm, derivePoolAddress, derivePositionAddress, getSqrtPriceFromPrice } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Devnet config address from Meteora docs
const DEVNET_CONFIG = '8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF';

async function createMeteoraPool(
  connection: Connection,
  cpAmm: CpAmm,
  owner: Keypair,
  tokenMint: string,
  tokenName: string,
  tokenAmount: number,
  solAmount: number
) {
  console.log(`\nCreating Meteora pool for ${tokenName} (${tokenMint})...`);

  const config = new PublicKey(DEVNET_CONFIG);
  const configState = await cpAmm.fetchConfigState(config);

  const tokenAMint = new PublicKey(tokenMint);
  const tokenBMint = new PublicKey(SOL_MINT);

  // Calculate amounts
  const tokenADecimals = 9;
  const tokenBDecimals = 9;
  const initialPrice = 0.00001; // 1 token = 0.00001 SOL (same as Raydium)

  const initialPoolTokenAAmount = new BN(tokenAmount).mul(new BN(10 ** tokenADecimals));
  const initialPoolTokenBAmount = new BN(solAmount).mul(new BN(10 ** tokenBDecimals));

  const initSqrtPrice = getSqrtPriceFromPrice(
    initialPrice.toString(),
    tokenADecimals,
    tokenBDecimals
  );

  console.log(`  Initial price: ${initialPrice}`);
  console.log(`  Token A amount: ${tokenAmount} tokens`);
  console.log(`  Token B amount: ${solAmount / 1e9} SOL`);

  const liquidityDelta = cpAmm.getLiquidityDelta({
    maxAmountTokenA: initialPoolTokenAAmount,
    maxAmountTokenB: initialPoolTokenBAmount,
    sqrtPrice: initSqrtPrice,
    sqrtMinPrice: configState.sqrtMinPrice,
    sqrtMaxPrice: configState.sqrtMaxPrice,
  });

  console.log(`  Liquidity delta: ${liquidityDelta.toString()}`);

  // Generate position NFT
  const positionNft = Keypair.generate();

  // Create pool transaction
  const createPoolTx = await cpAmm.createPool({
    payer: owner.publicKey,
    creator: owner.publicKey,
    config: config,
    positionNft: positionNft.publicKey,
    tokenAMint: tokenAMint,
    tokenBMint: tokenBMint,
    tokenAAmount: initialPoolTokenAAmount,
    tokenBAmount: initialPoolTokenBAmount,
    liquidityDelta: liquidityDelta,
    initSqrtPrice: initSqrtPrice,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: false,
  });

  console.log('  Sending transaction...');

  const signature = await sendAndConfirmTransaction(
    connection,
    createPoolTx,
    [owner, positionNft],
    {
      commitment: 'confirmed',
      skipPreflight: false,
    }
  );

  const poolAddress = derivePoolAddress(config, tokenAMint, tokenBMint);
  const positionAddress = derivePositionAddress(positionNft.publicKey);

  console.log(`  Pool created successfully!`);
  console.log(`  Pool ID: ${poolAddress.toString()}`);
  console.log(`  Position: ${positionAddress.toString()}`);
  console.log(`  Position NFT: ${positionNft.publicKey.toString()}`);
  console.log(`  Tx Hash: ${signature}`);
  console.log(`  Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

  return {
    poolId: poolAddress.toString(),
    position: positionAddress.toString(),
    positionNft: positionNft.publicKey.toString(),
    txHash: signature,
  };
}

async function main() {
  console.log('Creating Meteora CP-AMM Pools on Devnet\n');
  console.log('========================================\n');

  // Load wallet
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('WALLET_PRIVATE_KEY not found in .env');
  }

  const secretKey = bs58.decode(privateKey);
  const owner = Keypair.fromSecretKey(secretKey);

  console.log(`Wallet: ${owner.publicKey.toString()}`);

  // Connect to devnet
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    'confirmed'
  );

  const balance = await connection.getBalance(owner.publicKey);
  console.log(`Balance: ${balance / 1e9} SOL\n`);

  if (balance < 3e9) {
    console.log('Warning: Low balance. You may need more SOL for gas fees.');
    console.log('Run: solana airdrop 2\n');
  }

  // Initialize Meteora SDK
  const cpAmm = new CpAmm(connection);

  // Read token info from test-pools.json
  const poolsData = JSON.parse(fs.readFileSync('test-pools.json', 'utf-8'));

  const results: any = {};

  // Create pools for each token
  for (const [key, poolInfo] of Object.entries(poolsData)) {
    if (!key.startsWith('raydium-pool')) continue;

    const pool: any = poolInfo;
    const tokenName = pool.name;
    const tokenMint = pool.tokenMint;

    try {
      const result = await createMeteoraPool(
        connection,
        cpAmm,
        owner,
        tokenMint,
        tokenName,
        100000, // 100k tokens
        1 // 1 SOL (will be multiplied by 10^9 in the function)
      );

      results[`meteora-${key.replace('raydium-', '')}`] = {
        name: tokenName,
        poolId: result.poolId,
        tokenMint: tokenMint,
        solMint: SOL_MINT,
        txHash: result.txHash,
        position: result.position,
        positionNft: result.positionNft,
        tokenAmount: 100000,
        solAmount: 1,
        dex: 'meteora',
      };

      // Wait a bit between pool creations
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error: any) {
      console.error(`  Failed to create pool for ${tokenName}:`, error.message);
    }
  }

  // Save results
  const updatedPools = { ...poolsData, ...results };
  fs.writeFileSync('test-pools.json', JSON.stringify(updatedPools, null, 2));

  console.log('\n========================================');
  console.log('All Meteora pools created!');
  console.log('Results saved to test-pools.json');
  console.log('========================================\n');
}

main().catch(console.error);
