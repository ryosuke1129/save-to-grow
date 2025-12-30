import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
// ★追加: 作成したProviderをインポート
import AppWalletProvider from "../components/AppWalletProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Save to Grow",
  description: "Web3 Savings App",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <meta name="format-detection" content="telephone=no" />
      <body className={inter.className}>
        {/* ★追加: アプリ全体をProviderで囲む */}
        <AppWalletProvider>{children}</AppWalletProvider>
      </body>
    </html>
  );
}