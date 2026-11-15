import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  // عميل Turso يُستورد بمسار الملف مباشرة (src/lib/turso.ts) فيُجمَّع كاملًا داخل حزمة
  // serverless — تخريج Next الافتراضي لاسم الحزمة ينسخ node_modules ناقصًا في standalone
  // ويفشل وقت التشغيل، لذا لا نعتمد عليه إطلاقًا.
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
