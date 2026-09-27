import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
