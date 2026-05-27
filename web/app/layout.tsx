import type { Metadata, Viewport } from "next";
import { Inter, Fraunces } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const fraunces = Fraunces({ subsets: ["latin"], display: "swap", variable: "--font-fraunces" });
const inter    = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "AthletixOS — Gym & Sports Club Management",
  description: "Run your gym without the spreadsheets. Members, classes, payments, and messaging in one place.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AthletixOS",
  },
  formatDetection: { telephone: false },
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#1F1F23",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.className} ${fraunces.variable}`}>
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.svg" />
        {/* Apply persisted theme before first paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('athletixos-theme');if(t==='dark')document.documentElement.dataset.theme='dark';}catch(e){}`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
