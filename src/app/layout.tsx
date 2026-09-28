import type { Metadata, Viewport } from "next";
import { Shippori_Mincho_B1, Zen_Kaku_Gothic_New } from "next/font/google";
import "./globals.css";

// 本文は読みやすい角ゴシック、見出しと屋号だけ明朝（茶の品書きのような落ち着き）
const gothic = Zen_Kaku_Gothic_New({ weight: ["400", "500", "700"], subsets: ["latin"], variable: "--font-body", display: "swap" });
const mincho = Shippori_Mincho_B1({ weight: ["600", "800"], subsets: ["latin"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "悠三堂メール",
  description: "悠三堂の業務メール：用途別の振り分け・返信下書き・カレンダー連携",
  robots: { index: false, follow: false },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "悠三堂メール", statusBarStyle: "default" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#3f6b3a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${gothic.variable} ${mincho.variable}`}>
      <body>{children}</body>
    </html>
  );
}
