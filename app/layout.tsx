import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

/**
 * The three faces the design system specifies.
 *
 * Loaded through next/font rather than a stylesheet link: the files are
 * self-hosted at build time, so there is no render-blocking request to a third
 * party and no flash of fallback text. Worth noting that the previous stylesheet
 * named Inter but nothing ever fetched it — the app had been rendering in
 * whatever the operating system offered.
 *
 * Only the weights the design system actually uses are requested.
 */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-jakarta",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "CV Parser", template: "%s · CV Parser" },
  description: "Parse CVs from manual uploads and Google Drive: candidate name, phone number and job role applied for.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${jakarta.variable} ${mono.variable}`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
