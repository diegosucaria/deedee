import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";
import ZoomLock from "@/components/ZoomLock";

const inter = Inter({ subsets: ["latin"], display: 'swap', preload: true });

export const metadata = {
  title: "DeeDee Interface",
  description: "AI Agent Dashboard",
  icons: {
    icon: "/favicon-32x32.png",
    shortcut: "/favicon.ico",
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  manifest: "/site.webmanifest",
  appleWebApp: {
    capable: true,
    title: "DeeDee",
    statusBarStyle: "black-translucent",
  },
  // `apple-mobile-web-app-capable` (emitted by appleWebApp.capable above) is
  // deprecated in Chrome; the standard name is `mobile-web-app-capable`.
  // Emit both so old iOS + new Chrome both see it.
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }) {
  // Inject runtime config for client components.
  // SOCKET_URL is set at container runtime (e.g. Balena device vars) so we
  // can't rely on NEXT_PUBLIC_* (baked at build time). Instead, read the env
  // server-side and emit a tiny <script> the client can reference.
  const runtimeConfig = {
    socketUrl: process.env.SOCKET_URL || '',
  };

  return (
    <html lang="en" className="dark">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__DEEDEE_CONFIG__=${JSON.stringify(runtimeConfig)};`,
          }}
        />
      </head>
      <body
        className={`${inter.className} antialiased`}
      >
        <ZoomLock />
        <div className="flex h-dvh bg-black text-zinc-200 selection:bg-indigo-500 selection:text-white">
          <Sidebar />
          <main className="flex-1 min-w-0 overflow-y-auto relative flex flex-col overflow-x-hidden">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
