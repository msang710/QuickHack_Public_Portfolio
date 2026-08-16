// QuickHack note: QuickHack Next.js 앱의 빌드/런타임 설정을 정의합니다.
import type { NextConfig } from "next";

const configuredDistDir = String(
  process.env.QUICKHACK_NEXT_DIST_DIR || ""
).trim();

const nextConfig: NextConfig = {
  ...(configuredDistDir ? { distDir: configuredDistDir } : {}),
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": ["./node_modules/next/dist/lib/metadata/**/*"],
  },
  outputFileTracingExcludes: {
    "/*": [
      "./release/**/*",
      "./backups/**/*",
      "./config/**/*",
      "./data/**/*",
      "./database/**/*",
      "./mock_server/database/**/*",
      "./quickhack-keys/**/*",
      "./tools/node-portable/**/*",
      "./tools/android-sdk/**/*",
      "./tools/gradle/**/*",
      "./platform-tools/**/*",
      "./docs/**/*",
      "./screenshots/**/*",
      "./.tmp*/**/*",
      "./**/.env*",
      "./**/*.qhkey",
      "./**/*.key",
      "./**/*.pem",
      "./**/*.p12",
      "./**/*.pfx",
    ],
  },
  webpack(config) {
    if (
      process.env.CI === "true" ||
      process.env.QUICKHACK_DISABLE_BUILD_CACHE === "1"
    ) {
      config.cache = false;
    }
    return config;
  },
};

export default nextConfig;
