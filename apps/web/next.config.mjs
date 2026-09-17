import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  // The standalone output copies traced symlinks as they are, so in a git
  // worktree whose node_modules are links into the main checkout, .next/
  // standalone holds links that point back at it. The next build clears
  // .next by walking it, follows those links and empties the main checkout.
  // The prebuild script in package.json removes .next/standalone first.
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
