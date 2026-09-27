import type { MetadataRoute } from "next";

/** ホーム画面に追加して使えるように（iPhone の通知にも必要） */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "悠三堂メール",
    short_name: "悠三堂メール",
    start_url: "/inbox",
    display: "standalone",
    background_color: "#f7f5f0",
    theme_color: "#3f6b3a",
    lang: "ja",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
