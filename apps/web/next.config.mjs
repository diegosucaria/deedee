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
    ];
  },
};

export default nextConfig;
