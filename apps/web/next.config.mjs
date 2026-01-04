const nextConfig = {
  output: 'standalone',
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
