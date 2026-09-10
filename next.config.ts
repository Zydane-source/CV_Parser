import type { NextConfig } from "next";

// Next.js dev tooling (webpack HMR, React refresh) relies on eval; production bundles do not.
const isDev = process.env.NODE_ENV !== "production";
const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // Native / worker-heavy packages must not be bundled by webpack.
  serverExternalPackages: [
    "@prisma/client",
    "prisma",
    "bullmq",
    "ioredis",
    "pino",
    "sharp",
    "@napi-rs/canvas",
    "tesseract.js",
    "unpdf",
    "mammoth",
    "word-extractor",
    "googleapis",
    "file-type",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
