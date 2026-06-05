import type { Metadata, Viewport } from "next";
import { Inter, Fraunces } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./providers";

const fraunces = Fraunces({ subsets: ["latin"], display: "swap", variable: "--font-fraunces" });
const inter    = Inter({ subsets: ["latin"], display: "swap" });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://athletixos.app";
const SITE_NAME = "AthletixOS";
const SITE_TAGLINE = "Sports Club Management Software";
const SITE_DESCRIPTION =
  "Run your wrestling, martial arts, gymnastics, or youth sports club without spreadsheets. Members, classes, payments, attendance, messaging — all in one. 14-day free trial. 0% platform fee.";

const KEYWORDS = [
  "wrestling gym software",
  "martial arts gym software",
  "sports club management software",
  "wrestling academy management",
  "youth sports management",
  "athlete training software",
  "combat sports gym software",
  "gym management software",
  "BJJ gym software",
  "MMA gym software",
  "gymnastics club management",
  "class scheduling for gyms",
  "membership billing software",
];

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${SITE_TAGLINE}`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: KEYWORDS,
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: SITE_NAME,
  },
  formatDetection: { telephone: false, address: false, email: false },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: "en_US",
    images: [
      {
        url: "/brand/logo.PNG",
        width: 1200,
        height: 630,
        alt: `${SITE_NAME} — ${SITE_TAGLINE}`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    images: ["/brand/logo.PNG"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  category: "Business Software",
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

const ORG_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/brand/logo.PNG`,
  description: SITE_DESCRIPTION,
  sameAs: [],
};

const SOFTWARE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web, iOS, Android",
  description: SITE_DESCRIPTION,
  offers: [
    { "@type": "Offer", name: "Growth",     price: "50",  priceCurrency: "USD", category: "subscription" },
    { "@type": "Offer", name: "Pro",        price: "99",  priceCurrency: "USD", category: "subscription" },
    { "@type": "Offer", name: "Enterprise", price: "199", priceCurrency: "USD", category: "subscription" },
  ],
  aggregateRating: undefined,
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
        <Script
          id="ld-organization"
          type="application/ld+json"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORG_JSONLD) }}
        />
        <Script
          id="ld-software"
          type="application/ld+json"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(SOFTWARE_JSONLD) }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
