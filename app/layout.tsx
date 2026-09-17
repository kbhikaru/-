import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "空き日程マッチ",
  description:
    "複数の Google カレンダー予約ページを入力すると、共通の空き時間を計算して共有できます。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
