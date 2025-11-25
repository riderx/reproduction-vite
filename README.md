# Vite Sandbox WebSocket Reproduction

Minimal reproduction of running Vite dev server with WebSocket HMR in Cloudflare Sandbox.

## What This Tests

1. Creating a Vite project in a sandbox
2. Installing dependencies with `bun install`
3. Starting Vite dev server on port 3333
4. Exposing the port to get a preview URL
5. **Serving HTML with iframe to Vite preview** ⭐
6. Converting HTTPS → WSS for WebSocket connections
7. Streaming Vite process logs with `ctx.waitUntil()`

## Setup

```bash
cd reproduction-vite
npm install  # or bun install
```

## Run Locally

**Using Vite (recommended):**
```bash
npm run dev
```

This uses Vite with `@cloudflare/vite-plugin` to run the worker locally, which properly supports Durable Objects with custom containers.

Then visit:
- `http://localhost:5173/` - **Main page with iframe showing Vite preview**
- `http://localhost:5173/ws-url` - Get the WebSocket URL JSON
- `http://localhost:5173/direct` - Redirect directly to Vite preview (for debugging)

Note: Vite dev server runs on port 5173 by default.

## Deploy

```bash
npm run build  # Build with Vite
npm run deploy  # Deploy to Cloudflare
```

## Configuration

- **wrangler.json**: Uses `containers` with custom Dockerfile (not `script_name`)
- **Dockerfile**: Exposes port 3333 for preview URLs
- **vite.config.ts**: Uses `@cloudflare/vite-plugin` for local development

## Expected Flow

### On First Visit to `/`

1. **Worker serves HTML page** with iframe placeholder
2. **JavaScript fetches `/ws-url`** to get preview URL
3. **Worker initializes sandbox** (if not already done):
   - Creates package.json, index.html, main.js
   - Runs `bun install`
   - Starts Vite dev server with `bun run dev`
   - Streams Vite logs to console (via `ctx.waitUntil()`)
   - Waits ~5 seconds for Vite to be ready
4. **Worker exposes port 3333** to get preview URL
5. **Worker returns JSON** with:
   - `previewUrl`: HTTPS URL for iframe src
   - `url`: WSS URL for WebSocket (automatically used by Vite HMR)
6. **Browser creates iframe** with `src=previewUrl`
7. **Vite loads in iframe** with WebSocket HMR working

### Architecture

```
┌─────────────────────────────────────────┐
│ Worker (http://localhost:8787)          │
│  ├─ GET /       → HTML with iframe      │
│  ├─ GET /ws-url → Preview URL JSON      │
│  └─ proxyToSandbox → Routes preview     │
│            ↓                             │
│      ┌──────────────────────┐           │
│      │  Cloudflare Sandbox  │           │
│      │   ├─ Vite Server     │           │
│      │   │   (port 3333)    │           │
│      │   └─ WebSocket HMR   │           │
│      └──────────────────────┘           │
│            ↓                             │
│      Preview URL (exposed)              │
│      https://sandbox-xxx.preview.dev    │
│            ↓                             │
│      Loaded in <iframe>                 │
└─────────────────────────────────────────┘
```

## Logs to Watch For

All logs are prefixed for easy filtering:

- `INIT:` - Sandbox initialization
- `EXPOSE:` - Port exposure
- `VITE_LOG:` - Vite server output
- `WS_URL:` - WebSocket URL generation

## Common Issues

1. **Vite doesn't start**: Check `VITE_LOG` entries for errors
2. **No preview URL**: Check `EXPOSE:` logs for exposedAt value
3. **WebSocket fails**: Ensure preview URL uses `wss://` protocol
