import "./globals.css";
import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

// metadataBase resolves every RELATIVE metadata URL, including the generated
// opengraph-image. It previously pointed at graphadvocate.com, which is a
// different site — so the card image would have been requested from a host that
// does not serve it. Prefer whatever Vercel says this deployment is, so preview
// builds get their own working card instead of pointing at production.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://x402-watch.vercel.app");

export const metadata: Metadata = {
  title: "x402 Watch",
  description:
    "Live tracker of x402 micropayments to The Graph on Base — agent counts, growth, and per-agent leaderboards.",
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    title: "x402 Watch",
    description:
      "Live x402 micropayments on Base, with ERC-8004 agent attribution.",
    type: "website",
    url: "/",
    siteName: "x402 Watch",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "x402 Watch — live agent payments to The Graph on Base" }],
  },
  twitter: {
    // summary_large_image promises X an image. Until app/opengraph-image.tsx
    // existed this card declared one and never supplied it, so X fell back to a
    // bare text preview — worse than declaring "summary".
    card: "summary_large_image",
    title: "x402 Watch",
    description: "Live x402 micropayments on Base.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "x402 Watch — live agent payments to The Graph on Base" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${interTight.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen">
        <div className="mx-auto max-w-[1280px] px-6 py-8">{children}</div>
        <footer className="mx-auto max-w-[1280px] px-6 pb-8 pt-2 text-center">
          <div className="text-[13px] font-medium tracking-wide text-muted">
            Data powered by{" "}
            <a
              className="text-ink underline decoration-accent decoration-2 underline-offset-4 hover:text-accent"
              href="https://thegraph.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              The Graph
            </a>
          </div>
          <div className="mt-1 text-[11px] text-dim">
            refreshes once daily · run by{" "}
            <a className="text-muted hover:text-accent" href="https://graphadvocate.com" target="_blank" rel="noopener noreferrer">
              graphadvocate.eth
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
