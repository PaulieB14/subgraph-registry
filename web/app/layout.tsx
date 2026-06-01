import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "The Graph x402 Watch",
  description:
    "Live tracker of x402 micropayments to The Graph's gateway on Base — agent counts, growth, and per-agent leaderboards.",
  metadataBase: new URL("https://graphadvocate.com"),
  openGraph: {
    title: "The Graph x402 Watch",
    description:
      "Live x402 micropayments to The Graph on Base, with ERC-8004 agent attribution.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "The Graph x402 Watch",
    description: "Live x402 micropayments to The Graph on Base.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="mx-auto max-w-[1280px] px-6 py-8">{children}</div>
      </body>
    </html>
  );
}
