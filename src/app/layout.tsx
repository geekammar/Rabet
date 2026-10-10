import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Rabet",
    template: "%s — Rabet",
  },
  description:
    "Rabet is a lightweight Telegram-based digital services management system with a web dashboard.",
  applicationName: "Rabet",
  appleWebApp: {
    capable: true,
    title: "Rabet",
    // Matches the light dashboard surface so the status bar blends with the
    // sticky header in standalone mode.
    statusBarStyle: "default",
  },
  icons: {
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
};

// `viewportFit: "cover"` extends the page into display cut-outs so the
// `env(safe-area-inset-*)` paddings used by the shell actually take effect on
// notched phones in standalone mode. `themeColor` belongs here (not in
// `metadata`) per the Next.js viewport API.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* dvh keeps the shell sized against the mobile dynamic viewport so the
          on-screen chrome (address bar) cannot push content out of view. */}
      <body className="flex min-h-dvh flex-col">{children}</body>
    </html>
  );
}
