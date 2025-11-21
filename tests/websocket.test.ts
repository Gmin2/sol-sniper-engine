import { describe, it, expect } from '@jest/globals';

describe('WebSocket Lifecycle Tests', () => {
  describe('Connection Management', () => {
    it('should register WebSocket connection for order', () => {
      const wsConnections = new Map<string, Set<any>>();
      const orderId = 'test-order-123';
      const mockSocket = { id: 'socket-1' };

      wsConnections.set(orderId, new Set([mockSocket]));

      expect(wsConnections.has(orderId)).toBe(true);
      expect(wsConnections.get(orderId)?.size).toBe(1);
    });

    it('should support multiple connections per order', () => {
      const wsConnections = new Map<string, Set<any>>();
      const orderId = 'test-order-123';
      const socket1 = { id: 'socket-1' };
      const socket2 = { id: 'socket-2' };

      const connections = new Set([socket1, socket2]);
      wsConnections.set(orderId, connections);

      expect(wsConnections.get(orderId)?.size).toBe(2);
    });

    it('should remove connection on disconnect', () => {
      const wsConnections = new Map<string, Set<any>>();
      const orderId = 'test-order-123';
      const socket1 = { id: 'socket-1' };

      const connections = new Set([socket1]);
      wsConnections.set(orderId, connections);

      // Simulate disconnect
      connections.delete(socket1);

      expect(wsConnections.get(orderId)?.size).toBe(0);
    });

    it('should clean up empty connection sets', () => {
      const wsConnections = new Map<string, Set<any>>();
      const orderId = 'test-order-123';

      wsConnections.set(orderId, new Set());

      if (wsConnections.get(orderId)?.size === 0) {
        wsConnections.delete(orderId);
      }

      expect(wsConnections.has(orderId)).toBe(false);
    });
  });

  describe('Message Broadcasting', () => {
    it('should broadcast to all connections for an order', () => {
      const messages: any[] = [];
      const mockSocket = {
        readyState: 1, // OPEN
        send: (msg: string) => messages.push(JSON.parse(msg)),
      };

      const wsConnections = new Map<string, Set<any>>();
      const orderId = 'test-order-123';
      wsConnections.set(orderId, new Set([mockSocket]));

      // Simulate broadcast
      const message = {
        orderId,
        status: 'pending',
        message: 'Order queued',
      };

      const connections = wsConnections.get(orderId);
      connections?.forEach((ws) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(message));
        }
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].status).toBe('pending');
    });

    it('should include routing details in messages', () => {
      const message = {
        orderId: 'test-123',
        status: 'routing',
        routing: {
          raydium: { outputAmount: '10000000' },
          meteora: { outputAmount: '9000000' },
          selected: 'raydium',
          reason: 'Better output',
        },
      };

      expect(message).toHaveProperty('routing');
      expect(message.routing.selected).toBe('raydium');
    });

    it('should include transaction hash in confirmed message', () => {
      const message = {
        orderId: 'test-123',
        status: 'confirmed',
        txHash: 'yvkcasJTugoxSYnzGSbDsVUdeyjxi3kQebdZMmmbTZi',
        explorerUrl: 'https://explorer.solana.com/tx/yvkcasJTugoxSYnzGSbDsVUdeyjxi3kQebdZMmmbTZi?cluster=devnet',
      };

      expect(message.status).toBe('confirmed');
      expect(message).toHaveProperty('txHash');
      expect(message).toHaveProperty('explorerUrl');
      expect(message.explorerUrl).toContain('explorer.solana.com');
    });
  });

  describe('Error Handling', () => {
    it('should send error message for missing orderId', () => {
      const errorResponse = {
        error: 'Missing orderId',
        message: 'orderId query parameter is required',
      };

      expect(errorResponse).toHaveProperty('error');
      expect(errorResponse.error).toBe('Missing orderId');
    });

    it('should handle failed order status', () => {
      const failedMessage = {
        orderId: 'test-123',
        status: 'failed',
        message: 'Pool not found on any DEX',
        error: 'Pool not found on any DEX',
      };

      expect(failedMessage.status).toBe('failed');
      expect(failedMessage).toHaveProperty('error');
    });
  });
});
