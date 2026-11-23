import type { Metadata, Viewport } from 'next';
import { Cairo, Inter } from 'next/font/google';
import './globals.css';

const cairo = Cairo({
  subsets: ['arabic', 'latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-cairo',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-inter',
});

export const viewport: Viewport = {
  themeColor: '#0d071c',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
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
    <html lang="ar" className={`${cairo.variable} ${inter.variable}`}>
      <body className="bg-[#070410] text-white antialiased font-sans">
        {children}
      </body>
    </html>
  );
}