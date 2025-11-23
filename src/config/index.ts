import dotenv from 'dotenv';

// Load .env file if it exists (for local development)
// In production (Railway), environment variables are injected directly
const result = dotenv.config();
if (result.error) {
  console.log('No .env file found, using environment variables from Railway');
} else {
  console.log('.env file loaded successfully');
}

// Debug: Log database configuration (without sensitive data)
console.log('Database config:', {
  host: process.env.DB_HOST || 'not set',
  port: process.env.DB_PORT || 'not set',
  database: process.env.DB_NAME || 'not set',
  user: process.env.DB_USER || 'not set',
});
console.log('Redis config:', {
  host: process.env.REDIS_HOST || 'not set',
  port: process.env.REDIS_PORT || 'not set',
});

export const CONFIG = {
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
    password: process.env.REDIS_PASSWORD || undefined,
  },
  queue: {
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '10'),
    maxRetries: parseInt(process.env.MAX_RETRY_ATTEMPTS || '3'),
  },
};
