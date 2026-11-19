'use client';

import React, { useState, useEffect } from 'react';
import { translations, Language } from '@/lib/translations';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
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
} from 'lucide-react';

interface Bookmark {
  id: string;
  url: string;
  title: string;
  summary: string;
  category: string;
  image_url?: string;
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

  const [urlInput, setUrlInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [queryEmbedding, setQueryEmbedding] = useState<number[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);

  const [askQuery, setAskQuery] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [asking, setAsking] = useState(false);

  const t = translations[lang];

  // التحقق من حالة تسجيل الدخول عند فتح التطبيق
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setAuthError(
        lang === 'ar'
          ? 'أضف إعدادات Supabase إلى ملف .env.local ثم أعد تشغيل الخادم.'
          : 'Add Supabase settings to .env.local, then restart the server.'
      );
      setAuthLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // جلب روابط المستخدم من Supabase عند تسجيل الدخول
  useEffect(() => {
    if (user) {
      fetchBookmarks();
    } else {
      setBookmarks([]);
    }
  }, [user]);

  const fetchBookmarks = async () => {
    const { data, error } = await supabase
      .from('bookmarks')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data) {
      const formatted = data.map((item) => ({
        ...item,
        embedding: typeof item.embedding === 'string' ? JSON.parse(item.embedding) : item.embedding,
        created_at: new Date(item.created_at).toLocaleDateString(),
      }));
      setBookmarks(formatted);
    }
  };

  // تسجيل الدخول أو إنشاء حساب
  const handleAuth = async (isSignUp: boolean) => {
    setAuthError('');
    if (!isSupabaseConfigured) {
      setAuthError(
        lang === 'ar'
          ? 'أضف إعدادات Supabase إلى ملف .env.local ثم أعد تشغيل الخادم.'
          : 'Add Supabase settings to .env.local, then restart the server.'
      );
      return;
    }
    if (!email || !password) return;

    const { error } = isSignUp
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

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
      } catch {
        // تجاهل الخطأ
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // تحليل الرابط وحفظه في Supabase
  const handleAddBookmark = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim() || !user) return;

    setLoading(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput.trim(), lang }),
      });

      const data = await res.json();

      if (res.ok) {
        const { error: dbError } = await supabase.from('bookmarks').insert({
          user_id: user.id,
          url: urlInput.trim(),
          title: data.title,
          summary: data.summary,
          category: data.category,
          image_url: data.image_url,
          embedding: data.embedding && data.embedding.length > 0 ? data.embedding : null,
        });

        if (!dbError) {
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
        b.summary.toLowerCase().includes(searchQuery.toLowerCase());
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
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="bg-indigo-600 p-2 rounded-xl">
              <Brain className="w-6 h-6 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
              {t.appName}
            </span>
          </div>

          <div className="flex items-center gap-3">
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
              <button
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-rose-950/60 text-slate-300 hover:text-rose-300 border border-slate-700 px-3 py-2 rounded-lg transition cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{t.logoutBtn}</span>
              </button>
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
            </div>
          </div>
        </main>
      ) : (
        /* لوحة التحكم السحابية بعد تسجيل الدخول */
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
                      <p className="text-sm text-slate-400 leading-relaxed line-clamp-3">
                        {item.summary}
                      </p>
                    </div>
                  </div>

                  <div className="px-5 py-3 bg-slate-950/50 border-t border-slate-800/80 flex items-center justify-between">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                    >
                      <span>{t.visitBtn}</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t.deleteBtn}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      )}
    </div>
  );
}