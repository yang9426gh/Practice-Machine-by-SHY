import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Practice Machine by SHY",
  description: "Karaoke practice machine — stems, lyrics & chords",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
