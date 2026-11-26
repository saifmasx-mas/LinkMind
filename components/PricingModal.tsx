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

// I9 (2026-11-26): no payment gateway yet (Stripe/PayPal do not serve
// businesses registered in Türkiye). Buying is manual: each plan has a
// WhatsApp button (wa.me link with a prefilled message) and a Telegram
// button (t.me/+<phone> opens a direct chat with the owner — NOT the
// link bot, whose webhook only handles /start tokens and link saves, so a
// buyer's message to the bot would never reach the owner). The owner
// activates the plan manually after payment.
const WHATSAPP_NUMBER = '905362515878';
const TELEGRAM_CHAT_URL = 'https://t.me/+905362515878';
const waLink = (message: string) =>
  `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
export default function PricingModal({ credits, planType, lang, onClose }: PricingModalProps) {
  const t = translations[lang];
  const tr = (ar: string, trText: string, en: string) =>
    lang === 'ar' ? ar : lang === 'tr' ? trText : en;

  return (
    <div className="fixed inset-0 z-50 bg-[#05020d]/85 backdrop-blur-md flex items-center justify-center p-4">
      {/* التصميم (2026-11-24): حد أقصى 90% من الشاشة مع تمرير داخلي،
          حتى لا تنقطع النافذة على الهواتف القصيرة (~667 بكسل). */}
      <div className="bg-gradient-to-b from-[#1a0d38] to-[#0d061f] border border-amber-400/40 rounded-3xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:p-8 relative shadow-[0_0_60px_rgba(168,85,247,0.35)]">
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-purple-500 via-amber-400 to-fuchsia-500 rounded-t-3xl" />

        <button
          onClick={onClose}
          aria-label={lang === 'ar' ? 'إغلاق نافذة الباقات' : lang === 'tr' ? 'Pencereyi kapat' : 'Close pricing window'}
          className="absolute top-4 end-4 min-w-11 min-h-11 flex items-center justify-center text-purple-300 hover:text-white cursor-pointer"
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
          <p className="text-xs text-purple-200/85 mt-2">{t.paymentUnavailable}</p>
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
                <span className="text-xs font-normal text-purple-300/85">
                  {tr('/ 50 شرحاً', '/ 50 özet', '/ 50 summaries')}
                </span>
              </div>
              <p className="text-xs text-purple-200/85 mb-4">
                {tr(
                  'ادفع عند الحاجة — رصيد لا تنتهي صلاحيته أبداً',
                  'İhtiyaç duydukça ödeyin — krediler asla bitmez',
                  'Pay-As-You-Go — Credits never expire'
                )}
              </p>
              <ul className="space-y-2 text-xs text-purple-100/90 mb-6">
                <li>✓ {tr('تحويل 50 فيديو يوتيوب أو كتاب PDF إلى خطوات', '50 YouTube videosu veya PDF kitabı adıma dönüştürme', 'Turn 50 YouTube videos or PDF books into steps')}</li>
                <li>✓ {tr('نسخ Markdown جاهز لـ Notion وتصدير PDF', 'Notion için hazır Markdown kopyalama ve PDF dışa aktarma', 'Copy Markdown ready for Notion and PDF export')}</li>
                <li>✓ {tr('بدون التزام باشتراك شهري', 'Aylık abonelik zorunluluğu yok', 'No monthly subscription commitment')}</li>
              </ul>
            </div>
            <div className="space-y-2">
              <a
                href={waLink(
                  tr(
                    'مرحباً، أريد شراء باقة الطلاب (50 شرحاً - $5) في LinkMind',
                    'Merhaba, LinkMind Öğrenci Paketi (50 özet - $5) satın almak istiyorum',
                    'Hello, I want to buy the LinkMind Student Pack (50 summaries - $5)'
                  )
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white font-bold py-2.5 rounded-xl text-sm transition hover:opacity-90 cursor-pointer"
              >
                {tr('شراء عبر واتساب ($5)', 'WhatsApp ile Satın Al ($5)', 'Buy via WhatsApp ($5)')}
              </a>
              <a
                href={TELEGRAM_CHAT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-transparent border border-purple-400/50 text-purple-100 font-bold py-2.5 rounded-xl text-sm transition hover:bg-purple-500/10 cursor-pointer"
              >
                {tr('شراء عبر تيليجرام ($5)', 'Telegram ile Satın Al ($5)', 'Buy via Telegram ($5)')}
              </a>
            </div>
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
                <span className="text-xs font-normal text-purple-200/85">
                  {tr('/ شهرياً', '/ aylık', '/ month')}
                </span>
              </div>
              <p className="text-xs text-purple-200/85 mb-4">
                {tr(
                  'حوّل فيديوهاتك الطويلة وكتبك إلى ملخصات جاهزة لمتابعيك',
                  'Uzun videolarınızı ve kitaplarınızı takipçileriniz için hazır özetlere dönüştürün',
                  'Turn long tutorials & books into downloadable PDF/Notion guides'
                )}
              </p>
              <ul className="space-y-2 text-xs text-purple-100/90 mb-6">
                <li>✓ {tr('تحويل عدد غير محدود من الشروحات والكتب شهرياً', 'Ayda sınırsız özet ve kitap dönüştürme', 'Unlimited summaries and books every month')}</li>
                <li>✓ {tr('نسخ Markdown احترافي جاهز لـ Notion وتصدير PDF', 'Notion için hazır profesyonel Markdown kopyalama ve PDF dışa aktarma', 'Professional Markdown copy ready for Notion and PDF export')}</li>
                <li>✓ {tr('ربط بوت تيليجرام للحفظ الفوري', 'Anında kaydetme için Telegram botu bağlantısı', 'Telegram bot link for instant saving')}</li>
              </ul>
            </div>
            <div className="space-y-2">
              <a
                href={waLink(
                  tr(
                    'مرحباً، أريد الاشتراك في باقة صناع المحتوى والمدربين ($12/شهر) في LinkMind',
                    'Merhaba, LinkMind İçerik Üreticileri ve Eğitmenler paketine abone olmak istiyorum ($12/ay)',
                    'Hello, I want to subscribe to the LinkMind Creators & Coaches plan ($12/month)'
                  )
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 text-[#180a2e] font-extrabold py-2.5 rounded-xl text-sm transition hover:opacity-90 cursor-pointer"
              >
                {tr('اشترك عبر واتساب ($12/شهر)', 'WhatsApp ile Abone Ol ($12/ay)', 'Subscribe via WhatsApp ($12/mo)')}
              </a>
              <a
                href={TELEGRAM_CHAT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-transparent border border-amber-400/50 text-amber-200 font-extrabold py-2.5 rounded-xl text-sm transition hover:bg-amber-400/10 cursor-pointer"
              >
                {tr('اشترك عبر تيليجرام ($12/شهر)', 'Telegram ile Abone Ol ($12/ay)', 'Subscribe via Telegram ($12/mo)')}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
