import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // ほかのサイトの iframe に埋め込ませない（削除・迷惑メールのボタンを押させるクリックジャッキング対策）。
  // 添付の配信が自分で付ける Content-Security-Policy（sandbox）を上書きしないよう、CSP はここでは付けない
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
