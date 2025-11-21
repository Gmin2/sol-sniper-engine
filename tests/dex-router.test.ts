import { describe, it, expect, jest, beforeAll, beforeEach } from '@jest/globals';
import BN from 'bn.js';

const mockCheckRaydiumPoolExists = jest.fn();
const mockGetRaydiumSwapQuote = jest.fn();
const mockCheckMeteoraPoolExists = jest.fn();
const mockGetMeteoraSwapQuote = jest.fn();

const raydiumModulePromise = jest.unstable_mockModule('../src/integrations/raydium.ts', () => ({
  checkRaydiumPoolExists: mockCheckRaydiumPoolExists,
  getRaydiumSwapQuote: mockGetRaydiumSwapQuote,
  executeRaydiumSwap: jest.fn(),
}));

const meteoraModulePromise = jest.unstable_mockModule('../src/integrations/meteora.ts', () => ({
  checkMeteoraPoolExists: mockCheckMeteoraPoolExists,
  getMeteoraSwapQuote: mockGetMeteoraSwapQuote,
  executeMeteoraSwap: jest.fn(),
}));

type DexRouterModule = typeof import('../src/services/dex-router.ts');
let checkForPool: DexRouterModule['checkForPool'];
let getBestRoute: DexRouterModule['getBestRoute'];

beforeAll(async () => {
  await raydiumModulePromise;
  await meteoraModulePromise;
  const module = await import('../src/services/dex-router.ts');
  checkForPool = module.checkForPool;
  getBestRoute = module.getBestRoute;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckRaydiumPoolExists.mockReset();
  mockCheckMeteoraPoolExists.mockReset();
  mockGetRaydiumSwapQuote.mockReset();
  mockGetMeteoraSwapQuote.mockReset();

  mockCheckRaydiumPoolExists.mockResolvedValue({ exists: false, poolId: null });
  mockCheckMeteoraPoolExists.mockResolvedValue({ exists: false, poolId: null });
});

describe('DEX Router Tests', () => {
  describe('checkForPool', () => {
    it('should find Raydium pool when it exists', async () => {
      mockCheckRaydiumPoolExists.mockResolvedValue({
        exists: true,
        poolId: 'raydium-pool-123',
      });

      const result = await checkForPool('token-address-123');

      expect(result.found).toBe(true);
      expect(result.raydiumPoolId).toBe('raydium-pool-123');
    });

    it('should find Meteora pool when it exists', async () => {
      mockCheckMeteoraPoolExists.mockResolvedValue({
        exists: true,
        poolId: 'meteora-pool-456',
      });

      const result = await checkForPool('token-address-456');

      expect(result.found).toBe(true);
      expect(result.meteoraPoolId).toBe('meteora-pool-456');
    });

    it('should return not found when no pools exist', async () => {
      mockCheckRaydiumPoolExists.mockResolvedValue({ exists: false, poolId: null });
      mockCheckMeteoraPoolExists.mockResolvedValue({ exists: false, poolId: null });

      const result = await checkForPool('non-existent-token');

      expect(result.found).toBe(false);
      expect(result.raydiumPoolId).toBeNull();
      expect(result.meteoraPoolId).toBeNull();
    });
  });

  describe('getBestRoute', () => {
    it('should select Raydium when it has better output', async () => {
      mockGetRaydiumSwapQuote.mockResolvedValue({
        dex: 'raydium',
        outputAmount: new BN('10000000'),
        tradeFee: new BN('250000'),
        priceImpact: 5.0,
      });

      mockGetMeteoraSwapQuote.mockResolvedValue({
        dex: 'meteora',
        outputAmount: new BN('9000000'),
        tradeFee: new BN('200000'),
        priceImpact: 4.5,
      });

      const order = { amountIn: '100000000', slippage: '0.01' };
      const result = await getBestRoute(order, 'raydium-pool', 'meteora-pool');

      expect(result.dex).toBe('raydium');
      expect(result.reason).toContain('Better output');
    });

    it('should select Meteora when it has better output', async () => {
      mockGetRaydiumSwapQuote.mockResolvedValue({
        dex: 'raydium',
        outputAmount: new BN('9000000'),
        tradeFee: new BN('250000'),
        priceImpact: 5.0,
      });

      mockGetMeteoraSwapQuote.mockResolvedValue({
        dex: 'meteora',
        outputAmount: new BN('10000000'),
        tradeFee: new BN('200000'),
        priceImpact: 4.5,
      });

      const order = { amountIn: '100000000', slippage: '0.01' };
      const result = await getBestRoute(order, 'raydium-pool', 'meteora-pool');

      expect(result.dex).toBe('meteora');
      expect(result.reason).toContain('Better output');
    });

    it('should handle when only Raydium is available', async () => {
      mockGetRaydiumSwapQuote.mockResolvedValue({
        dex: 'raydium',
        outputAmount: new BN('10000000'),
        tradeFee: new BN('250000'),
        priceImpact: 5.0,
      });

      mockGetMeteoraSwapQuote.mockRejectedValue(new Error('Pool not found'));

      const order = { amountIn: '100000000', slippage: '0.01' };
      const result = await getBestRoute(order, 'raydium-pool', null);

      expect(result.dex).toBe('raydium');
      expect(result.reason).toBe('Only Raydium available');
    });

    it('should handle when only Meteora is available', async () => {
      mockGetRaydiumSwapQuote.mockRejectedValue(new Error('Pool not found'));

      mockGetMeteoraSwapQuote.mockResolvedValue({
        dex: 'meteora',
        outputAmount: new BN('10000000'),
        tradeFee: new BN('200000'),
        priceImpact: 4.5,
      });

      const order = { amountIn: '100000000', slippage: '0.01' };
      const result = await getBestRoute(order, null, 'meteora-pool');

      expect(result.dex).toBe('meteora');
      expect(result.reason).toBe('Only Meteora available');
    });

    it('should throw error when no DEX is available', async () => {
      mockGetRaydiumSwapQuote.mockRejectedValue(new Error('Pool not found'));
      mockGetMeteoraSwapQuote.mockRejectedValue(new Error('Pool not found'));

      const order = { amountIn: '100000000', slippage: '0.01' };

      await expect(getBestRoute(order, null, null)).rejects.toThrow(
        'No quotes available from any DEX'
      );
    });
  });
});
