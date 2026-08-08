import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@metrika/contracts'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
