# Vite HMR with Cloudflare Sandbox - Reproduction Project

This project demonstrates Vite Hot Module Replacement (HMR) integration with Cloudflare Sandbox using Durable Objects and containers.

## Architecture

- **Worker**: Handles routing and sandbox initialization
- **Durable Object**: Manages individual sandbox instances with custom Docker container
- **Container**: Runs Vite dev server on port 3333 inside sandbox
- **Static HTML**: Split-screen UI showing Vite preview iframe and real-time logs

## What Works ✅

1. **Dynamic Sandbox Management**: Support for multiple concurrent sandboxes via URL parameters
2. **HTTP Proxying**: `containerFetch(request, 3333)` successfully routes requests to Vite server
3. **File Watching**: Vite detects file changes and triggers rebuild
4. **Manual Reload**: File changes persist and appear on manual page reload
5. **Process Management**: Automatic cleanup of old processes on initialization
6. **Server-Sent Events**: Real-time log streaming from Vite server
7. **No External Dependencies**: All routing through worker, no `lvh.me` or external DNS required

## Known Limitations ⚠️

### WebSocket HMR in Local Development

**Status**: WebSocket connections fail in local development with `wrangler dev`

**Symptoms**:
- Browser attempts WebSocket connection: `ws://localhost:8787/sandbox/{id}/preview/?token=...`
- Connection fails with "bad response from server"
- No worker log entry appears for WebSocket requests
- Vite logs show `[vite] page reload main.js` but browser doesn't auto-reload

**Root Cause**: `wrangler dev` does not pass WebSocket upgrade requests to the worker's fetch handler. The WebSocket connection attempt never reaches the worker code, so `containerFetch()` is never called for the upgrade request.

**Expected Behavior in Production**: WebSocket HMR should work when deployed to production with a real domain, as documented in the Cloudflare Sandbox SDK.

## Project Structure

```
reproduction-vite/
├── src/
│   └── index.ts          # Worker with routing and sandbox management
├── public/
│   └── index.html        # Split-screen UI (logs + preview)
├── Dockerfile            # Container image with Bun + Vite
├── wrangler.json         # Worker configuration
├── vite.config.ts        # Outer Vite config (not used with wrangler dev)
├── package.json          # Scripts and dependencies
└── tsconfig.json         # TypeScript configuration
```

## Routes

### `/`
Static HTML page with split-screen interface:
- Left: Real-time Vite server logs (SSE stream)
- Right: Vite preview iframe
- Controls: "Test HMR" button and manual reload

### `/sandbox/:sandboxId/ws-url`
Initialize sandbox and return preview URL:
```json
{
  "previewUrl": "http://localhost:8787/sandbox/{sandboxId}/preview/",
  "sandboxId": "vite-hmr-1234567890"
}
```

### `/sandbox/:sandboxId/preview/*`
Proxy all requests to Vite server inside container:
- HTTP requests → `containerFetch(request, 3333)`
- WebSocket upgrades → Handled by `containerFetch()` (works in production)
- Vite base path configured to match route

### `/sandbox/:sandboxId/logs-stream`
Server-Sent Events stream of Vite server output

### `/sandbox/:sandboxId/test-hmr` (POST)
Create/update test file to trigger HMR:
```javascript
// Creates /workspace/src/main.js with button click counter
```

## Sandbox Configuration

Each sandbox initializes with:

1. **File Structure**:
   ```
   /workspace/
   ├── package.json          # Vite + dependencies
   ├── vite.config.js        # Dynamic config with base path
   ├── index.html            # Entry point
   └── src/
       └── main.js           # App code (updated by test-hmr)
   ```

2. **Vite Config** (generated dynamically):
   ```javascript
   {
     base: '/sandbox/{sandboxId}/preview/',
     server: {
       host: '0.0.0.0',
       port: 3333,
       strictPort: true,
       allowedHosts: ['localhost', '.localhost', 'container'],
       hmr: {
         protocol: 'ws'  // Auto-detects host/port from window.location
       }
     }
   }
   ```

3. **Process Management**:
   - Checks `listProcesses()` on each initialization
   - Kills all existing processes before starting Vite
   - Waits for "ready in" log before returning preview URL

## Development

### Install Dependencies
```bash
npm install
```

### Run Local Development
```bash
npm run dev
```

Opens [http://localhost:8787](http://localhost:8787)

### Test HMR Flow

1. Click "Test HMR" button
2. Worker creates/updates [/workspace/src/main.js](/workspace/src/main.js) with incremented counter
3. Vite detects change and logs `[vite] page reload main.js`
4. **In production**: Browser WebSocket receives update and auto-reloads
5. **In local dev**: Click "Reload Preview" button to see changes

## Key Implementation Details

### Dynamic Sandbox ID
```javascript
const SANDBOX_ID = 'vite-hmr-' + Date.now();  // Fresh container each reload
```

### Container Fetch with Port
```typescript
// CRITICAL: Must specify port 3333 (third parameter)
const response = await sandbox.containerFetch(request, 3333);
```

### Process Cleanup
```typescript
// ALWAYS check processes - don't rely on in-memory state
const processes = await sandbox.listProcesses();
for (const process of processes) {
  await sandbox.killProcess(process.id);
}
```

### Vite Readiness Detection
```typescript
// Parse SSE stream and wait for "ready in" message
for await (const chunk of parseSSEStream(logStream)) {
  if (chunk.data?.includes('ready in')) {
    break;  // Vite is ready
  }
}
```

## Deployment

```bash
npm run deploy
```

Builds Vite assets and deploys worker with Durable Objects.

## Expected Production Behavior

When deployed to production:
- WebSocket upgrade requests should reach the worker's fetch handler
- `containerFetch()` will handle WebSocket upgrade to container
- Vite HMR should work automatically without manual reload
- All routes work through the worker without direct container access

## Dependencies

- `@cloudflare/sandbox` ^0.5.4 - Sandbox SDK
- `@cloudflare/vite-plugin` ^1.14.0 - Vite integration
- `@cloudflare/workers-types` ^4.20241127.0 - TypeScript types
- `vite` ^7.2.2 - Build tool
- `wrangler` ^4.50.0 - Cloudflare Workers CLI

## Troubleshooting

### "Port 3333 is already exposed"
Fixed by checking `getExposedPorts()` before calling `exposePort()` and reusing existing exposures.

### "Hello from Bun server!"
Occurs when connecting to wrong port. Ensure `containerFetch(request, 3333)` specifies port 3333.

### "Blocked request. This host is not allowed"
Fixed by adding `"container"` to `allowedHosts` in sandbox's Vite config.

### WebSocket connection fails in local dev
Known limitation of `wrangler dev` - WebSocket upgrade requests don't reach worker. Expected to work in production deployment
