import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { createOrder } from '../services/database.ts';
import { wsConnections } from '../services/order-processor.ts';
import { CONFIG } from '../config/index.ts';
import logger from '../utils/logger.ts';

export async function orderRoutes(fastify: FastifyInstance, orderQueue: Queue) {

  // SINGLE ENDPOINT: POST /api/orders/execute
  // Task requirement: "Single endpoint handles both protocols"

  // HTTP POST: Submit order, returns orderId
  // Task requirement: "User submits order via POST /api/orders/execute"
  // Task requirement: "API validates order and returns orderId"
  fastify.post('/api/orders/execute', async (request, reply) => {
    const order = request.body as any;

    if (!order || !order.tokenAddress || !order.amountIn || !order.slippage) {
      return reply.code(400).send({
        error: 'Invalid order',
        message: 'tokenAddress, amountIn, and slippage are required',
      });
    }

    const orderId = randomUUID();

    logger.info(`HTTP POST order received: ${orderId}`);
    logger.info(`  Token: ${order.tokenAddress}`);
    logger.info(`  Amount: ${order.amountIn} SOL`);
    logger.info(`  Slippage: ${order.slippage}%`);

    await createOrder(orderId, order);

    await orderQueue.add(
      'sniper',
      { orderId, order },
      {
        attempts: CONFIG.queue.maxRetries,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    // Return orderId - client upgrades connection to WebSocket on SAME endpoint
    const protocol = request.protocol === 'https' ? 'wss' : 'ws';
    const host = request.hostname;
    return reply.code(200).send({
      orderId,
      status: 'pending',
      message: 'Order queued. Upgrade connection to WebSocket for live updates.',
      upgradeUrl: `${protocol}://${host}/api/orders/execute?orderId=${orderId}`,
    });
  });

  // SAME ENDPOINT: GET /api/orders/execute (WebSocket upgrade)
  // Task requirement: "Connection upgrades to WebSocket for status streaming"
  fastify.get('/api/orders/execute', { websocket: true }, async (socket, request) => {
    const query = request.query as any;
    const orderId = query.orderId;

    if (!orderId) {
      socket.send(JSON.stringify({
        error: 'Missing orderId',
        message: 'orderId query parameter is required',
      }));
      socket.close();
      return;
    }

    logger.info(`WebSocket upgrade for order: ${orderId}`);

    if (!wsConnections.has(orderId)) {
      wsConnections.set(orderId, new Set());
    }
    wsConnections.get(orderId)!.add(socket);

    socket.send(JSON.stringify({
      orderId,
      message: 'WebSocket connected. Streaming status updates...',
      connected: true,
    }));

    socket.on('close', () => {
      logger.info(`WebSocket disconnected for order: ${orderId}`);
      const connections = wsConnections.get(orderId);
      if (connections) {
        connections.delete(socket);
        if (connections.size === 0) {
          wsConnections.delete(orderId);
        }
      }
    });

    socket.on('error', (err: any) => {
      logger.error('WebSocket error:', err);
    });
  });

  // Get order by ID
  fastify.get('/api/orders/:id', async (request, reply) => {
    const { id } = request.params as any;

    const { pgPool } = await import('../services/database.js');
    const result = await pgPool.query(
      'SELECT * FROM orders WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Order not found' });
    }

    return reply.send(result.rows[0]);
  });
}
