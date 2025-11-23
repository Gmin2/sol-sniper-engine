# Sniper Order Execution Engine

The api is deployed in production at [https://sol-sniper-engine-production.up.railway.app/health][https://sol-sniper-engine-production.up.railway.app/health]

A high-performance order execution engine for Solana token sniping with intelligent DEX routing between Raydium and Meteora.

## 🎯 Features

- **Sniper Orders**: Execute trades immediately when liquidity pools are detected
- **Dual-DEX Routing**: Automatically routes between Raydium CPMM and Meteora CP-AMM for best prices
- **Real Devnet Execution**: Actual blockchain transactions on Solana devnet (not mocked)
- **WebSocket Streaming**: Real-time order status updates
- **Concurrent Processing**: Handles up to 10 concurrent orders, 100 orders/minute
- **Retry Logic**: Exponential backoff with 3 retry attempts
- **Production-Ready**: Modular architecture, structured logging with Pino


## 🚀 Tech Stack

- **Runtime**: Node.js + TypeScript
- **Web Framework**: Fastify (with WebSocket support)
- **Queue**: BullMQ + Redis
- **Database**: PostgreSQL
- **DEX SDKs**:
  - `@raydium-io/raydium-sdk-v2` (CPMM pools)
  - `@meteora-ag/cp-amm-sdk` (CP-AMM pools)
- **Blockchain**: Solana Web3.js
- **Logger**: Pino (fast, structured logging)

## 📋 Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 7+
- Docker & Docker Compose (optional)
- Solana devnet wallet with SOL

## ⚙️ Setup Instructions

### 1. Clone & Install

```bash
git clone <your-repo>
cd assignment
pnpm install
```

### 2. Configure Environment

Create `.env` file:

```env
PORT=3000

# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_CLUSTER=devnet
WALLET_PRIVATE_KEY=<your-base58-private-key>

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=sniper_engine
DB_USER=postgres
DB_PASSWORD=postgres

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Queue
QUEUE_CONCURRENCY=10
MAX_RETRY_ATTEMPTS=3

# Logging
LOG_LEVEL=info
```

### 3. Start Infrastructure

**Option A: Docker Compose** (Recommended)

```bash
docker-compose up -d
```

**Option B: Manual**

```bash
# PostgreSQL
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:14

# Redis
docker run -d -p 6379:6379 redis:7
```

### 4. Build & Run

```bash
pnpm run build
pnpm run dev
```

Server starts at `http://localhost:3000`

## 🧪 Testing with Postman

### Quick Start

1. **Import Collection**: Import `postman-collection.json` into Postman
2. **Run Health Check** - Verify server and all services are running
3. **Submit Order** - POST request returns orderId and WebSocket URL
4. **Connect WebSocket Manually** - See live status updates

---

## 📡 API Endpoints

### Single Endpoint Pattern

The API uses **ONE endpoint** `/api/orders/execute` that handles both protocols:

✅ **Task Requirement**: "Single endpoint handles both protocols"

---

### 1️⃣ Submit Order (HTTP POST)

**Endpoint**: `POST /api/orders/execute`

**Request Body**:
```json
{
  "tokenAddress": "B2DdhSFkydrDMbeamxnVyxiZNABVPoTFJjZKzSc1G3DP",
  "amountIn": "100000000",
  "slippage": "0.01"
}
```

**Response** (HTTP 200):
```json
{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "message": "Order queued. Upgrade connection to WebSocket for live updates.",
  "upgradeUrl": "ws://localhost:3000/api/orders/execute?orderId=550e8400-e29b-41d4-a716-446655440000"
}
```

✅ **Task Requirement**: "User submits order via POST /api/orders/execute"
✅ **Task Requirement**: "API validates order and returns orderId"

**Testing in Postman**:
1. Use the "2. Submit Order (HTTP POST)" request from the collection
2. The response automatically saves `orderId` and `upgradeUrl` to environment variables
3. Copy the `upgradeUrl` from the response

---

### 2️⃣ Stream Updates (WebSocket)

**Endpoint**: `GET ws://localhost:3000/api/orders/execute?orderId={orderId}`

✅ **Task Requirement**: "Connection upgrades to WebSocket for status streaming"

**Note**: Same endpoint path (`/api/orders/execute`) - only the protocol changes (HTTP → WebSocket)

**Testing in Postman**:
1. After submitting order via POST, copy the `upgradeUrl` from response
2. In Postman: **New** → **WebSocket Request**
3. Paste the `upgradeUrl`
4. Click **Connect**
5. Watch live status updates stream in real-time!

---

### 📺 WebSocket Status Updates (Real-Time Streaming)

**⏱️ Timing Note**: The engine includes intentional delays between status transitions (~1-2 seconds each) to make the streaming visible in demos and videos. Total order execution takes ~15-20 seconds, allowing you to clearly see each status transition in Postman. In production, you can reduce these delays in `src/services/order-processor.ts` for faster execution.

**You'll immediately start receiving status updates:**

You'll see messages streaming in the response pane:

```json
// Message 1: Order received
{
  "orderId": "uuid-here",
  "status": "pending",
  "message": "Order received and queued. Streaming updates..."
}

// Message 2: Pending
{
  "orderId": "uuid-here",
  "status": "pending",
  "message": "Order received and queued"
}

// Message 3: Monitoring
{
  "orderId": "uuid-here",
  "status": "monitoring",
  "message": "Monitoring for pool creation: B2DdhSFK..."
}

// Message 4: Triggered
{
  "orderId": "uuid-here",
  "status": "triggered",
  "message": "Pool detected! Starting execution..."
}

// Message 5: Routing (with DEX comparison)
{
  "orderId": "uuid-here",
  "status": "routing",
  "message": "Best route selected: raydium",
  "routing": {
    "raydium": {
      "dex": "raydium",
      "poolId": "BmbSmAsSAgRWFLWCGte1fi9o5HUxJma3RgMWXvPnqwUh",
      "outputAmount": "7542986675594",
      "tradeFee": "250000",
      "priceImpact": 8.75
    },
    "meteora": {
      "dex": "meteora",
      "poolId": "9bNX6QXvTBoyGv1H3X2D81qTnmnWdPFCKjbMQ1VmjEjV",
      "outputAmount": "6391027378206",
      "tradeFee": "19229032052",
      "priceImpact": 8.66
    },
    "selected": "raydium",
    "reason": "Better output: 75,42,98,66,75,594 vs 63,91,02,73,78,206"
  }
}

// Message 6: Building
{
  "orderId": "uuid-here",
  "status": "building",
  "message": "Building transaction on raydium...",
  "selectedDex": "raydium"
}

// Message 7: Submitted
{
  "orderId": "uuid-here",
  "status": "submitted",
  "message": "Transaction submitted to blockchain..."
}

// Message 8: Confirmed (Success!)
{
  "orderId": "uuid-here",
  "status": "confirmed",
  "message": "Transaction confirmed!",
  "txHash": "yvkcasJTugoxSYnzGSbDsVUdeyjxi3kQebdZMmmbTZiFs1wHqCLLn42PMK6ZRMxezCHwws8zUMDWRxQWF4zHGXk",
  "explorerUrl": "https://explorer.solana.com/tx/yvkcasJTugoxSYnzGSbDsVUdeyjxi3kQebdZMmmbTZiFs1wHqCLLn42PMK6ZRMxezCHwws8zUMDWRxQWF4zHGXk?cluster=devnet"
}
```

**4. Verify on Blockchain**

Click the `explorerUrl` link to see the actual transaction on Solana Explorer!

---

### 3️⃣ Get Order Status (HTTP GET)

**Endpoint**: `GET /api/orders/{orderId}`

**Use Case**: Check order status after WebSocket disconnection or retrieve final transaction hash

**Response**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "confirmed",
  "token_address": "B2DdhSFkydrDMbeamxnVyxiZNABVPoTFJjZKzSc1G3DP",
  "amount_in": "100000000",
  "slippage": "0.01",
  "selected_dex": "raydium",
  "tx_hash": "yvkcasJTugoxSYnzGSbDsVUdeyjxi3kQebdZMmmbTZi...",
  "error_message": null,
  "created_at": "2025-01-21T20:30:00.000Z",
  "updated_at": "2025-01-21T20:30:18.000Z"
}
```

---

### 4️⃣ Health Check (HTTP GET)

**Endpoint**: `GET /health`

**Response**:
```json
{
  "status": "healthy",
  "timestamp": "2025-01-21T20:30:00.000Z",
  "services": {
    "postgres": "connected",
    "redis": "connected",
    "queue": "running"
  }
}
```

---

## 🧪 Testing Scenarios

### Testing Concurrent Orders

To test concurrent processing (up to 10 concurrent, 100/minute):

1. Submit **5 orders** via POST endpoint (rapid fire)
2. For each order, connect to its WebSocket URL
3. Watch them process concurrently with different routing decisions
4. Observe queue management in server logs

### Testing Error Cases

**Invalid Order Data:**

POST with missing fields:
```json
{
  "tokenAddress": "invalid"
}
```

Returns HTTP 400:
```json
{
  "error": "Invalid order",
  "message": "tokenAddress, amountIn, and slippage are required"
}
```

**Pool Not Found:**

POST with non-existent token:
```json
{
  "tokenAddress": "NonExistentTokenMint111111111111111111",
  "amountIn": "100000000",
  "slippage": "0.01"
}
```

Order will transition to `"status": "failed"` via WebSocket with error message.

## 📊 Order Lifecycle States

1. **pending** - Order received and queued
2. **monitoring** - Checking for pool existence (sniper-specific)
3. **triggered** - Pool detected, starting execution
4. **routing** - Comparing Raydium vs Meteora quotes
5. **building** - Constructing transaction
6. **submitted** - Transaction sent to blockchain
7. **confirmed** - Transaction successful ✅
8. **failed** - Error occurred ❌

## 🎯 Why Sniper Orders?

**Chosen Order Type: Sniper Orders**

Sniper orders were chosen because they demonstrate the most complex execution flow and real-world trading value. They require pool monitoring/detection, instant execution upon pool creation, and showcase the full routing decision-making process when liquidity first appears.

**Extending to Other Order Types:**

The same engine can easily support the other order types with minimal modifications:

- **Market Orders**: Remove the "monitoring" state (lines 188-210 in `order-processor.ts`). Start directly from "routing" state for immediate execution at current market price.

- **Limit Orders**: Replace "monitoring" with a price-checking loop that polls DEX quotes every N seconds. When `currentPrice <= targetPrice`, transition to "triggered" state and execute. Add a `targetPrice` field to order schema and check `bestRoute.selectedQuote.price` against it before proceeding to execution.

## 🔍 DEX Routing Logic

The engine fetches quotes from both DEXs and selects the best route:

1. **Fetch Quotes**: Parallel requests to Raydium and Meteora
2. **Compare Output**: Select DEX with higher output amount
3. **Execute**: Route order to winning DEX
4. **Log Decision**: Full transparency in routing choice

**Example Routing Decision**:

```
Raydium: 7,542,986,675,594 tokens (0.25% fee, 8.75% impact)
Meteora: 6,391,027,378,206 tokens (0.25% fee, 8.66% impact)
Selected: Raydium (Better output by 18%)
```

## 🐛 Troubleshooting

### WebSocket connection closes immediately

- Check that server is running: `curl http://localhost:3000/health`
- Verify WebSocket plugin is installed in Postman

### "Pool not found" errors

- Use test tokens from `test-pools.json`
- Token must have both Raydium and Meteora pools created

### Transaction failures

- Check wallet has enough SOL on devnet
- Verify slippage tolerance (try `0.05` for 5%)
- Check Solana network status

### Database connection errors

- Ensure PostgreSQL is running: `docker ps`
- Test connection: `psql -h localhost -U postgres -d sniper_engine`

---

## ✅ Core Requirements Compliance

### 1. Order Types (Choose ONE) ✅
**Implemented**: Sniper Orders - Execute on token launch/pool creation

**Why Chosen**: Sniper orders demonstrate the most complex execution flow including pool monitoring, instant execution, and real-world trading scenarios.

**Extension to Other Types**:
- **Market Orders**: Remove "monitoring" state from `order-processor.ts:47-56`. Execute immediately at current price.
- **Limit Orders**: Replace "monitoring" with price polling. Add `targetPrice` field and check `bestRoute.selectedQuote.price <= targetPrice` before executing.

### 2. DEX Router Implementation 
- ✅ Query both Raydium and Meteora for quotes (`dex-router.ts:76-107`)
- ✅ Route to best price automatically (compare `outputAmount`)
- ✅ Handle wrapped SOL for native token swaps (handled by SDKs)
- ✅ Log routing decisions for transparency (Pino structured logs)

**Implementation**: `src/services/dex-router.ts`

### 3. HTTP → WebSocket Pattern 
- ✅ Single endpoint handles both protocols (`/api/orders/execute`)
- ✅ Initial POST returns `orderId` (`routes/orders.ts:17-53`)
- ✅ Connection upgrades to WebSocket for status streaming (`routes/orders.ts:57-97`)

**Implementation**: `src/routes/orders.ts`

### 4. Concurrent Processing 
- ✅ Queue system managing up to 10 concurrent orders (BullMQ)
- ✅ Process 100 orders/minute (rate limiter: `order-processor.ts:169-172`)
- ✅ Exponential back-off retry ≤3 attempts (`order-processor.ts:179-183`)
- ✅ Emit "failed" status and persist failure reason (`order-processor.ts:145-151`)

**Implementation**: `src/services/order-processor.ts`

---

## 📝 Environment Variables Reference

| Variable               | Description                          | Default                          |
| ---------------------- | ------------------------------------ | -------------------------------- |
| `PORT`                 | HTTP server port                     | `3000`                           |
| `SOLANA_RPC_URL`       | Solana RPC endpoint                  | `https://api.devnet.solana.com`  |
| `SOLANA_CLUSTER`       | Network (mainnet/devnet)             | `devnet`                         |
| `WALLET_PRIVATE_KEY`   | Base58 private key                   | Required                         |
| `DB_HOST`              | PostgreSQL host                      | `localhost`                      |
| `DB_PORT`              | PostgreSQL port                      | `5432`                           |
| `DB_NAME`              | Database name                        | `sniper_engine`                  |
| `DB_USER`              | Database user                        | `postgres`                       |
| `DB_PASSWORD`          | Database password                    | `postgres`                       |
| `REDIS_HOST`           | Redis host                           | `localhost`                      |
| `REDIS_PORT`           | Redis port                           | `6379`                           |
| `QUEUE_CONCURRENCY`    | Max concurrent orders                | `10`                             |
| `MAX_RETRY_ATTEMPTS`   | Retry attempts on failure            | `3`                              |
| `LOG_LEVEL`            | Logging level (info/debug/error)     | `info`                           |

## 🔗 Links

- **Deployed Link**: `https://sol-sniper-engine-production.up.railway.app/health`
- **Postman Collection**: `postman-collection.json`
- **Test Pools**: `test-pools.json`
- **Transaction Examples**: See Solana Explorer links in WebSocket responses