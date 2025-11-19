import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const CONFIG = {
  port: parseInt(process.env.PORT || '3000'),
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

// REDIS + BULLMQ SETUP

const redisConnection = new Redis({
  host: CONFIG.redis.host,
  port: CONFIG.redis.port,
  maxRetriesPerRequest: null,
});

// Create BullMQ Queue
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
      if (ws.readyState === 1) { // 1 = OPEN state for WebSocket
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

      // Simulate pool monitoring (checking every 2 seconds for 30 seconds max)
      const poolFound = await simulatePoolMonitoring(orderId, order.tokenAddress);

      if (!poolFound) {
        throw new Error('Pool not found within timeout');
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

      const bestRoute = await getBestRoute(order);

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

      // Simulate transaction execution
      const txHash = await simulateTransactionExecution(bestRoute, order);
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

// mock function to quickstart

async function simulatePoolMonitoring(orderId: string, tokenAddress: string): Promise<boolean> {
  // Simulate checking for pool every 2 seconds
  // In real implementation, this would check Raydium/Meteora for pool existence

  const maxAttempts = 15; // 30 seconds max
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);

    // For demo: pool "found" after 6 seconds
    if (i >= 2) {
      return true;
    }

    console.log(`  Checking for pool... attempt ${i + 1}/${maxAttempts}`);
  }

  return false;
}

async function getBestRoute(order: any) {
  // Mock DEX quotes with slight price difference
  const raydiumQuote = {
    outputAmount: 95000 + Math.random() * 5000,
    fee: 0.0025, // 0.25%
  };

  const meteoraQuote = {
    outputAmount: 93000 + Math.random() * 7000,
    fee: 0.002, // 0.20%
  };

  console.log(` Raydium: ${raydiumQuote.outputAmount.toFixed(2)} tokens (fee: ${(raydiumQuote.fee * 100).toFixed(2)}%)`);
  console.log(` Meteora: ${meteoraQuote.outputAmount.toFixed(2)} tokens (fee: ${(meteoraQuote.fee * 100).toFixed(2)}%)`);

  const selectedDex = raydiumQuote.outputAmount > meteoraQuote.outputAmount ? 'raydium' : 'meteora';
  const reason = raydiumQuote.outputAmount > meteoraQuote.outputAmount
    ? 'Better output amount'
    : 'Better output amount';

  console.log(`  Selected: ${selectedDex} (${reason})`);

  return {
    dex: selectedDex,
    raydiumQuote,
    meteoraQuote,
    reason,
  };
}

async function simulateTransactionExecution(route: any, order: any): Promise<string> {
  // Mock transaction hash
  // In real implementation, this would execute actual swap on Solana
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let txHash = '';
  for (let i = 0; i < 88; i++) {
    txHash += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return txHash;
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

// HTTP POST endpoint
fastify.post('/api/orders/execute', async (request, reply) => {
  const order = request.body as any;

  // Validate input
  if (!order.tokenAddress || !order.amountIn || !order.slippage) {
    return reply.code(400).send({
      error: 'Invalid order',
      message: 'tokenAddress, amountIn, and slippage are required',
    });
  }

  // Generate order ID
  const orderId = randomUUID();

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

  console.log(`\n New order received: ${orderId}`);
  console.log(`   Token: ${order.tokenAddress}`);
  console.log(`   Amount: ${order.amountIn} SOL`);
  console.log(`   Slippage: ${order.slippage}%`);

  // Return order ID immediately
  return reply.code(200).send({
    orderId,
    status: 'pending',
    message: 'Order queued successfully. Connect to WebSocket for live updates.',
    wsUrl: `ws://localhost:${CONFIG.port}/ws/orders/${orderId}`,
  });
});

// WebSocket endpoint
fastify.get('/ws/orders/:orderId', { websocket: true }, (socket, request) => {
  const { orderId } = request.params as any;

  console.log(`WebSocket connected for order: ${orderId}`);

  // Store socket connection
  if (!wsConnections.has(orderId)) {
    wsConnections.set(orderId, new Set());
  }
  wsConnections.get(orderId)!.add(socket);

  // Send initial connection message
  socket.send(JSON.stringify({
    orderId,
    message: 'Connected to order status stream',
    connected: true,
  }));

  // Handle disconnect
  socket.on('close', () => {
    console.log(`WebSocket disconnected for order: ${orderId}`);
    const connections = wsConnections.get(orderId);
    if (connections) {
      connections.delete(socket);
      if (connections.size === 0) {
        wsConnections.delete(orderId);
      }
    }
  });

  socket.on('error', (err: any) => {
    console.error(`WebSocket error for order ${orderId}:`, err);
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

    // Start Fastify server
    await app.listen({ port: CONFIG.port, host: '0.0.0.0' });

    console.log('\n Sniper Order Execution Engine Started!');
    console.log(` HTTP Server: http://localhost:${CONFIG.port}`);
    console.log(` WebSocket: ws://localhost:${CONFIG.port}/ws/orders/{orderId}`);
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
