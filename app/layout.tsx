import type { Metadata, Viewport } from 'next';
import { Tajawal } from 'next/font/google';
import './globals.css';

// التصميم (2026-11-24): خط عربي مخصص (Tajawal) يُستضاف محلياً عبر
// next/font، فلا يحتاج اتصالاً خارجياً وقت التشغيل ويحترم سياسة
// font-src 'self' في next.config.ts.
const tajawal = Tajawal({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '700', '800'],
  variable: '--font-tajawal',
  display: 'swap',
});

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
    icon: '/icon-512.png',
    apple: '/icon-192.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // التصميم (2026-11-24): الاتجاه واللغة الافتراضيان عربيان؛ يحدّثهما
  // app/page.tsx من جهة العميل عند تبديل اللغة.
  // ملاحظة: صنف الخط يوضع على <html> لا على <body>، لأن متغير
  // --font-sans في @theme يُحسب على :root ويحتاج --font-tajawal
  // معرّفاً هناك، وإلا صار الخط غير صالح وقت الحساب.
  return (
    <html lang="ar" dir="rtl" className={tajawal.variable}>
      <body className="bg-[#070410] text-white antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
