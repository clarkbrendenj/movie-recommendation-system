import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Afterglow — your next great movie",
  description: "Rate the films you know. Find the ones you'll love. Your own movie club, shaped by your taste.",
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
