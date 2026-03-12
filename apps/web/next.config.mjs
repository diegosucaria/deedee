import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  output: 'standalone',
  turbopack: {
    root: resolve(__dirname, '../..'),
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  async rewrites() {
    return {
      // beforeFiles: intercept socket.io before any file-system check.
      beforeFiles: [
        {
          source: '/socket.io',
          destination: 'http://interfaces:5000/socket.io/',
        },
        {
          source: '/socket.io/:path+',
          destination: 'http://interfaces:5000/socket.io/:path+',
        },
      ],
      // fallback: only reached after ALL file-system routes (static AND dynamic)
      // have been checked. This ensures local API Route Handlers like
      // /api/logs/[container] and /api/whatsapp/avatar resolve first.
      // Unmatched /api/* paths are then proxied to the external API gateway.
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
