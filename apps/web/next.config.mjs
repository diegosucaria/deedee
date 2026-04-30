import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  output: 'standalone',
  turbopack: {
    root: resolve(__dirname, '../..'),
  },
  // Boot-time auth bootstrap: applies LOGIN_PASSWORD env var, GCs the
  // store, and logs the auth posture. See src/instrumentation.js.
  experimental: {
    instrumentationHook: true,
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  async rewrites() {
    // Socket.io now routes through the API gateway (port 3001) directly,
    // bypassing Next.js. This enables proper WebSocket upgrades and avoids
    // Traefik forward-auth CSRF cookie spam from HTTP polling.
    // See useSocket.js getSocketUrl() for client-side routing.
    return {
      fallback: [
        {
          source: '/api/:path*',
          destination: 'http://api:3001/:path*',
        },
      ],
    };
  },
};

export default nextConfig;
