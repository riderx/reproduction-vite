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

## Implementation Notes

### Log-Based Auto-Reload (No WebSocket)

Instead of using Vite's WebSocket-based HMR, this project uses a log-based auto-reload approach:

1. Vite HMR is **enabled server-side** to produce proper rebuild logs
2. HMR client is configured to connect to invalid WebSocket endpoint (`invalid.local:9999`)
3. Client connects to `/sandbox/:sandboxId/logs-stream` via Server-Sent Events (SSE)
4. When Vite detects file changes and rebuilds, it logs `[vite] hmr update` or `[vite] page reload`
5. Client watches the log stream and triggers `iframe.contentWindow.location.reload()` automatically
6. This provides automatic updates without WebSocket connections or errors

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

### `/sandbox/:sandboxId/init`
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
- Vite base path configured to match route
- HMR enabled server-side but client connects to invalid WebSocket
- Auto-reload triggered by watching log stream

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
       allowedHosts: ['localhost', '.localhost', 'container', 'appmi.store', '.appmi.store'],
       hmr: {
         // HMR enabled server-side for proper rebuild logs
         // Client configured to fail silently without WebSocket errors
         protocol: 'ws',
         host: 'invalid.local',
         port: 9999,
         clientPort: 9999
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
2. Worker creates/updates [/workspace/main.js](/workspace/main.js) with incremented counter
3. Vite detects change and logs `[vite] page reload main.js`
4. Client watches log stream and auto-reloads iframe when reload message detected
5. Changes appear automatically without manual refresh

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

## Production Deployment

When deployed to production (appmi.store):
- All HTTP requests are proxied via `containerFetch(request, 3333)`
- Log-based auto-reload works the same as in local development
- No WebSocket connections required
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
Fixed by adding production domains (`"appmi.store"`, `".appmi.store"`) to `allowedHosts` in sandbox's Vite config.
