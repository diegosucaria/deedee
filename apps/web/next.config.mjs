const nextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/socket.io/:path*',
        destination: 'http://interfaces:5000/socket.io/:path*',
      },
    ];
  },
};

export default nextConfig;
