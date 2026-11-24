'use client';

import React from 'react';
import { Crown, X, Zap } from 'lucide-react';
import { Language, translations } from '@/lib/translations';

interface PricingModalProps {
  credits: number;
  planType: 'free' | 'pro';
  lang: Language;
  onClose: () => void;
}

// I9: the buy/subscribe buttons used to show an alert pretending a payment
// gateway was "coming soon". No payment gateway is implemented, so the
// buttons are disabled and say so clearly instead of advertising a feature
// that does not exist.
export default function PricingModal({ credits, planType, lang, onClose }: PricingModalProps) {
  const t = translations[lang];
  const tr = (ar: string, trText: string, en: string) =>
    lang === 'ar' ? ar : lang === 'tr' ? trText : en;

  return (
    <div className="fixed inset-0 z-50 bg-[#05020d]/85 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-gradient-to-b from-[#1a0d38] to-[#0d061f] border border-amber-400/40 rounded-3xl max-w-2xl w-full p-6 sm:p-8 relative shadow-[0_0_60px_rgba(168,85,247,0.35)]">
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-purple-500 via-amber-400 to-fuchsia-500 rounded-t-3xl" />

        <button
          onClick={onClose}
          className="absolute top-4 end-4 text-purple-300 hover:text-white cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="text-center mb-6">
          <h2 className="text-2xl font-extrabold text-white mb-2">
            {tr(
              'اشحن رصيدك وحوّل الشروحات والكتب إلى خطوات عملية',
              'Kredinizi yükleyin ve dersleri/kitapları adımlara dönüştürün',
              'Upgrade Your Learning Workflow'
            )}
          </h2>
          <p className="text-sm text-amber-300/90 font-medium">
            {tr(
              `رصيدك الحالي: ${planType === 'pro' ? 'غير محدود (PRO)' : `${credits} شروحات`}`,
              `Mevcut bakiyeniz: ${planType === 'pro' ? 'Sınırsız (PRO)' : `${credits} kredi`}`,
              `Current balance: ${planType === 'pro' ? 'Unlimited (PRO)' : `${credits} credits`}`
            )}
          </p>
          <p className="text-xs text-purple-200/70 mt-2">{t.paymentUnavailable}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* باقة الطلاب */}
          <div className="bg-[#090514]/90 border border-purple-500/30 rounded-2xl p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold uppercase px-3 py-1 rounded-full bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30">
                  {tr('باقة الطلاب', 'Öğrenci Paketi', 'Student Pack')}
                </span>
                <Zap className="w-5 h-5 text-fuchsia-400" />
              </div>
              <div className="text-3xl font-extrabold text-white mb-1">
                $5{' '}
                <span className="text-xs font-normal text-purple-300/70">
                  {tr('/ 50 شرحاً', '/ 50 özet', '/ 50 summaries')}
                </span>
              </div>
              <p className="text-xs text-purple-200/70 mb-4">
                {tr(
                  'ادفع عند الحاجة — رصيد لا تنتهي صلاحيته أبداً',
                  'İhtiyaç duydukça ödeyin — krediler asla bitmez',
                  'Pay-As-You-Go — Credits never expire'
                )}
              </p>
              <ul className="space-y-2 text-xs text-purple-100/90 mb-6">
                <li>✓ {tr('تحويل 50 فيديو يوتيوب أو كتاب PDF إلى خطوات', '50 YouTube videosu veya PDF kitabı adıma dönüştürme', 'Turn 50 YouTube videos or PDF books into steps')}</li>
                <li>✓ {tr('تصدير مباشر إلى Notion و PDF', 'Notion ve PDF’ye doğrudan dışa aktarma', 'Direct export to Notion and PDF')}</li>
                <li>✓ {tr('بدون التزام باشتراك شهري', 'Aylık abonelik zorunluluğu yok', 'No monthly subscription commitment')}</li>
              </ul>
            </div>
            <button
              disabled
              title={t.paymentUnavailable}
              className="w-full bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white font-bold py-2.5 rounded-xl text-sm transition cursor-not-allowed opacity-50"
            >
              {tr('شراء 50 شرحاً ($5)', '50 Özet Satın Al ($5)', 'Buy 50 Credits ($5)')}
            </button>
          </div>

          {/* باقة صناع المحتوى والمدربين الذهبية */}
          <div className="bg-gradient-to-b from-purple-900/40 to-[#090514] border border-amber-400/50 rounded-2xl p-6 flex flex-col justify-between shadow-[0_0_30px_rgba(251,191,36,0.15)]">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold uppercase px-3 py-1 rounded-full bg-amber-400/20 text-amber-300 border border-amber-400/40">
                  {tr('صنّاع المحتوى والمدربين', 'İçerik Üreticileri ve Eğitmenler', 'Creators & Coaches')}
                </span>
                <Crown className="w-5 h-5 text-amber-400" />
              </div>
              <div className="text-3xl font-extrabold text-amber-300 mb-1">
                $12{' '}
                <span className="text-xs font-normal text-purple-200/70">
                  {tr('/ شهرياً', '/ aylık', '/ month')}
                </span>
              </div>
              <p className="text-xs text-purple-200/70 mb-4">
                {tr(
                  'حوّل فيديوهاتك الطويلة وكتبك إلى ملخصات جاهزة لمتابعيك',
                  'Uzun videolarınızı ve kitaplarınızı takipçileriniz için hazır özetlere dönüştürün',
                  'Turn long tutorials & books into downloadable PDF/Notion guides'
                )}
              </p>
              <ul className="space-y-2 text-xs text-purple-100/90 mb-6">
                <li>✓ {tr('تحويل عدد غير محدود من الشروحات والكتب شهرياً', 'Ayda sınırsız özet ve kitap dönüştürme', 'Unlimited summaries and books every month')}</li>
                <li>✓ {tr('تصدير احترافي PDF و Notion جاهز للتوزيع', 'Dağıtıma hazır profesyonel PDF ve Notion dışa aktarma', 'Professional PDF & Notion export ready to share')}</li>
                <li>✓ {tr('ربط بوت تيليجرام للحفظ الفوري', 'Anında kaydetme için Telegram botu bağlantısı', 'Telegram bot link for instant saving')}</li>
              </ul>
            </div>
            <button
              disabled
              title={t.paymentUnavailable}
              className="w-full bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 text-[#180a2e] font-extrabold py-2.5 rounded-xl text-sm transition cursor-not-allowed opacity-50"
            >
              {tr('اشترك الآن ($12/شهر)', 'Şimdi Abone Ol ($12/ay)', 'Subscribe ($12/mo)')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
