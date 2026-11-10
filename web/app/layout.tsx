import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Afterglow — your private picture house",
  description: "Your private picture house. Rate movies and whole TV series, save watchlists, and discover a great watch together.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
