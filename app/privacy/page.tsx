import type { Metadata } from 'next';
import { ArrowRight, Mail, Phone, ShieldCheck } from 'lucide-react';

export const metadata: Metadata = {
  title: 'سياسة الخصوصية | LinkMind',
  description:
    'يحفظ LinkMind روابطك وكتبك وملخصاتها في حسابك الخاص فقط، ولا يشاركها مع أي شخص أو جهة أخرى. بياناتك تبقى لك وحدك.',
};

// صفحة سياسة الخصوصية العامة (2026-11-27): رابطها مطلوب في
// Google Cloud Console لنشر تطبيق OAuth من Testing إلى Production،
// لأن زر «Publish app» معطّل ما دام رابط سياسة الخصوصية فارغاً.
// النص هو نص نافذة الخصوصية نفسه في التذييل حرفياً (lib/translations.ts).
export default function PrivacyPage() {
  return (
    <div
      dir="rtl"
      lang="ar"
      className="min-h-screen bg-[#070410] text-white font-sans relative overflow-x-hidden"
    >
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div className="absolute -top-32 -start-32 w-[520px] h-[520px] rounded-full bg-purple-700/25 blur-[130px]" />
        <div className="absolute top-1/4 -end-32 w-[480px] h-[480px] rounded-full bg-indigo-600/20 blur-[130px]" />
        <div className="absolute -bottom-32 start-1/3 w-[560px] h-[420px] rounded-full bg-fuchsia-600/20 blur-[140px]" />
      </div>

      <header className="relative z-10 border-b border-purple-500/20 bg-[#0d071c]/75 backdrop-blur-xl sticky top-0 shadow-[0_4px_30px_rgba(88,28,135,0.2)]">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <a href="/" className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="شعار LinkMind"
              className="w-11 h-11 rounded-xl object-cover border border-amber-400/50 shadow-[0_0_20px_rgba(251,191,36,0.4)]"
            />
            <span className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-500 bg-clip-text text-transparent">
              LinkMind
            </span>
          </a>
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-300 hover:text-amber-200"
          >
            <ArrowRight className="w-4 h-4" />
            العودة إلى الموقع
          </a>
        </div>
      </header>

      <main className="relative z-10 max-w-4xl mx-auto px-4 py-10">
        <div className="text-center mb-10">
          <ShieldCheck className="w-12 h-12 text-amber-400 mx-auto mb-4" />
          <h1 className="text-3xl font-extrabold bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-500 bg-clip-text text-transparent mb-3">
            سياسة الخصوصية
          </h1>
          <p className="text-sm text-purple-200/60">آخر تحديث: 27 تشرين الثاني 2026</p>
        </div>

        <section className="bg-[#120926]/85 backdrop-blur-xl border border-purple-500/30 rounded-3xl p-6 mb-6">
          <p className="text-base text-purple-200/90 leading-relaxed">
            يحفظ LinkMind روابطك وكتبك وملخصاتها في حسابك الخاص فقط، ولا يشاركها
            مع أي شخص أو جهة أخرى. بياناتك تبقى لك وحدك.
          </p>
        </section>

        <section className="bg-[#120926]/85 backdrop-blur-xl border border-purple-500/30 rounded-3xl p-6 mb-6">
          <h2 className="text-xl font-extrabold text-amber-300 flex items-center gap-2 mb-4">
            <Mail className="w-6 h-6 text-amber-400" />
            تواصل معنا
          </h2>
          <p className="text-sm text-purple-200/85 leading-relaxed mb-4">
            لأي استفسار عن خصوصية بياناتك:
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm font-semibold">
            <a
              href="tel:+905362515878"
              dir="ltr"
              className="flex items-center gap-1.5 text-amber-300 hover:text-amber-200 transition"
            >
              <Phone className="w-4 h-4" />
              +905362515878
            </a>
            <a
              href="mailto:saif.masx@gmail.com"
              className="flex items-center gap-1.5 text-amber-300 hover:text-amber-200 transition"
            >
              <Mail className="w-4 h-4" />
              saif.masx@gmail.com
            </a>
          </div>
        </section>

        <p className="text-center text-xs text-purple-200/60 mt-8">
          © 2026 LinkMind — جميع الحقوق محفوظة
        </p>
      </main>
    </div>
  );
}
