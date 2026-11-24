import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  themeColor: '#0d071c',
  width: 'device-width',
  initialScale: 1,
  // maximumScale: 1 was removed: it prevented pinch-to-zoom (accessibility).
};

export const metadata: Metadata = {
  title: 'LinkMind | ذاكرتك الثانية الذكية',
  description: 'حوّل الروابط والفيديوهات والكتب إلى ملخصات وخطوات عملية بالذكاء الاصطناعي',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'LinkMind',
  },
  icons: {
    icon: '/logo.png',
    apple: '/logo.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar">
      <body className="bg-[#070410] text-white antialiased font-sans">
        {children}
      </body>
    </html>
  );
}