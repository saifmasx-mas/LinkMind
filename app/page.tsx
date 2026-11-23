'use client';

import React, { useState, useEffect } from 'react';
import { translations, Language } from '@/lib/translations';
import { supabase } from '@/lib/supabase';
import { User } from '@supabase/supabase-js';
import {
  Brain,
  Plus,
  Search,
  ExternalLink,
  Trash2,
  Sparkles,
  Globe,
  MessageSquare,
  X,
  LogOut,
  Lock,
  Send,
  CheckSquare,
  Square,
  FileText,
  Copy,
  Check,
  Zap,
  Crown,
} from 'lucide-react';

interface Bookmark {
  id: string;
  url: string;
  title: string;
  summary: string;
  category: string;
  image_url?: string;
  checklist?: string[];
  embedding?: number[];
  created_at: string;
}

function cosineSimilarity(vecA?: number[], vecB?: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export default function Home() {
  const [lang, setLang] = useState<Language>('ar');
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // حالة الرصيد والباقة
  const [credits, setCredits] = useState<number>(5);
  const [planType, setPlanType] = useState<'free' | 'pro'>('free');
  const [showPricingModal, setShowPricingModal] = useState(false);

  const [urlInput, setUrlInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [queryEmbedding, setQueryEmbedding] = useState<number[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);

  // تتبع الخطوات المنجزة لكل بطاقة ونسخ Notion
  const [completedSteps, setCompletedSteps] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [askQuery, setAskQuery] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [asking, setAsking] = useState(false);

  const t = translations[lang];
  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || 'saifmas_bot';

  // التحقق من حالة تسجيل الدخول
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // جلب الروابط والرصيد عند تسجيل الدخول
  useEffect(() => {
    if (user) {
      fetchBookmarks();
      fetchUserProfile();
    } else {
      setBookmarks([]);
    }
  }, [user]);

  const fetchUserProfile = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('user_profiles')
      .select('credits, plan_type')
      .eq('user_id', user.id)
      .single();

    if (data) {
      setCredits(data.credits);
      setPlanType(data.plan_type === 'pro' ? 'pro' : 'free');
    }
  };

  const fetchBookmarks = async () => {
    const { data, error } = await supabase
      .from('bookmarks')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data) {
      const formatted = data.map((item) => ({
        ...item,
        checklist: Array.isArray(item.checklist)
          ? item.checklist
          : typeof item.checklist === 'string'
          ? JSON.parse(item.checklist)
          : [],
        embedding: typeof item.embedding === 'string' ? JSON.parse(item.embedding) : item.embedding,
        created_at: new Date(item.created_at).toLocaleDateString(),
      }));
      setBookmarks(formatted);
    }
  };

  const handleAuth = async (isSignUp: boolean) => {
    setAuthError('');
    if (!email || !password) return;

    const { error } = isSignUp
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setAuthError(error.message);
    }
  };

  const handleGoogleLogin = async () => {
    setAuthError('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
    if (error) {
      setAuthError(error.message);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  // تحديث البصمة الدلالية للبحث
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 3) {
      setQueryEmbedding([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery, mode: 'embed' }),
        });
        if (res.ok) {
          const data = await res.json();
          setQueryEmbedding(data.embedding || []);
        }
      } catch {}
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // تحويل الرابط إلى ملخص وخطوات عملية
  const handleAddBookmark = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim() || !user) return;

    if (planType !== 'pro' && credits <= 0) {
      setShowPricingModal(true);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlInput.trim(),
          lang,
          userId: user.id,
        }),
      });

      const data = await res.json();

      if (res.status === 402 || data.error === 'OUT_OF_CREDITS') {
        setCredits(0);
        setShowPricingModal(true);
        return;
      }

      if (res.ok) {
        const { error: dbError } = await supabase.from('bookmarks').insert({
          user_id: user.id,
          url: urlInput.trim(),
          title: data.title,
          summary: data.summary,
          category: data.category,
          image_url: data.image_url,
          checklist: data.checklist || [],
          embedding: data.embedding && data.embedding.length > 0 ? data.embedding : null,
        });

        if (!dbError) {
          if (typeof data.remainingCredits === 'number') {
            setCredits(data.remainingCredits);
          }
          await fetchBookmarks();
          setUrlInput('');
        } else {
          alert('Database error: ' + dbError.message);
        }
      } else {
        alert(lang === 'ar' ? 'تأكد من صحة الرابط!' : 'Please enter a valid URL!');
      }
    } catch {
      alert('Error processing link');
    } finally {
      setLoading(false);
    }
  };

  // تبديل حالة إنجاز الخطوة
  const toggleStep = (bookmarkId: string, stepIndex: number) => {
    const key = `${bookmarkId}-${stepIndex}`;
    setCompletedSteps((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // نسخ الخطوات بصيغة Notion / Markdown
  const handleCopyNotion = (item: Bookmark) => {
    const stepsText = (item.checklist || [])
      .map((step, idx) => `- [ ] **${idx + 1}.** ${step}`)
      .join('\n');

    const markdown = `# ${item.title}\n\n> ${item.summary}\n\n🔗 **Source:** ${item.url}\n\n## Actionable Checklist\n${stepsText}\n\n---\n*Generated by LinkMind AI*`;

    navigator.clipboard.writeText(markdown);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // تصدير الخطوات كملف PDF منسق
  const handleExportPDF = (item: Bookmark) => {
    const printWindow = window.open('', '_blank', 'width=800,height=900');
    if (!printWindow) return;

    const stepsHtml = (item.checklist || [])
      .map(
        (step, idx) =>
          `<li style="margin-bottom: 12px; padding: 10px 14px; background: #f8fafc; border-radius: 8px; border-inline-start: 4px solid #4f46e5;">
            <strong>${idx + 1}.</strong> ${step}
          </li>`
      )
      .join('');

    printWindow.document.write(`
      <html dir="${t.dir}">
        <head>
          <title>${item.title} - LinkMind Checklist</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; color: #0f172a; line-height: 1.6; }
            .badge { display: inline-block; background: #eef2ff; color: #4338ca; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: bold; }
            h1 { font-size: 24px; margin: 16px 0 12px; color: #1e1b4b; }
            .summary { background: #f1f5f9; padding: 16px; border-radius: 10px; color: #334155; margin-bottom: 24px; }
            ul { list-style: none; padding: 0; }
            .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; }
          </style>
        </head>
        <body>
          <span class="badge">${item.category}</span>
          <h1>${item.title}</h1>
          <div class="summary">${item.summary}</div>
          <h3>${lang === 'ar' ? 'خطوات التنفيذ العملية (Checklist):' : 'Actionable Checklist:'}</h3>
          <ul>${stepsHtml}</ul>
          <div class="footer">
            Source: ${item.url} <br/>
            Generated by LinkMind Tutorial-to-Checklist
          </div>
          <script>window.onload = () => { window.print(); }</script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handleAskMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!askQuery.trim() || bookmarks.length === 0) return;

    setAsking(true);
    setAiAnswer('');
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: askQuery,
          bookmarks,
          lang,
          mode: 'chat',
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setAiAnswer(data.answer);
      }
    } catch {
      setAiAnswer('حدث خطأ أثناء استشارة الذاكرة.');
    } finally {
      setAsking(false);
    }
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('bookmarks').delete().eq('id', id);
    if (!error) {
      setBookmarks(bookmarks.filter((b) => b.id !== id));
    }
  };

  const filteredBookmarks = bookmarks
    .map((b) => {
      const textMatch =
        b.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        b.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (b.checklist || []).some((step) =>
          step.toLowerCase().includes(searchQuery.toLowerCase())
        );
      const semanticScore = cosineSimilarity(queryEmbedding, b.embedding);
      return { ...b, textMatch, semanticScore };
    })
    .filter((b) => {
      const matchesCategory =
        selectedCategory === 'All' || b.category === selectedCategory;
      if (!searchQuery.trim()) return matchesCategory;
      return matchesCategory && (b.textMatch || b.semanticScore > 0.45);
    })
    .sort((a, b) => {
      if (!searchQuery.trim()) return 0;
      return b.semanticScore - a.semanticScore;
    });

  return (
    <div dir={t.dir} className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      {/* الشريط العلوي */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="bg-indigo-600 p-2 rounded-xl">
              <Brain className="w-6 h-6 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
              {t.appName}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* عداد الرصيد والترقية */}
            {user && (
              <button
                onClick={() => setShowPricingModal(true)}
                className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border transition cursor-pointer ${
                  planType === 'pro'
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/25'
                    : credits > 0
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25'
                    : 'bg-rose-500/15 text-rose-300 border-rose-500/40 hover:bg-rose-500/25'
                }`}
              >
                {planType === 'pro' ? (
                  <>
                    <Crown className="w-3.5 h-3.5 text-amber-400" />
                    <span>PRO ∞</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-3.5 h-3.5" />
                    <span>
                      {lang === 'ar'
                        ? `الرصيد: ${credits} شروحات`
                        : lang === 'tr'
                        ? `Kredi: ${credits}`
                        : `Credits: ${credits}`}
                    </span>
                  </>
                )}
              </button>
            )}

            {/* أزرار اللغات الثلاث */}
            <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg border border-slate-700">
              <Globe className="w-4 h-4 text-slate-400 mx-1.5" />
              {(['ar', 'tr', 'en'] as Language[]).map((l) => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold uppercase transition ${
                    lang === l
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>

            {user && (
              <>
                <a
                  href={`https://t.me/${botUsername}?start=${user.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs bg-sky-600/20 hover:bg-sky-600/30 text-sky-400 border border-sky-500/30 px-3 py-2 rounded-lg transition"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Telegram</span>
                </a>

                <button
                  onClick={handleLogout}
                  className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-rose-950/60 text-slate-300 hover:text-rose-300 border border-slate-700 px-3 py-2 rounded-lg transition cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>{t.logoutBtn}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* شاشة التحميل أو تسجيل الدخول */}
      {authLoading ? (
        <div className="flex justify-center items-center py-32">
          <Sparkles className="w-8 h-8 text-indigo-500 animate-spin" />
        </div>
      ) : !user ? (
        <main className="max-w-md mx-auto px-4 py-20">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
            <div className="flex justify-center mb-4">
              <div className="bg-indigo-600/20 p-3 rounded-2xl border border-indigo-500/30">
                <Lock className="w-7 h-7 text-indigo-400" />
              </div>
            </div>
            <h2 className="text-2xl font-bold text-center text-white mb-2">
              {t.loginTitle}
            </h2>
            <p className="text-sm text-center text-slate-400 mb-6">{t.tagline}</p>

            {authError && (
              <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 text-center">
                {authError}
              </div>
            )}

            <div className="space-y-4">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.emailPlaceholder}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t.passwordPlaceholder}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500"
              />

              <div className="flex flex-col gap-2.5 pt-2">
                <button
                  onClick={() => handleAuth(false)}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-xl transition cursor-pointer"
                >
                  {t.loginBtn}
                </button>
                <button
                  onClick={() => handleAuth(true)}
                  className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium py-3 rounded-xl transition cursor-pointer"
                >
                  {t.signupBtn}
                </button>
              </div>

              <div className="relative my-3 flex items-center justify-center">
                <span className="border-t border-slate-800 w-full"></span>
                <span className="bg-slate-900 px-3 text-xs text-slate-500">OR</span>
                <span className="border-t border-slate-800 w-full"></span>
              </div>

              <button
                type="button"
                onClick={handleGoogleLogin}
                className="w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold py-3 rounded-xl flex items-center justify-center gap-2.5 transition cursor-pointer shadow"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
                  />
                </svg>
                <span>{t.googleBtn}</span>
              </button>
            </div>
          </div>
        </main>
      ) : (
        /* لوحة التحكم السحابية */
        <main className="max-w-6xl mx-auto px-4 py-10">
          <div className="text-center max-w-2xl mx-auto mb-8">
            <h1 className="text-3xl sm:text-4xl font-extrabold mb-3 text-white">
              {t.tagline}
            </h1>
            <p className="text-xs text-slate-500">{user.email}</p>
          </div>

          <form
            onSubmit={handleAddBookmark}
            className="max-w-3xl mx-auto mb-6 flex flex-col sm:flex-row gap-3"
          >
            <input
              type="url"
              required
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder={t.placeholder}
              className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3.5 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />
            <button
              type="submit"
              disabled={loading}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white font-semibold px-6 py-3.5 rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
            >
              {loading ? (
                <Sparkles className="w-5 h-5 animate-spin" />
              ) : (
                <Plus className="w-5 h-5" />
              )}
              <span>{loading ? t.savingBtn : t.saveBtn}</span>
            </button>
          </form>

          {bookmarks.length > 0 && (
            <div className="max-w-3xl mx-auto mb-8 bg-gradient-to-r from-indigo-950/60 to-slate-900 border border-indigo-500/30 rounded-2xl p-4">
              <form onSubmit={handleAskMemory} className="flex flex-col sm:flex-row gap-2.5">
                <div className="relative flex-1">
                  <MessageSquare className="w-4 h-4 text-indigo-400 absolute top-3.5 start-3.5" />
                  <input
                    type="text"
                    value={askQuery}
                    onChange={(e) => setAskQuery(e.target.value)}
                    placeholder={t.askPlaceholder}
                    className="w-full bg-slate-950/80 border border-slate-700 rounded-xl ps-10 pe-4 py-2.5 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-indigo-400"
                  />
                </div>
                <button
                  type="submit"
                  disabled={asking}
                  className="bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-900 text-white text-sm font-semibold px-5 py-2.5 rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{asking ? t.askingBtn : t.askBtn}</span>
                </button>
              </form>

              {aiAnswer && (
                <div className="mt-4 p-4 bg-slate-950/90 rounded-xl border border-indigo-500/20 relative">
                  <button
                    onClick={() => setAiAnswer('')}
                    className="absolute top-3 end-3 text-slate-500 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                  <p className="text-xs font-bold text-indigo-400 mb-1.5">{t.aiAnswerTitle}</p>
                  <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">
                    {aiAnswer}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-8 bg-slate-900/50 p-4 rounded-2xl border border-slate-800">
            <div className="relative w-full md:w-96">
              <Search className="w-4 h-4 text-slate-400 absolute top-3.5 start-3.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg ps-10 pe-4 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {Object.entries(t.categories).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSelectedCategory(key)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${
                    selectedCategory === key
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {filteredBookmarks.length === 0 ? (
            <div className="text-center py-20 border border-dashed border-slate-800 rounded-2xl text-slate-500">
              {t.emptyState}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredBookmarks.map((item) => (
                <div
                  key={item.id}
                  className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col justify-between hover:border-slate-700 transition shadow-lg"
                >
                  <div>
                    {item.image_url && (
                      <img
                        src={item.image_url}
                        alt={item.title}
                        className="w-full h-40 object-cover border-b border-slate-800"
                      />
                    )}
                    <div className="p-5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                          {t.categories[item.category as keyof typeof t.categories] || item.category}
                        </span>
                        <span className="text-xs text-slate-500">{item.created_at}</span>
                      </div>
                      <h3 className="font-bold text-lg text-white mb-2 line-clamp-2">
                        {item.title}
                      </h3>
                      <p className="text-sm text-slate-400 leading-relaxed mb-4">
                        {item.summary}
                      </p>

                      {/* قائمة الخطوات العملية التفاعلية (Tutorial-to-Checklist) */}
                      {item.checklist && item.checklist.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-slate-800/80">
                          <p className="text-xs font-bold text-cyan-400 mb-2.5 flex items-center gap-1.5">
                            <CheckSquare className="w-3.5 h-3.5" />
                            <span>
                              {lang === 'ar'
                                ? 'خطوات التنفيذ العملية:'
                                : lang === 'tr'
                                ? 'Uygulama Adımları:'
                                : 'Actionable Checklist:'}
                            </span>
                          </p>
                          <ul className="space-y-2 max-h-56 overflow-y-auto pe-1">
                            {item.checklist.map((step, idx) => {
                              const isDone = !!completedSteps[`${item.id}-${idx}`];
                              return (
                                <li
                                  key={idx}
                                  onClick={() => toggleStep(item.id, idx)}
                                  className={`flex items-start gap-2 text-xs p-2 rounded-lg cursor-pointer transition ${
                                    isDone
                                      ? 'bg-emerald-950/30 text-slate-500 line-through'
                                      : 'bg-slate-950/70 text-slate-200 hover:bg-slate-800/70'
                                  }`}
                                >
                                  {isDone ? (
                                    <CheckSquare className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                                  ) : (
                                    <Square className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                                  )}
                                  <span className="leading-relaxed">{step}</span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* شريط الإجراءات والتصدير لـ Notion و PDF */}
                  <div className="px-4 py-3 bg-slate-950/70 border-t border-slate-800/80 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                      >
                        <span>{t.visitBtn}</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>

                      {item.checklist && item.checklist.length > 0 && (
                        <>
                          <button
                            onClick={() => handleCopyNotion(item)}
                            title="Copy Markdown for Notion"
                            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-2 py-1 rounded flex items-center gap-1 transition cursor-pointer"
                          >
                            {copiedId === item.id ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3 text-cyan-400" />
                            )}
                            <span>Notion</span>
                          </button>

                          <button
                            onClick={() => handleExportPDF(item)}
                            title="Export as PDF"
                            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-2 py-1 rounded flex items-center gap-1 transition cursor-pointer"
                          >
                            <FileText className="w-3 h-3 text-amber-400" />
                            <span>PDF</span>
                          </button>
                        </>
                      )}
                    </div>

                    <button
                      onClick={() => handleDelete(item.id)}
                      className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      )}

      {/* نافذة الباقات والرصيد (Pricing Modal) */}
      {showPricingModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-6 sm:p-8 relative shadow-2xl">
            <button
              onClick={() => setShowPricingModal(false)}
              className="absolute top-4 end-4 text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="text-center mb-6">
              <h2 className="text-2xl font-bold text-white mb-2">
                {lang === 'ar'
                  ? 'اشحن رصيدك وحوّل الشروحات إلى خطوات عملية'
                  : 'Upgrade Your Learning Workflow'}
              </h2>
              <p className="text-sm text-slate-400">
                {lang === 'ar'
                  ? `رصيدك الحالي: ${planType === 'pro' ? 'غير محدود (PRO)' : `${credits} شروحات`}`
                  : `Current balance: ${planType === 'pro' ? 'Unlimited (PRO)' : `${credits} credits`}`}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* باقة الطلاب Pay-As-You-Go */}
              <div className="bg-slate-950 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold uppercase px-2.5 py-1 rounded-full bg-cyan-500/10 text-cyan-400">
                      {lang === 'ar' ? 'باقة الطلاب' : 'Student Pack'}
                    </span>
                    <Zap className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div className="text-3xl font-extrabold text-white mb-1">
                    $5 <span className="text-xs font-normal text-slate-400">/ 50 شرحاً</span>
                  </div>
                  <p className="text-xs text-slate-400 mb-4">
                    {lang === 'ar'
                      ? 'ادفع عند الحاجة — رصيد لا تنتهي صلاحيته أبداً'
                      : 'Pay-As-You-Go — Credits never expire'}
                  </p>
                  <ul className="space-y-2 text-xs text-slate-300 mb-6">
                    <li>✓ تحويل 50 فيديو يوتيوب أو مقال إلى خطوات</li>
                    <li>✓ تصدير مباشر إلى Notion و PDF</li>
                    <li>✓ بدون التزام باشتراك شهري</li>
                  </ul>
                </div>
                <button
                  onClick={() =>
                    alert(
                      lang === 'ar'
                        ? 'سيتم ربط بوابة الدفع قريباً! (50 شرحاً مقابل 5$)'
                        : 'Payment gateway integration coming soon!'
                    )
                  }
                  className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-semibold py-2.5 rounded-xl text-sm transition cursor-pointer"
                >
                  {lang === 'ar' ? 'شراء 50 شرحاً ($5)' : 'Buy 50 Credits ($5)'}
                </button>
              </div>

              {/* باقة صناع المحتوى والمدربين */}
              <div className="bg-gradient-to-b from-indigo-950/60 to-slate-950 border border-indigo-500/50 rounded-2xl p-6 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold uppercase px-2.5 py-1 rounded-full bg-indigo-500/20 text-indigo-300">
                      {lang === 'ar' ? 'صنّاع المحتوى والمدربين' : 'Creators & Coaches'}
                    </span>
                    <Crown className="w-5 h-5 text-amber-400" />
                  </div>
                  <div className="text-3xl font-extrabold text-white mb-1">
                    $12 <span className="text-xs font-normal text-slate-400">/ شهرياً</span>
                  </div>
                  <p className="text-xs text-slate-400 mb-4">
                    {lang === 'ar'
                      ? 'حوّل فيديوهاتك الطويلة إلى ملخصات جاهزة لمتابعيك'
                      : 'Turn long tutorials into downloadable PDF/Notion guides'}
                  </p>
                  <ul className="space-y-2 text-xs text-slate-300 mb-6">
                    <li>✓ تحويل عدد غير محدود من الشروحات شهرياً</li>
                    <li>✓ تصدير احترافي PDF و Notion جاهز للتوزيع</li>
                    <li>✓ ربط بوت تيليجرام للحفظ الفوري</li>
                  </ul>
                </div>
                <button
                  onClick={() =>
                    alert(
                      lang === 'ar'
                        ? 'سيتم ربط بوابة الدفع قريباً! (باقة المدربين 12$/شهر)'
                        : 'Payment gateway integration coming soon!'
                    )
                  }
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2.5 rounded-xl text-sm transition cursor-pointer"
                >
                  {lang === 'ar' ? 'اشترك الآن ($12/شهر)' : 'Subscribe ($12/mo)'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}