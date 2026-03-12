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
      // beforeFiles: Next.js API Routes in src/app/api/ are resolved first.
      // afterFiles: only unmatched /api/* paths are proxied to the external API gateway.
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
      afterFiles: [
        {
          source: '/api/:path*',
          destination: 'http://api:3001/:path*',
        },
      ],
    };
  },
};

export default nextConfig;
