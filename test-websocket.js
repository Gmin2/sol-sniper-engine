const WebSocket = require('ws');

// First, submit an order
fetch('http://localhost:3000/api/orders/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tokenAddress: 'TestToken987654321',
    amountIn: 0.5,
    slippage: 3
  })
})
.then(res => res.json())
.then(data => {
  console.log('\n[HTTP] Order submitted:', data);
  console.log('[HTTP] OrderId:', data.orderId);
  console.log('\n[WS] Connecting to WebSocket...\n');

  // Connect to WebSocket
  const ws = new WebSocket(data.wsUrl);

  ws.on('open', () => {
    console.log('[WS] Connected to order status stream\n');
  });

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log(`[${new Date().toLocaleTimeString()}] Status: ${data.status}`);
    if (data.message) {
      console.log(`  Message: ${data.message}`);
    }
    if (data.routing) {
      console.log(`  Raydium: ${data.routing.raydium.outputAmount.toFixed(2)} tokens`);
      console.log(`  Meteora: ${data.routing.meteora.outputAmount.toFixed(2)} tokens`);
      console.log(`  Selected: ${data.routing.selected}`);
    }
    if (data.txHash) {
      console.log(`  TxHash: ${data.txHash}`);
      console.log(`  Explorer: ${data.explorerUrl}`);
    }
    console.log('');

    // Close after confirmed or failed
    if (data.status === 'confirmed' || data.status === 'failed') {
      console.log('[WS] Order complete, closing connection\n');
      ws.close();
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed');
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
})
.catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
