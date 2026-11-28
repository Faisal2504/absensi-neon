import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fast Absensi Pro MFR",
  description: "Aplikasi absensi online dan offline dengan QR Code, GPS & selfie",
  manifest: "/manifest.json?v=6",
  icons: {
    icon: [
      { url: "/Logo%20Absensi%20Cepat%20Emas%20Pink.png?v=6", sizes: "192x192", type: "image/png" },
      { url: "/Logo%20Absensi%20Cepat%20Emas%20Pink.png?v=6", sizes: "512x512", type: "image/png" },
    ],
    shortcut: [{ url: "/Logo%20Absensi%20Cepat%20Emas%20Pink.png?v=6", type: "image/png" }],
    apple: [{ url: "/Logo%20Absensi%20Cepat%20Emas%20Pink.png?v=6", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0B1220",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
