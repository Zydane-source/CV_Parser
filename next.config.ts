import type { NextConfig } from "next";

// Next.js dev tooling (webpack HMR, React refresh) relies on eval; production bundles do not.
const isDev = process.env.NODE_ENV !== "production";
const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // Allows a verification build to run without clobbering the .next directory a
  // dev server is currently using (CI: NEXT_DIST_DIR=.next-build npm run build).
  distDir: process.env.NEXT_DIST_DIR || ".next",
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
  /**
   * Files Tesseract loads from disk at runtime rather than through require().
   *
   * The deployment tracer follows imports, so it never saw these: the core's
   * .wasm is opened with fs, and the worker script is spawned by path. On Vercel
   * every OCR call then failed with ENOENT inside a worker thread, which nothing
   * could catch, and the invocation hung until the 60s limit — two in three
   * drain calls in production were dying this way.
   */
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/tesseract.js-core/*.wasm",
      "./node_modules/tesseract.js-core/*.js",
      "./node_modules/tesseract.js/src/worker-script/**/*",
      "./node_modules/tesseract.js/src/constants/**/*",
      "./node_modules/tesseract.js/src/utils/**/*",
      "./node_modules/wasm-feature-detect/**/*",
      "./node_modules/regenerator-runtime/**/*",
      "./node_modules/is-url/**/*",
      "./node_modules/zlibjs/**/*",
      "./node_modules/bmp-js/**/*",
      "./node_modules/node-fetch/**/*",
    ],
  },
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
