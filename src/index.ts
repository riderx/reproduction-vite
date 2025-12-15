import { getSandbox, proxyToSandbox, parseSSEStream } from '@cloudflare/sandbox';
import type { DurableObjectNamespace } from '@cloudflare/workers-types';

export { Sandbox } from '@cloudflare/sandbox';

export interface Env {
  Sandbox: DurableObjectNamespace<any>;
  ASSETS: Fetcher;
}

// Track initialized sandboxes and their logs
const initialized = new Set<string>();
const processLogs: string[] = [];
let viteReadyPromise: Promise<void> | null = null;
let viteReadyResolve: (() => void) | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log({
      message: "REQUEST RECEIVED",
      event: "request:start",
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers)
    });

    // Auto-route all requests via proxyToSandbox first
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) {
      console.log({
        message: "PROXIED to sandbox",
        event: "proxy:success",
        url: request.url,
        status: proxyResponse.status
      });
      return proxyResponse;
    }

    const url = new URL(request.url);
    const hostname = url.host;

    // Route: GET /ws-url - Return WebSocket URL for client to connect
    if (url.pathname === '/ws-url') {
      console.log({
        message: "WS_URL endpoint called",
        event: "wsurl:request",
        hostname
      });

      const sandbox = getSandbox(env.Sandbox, 'vite-echo-server', { normalizeId: true });

      try {
        // Initialize Vite server on first request
        if (!initialized.has('vite-echo-server')) {
          console.log({
            message: "INITIALIZING sandbox for first time",
            event: "init:start"
          });

          // Create promise to track when Vite is ready
          viteReadyPromise = new Promise((resolve) => {
            viteReadyResolve = resolve;
          });

          // Create a simple Vite dev server with WebSocket support
          console.log({ message: "INIT: Creating package.json", event: "init:package" });
          await sandbox.writeFile(
            '/workspace/package.json',
            JSON.stringify({
              name: "vite-ws-test",
              type: "module",
              scripts: {
                dev: "vite --host 0.0.0.0 --port 3333 --strictPort"
              },
              dependencies: {
                "vite": "^5.0.0"
              }
            }, null, 2)
          );

          console.log({ message: "INIT: Creating index.html", event: "init:html" });
          await sandbox.writeFile(
            '/workspace/index.html',
            `<!DOCTYPE html>
<html>
<head>
  <title>Vite WS Test</title>
</head>
<body>
  <h1>Hello from Vite in Cloudflare Sandbox!</h1>
  <div id="app">
    <p>This is a minimal Vite server running in a Cloudflare Sandbox.</p>
    <p>WebSocket HMR should work automatically.</p>
  </div>
  <script type="module" src="/main.js"></script>
</body>
</html>`
          );

          console.log({ message: "INIT: Creating main.js", event: "init:js" });
          await sandbox.writeFile(
            '/workspace/main.js',
            `console.log('Hello from Vite!');
document.getElementById('app').innerHTML += '<p>JavaScript loaded successfully!</p>';`
          );

          console.log({ message: "INIT: Installing dependencies with bun", event: "init:install" });
          const installResult = await sandbox.exec('bun install', { cwd: '/workspace' });
          console.log({
            message: "INIT: Dependencies installed",
            event: "init:install:complete",
            stdout: installResult.stdout,
            stderr: installResult.stderr
          });

          console.log({ message: "INIT: Starting Vite dev server process", event: "init:vite:start" });
          const process = await sandbox.startProcess('bun run dev', {
            cwd: '/workspace',
            env: { NODE_ENV: 'development' }
          });

          console.log({
            message: "INIT: Vite process started",
            event: "init:vite:spawned",
            processId: process.id
          });

          // Stream and log Vite output using parseSSEStream
          const logStreamPromise = (async () => {
            try {
              const logStream = await sandbox.streamProcessLogs(process.id);
              console.log({ message: "INIT: Got log stream", event: "init:logs:start" });

              for await (const event of parseSSEStream<{ type?: string; data?: string }>(logStream)) {
                const logLine = event.data?.trim();

                if (logLine) {
                  // Store logs in memory
                  processLogs.push(logLine);

                  console.log({
                    message: "VITE_LOG",
                    event: "vite:log",
                    log: logLine
                  });

                  // Check if Vite is ready by looking for specific log patterns
                  if (viteReadyResolve && !initialized.has('vite-echo-server')) {
                    // Vite prints "Local: http://..." or "ready in" when server is up
                    if (logLine.includes('Local:') || logLine.includes('ready in') || logLine.includes('localhost:3333')) {
                      console.log({
                        message: "VITE_READY: Detected Vite ready signal in logs",
                        event: "vite:ready",
                        logLine
                      });
                      viteReadyResolve();
                      viteReadyResolve = null;
                    }
                  }
                }
              }
            } catch (error) {
              console.error({
                message: "INIT: Log stream error",
                event: "init:logs:error",
                error: String(error)
              });
            }
          })();

          ctx.waitUntil(logStreamPromise);

          // Wait for Vite to be ready (detected from logs)
          console.log({ message: "INIT: Waiting for Vite ready signal from logs", event: "init:wait:start" });

          const timeout = new Promise<void>((resolve) => {
            setTimeout(() => {
              console.warn({ message: "INIT: Timeout waiting for Vite (30s)", event: "init:wait:timeout" });
              resolve();
            }, 30000); // 30 second timeout
          });

          // Wait for either Vite ready signal or timeout
          await Promise.race([viteReadyPromise, timeout]);

          initialized.add('vite-echo-server');
          console.log({ message: "INIT: Complete", event: "init:complete" });
        }

        // Expose port and get preview URL
        console.log({ message: "EXPOSE: Exposing port 3333", event: "expose:start", hostname });
        const exposeResult = await sandbox.exposePort(3333, { hostname, name: 'vite-preview' });
        const exposedAt = exposeResult.url || (exposeResult as any).exposedAt;
        console.log({
          message: "EXPOSE: Port exposed",
          event: "expose:success",
          exposedAt,
          exposeResult
        });

        // Convert https to wss for WebSocket
        const wsUrl = exposedAt.replace('https://', 'wss://').replace('http://', 'ws://');

        console.log({
          message: "WS_URL: Returning to client",
          event: "wsurl:response",
          httpsUrl: exposedAt,
          wsUrl
        });

        return Response.json({
          url: wsUrl,
          previewUrl: exposedAt,
          message: 'Connect to this WebSocket URL for Vite HMR'
        });
      } catch (error) {
        console.error({
          message: "ERROR",
          event: "error",
          error: String(error),
          stack: (error as Error).stack
        });
        return Response.json({
          error: String(error)
        }, { status: 500 });
      }
    }

    // Route: GET / - Serve static HTML from assets
    if (url.pathname === '/' || url.pathname === '/index.html') {
      console.log({ message: "ROOT: Serving static index.html from assets", event: "root:request" });
      return env.ASSETS.fetch(request);
    }

    // Route: GET /logs-stream - Stream Vite server logs via SSE
    if (url.pathname === '/logs-stream') {
      console.log({ message: "LOGS_STREAM: Starting SSE stream", event: "logs:stream:start" });

      const encoder = new TextEncoder();
      let lastLogIndex = 0;
      let interval: ReturnType<typeof setInterval> | null = null;

      const stream = new ReadableStream({
        start(controller) {
          // Send existing logs
          for (let i = 0; i < processLogs.length; i++) {
            const logData = JSON.stringify({
              event: 'vite:log',
              log: processLogs[i],
              index: i
            });
            controller.enqueue(encoder.encode(`data: ${logData}\n\n`));
          }
          lastLogIndex = processLogs.length;

          // Poll for new logs every 500ms
          interval = setInterval(() => {
            if (lastLogIndex < processLogs.length) {
              for (let i = lastLogIndex; i < processLogs.length; i++) {
                const logData = JSON.stringify({
                  event: 'vite:log',
                  log: processLogs[i],
                  index: i
                });
                controller.enqueue(encoder.encode(`data: ${logData}\n\n`));
              }
              lastLogIndex = processLogs.length;
            }
          }, 500);
        },
        cancel() {
          // Cleanup on close
          if (interval) {
            clearInterval(interval);
          }
          console.log({ message: "LOGS_STREAM: Stream cancelled", event: "logs:stream:cancel" });
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      });
    }

    // Route: GET /direct - Direct link to preview (for debugging)
    if (url.pathname === '/direct') {
      const sandbox = getSandbox(env.Sandbox, 'vite-echo-server', { normalizeId: true });
      const { hostname } = url;

      try {
        const result = await sandbox.exposePort(3333, { hostname, name: 'vite-preview' });
        const previewUrl = result.url || (result as any).exposedAt;
        console.log({ message: "DIRECT: Redirecting to preview", event: "direct:redirect", previewUrl, result });
        return Response.redirect(previewUrl, 302);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
};
