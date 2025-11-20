import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';

import {
  initializeRaydium,
  checkRaydiumPoolExists,
  getRaydiumSwapQuote,
  executeRaydiumSwap,
} from './integrations/raydium.ts';
import {
  initializeMeteora,
  checkMeteoraPoolExists,
  getMeteoraSwapQuote,
  executeMeteoraSwap,
} from './integrations/meteora.ts';

dotenv.config();

const CONFIG = {
  port: parseInt(process.env.PORT || '3000'),
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    cluster: (process.env.SOLANA_CLUSTER || 'devnet') as 'mainnet' | 'devnet',
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY!,
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'sniper_engine',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  queue: {
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '10'),
    maxRetries: parseInt(process.env.MAX_RETRY_ATTEMPTS || '3'),
  },
};

const pgPool = new Pool(CONFIG.database);

async function initSolana() {
  const connection = new Connection(CONFIG.solana.rpcUrl, 'confirmed');
  const secretKey = bs58.decode(CONFIG.solana.walletPrivateKey);
  const owner = Keypair.fromSecretKey(secretKey);

  const dexConfig = {
    connection,
    owner,
    cluster: CONFIG.solana.cluster,
  };

  console.log(' Initializing Raydium SDK...');
  await initializeRaydium(dexConfig);

  console.log(' Initializing Meteora SDK...');
  await initializeMeteora(dexConfig);

  console.log(' DEX SDKs initialized');
}

// Initialize database schema
async function initDatabase() {
  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        token_address VARCHAR(50) NOT NULL,
        amount_in NUMERIC NOT NULL,
        slippage NUMERIC NOT NULL,
        selected_dex VARCHAR(20),
        tx_hash VARCHAR(100),
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    `);
    console.log(' Database initialized');
  } catch (error) {
    console.error(' Database initialization error:', error);
  } finally {
    client.release();
  }
}

const redisConnection = new Redis({
  host: CONFIG.redis.host,
  port: CONFIG.redis.port,
  maxRetriesPerRequest: null,
});

const orderQueue = new Queue('sniper-orders', {
  connection: redisConnection,
});

// WebSocket connections storage (orderId -> WebSocket connections)
const wsConnections = new Map<string, Set<any>>();

function broadcastToOrder(orderId: string, message: any) {
  const connections = wsConnections.get(orderId);
  if (connections) {
    const messageStr = JSON.stringify(message);
    connections.forEach((ws) => {
      if (ws.readyState === 1) { 
        // 1 = OPEN state for WebSocket
        ws.send(messageStr);
      }
    });
  }
}

async function createOrder(orderId: string, orderData: any) {
  await pgPool.query(
    `INSERT INTO orders (id, status, token_address, amount_in, slippage)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, 'pending', orderData.tokenAddress, orderData.amountIn, orderData.slippage]
  );
}

async function updateOrderStatus(orderId: string, status: string, data: any = {}) {
  const fields: string[] = ['status = $2', 'updated_at = NOW()'];
  const values: any[] = [orderId, status];
  let paramCount = 3;

  if (data.selectedDex) {
    fields.push(`selected_dex = $${paramCount}`);
    values.push(data.selectedDex);
    paramCount++;
  }

  if (data.txHash) {
    fields.push(`tx_hash = $${paramCount}`);
    values.push(data.txHash);
    paramCount++;
  }

  if (data.errorMessage) {
    fields.push(`error_message = $${paramCount}`);
    values.push(data.errorMessage);
    paramCount++;
  }

  await pgPool.query(
    `UPDATE orders SET ${fields.join(', ')} WHERE id = $1`,
    values
  );
}

const worker = new Worker(
  'sniper-orders',
  async (job) => {
    const { orderId, order } = job.data;

    console.log(`\n Processing order ${orderId}`);

    try {
      // STEP 1: PENDING
      await updateOrderStatus(orderId, 'pending');
      broadcastToOrder(orderId, {
        orderId,
        status: 'pending',
        message: 'Order received and queued'
      });
      await sleep(1000);

      // STEP 2: MONITORING
      await updateOrderStatus(orderId, 'monitoring');
      broadcastToOrder(orderId, {
        orderId,
        status: 'monitoring',
        message: `Monitoring for pool creation: ${order.tokenAddress.slice(0, 8)}...`
      });
      console.log(` Monitoring pool for token: ${order.tokenAddress}`);

      // Check for pool existence
      const poolCheck = await checkForPool(orderId, order.tokenAddress);

      if (!poolCheck.found) {
        throw new Error('Pool not found on any DEX');
      }

      // STEP 3: TRIGGERED
      await updateOrderStatus(orderId, 'triggered');
      broadcastToOrder(orderId, {
        orderId,
        status: 'triggered',
        message: 'Pool detected! Starting execution...'
      });
      console.log(` Pool found for ${order.tokenAddress}`);
      await sleep(1000);

      // STEP 4: ROUTING
      await updateOrderStatus(orderId, 'routing');
      broadcastToOrder(orderId, {
        orderId,
        status: 'routing',
        message: 'Comparing Raydium and Meteora quotes...'
      });
      console.log(` Fetching quotes from DEXs...`);

      const bestRoute = await getBestRoute(order, poolCheck.raydiumPoolId, poolCheck.meteoraPoolId);

      broadcastToOrder(orderId, {
        orderId,
        status: 'routing',
        message: `Best route selected: ${bestRoute.dex}`,
        routing: {
          raydium: bestRoute.raydiumQuote,
          meteora: bestRoute.meteoraQuote,
          selected: bestRoute.dex,
          reason: bestRoute.reason,
        }
      });
      await sleep(1000);

      // STEP 5: BUILDING
      await updateOrderStatus(orderId, 'building', { selectedDex: bestRoute.dex });
      broadcastToOrder(orderId, {
        orderId,
        status: 'building',
        message: `Building transaction on ${bestRoute.dex}...`,
        selectedDex: bestRoute.dex
      });
      console.log(` Building transaction on ${bestRoute.dex}...`);
      await sleep(2000);

      // STEP 6: SUBMITTED
      await updateOrderStatus(orderId, 'submitted');
      broadcastToOrder(orderId, {
        orderId,
        status: 'submitted',
        message: 'Transaction submitted to blockchain...'
      });
      console.log(` Transaction submitted...`);

      // Execute real swap on chosen DEX (Raydium or Meteora)
      const txHash = await executeTransaction(bestRoute, order);
      // Wait a bit for blockchain confirmation
      await sleep(3000);

      // STEP 7: CONFIRMED
      await updateOrderStatus(orderId, 'confirmed', { txHash });
      broadcastToOrder(orderId, {
        orderId,
        status: 'confirmed',
        message: 'Transaction confirmed!',
        txHash,
        explorerUrl: `https://explorer.solana.com/tx/${txHash}?cluster=devnet`
      });
      console.log(` Transaction confirmed: ${txHash}`);

      return { success: true, txHash };

    } catch (error: any) {
      console.error(` Order ${orderId} failed:`, error.message);

      await updateOrderStatus(orderId, 'failed', { errorMessage: error.message });
      broadcastToOrder(orderId, {
        orderId,
        status: 'failed',
        message: error.message,
        error: error.message
      });

      throw error; // Let BullMQ handle retry
    }
  },
  {
    connection: redisConnection,
    concurrency: CONFIG.queue.concurrency,
    limiter: {
      max: 100, // 100 jobs
      duration: 60000, // per minute
    },
    settings: {
      backoffStrategy: (attemptsMade: number) => {
        // Exponential backoff: 2s, 4s, 8s
        return Math.pow(2, attemptsMade) * 1000;
      },
    },
  }
);

// Worker event listeners
worker.on('completed', (job) => {
  console.log(` Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.log(` Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err.message);
});

// Real pool detection using Raydium and Meteora
async function checkForPool(orderId: string, tokenAddress: string): Promise<{ found: boolean; raydiumPoolId: string | null; meteoraPoolId: string | null }> {
  console.log(` Checking for pools for token: ${tokenAddress}`);

  let raydiumPoolId: string | null = null;
  let meteoraPoolId: string | null = null;

  // Check test-pools.json for known pools
  const fs = await import('fs');
  try {
    const poolsData = JSON.parse(fs.readFileSync('test-pools.json', 'utf-8'));

    // Check for Raydium pools
    for (const [key, pool] of Object.entries(poolsData)) {
      if (key.startsWith('raydium-pool')) {
        const poolInfo: any = pool;
        if (poolInfo.tokenMint === tokenAddress) {
          raydiumPoolId = poolInfo.poolId;
          console.log(`  Raydium pool found: ${raydiumPoolId}`);
        }
      }
    }

    // Check for Meteora pools
    for (const [key, pool] of Object.entries(poolsData)) {
      if (key.startsWith('meteora-pool')) {
        const poolInfo: any = pool;
        if (poolInfo.tokenMint === tokenAddress) {
          meteoraPoolId = poolInfo.poolId;
          console.log(`  Meteora pool found: ${meteoraPoolId}`);
        }
      }
    }
  } catch (error) {
    console.log('  No test-pools.json found, checking blockchain...');
  }

  // If not found in file, check blockchain
  if (!raydiumPoolId) {
    const raydiumPoolInfo = await checkRaydiumPoolExists(tokenAddress);
    if (raydiumPoolInfo.exists) {
      raydiumPoolId = raydiumPoolInfo.poolId;
      console.log(`  Raydium pool found on-chain: ${raydiumPoolId}`);
    }
  }

  if (!meteoraPoolId) {
    const meteoraPoolInfo = await checkMeteoraPoolExists(tokenAddress);
    if (meteoraPoolInfo.exists) {
      meteoraPoolId = meteoraPoolInfo.poolId;
      console.log(`  Meteora pool found on-chain: ${meteoraPoolId}`);
    }
  }

  const found = raydiumPoolId !== null || meteoraPoolId !== null;

  if (!found) {
    console.log('  No pools found on any DEX');
  }

  return { found, raydiumPoolId, meteoraPoolId };
}

async function getBestRoute(order: any, raydiumPoolId: string | null, meteoraPoolId: string | null) {
  console.log(` Getting quotes from DEXs...`);

  const inputAmount = new BN(order.amountIn);
  const slippage = parseFloat(order.slippage);

  let raydiumQuote, meteoraQuote;

  // Get Raydium quote
  if (raydiumPoolId) {
    try {
      raydiumQuote = await getRaydiumSwapQuote(raydiumPoolId, 'So11111111111111111111111111111111111111112', inputAmount, slippage);
      console.log(` Raydium: ${raydiumQuote.outputAmount.toString()} tokens (fee: ${raydiumQuote.tradeFee.toString()}, impact: ${raydiumQuote.priceImpact.toFixed(2)}%)`);
    } catch (error: any) {
      console.log(` Raydium quote failed: ${error.message}`);
    }
  } else {
    console.log(` Raydium: No pool available`);
  }

  // Get Meteora quote
  if (meteoraPoolId) {
    try {
      meteoraQuote = await getMeteoraSwapQuote(meteoraPoolId, 'So11111111111111111111111111111111111111112', inputAmount, slippage);
      console.log(` Meteora: ${meteoraQuote.outputAmount.toString()} tokens (fee: ${meteoraQuote.tradeFee.toString()}, impact: ${meteoraQuote.priceImpact.toFixed(2)}%)`);
    } catch (error: any) {
      console.log(` Meteora quote failed: ${error.message}`);
    }
  } else {
    console.log(` Meteora: No pool available`);
  }

  // Select best route based on output amount
  if (!raydiumQuote && !meteoraQuote) {
    throw new Error('No quotes available from any DEX');
  }

  let selectedDex: string;
  let selectedPoolId: string;
  let reason: string;

  if (!meteoraQuote && raydiumQuote) {
    selectedDex = 'raydium';
    selectedPoolId = raydiumPoolId!;
    reason = 'Only Raydium available';
  } else if (!raydiumQuote && meteoraQuote) {
    selectedDex = 'meteora';
    selectedPoolId = meteoraPoolId!;
    reason = 'Only Meteora available';
  } else if (raydiumQuote && meteoraQuote) {
    const raydiumOutput = raydiumQuote.outputAmount.toNumber();
    const meteoraOutput = meteoraQuote.outputAmount.toNumber();

    if (raydiumOutput > meteoraOutput) {
      selectedDex = 'raydium';
      selectedPoolId = raydiumPoolId!;
      reason = `Better output: ${raydiumOutput.toLocaleString()} vs ${meteoraOutput.toLocaleString()}`;
    } else {
      selectedDex = 'meteora';
      selectedPoolId = meteoraPoolId!;
      reason = `Better output: ${meteoraOutput.toLocaleString()} vs ${raydiumOutput.toLocaleString()}`;
    }
  } else {
    throw new Error('Unexpected state: quotes exist but cannot select DEX');
  }

  console.log(`  Selected: ${selectedDex} (${reason})`);

  return {
    dex: selectedDex,
    poolId: selectedPoolId,
    raydiumQuote,
    meteoraQuote,
    selectedQuote: selectedDex === 'raydium' ? raydiumQuote : meteoraQuote,
    reason,
  };
}

async function executeTransaction(route: any, order: any): Promise<string> {
  console.log(`  Executing swap on ${route.dex}...`);

  const inputAmount = new BN(order.amountIn);
  const slippage = parseFloat(order.slippage);

  if (route.dex === 'raydium') {
    const result = await executeRaydiumSwap(
      route.poolId,
      'So11111111111111111111111111111111111111112',
      inputAmount,
      slippage
    );

    console.log(`  Swap executed: ${result.txId}`);
    console.log(`  Explorer: ${result.explorerUrl}`);

    return result.txId;
  } else if (route.dex === 'meteora') {
    const result = await executeMeteoraSwap(
      route.poolId,
      'So11111111111111111111111111111111111111112',
      inputAmount,
      slippage
    );

    console.log(`  Swap executed: ${result.txId}`);
    console.log(`  Explorer: ${result.explorerUrl}`);

    return result.txId;
  } else {
    throw new Error(`Unknown DEX: ${route.dex}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const app = Fastify({
  logger: true,
});

// Register plugins
app.register(cors);
app.register(websocket);

// Register routes inside a plugin context
app.register(async function (fastify) {

// Single endpoint that handles both HTTP and WebSocket
// For WebSocket: Client connects, then sends order data as first message
// For HTTP POST: Returns error asking client to use WebSocket
fastify.post('/api/orders/execute', async (request, reply) => {
  return reply.code(400).send({
    error: 'WebSocket connection required',
    message: 'Please connect via WebSocket to ws://localhost:3000/api/orders/execute and send order data as first message.',
  });
});

fastify.get('/api/orders/execute', { websocket: true }, async (socket, request) => {
  console.log('\nWebSocket connection established');

  let orderId: string | null = null;
  let orderProcessed = false;

  // Wait for order data from client
  socket.on('message', async (data) => {
    // Only process the first message as order data
    if (orderProcessed) {
      return;
    }
    orderProcessed = true;

    let order: any;
    try {
      order = JSON.parse(data.toString());

      if (!order || !order.tokenAddress || !order.amountIn || !order.slippage) {
        socket.send(JSON.stringify({
          error: 'Invalid order',
          message: 'tokenAddress, amountIn, and slippage are required',
        }));
        socket.close();
        return;
      }
    } catch (error: any) {
      socket.send(JSON.stringify({
        error: 'Invalid JSON',
        message: error.message,
      }));
      socket.close();
      return;
    }

    // Generate order ID
    orderId = randomUUID();

    console.log(`\n New order received: ${orderId}`);
    console.log(`   Token: ${order.tokenAddress}`);
    console.log(`   Amount: ${order.amountIn} SOL`);
    console.log(`   Slippage: ${order.slippage}%`);

    // Register socket for this order
    if (!wsConnections.has(orderId)) {
      wsConnections.set(orderId, new Set());
    }
    wsConnections.get(orderId)!.add(socket);

    // Send orderId immediately via WebSocket
    socket.send(JSON.stringify({
      orderId,
      status: 'pending',
      message: 'Order received and queued. Streaming updates...',
    }));

    // Save to database
    await createOrder(orderId, order);

    // Add to BullMQ queue
    await orderQueue.add(
      'sniper',
      { orderId, order },
      {
        attempts: CONFIG.queue.maxRetries,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );
  });

  // Handle disconnect
  socket.on('close', () => {
    if (orderId) {
      console.log(`WebSocket disconnected for order: ${orderId}`);
      const connections = wsConnections.get(orderId);
      if (connections) {
        connections.delete(socket);
        if (connections.size === 0) {
          wsConnections.delete(orderId);
        }
      }
    } else {
      console.log('WebSocket disconnected (no order was placed)');
    }
  });

  socket.on('error', (err: any) => {
    console.error(`WebSocket error:`, err);
  });
});


fastify.get('/api/orders/:id', async (request, reply) => {
  const { id } = request.params as any;

  const result = await pgPool.query(
    'SELECT * FROM orders WHERE id = $1',
    [id]
  );

  if (result.rows.length === 0) {
    return reply.code(404).send({ error: 'Order not found' });
  }

  return reply.send(result.rows[0]);
});

fastify.get('/health', async (request, reply) => {
  try {
    await pgPool.query('SELECT 1');
    await redisConnection.ping();

    return reply.send({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        postgres: 'connected',
        redis: 'connected',
        queue: 'running',
      },
    });
  } catch (error: any) {
    return reply.code(503).send({
      status: 'unhealthy',
      error: error.message,
    });
  }
});

}); // Close the register function

async function start() {
  try {
    // Initialize database
    await initDatabase();

    // Initialize Solana and DEX SDKs
    await initSolana();

    // Start Fastify server
    await app.listen({ port: CONFIG.port, host: '0.0.0.0' });

    console.log('\n Sniper Order Execution Engine Started!');
    console.log(` HTTP Server: http://localhost:${CONFIG.port}`);
    console.log(` WebSocket endpoint: ws://localhost:${CONFIG.port}/api/orders/execute`);
    console.log(`   (Connect via WebSocket, then send order JSON as first message)`);
    console.log(` PostgreSQL: ${CONFIG.database.host}:${CONFIG.database.port}`);
    console.log(` Redis: ${CONFIG.redis.host}:${CONFIG.redis.port}`);
    console.log(` Workers: ${CONFIG.queue.concurrency} concurrent`);
    console.log('\n Ready to accept orders!\n');

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n Shutting down gracefully...');
  await worker.close();
  await orderQueue.close();
  await redisConnection.quit();
  await pgPool.end();
  await app.close();
  process.exit(0);
});

start();
