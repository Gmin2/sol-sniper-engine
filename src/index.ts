import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { CONFIG } from './config/index.ts';
import { initDatabase } from './services/database.ts';
import { createOrderWorker } from './services/order-processor.ts';
import { orderRoutes } from './routes/orders.ts';
import { healthRoutes } from './routes/health.ts';
import {
  initializeRaydium,
  initializeMeteora,
} from './integrations/index.ts';
import logger from './utils/logger.ts';

// Initialize Solana and DEX SDKs
async function initSolana() {
  const connection = new Connection(CONFIG.solana.rpcUrl, 'confirmed');
  const secretKey = bs58.decode(CONFIG.solana.walletPrivateKey);
  const owner = Keypair.fromSecretKey(secretKey);

  const dexConfig = {
    connection,
    owner,
    cluster: CONFIG.solana.cluster,
  };

  logger.info('Initializing Raydium SDK...');
  await initializeRaydium(dexConfig);

  logger.info('Initializing Meteora SDK...');
  await initializeMeteora(dexConfig);

  logger.info('DEX SDKs initialized');
}

// Create Fastify app
const app = Fastify({
  trustProxy: true,
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  },
});

// Register plugins
app.register(cors);
app.register(websocket);

// Initialize Redis connection
const redisConnection = new Redis({
  host: CONFIG.redis.host,
  port: CONFIG.redis.port,
  ...(CONFIG.redis.password && { password: CONFIG.redis.password }),
  maxRetriesPerRequest: null,
});

// Create BullMQ Queue
const orderQueue = new Queue('sniper-orders', {
  connection: redisConnection,
});

// Create worker
const worker = createOrderWorker(redisConnection);

// Register routes
app.register(async function (fastify) {
  await orderRoutes(fastify, orderQueue);
  await healthRoutes(fastify, redisConnection);
});

async function start() {
  try {
    // Initialize database
    await initDatabase();

    // Initialize Solana and DEX SDKs
    await initSolana();

    // Start Fastify server
    await app.listen({ port: CONFIG.port, host: '0.0.0.0' });

    logger.info('Sniper Order Execution Engine Started!');
    logger.info(`HTTP Server: http://localhost:${CONFIG.port}`);
    logger.info(`WebSocket endpoint: ws://localhost:${CONFIG.port}/api/orders/execute`);
    logger.info('  (Connect via WebSocket, then send order JSON as first message)');
    logger.info(`PostgreSQL: ${CONFIG.database.host}:${CONFIG.database.port}`);
    logger.info(`Redis: ${CONFIG.redis.host}:${CONFIG.redis.port}`);
    logger.info(`Workers: ${CONFIG.queue.concurrency} concurrent`);
    logger.info('Ready to accept orders!');

  } catch (error) {
    logger.error({ err: error as Error }, 'Failed to start server');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  await worker.close();
  await orderQueue.close();
  await redisConnection.quit();
  const { pgPool } = await import('./services/database.ts');
  await pgPool.end();
  await app.close();
  process.exit(0);
});

start();
