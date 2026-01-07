import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const satoshi = localFont({
  src: [
    {
      path: "./fonts/Satoshi-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/Satoshi-Medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/Satoshi-Bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-satoshi",
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Visual Degrees - Who is connected to who?",
  description: "Find visual proof of connections between any two people through photos. Discover the degrees of separation using AI-powered image analysis.",
  keywords: ["six degrees of separation", "celebrity connections", "visual proof", "photo connections", "social graph"],
  authors: [{ name: "Visual Degrees" }],
  openGraph: {
    title: "Visual Degrees - Who is connected to who?",
    description: "Find visual proof of connections between any two people through photos.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Visual Degrees - Who is connected to who?",
    description: "Find visual proof of connections between any two people through photos.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${satoshi.className} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
