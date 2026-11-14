import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['pdfmake'],
  // pdfmake reads the PDF amount font from disk at runtime, so file tracing can't find it on its own.
  outputFileTracingIncludes: {
    '/api/payroll/reports/**': ['src/features/payroll-reports/assets/fonts/**/*'],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
