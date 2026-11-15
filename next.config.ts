import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  // إبقاء مشغّل libsql الأصلي خارج حزمة serverless — تجميعه يكسر الاتصال بقاعدة Turso على Vercel
  serverExternalPackages: ["@libsql/client", "libsql"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
