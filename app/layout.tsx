import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CV Parser", template: "%s · CV Parser" },
  description: "Parse CVs from manual uploads and Google Drive: candidate name, phone number and job role applied for.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
