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
    return [
      {
        source: '/socket.io',
        destination: 'http://interfaces:5000/socket.io/',
      },
      {
        source: '/socket.io/:path+',
        destination: 'http://interfaces:5000/socket.io/:path+',
      },
      {
        source: '/api/:path*',
        destination: 'http://api:3001/:path*',
      },
    ];
  },
};

export default nextConfig;
