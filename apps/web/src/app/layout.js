import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "DeeDee Interface",
  description: "AI Agent Dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.className} antialiased`}
      >
        <div className="flex min-h-screen bg-black text-zinc-200 selection:bg-indigo-500 selection:text-white">
          <Sidebar />
          <main className="flex-1 overflow-hidden relative flex flex-col">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
