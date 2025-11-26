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
    } else {
      console.log({
        message: "proxyToSandbox returned null - not a preview URL",
        event: "proxy:skip",
        url: request.url
      });
    }

    const url = new URL(request.url);
    const { hostname } = url;

    // Route: GET /sandbox/:sandboxId/ws-url - Return WebSocket URL for client to connect
    const wsUrlMatch = url.pathname.match(/^\/sandbox\/([^/]+)\/ws-url$/);
    if (wsUrlMatch) {
      const sandboxId = wsUrlMatch[1];

      console.log({
        message: "WS_URL endpoint called",
        event: "wsurl:request",
        sandboxId
      });

      const sandbox = getSandbox(env.Sandbox, sandboxId, { normalizeId: true });

      try {
        // ALWAYS check processes - don't rely on in-memory state
        const processes = await sandbox.listProcesses();
        const viteProcess = processes.find(p => p.command?.includes('vite') || p.command?.includes('bun run dev'));

        let needsInit = !viteProcess;

        if (viteProcess) {
          console.log({
            message: "INIT: Vite already running, skipping init",
            event: "init:skip",
            processId: viteProcess.id,
            command: viteProcess.command
          });
          initialized.add(sandboxId);
        }

        // Initialize Vite server only if needed
        if (needsInit) {
          console.log({
            message: "INITIALIZING sandbox - checking for old processes",
            event: "init:start"
          });

          // Kill any existing processes (from previous sessions/tests)
          for (const process of processes) {
            console.log({
              message: "INIT: Killing old process",
              event: "init:kill",
              processId: process.id,
              command: process.command
            });
            try {
              await sandbox.killProcess(process.id);
            } catch (error) {
              console.warn({
                message: "INIT: Failed to kill process (might already be dead)",
                error: String(error)
              });
            }
          }

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
  <title>Vite in Cloudflare Sandbox</title>
</head>
<body>
  <h1>Hello from Vite in Cloudflare Sandbox!</h1>
  <div id="app">
    <p>This is a minimal Vite server running in a Cloudflare Sandbox.</p>
    <p>HMR via log-based auto-reload is enabled.</p>
  </div>
  <script type="module" src="/main.js"></script>
</body>
</html>`
          );

          console.log({ message: "INIT: Creating vite.config.js", event: "init:vite-config" });
          await sandbox.writeFile(
            '/workspace/vite.config.js',
            `export default {
  base: '/sandbox/${sandboxId}/preview/',
  server: {
    host: '0.0.0.0',
    port: 3333,
    strictPort: true,
    allowedHosts: [
      'localhost',
      '.localhost',
      'container',      // Allow containerFetch requests
      'appmi.store',    // Production domain
      '.appmi.store'    // Production wildcard subdomains
    ],
    hmr: false  // Disable WebSocket HMR - use log-based auto-reload instead
  }
}`
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
                  if (viteReadyResolve && !initialized.has(sandboxId)) {
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

          initialized.add(sandboxId);
          console.log({ message: "INIT: Complete", event: "init:complete" });
        }

        // For local dev, return /sandbox/:sandboxId/preview/ URL (with trailing slash for Vite base)
        // In production with custom domain, would expose port and return preview URL
        const previewUrl = new URL(`/sandbox/${sandboxId}/preview/`, url.origin).toString();

        console.log({
          message: "WS_URL: Returning to client",
          event: "wsurl:response",
          previewUrl,
          sandboxId
        });

        return Response.json({
          previewUrl,  // http://localhost:5151/sandbox/{sandboxId}/preview
          sandboxId
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

    // Route: POST /sandbox/:sandboxId/test-hmr - Update main.js to test HMR
    const testHmrMatch = url.pathname.match(/^\/sandbox\/([^/]+)\/test-hmr$/);
    if (testHmrMatch && request.method === 'POST') {
      const sandboxId = testHmrMatch[1];
      console.log({ message: "TEST_HMR: Updating main.js", event: "test:hmr:start", sandboxId });

      const sandbox = getSandbox(env.Sandbox, sandboxId, { normalizeId: true });

      try {
        const body = await request.json() as { count: number };
        const count = body.count || 0;

        // Update main.js with new counter value
        const newMainJs = `console.log('Hello from Vite! Count: ${count}');
const app = document.getElementById('app');
if (app) {
  app.innerHTML += '<p>JavaScript loaded successfully! Click count: <strong>${count}</strong></p>';
}`;

        await sandbox.writeFile('/workspace/main.js', newMainJs);

        console.log({
          message: "TEST_HMR: File updated",
          event: "test:hmr:success",
          count
        });

        return Response.json({
          success: true,
          count,
          message: 'main.js updated, HMR should trigger'
        });
      } catch (error) {
        console.error({ message: "TEST_HMR: Error", error: String(error) });
        return Response.json({
          success: false,
          error: String(error)
        }, { status: 500 });
      }
    }

    // Route: GET /sandbox/:sandboxId/logs-stream - Stream Vite server logs via SSE
    const logsMatch = url.pathname.match(/^\/sandbox\/([^/]+)\/logs-stream$/);
    if (logsMatch) {
      const sandboxId = logsMatch[1];
      console.log({ message: "LOGS_STREAM: Starting SSE stream", event: "logs:stream:start", sandboxId });

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

    // Route: /sandbox/:sandboxId/preview/* - Proxy to sandbox Vite server
    // This is the local dev pattern - routes directly to container without exposing ports
    const previewMatch = url.pathname.match(/^\/sandbox\/([^/]+)\/preview(.*)$/);
    if (previewMatch) {
      const sandboxId = previewMatch[1];
      const subPath = previewMatch[2] || '/';

      const sandbox = getSandbox(env.Sandbox, sandboxId, { normalizeId: true });

      console.log({
        message: "PREVIEW: Proxying request to sandbox",
        event: "preview:proxy",
        sandboxId,
        subPath
      });

      try {
        // Pass the original request to containerFetch with port 3333
        const response = await sandbox.containerFetch(request, 3333);

        console.log({
          message: "PREVIEW: Response from container",
          event: "preview:response",
          status: response.status
        });

        return response;
      } catch (error) {
        console.error({ message: "PREVIEW: Error", error: String(error) });
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // All other routes - 404
    return new Response('Not found', { status: 404 });
  }
};
