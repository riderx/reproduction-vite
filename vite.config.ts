import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [
    cloudflare({
      // Ensure all requests (including WebSocket) are passed to the worker
      persistState: true
    })
  ],
  server: {
    port: 5151,
    strictPort: true,
    host: true,
    allowedHosts: [
      'localhost',
      '.localhost'
    ]
  }
});
