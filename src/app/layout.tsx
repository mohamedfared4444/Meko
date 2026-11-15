import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meko — مولد الوسائط الذكي (MCP)",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع لوحة إدارة عربية وتبديل تلقائي للمفاتيح.",
  keywords: ["MCP", "AI", "media generator", "kie.ai", "Turso", "Next.js"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* خط عربي جيد — يُحمَّل وقت التشغيل ولا يعطل البناء */}
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-slate-950 text-slate-100 [font-family:Cairo,ui-sans-serif,system-ui,'Segoe_UI',sans-serif]">
        {children}
      </body>
    </html>
  );
}
