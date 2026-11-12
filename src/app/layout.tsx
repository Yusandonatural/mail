import type { Metadata, Viewport } from "next";
import { Zen_Kaku_Gothic_New } from "next/font/google";
import "./globals.css";

// 端末の標準の文字（ヒラギノ・SF など）を優先し、無い端末だけ Zen Kaku Gothic を使う
const gothic = Zen_Kaku_Gothic_New({ weight: ["400", "500", "700"], subsets: ["latin"], variable: "--font-fallback", display: "swap" });

export const metadata: Metadata = {
  title: "悠三堂メール",
  description: "悠三堂の業務メール：用途別の振り分け・返信下書き・カレンダー連携",
  robots: { index: false, follow: false },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "悠三堂メール", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111317" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={gothic.variable}>
      <body>{children}</body>
    </html>
  );
}
