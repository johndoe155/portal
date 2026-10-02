import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "School Portal", description: "High School Portal" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#4338ca" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
