import type { ComponentType, ReactNode } from 'react';
import {
  ArrowRight,
  Atom,
  Bell,
  BookOpen,
  Bot,
  Brain,
  CheckCircle2,
  Cloud,
  Code2,
  CreditCard,
  Cpu,
  Database,
  FileText,
  Gauge,
  Globe,
  GraduationCap,
  Info,
  Languages,
  Lightbulb,
  Link2,
  ListChecks,
  Lock,
  MessagesSquare,
  Orbit,
  Palette,
  Rocket,
  ShieldCheck,
  Sparkles,
  Trophy,
  Wallet,
} from 'lucide-react';

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="bg-[#120926]/85 backdrop-blur-xl border border-purple-500/30 rounded-3xl p-6 mb-6">
      <h2 className="text-xl font-extrabold text-amber-300 flex items-center gap-2 mb-4">
        <Icon className="w-6 h-6 text-amber-400" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Item({
  icon: Icon,
  title,
  text,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  text: string;
}) {
  return (
    <li className="flex items-start gap-3 bg-[#090514]/80 border border-purple-500/15 rounded-2xl px-4 py-3">
      <Icon className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-bold text-white">{title}</p>
        <p className="text-sm text-purple-200/85 leading-relaxed">{text}</p>
      </div>
    </li>
  );
}

const tech = [
  { name: 'Next.js 15', desc: 'إطار عمل React مع مسارات API مدمجة', Icon: Rocket },
  { name: 'TypeScript', desc: 'كتابة آمنة الأنواع تقلل الأخطاء قبل التشغيل', Icon: Code2 },
  { name: 'React 19', desc: 'واجهة تفاعلية سريعة', Icon: Atom },
  { name: 'Tailwind CSS', desc: 'تنسيق سريع بهوية بنفسجي داكن وذهبي', Icon: Palette },
  { name: 'Supabase', desc: 'قاعدة بيانات Postgres والمصادقة وحماية RLS', Icon: Database },
  { name: 'Google Gemini', desc: 'التلخيص وتوليد الخطوات والإجابة عن الأسئلة', Icon: Brain },
  { name: 'Vercel', desc: 'استضافة ونشر تلقائي عند كل دمج', Icon: Cloud },
  { name: 'Cloudflare Turnstile', desc: 'تحقق أن المستخدم إنسان قبل تسجيل الدخول', Icon: ShieldCheck },
  { name: 'Telegram Bot API', desc: 'حفظ الروابط والدعم من داخل تيليجرام', Icon: Bot },
];

export default function PresentationPage() {
  return (
    <div dir="rtl" lang="ar" className="min-h-screen bg-[#070410] text-white font-sans relative overflow-x-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div className="absolute -top-32 -start-32 w-[520px] h-[520px] rounded-full bg-purple-700/25 blur-[130px]" />
        <div className="absolute top-1/4 -end-32 w-[480px] h-[480px] rounded-full bg-indigo-600/20 blur-[130px]" />
        <div className="absolute -bottom-32 start-1/3 w-[560px] h-[420px] rounded-full bg-fuchsia-600/20 blur-[140px]" />
      </div>

      <header className="relative z-10 border-b border-purple-500/20 bg-[#0d071c]/75 backdrop-blur-xl sticky top-0 shadow-[0_4px_30px_rgba(88,28,135,0.2)]">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <a href="/" className="flex items-center gap-3">
            <img src="/logo.png" alt="شعار LinkMind" className="w-11 h-11 rounded-xl object-cover border border-amber-400/50 shadow-[0_0_20px_rgba(251,191,36,0.4)]" />
            <span className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-500 bg-clip-text text-transparent">
              LinkMind
            </span>
          </a>
          <a href="/" className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-300 hover:text-amber-200">
            <ArrowRight className="w-4 h-4" />
            العودة إلى الموقع
          </a>
        </div>
      </header>

      <main className="relative z-10 max-w-4xl mx-auto px-4 py-10">
        <div className="text-center mb-10">
          <GraduationCap className="w-12 h-12 text-amber-400 mx-auto mb-4" />
          <h1 className="text-3xl font-extrabold bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-500 bg-clip-text text-transparent mb-3">
            LinkMind — العرض التقديمي لمشروع التخرج
          </h1>
          <p className="text-base text-purple-200/90 leading-relaxed">
            ذاكرتك الثانية الذكية لتنظيم الروابط والكتب — هذه الصفحة للشرح أمام لجنة التخرج.
          </p>
        </div>

        <Section icon={Lightbulb} title="1 — ما هو LinkMind؟ والمشكلة التي يحلها">
          <ul className="space-y-3 list-none">
            <Item icon={Brain} title="الفكرة" text="ذاكرة سحابية ذكية: تلصق رابطاً أو ترفع كتاباً، فيحوّله الذكاء الاصطناعي إلى ملخص وخطوات عملية محفوظة في مكتبة قابلة للبحث." />
            <Item icon={Info} title="المشكلة" text="الروابط والفيديوهات والكتب تتراكم وتضيع؛ وإعادة قراءتها أو مشاهدتها تستهلك وقتاً طويلاً، ولا يوجد مكان واحد يجمعها مع ملخصاتها." />
            <Item icon={CheckCircle2} title="الحل" text="مكان واحد يحفظ كل شيء مع ملخص ذكي وخطوات عملية، مع إمكانية سؤال المكتبة عن محفوظاتها بالمعنى." />
          </ul>
        </Section>

        <Section icon={ListChecks} title="2 — كيف يعمل؟">
          <ul className="space-y-3 list-none">
            <Item icon={Link2} title="الخطوة 1 — حفظ رابط" text="الصق رابط يوتيوب أو فيسبوك أو تيك توك أو إكس أو مقال، واضغط «حفظ وتلخيص»." />
            <Item icon={BookOpen} title="الخطوة 2 — رفع كتاب" text="ارفع ملف PDF أو Word فيحصل الكتاب على ملخص شامل فصلاً بفصل." />
            <Item icon={MessagesSquare} title="الخطوة 3 — اسأل ذاكرتك" text="اسأل عن محفوظاتك بالمعنى، فيجيب الذكاء الاصطناعي من مكتبتك أنت فقط." />
            <Item icon={Orbit} title="الخطوة 4 — المكتبة «المجرة»" text="كل المحفوظات مصنفة حسب المصدر وقابلة للبحث بالمعنى، في بطاقات مضغوطة مع زر «المزيد» لعرض الملخص الكامل." />
          </ul>
        </Section>

        <Section icon={Sparkles} title="3 — الميزات">
          <ul className="space-y-3 list-none">
            <Item icon={Globe} title="مصادر متعددة" text="YouTube و Facebook و TikTok و X و Instagram والمقالات والمدونات وملفات PDF و Word." />
            <Item icon={FileText} title="ملخصات شاملة" text="الكتب والمقالات الطويلة تُلخَّص قسماً بقسم ثم تُدمج في ملخص واحد كامل." />
            <Item icon={Bot} title="بوت تيليجرام" text="حفظ الروابط من تيليجرام، ووكيل دعم يجيب عن أسئلة العملاء ويحوّل نية الشراء إلى صاحب الموقع." />
            <Item icon={Bell} title="إشعارات المسؤول" text="إشعار فوري عند كل تسجيل جديد، وصفحة «المشتركون الجدد» للمسؤول فقط." />
            <Item icon={Languages} title="ثلاث لغات" text="العربية والتركية والإنجليزية في كل الواجهة." />
            <Item icon={ShieldCheck} title="صدق المحتوى" text="إذا تعذّر جلب محتوى رابط لا يُحفظ ملخص مخترَع ولا يُخصم أي رصيد." />
          </ul>
        </Section>

        <Section icon={Cpu} title="4 — التقنية المستخدمة">
          <div className="grid sm:grid-cols-2 gap-3">
            {tech.map(({ name, desc, Icon }) => (
              <div key={name} className="flex items-start gap-3 bg-[#090514]/80 border border-purple-500/15 rounded-2xl px-4 py-3">
                <Icon className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-white" dir="ltr" style={{ textAlign: 'right' }}>{name}</p>
                  <p className="text-sm text-purple-200/85 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section icon={Lock} title="5 — الأمان">
          <ul className="space-y-3 list-none">
            <Item icon={Database} title="حماية RLS" text="كل مستخدم يرى بياناته فقط؛ لا يستطيع أحد الوصول إلى مكتبة غيره." />
            <Item icon={ShieldCheck} title="التحقق البشري" text="Cloudflare Turnstile يتأكد أن المستخدم إنسان قبل تسجيل الدخول." />
            <Item icon={CheckCircle2} title="بوابة «لا محتوى»" text="لا ملخصات مخترَعة ولا خصم رصيد عند فشل جلب محتوى الرابط." />
            <Item icon={Gauge} title="حدود الاستخدام" text="حد معدل في كل مسار حتى لا يُستنزف الذكاء الاصطناعي." />
            <Item icon={Lock} title="مصادقة آمنة" text="مصادقة Bearer في كل مسار حساس، ولا ثقة بمدخلات المستخدم في تحديد الهوية." />
          </ul>
        </Section>

        <Section icon={CreditCard} title="6 — الباقات والدفع">
          <ul className="space-y-3 list-none">
            <Item icon={Wallet} title="باقة الطلاب — 5 دولارات" text="50 شرحاً بدفعة واحدة، والرصيد لا تنتهي صلاحيته أبداً." />
            <Item icon={Trophy} title="باقة صناع المحتوى والمدربين — 12 دولاراً شهرياً" text="شروحات وكتب غير محدودة." />
            <Item icon={Info} title="بصدق: لا توجد بوابة دفع آلية بعد" text="Stripe و PayPal لا يخدمان الشركات المسجلة في تركيا. الدفع حالياً يدوي عبر واتساب أو تيليجرام، والتفعيل يدوي بعد إتمام الدفع." />
          </ul>
        </Section>

        <Section icon={Trophy} title="7 — ملخص ما تم إنجازه">
          <ul className="space-y-3 list-none">
            <Item icon={CheckCircle2} title="الموقع مكتمل ويعمل حياً" text="على link-mind-bay.vercel.app، مع 19 طلب سحب مدموجة: إصلاحات أمان، وملخصات شاملة، وبوت تيليجرام، ووكيل دعم، وإصلاحات تصنيف." />
            <Item icon={Info} title="حدود معروفة بصدق" text="روابط LinkedIn لا يمكن تلخيص محتواها (جدار تسجيل دخول)؛ وملخصات الفيديو من العنوان والوصف وليست نصاً منطوقاً كاملاً؛ ولا يوجد تطبيق جوال بعد." />
          </ul>
        </Section>

        <p className="text-center text-xs text-purple-200/60 mt-8">© 2026 LinkMind — جميع الحقوق محفوظة</p>
      </main>
    </div>
  );
}
