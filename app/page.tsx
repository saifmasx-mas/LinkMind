'use client';

import React, { useState, useEffect, useRef } from 'react';
import { translations, Language } from '@/lib/translations';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { detectSource } from '@/lib/source-detect';
import { decidePdfBookPath, noticeAfterSave } from '@/lib/book-upload';
import {
  buildBookPrintHtml,
  countBookIdeas,
  parseBookSummary,
  parsePlainSummaryToChapters,
  stripBookChapters,
  type BookChapterData,
} from '@/lib/book-reader';
import { User } from '@supabase/supabase-js';
import OrbitalHub, { SourceFilter } from '@/components/OrbitalHub';
import LanguageDropdown from '@/components/LanguageDropdown';
import PricingModal from '@/components/PricingModal';
import TurnstileWidget, {
  TurnstileWidgetHandle,
} from '@/components/TurnstileWidget';
import {
  WhatsAppIcon,
} from '@/components/SocialIcons';
import {
  Plus,
  Search,
  ExternalLink,
  Trash2,
  Sparkles,
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
  ChevronDown,
  ChevronUp,
  Mail,
  ShieldCheck,
  Phone,
  Presentation,
  Users,
  BookOpen,
  Download,
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

// BLOGGER ICON (2026-11-26): a saved link from a Blogger blog
// (blogspot.com or blogger.com) shows the orange Blogger badge on its
// library card, so the source is visible at a glance — even when the
// article has no cover image of its own.
// (2026-11-27): one definition of "is Blogger" — detectSource in
// lib/source-detect.ts, which the counts and the filter also use, so
// the badge, the count and the filter can never disagree again.
function isBloggerUrl(url: string): boolean {
  return detectSource(url) === 'blogger';
}

export default function Home() {
  const [lang, setLang] = useState<Language>('ar');
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  // رسالة نجاح بعد إنشاء الحساب (تأكيد البريد أو تسجيل دخول مباشر).
  const [authMessage, setAuthMessage] = useState('');

  // Cloudflare Turnstile (2026-11-24): the "are you a robot" check on the
  // login page. The public site key comes from the env var; when it is
  // missing (local dev without the key) the widget is skipped and login
  // works exactly as before. Production has the key set before deploy.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  // حالة الرصيد والباقة
  const [credits, setCredits] = useState<number>(5);
  const [planType, setPlanType] = useState<'free' | 'pro'>('free');
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  // حالة تصفية المجرة المدارية
  const [selectedSource, setSelectedSource] = useState<SourceFilter>('all');

  const [urlInput, setUrlInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [queryEmbedding, setQueryEmbedding] = useState<number[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);

  // تتبع الخطوات المنجزة لكل بطاقة ونسخ Notion
  // I10: completed steps survive a page refresh (localStorage).
  const [completedSteps, setCompletedSteps] = useState<Record<string, boolean>>(() => {
    try {
      const saved = window.localStorage.getItem('linkmind-completed-steps');
      return saved ? (JSON.parse(saved) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // البطاقات المضغوطة: الملخص والقائمة مطويان افتراضياً، ويُفتحان بزر «المزيد».
  const [expandedSummary, setExpandedSummary] = useState<Record<string, boolean>>({});
  const [expandedChecklist, setExpandedChecklist] = useState<Record<string, boolean>>({});
  // قارئ الكتاب (2026-11-27): البطاقة المفتوحة في نافذة القارئ، مع
  // حالة طيّ فصولها وأفكارها. تُعاد الحالة عند فتح كتاب آخر.
  const [readerBook, setReaderBook] = useState<Bookmark | null>(null);
  const [expandedReaderChapters, setExpandedReaderChapters] = useState<Record<string, boolean>>({});
  const [expandedReaderIdeas, setExpandedReaderIdeas] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  const [telegramLinking, setTelegramLinking] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  // ADMIN SIGNUPS PAGE (2026-11-26): the "المشتركون الجدد" button in the
  // header only ever appears when the server confirms the caller is the
  // admin — the browser never decides that. A 401/403 from
  // /api/admin/signups simply means this account is not the admin, so the
  // button stays completely hidden; regular users never see it at all.
  // The list itself lives on the standalone /admin/signups page.
  const [isAdmin, setIsAdmin] = useState(false);
  // التصميم (2026-11-24): حالة تسجيل الدخول + تأكيد الحذف + مرجع حقل الرابط.
  const [authBusy, setAuthBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const [askQuery, setAskQuery] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [asking, setAsking] = useState(false);

  const t = translations[lang];
  // I2: no hardcoded bot name. When the variable is missing the Telegram
  // button is hidden instead of linking to somebody else's bot.
  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  // SECURITY (2026-11-24 audit): Supabase's raw messages distinguish
  // "user not found" from "wrong password" (and "email already
  // registered"), which lets anyone probe whether an email has an
  // account. Show one generic message for every auth failure; the
  // technical detail stays in the console only.
  const genericAuthError = (): string =>
    lang === 'ar'
      ? 'تعذر تسجيل الدخول. تحقق من بريدك الإلكتروني وكلمة المرور وحاول مجدداً.'
      : lang === 'tr'
      ? 'Giriş yapılamadı. E-posta adresinizi ve şifrenizi kontrol edip tekrar deneyin.'
      : 'Could not sign in. Check your email and password and try again.';

  // Cloudflare Turnstile: verify the token on the server before any
  // Supabase auth call. A token is single-use, so a failed attempt resets
  // the widget for a fresh challenge.
  const resetTurnstile = () => {
    turnstileRef.current?.reset();
    setTurnstileToken(null);
  };

  const verifyTurnstile = async (): Promise<boolean> => {
    if (!turnstileSiteKey) return true;
    if (!turnstileToken) {
      setAuthError(t.turnstileRequired);
      return false;
    }
    try {
      const res = await fetch('/api/verify-turnstile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: turnstileToken }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
      };
      if (!res.ok || !data.success) {
        setAuthError(t.turnstileFailed);
        resetTurnstile();
        return false;
      }
      return true;
    } catch {
      setAuthError(t.turnstileFailed);
      resetTurnstile();
      return false;
    }
  };

  const genericSaveError = (): string =>
    lang === 'ar'
      ? 'تعذر الحفظ حالياً. حاول لاحقاً.'
      : lang === 'tr'
      ? 'Şu anda kaydedilemedi. Daha sonra tekrar deneyin.'
      : 'Could not save right now. Please try again later.';

  // TIMEOUT FIX (2026-11-25): /api/analyze can take a while (page fetch +
  // Gemini). Abort at 55s — before Vercel's 60s function limit — and say so
  // plainly instead of the generic save error. AbortSignal.timeout aborts
  // with a DOMException named 'TimeoutError'.
  const ANALYZE_TIMEOUT_MS = 55_000;
  // FULL-BOOK SUMMARY (2026-11-26): the old 14,000-character cap meant
  // only the beginning of a book ever reached the server. The whole
  // extracted text (up to 200,000 characters ≈ a full typical book) is
  // now sent, and the server splits it into chapters in
  // lib/book-summary.ts. Must match MAX_BOOK_TEXT_CHARS there.
  const MAX_BOOK_TEXT_CHARS = 200_000;
  const analyzeTimeoutMessage = (): string =>
    lang === 'ar'
      ? 'استغرق التحليل وقتاً طويلاً، حاول مجدداً.'
      : lang === 'tr'
      ? 'Analiz çok uzun sürdü, lütfen tekrar deneyin.'
      : 'The analysis took too long, please try again.';
  const isFetchTimeout = (err: unknown): boolean =>
    err instanceof DOMException && err.name === 'TimeoutError';

  // Authorization header for the authenticated API routes (C1).
  const authHeaders = async (): Promise<Record<string, string>> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }
      : { 'Content-Type': 'application/json' };
  };

  const sourceCounts: Record<SourceFilter, number> = {
    all: bookmarks.length,
    youtube: bookmarks.filter((b) => detectSource(b.url) === 'youtube').length,
    pdf: bookmarks.filter((b) => detectSource(b.url) === 'pdf').length,
    word: bookmarks.filter((b) => detectSource(b.url) === 'word').length,
    facebook: bookmarks.filter((b) => detectSource(b.url) === 'facebook').length,
    google: bookmarks.filter((b) => detectSource(b.url) === 'google').length,
    instagram: bookmarks.filter((b) => detectSource(b.url) === 'instagram').length,
    tiktok: bookmarks.filter((b) => detectSource(b.url) === 'tiktok').length,
    linkedin: bookmarks.filter((b) => detectSource(b.url) === 'linkedin').length,
    x: bookmarks.filter((b) => detectSource(b.url) === 'x').length,
    telegram: bookmarks.filter((b) => detectSource(b.url) === 'telegram').length,
    // BLOGGER (2026-11-27): the three saved Blogger articles were
    // counted under 'all' because detectSource had no 'blogger' case,
    // so the Galaxy showed no Blogger filter. Classified by URL here
    // (and in the filter below), so existing rows need no re-paste.
    blogger: bookmarks.filter((b) => detectSource(b.url) === 'blogger').length,
  };

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

  // التصميم (2026-11-24): حدّث لغة الصفحة واتجاهها عند تبديل اللغة،
  // حتى يقرأ قارئ الشاشة والمتصفح الاتجاه الصحيح.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = t.dir;
  }, [lang, t.dir]);

  useEffect(() => {
    if (user) {
      fetchBookmarks();
      fetchUserProfile();
      checkIsAdmin();
      // ADMIN SIGNUP NOTIFY: a Google (or any OAuth) account has no
      // signUp call on this page, so a first login is detected here:
      // the auth account was created minutes ago. Guarded by
      // sessionStorage so one login notifies once per tab; the server
      // also rate-limits to one message per email per hour.
      try {
        const createdMs = Date.parse(user.created_at || '');
        const isBrandNew = !Number.isNaN(createdMs) && Date.now() - createdMs < 10 * 60 * 1000;
        const guardKey = `linkmind-notified-signup:${user.id}`;
        if (isBrandNew && user.email && !window.sessionStorage.getItem(guardKey)) {
          window.sessionStorage.setItem(guardKey, '1');
          notifySignup(user.email);
        }
      } catch {
        // Notification is best-effort only.
      }
    } else {
      setBookmarks([]);
      setIsAdmin(false);
    }
  }, [user]);

  useEffect(() => {
    try {
      window.localStorage.setItem('linkmind-completed-steps', JSON.stringify(completedSteps));
    } catch {
      // Storage full or unavailable: checklist state just stays in memory.
    }
  }, [completedSteps]);

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

  // ADMIN SIGNUPS PAGE: ask the server whether this account is the admin.
  // The list itself is fetched by the standalone /admin/signups page; here
  // we only need the yes/no answer to decide whether to show the button.
  // A 401/403 simply means this account is not the admin.
  const checkIsAdmin = async () => {
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/admin/signups', { headers });
      setIsAdmin(res.ok);
    } catch {
      setIsAdmin(false);
    }
  };

  // ADMIN SIGNUP NOTIFY: tell the server a new account was just created
  // so it can Telegram the admin. Fire-and-forget — it never blocks the
  // UI and never shows an error to the new user. The admin panel is the
  // reliable record; this message is only the instant alert.
  const notifySignup = (signupEmail: string) => {
    fetch('/api/admin/notify-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: signupEmail }),
    }).catch(() => {
      // Best-effort only; the admin panel still shows the signup.
    });
  };

  // C8: one corrupt checklist/embedding row used to throw inside .map()
  // and wipe the whole library. Parse defensively, one row at a time.
  const safeJsonArray = (value: unknown): number[] | string[] => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  const fetchBookmarks = async () => {
    if (!user) return;
    // C3: ask only for this user's rows (RLS is the second line of defence,
    // not the only one).
    const { data, error } = await supabase
      .from('bookmarks')
      // SECURITY (2026-11-24 audit): select only the columns the UI uses
      // instead of '*', so a future private column can never leak to the
      // browser. `embedding` is still needed for local semantic search.
      .select('id, url, title, summary, category, image_url, checklist, embedding, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (!error && data) {
      const formatted = data.map((item) => ({
        ...item,
        checklist: safeJsonArray(item.checklist) as string[],
        embedding: safeJsonArray(item.embedding) as number[],
        created_at: new Date(item.created_at).toLocaleString(),
      }));
      setBookmarks(formatted);
    }
  };

  const handleAuth = async (isSignUp: boolean) => {
    setAuthError('');
    setAuthMessage('');
    if (!email || !password) return;

    // Cloudflare Turnstile: no auth call before the human check passes.
    if (!(await verifyTurnstile())) return;

    // التصميم (2026-11-24): نص واضح أثناء تسجيل الدخول بدل دوّارة صامتة.
    setAuthBusy(true);
    const { data, error } = isSignUp
      ? await supabase.auth.signUp({
          email,
          password,
          // I4: email confirmation must land on the dedicated callback page.
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        })
      : await supabase.auth.signInWithPassword({ email, password });

    setAuthBusy(false);
    if (error) {
      console.error('Auth failed:', error.message);
      setAuthError(genericAuthError());
      // The token was already spent on the server check, so it cannot be
      // reused for the next attempt.
      resetTurnstile();
    } else if (isSignUp) {
      // ADMIN SIGNUP NOTIFY: tell the server right away so the admin
      // gets a Telegram message. Works even before email confirmation,
      // because the server verifies the new account itself.
      notifySignup(email);
      // Tell the user what happened — before this fix signup showed
      // nothing at all. With a session the user is signed in already
      // (the library view opens, so the message goes to the notice bar
      // there); without one they must confirm their email first, so the
      // message stays on the login screen.
      if (data?.session) {
        setNotice(t.signupSuccessSignedIn);
      } else {
        setAuthMessage(t.signupSuccessConfirmEmail);
      }
    }
  };

  const handleGoogleLogin = async () => {
    setAuthError('');
    setAuthMessage('');
    // Cloudflare Turnstile: the Google button needs the human check too.
    if (!(await verifyTurnstile())) return;
    setAuthBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // I4: the dedicated /auth/callback page exists for exactly this.
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setAuthBusy(false);
    if (error) {
      console.error('Google sign-in failed:', error.message);
      setAuthError(genericAuthError());
      resetTurnstile();
    }
  };

  // C6: the reset-password page existed but nothing in the UI ever linked
  // to it. This sends the reset email to /auth/reset-password.
  const handleForgotPassword = async () => {
    setAuthError('');
    setResetSent(false);
    if (!email) {
      setAuthError(
        lang === 'ar'
          ? 'اكتب بريدك الإلكتروني أولاً ثم اضغط "نسيت كلمة المرور؟".'
          : lang === 'tr'
          ? 'Önce e-posta adresinizi girin, sonra "Şifrenizi mi unuttunuz?" bağlantısına dokunun.'
          : 'Enter your email first, then tap "Forgot password?".'
      );
      return;
    }
    setResetBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    setResetBusy(false);
    if (error) {
      console.error('Password reset failed:', error.message);
      setAuthError(
        lang === 'ar'
          ? 'تعذر إرسال رسالة إعادة تعيين كلمة المرور. حاول لاحقاً.'
          : lang === 'tr'
          ? 'Şifre sıfırlama e-postası gönderilemedi. Daha sonra tekrar deneyin.'
          : 'Could not send the password reset email. Please try again later.'
      );
    } else {
      setResetSent(true);
    }
  };

  // C5: the Telegram button used to open t.me/<bot>?start=<user.id>, which
  // the webhook always rejects. It now asks the server for a one-time
  // 43-character token and opens the link it returns.
  const handleTelegramLink = async () => {
    if (!user) {
      setNotice(t.telegramSignInRequired);
      return;
    }
    setTelegramLinking(true);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/telegram/link', {
        method: 'POST',
        headers,
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer');
      } else {
        setNotice(t.telegramLinkFailed);
      }
    } catch {
      setNotice(t.telegramLinkFailed);
    } finally {
      setTelegramLinking(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 3) {
      setQueryEmbedding([]);
      return;
    }

    // I11: cancel the previous embedding request when the query changes,
    // instead of letting stale results overwrite newer ones.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const headers = await authHeaders();
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({ query: searchQuery, mode: 'embed' }),
        });
        if (res.ok) {
          const data = await res.json();
          setQueryEmbedding(data.embedding || []);
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          // Embedding failure is non-fatal: text search still works.
        }
      }
    }, 500);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [searchQuery]);

  // إضافة رابط ويب أو يوتيوب أو تيك توك
  const handleAddBookmark = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim() || !user) return;

    // I5: refuse a link that is already in this user's library.
    if (bookmarks.some((b) => b.url === urlInput.trim())) {
      setNotice(t.duplicateLink);
      return;
    }

    if (planType !== 'pro' && credits <= 0) {
      setShowPricingModal(true);
      return;
    }

    setLoading(true);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
        body: JSON.stringify({
          url: urlInput.trim(),
          lang,
        }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server returned status ${res.status}`);
      }

      const data = await res.json();

      if (res.status === 409 || data.error === 'DUPLICATE_LINK') {
        setNotice(t.duplicateLink);
        return;
      }

      if (res.status === 402 || data.error === 'OUT_OF_CREDITS') {
        setCredits(0);
        setShowPricingModal(true);
        return;
      }

      // NO-CONTENT FIX (2026-11-25): the server could not fetch any real
      // content for this link, so no summary was created and no credit was
      // deducted. Show the server's plain-Arabic message instead of the
      // generic "AI unavailable" one.
      // BOOK TEXT TRUNCATED (2026-11-27): the book did not reach the
      // server in full — the summary would have covered only the
      // beginning of the book. Ask for a re-upload; no credit deducted.
      if (data.error === 'BOOK_TEXT_TRUNCATED') {
        setNotice(t.bookTruncatedNotice);
        return;
      }

      if (data.error === 'CONTENT_UNAVAILABLE') {
        setNotice(
          typeof data.message === 'string' && data.message
            ? data.message
            : lang === 'ar'
              ? 'تعذّر جلب محتوى هذا الرابط، فلم يتم إنشاء ملخص. جرّب رابطاً آخر، ولم يُخصم أي رصيد.'
              : 'Could not fetch this link’s content, so no summary was created. Try another link; no credit was deducted.'
        );
        return;
      }

      if (res.status === 503 || data.error === 'AI_UNAVAILABLE') {
        setNotice(
          lang === 'ar'
            ? 'خدمة الذكاء الاصطناعي غير متاحة حالياً. حاول لاحقاً، ولم يُخصم أي رصيد.'
            : lang === 'tr'
            ? 'Yapay zeka hizmeti şu anda kullanılamıyor. Daha sonra tekrar deneyin, kredi düşülmedi.'
            : 'The AI service is unavailable right now. Try again later; no credit was deducted.'
        );
        return;
      }

      if (res.ok) {
        // H4 (audit #2): the bookmark row is now inserted server-side
        // in /api/analyze — the browser only refreshes the library.
        // The old browser insert could fail AFTER the server had
        // deducted the credit, losing the credit with no card saved.
        if (typeof data.remainingCredits === 'number') {
          setCredits(data.remainingCredits);
        }
        // I7: the page/transcript could not be fetched, so the summary is
        // based on the title alone — say so instead of failing silently.
        // A successful save with no warning of its own clears any
        // stale notice (e.g. an old "scanned book" warning from a
        // previous failed upload) so it is not misread as describing
        // the item that has just been saved.
        setNotice(noticeAfterSave(!!data.contentWarning, t.contentWarning));
        await fetchBookmarks();
        setUrlInput('');
      } else {
        setNotice(data.error || (lang === 'ar' ? 'تأكد من صحة الرابط!' : 'Please enter a valid URL!'));
      }
    } catch (err) {
      console.error('Failed to save bookmark:', err);
      setNotice(isFetchTimeout(err) ? analyzeTimeoutMessage() : genericSaveError());
    } finally {
      setLoading(false);
    }
  };

  // تحويل الملف إلى Base64 فقط للكتب المصورة الصغيرة
  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  // رفع كتاب PDF أو مستند Word / TXT وتلخيصه تلخيصاً شاملاً فصلاً فصلاً
  // (lib/book-summary.ts) بدل ملخص مختصر لأهم الأفكار فقط
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    if (planType !== 'pro' && credits <= 0) {
      setShowPricingModal(true);
      e.target.value = '';
      return;
    }

    setLoading(true);
    try {
      const lower = file.name.toLowerCase();
      const cleanTitle = file.name.replace(/\.[^/.]+$/, '');
      let payload: any = {
        lang,
        bookTitle: cleanTitle,
      };

      if (lower.endsWith('.pdf')) {
        // 1. استخراج النص محلياً في المتصفح بدون Worker خارجي لتجنب 504
        let extractedText = '';
        try {
          const pdfjsLib = await import('pdfjs-dist');
          pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
            'pdfjs-dist/build/pdf.worker.mjs',
            import.meta.url
          ).toString();
          const arrayBuffer = await file.arrayBuffer();
          const loadingTask = pdfjsLib.getDocument({
            data: arrayBuffer,
            useWorkerFetch: false,
          });
          try {
            const pdf = await loadingTask.promise;
            // FULL-BOOK SUMMARY (2026-11-26): read up to 200 pages (was
            // 25) and keep page breaks as newlines — the server splits
            // the book into chapters from its headings, and headings only
            // survive when line breaks are preserved.
            const maxPages = Math.min(pdf.numPages, 200);
            for (let i = 1; i <= maxPages; i++) {
              const page = await pdf.getPage(i);
              const content = await page.getTextContent();
              extractedText +=
                content.items.map((item) => ('str' in item ? item.str : '')).join(' ') + '\n';
              if (extractedText.length > MAX_BOOK_TEXT_CHARS) break;
            }
          } finally {
            await loadingTask.destroy();
          }
          extractedText = extractedText
            .replace(/[^\S\n]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        } catch (error) {
          console.error('PDF text extraction failed:', error);
        }

        // Which path a PDF book takes is decided in lib/book-upload.ts
        // (decidePdfBookPath) so the rule is unit-testable: a text PDF
        // always takes the text path, a small scanned PDF goes as
        // Base64, and only a scanned PDF over 1.8MB shows the warning.
        const pdfPath = decidePdfBookPath(extractedText.length, file.size);
        if (pdfPath === 'text') {
          payload.bookText = extractedText.slice(0, MAX_BOOK_TEXT_CHARS);
          // C1 (audit #2): send the length AFTER the 200k cap, not the
          // full length — the server compares what it received with
          // this number, and a book longer than the cap would otherwise
          // be rejected as "truncated" on every attempt.
          payload.bookTextLength = payload.bookText.length;
          payload.bookType = 'pdf';
        } else if (pdfPath === 'scanned-small') {
          // 2. إذا كان PDF مصوراً (Scan) وحجمه مناسب نرسله كـ Base64
          const base64 = await fileToBase64(file);
          payload.bookBase64 = base64;
          payload.bookMimeType = 'application/pdf';
          payload.bookType = 'pdf';
        } else {
          setNotice(
            lang === 'ar'
              ? 'هذا الكتاب مصوّر (Scan) وحجمه كبير (أكثر من 1.8MB). جرب كتاباً نصياً أو ملفاً أصغر حجماً.'
              : 'Scanned PDF is larger than 1.8MB. Please use a text-based or smaller PDF.'
          );
          return;
        }
      } else if (lower.endsWith('.docx')) {
        const mammoth = await import('mammoth');
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        // Keep paragraph breaks (mammoth returns one paragraph per line)
        // so the server can find the chapter headings.
        const text = (result.value || '')
          .replace(/[^\S\n]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (!text) {
          setNotice(lang === 'ar' ? 'ملف Word فارغ!' : 'Word document is empty!');
          return;
        }
        payload.bookText = text.slice(0, MAX_BOOK_TEXT_CHARS);
        // Length-integrity guard (2026-11-27): the server compares the
        // text it received with this length and refuses (503, no credit)
        // if the book was cut in transit — the live «اللغة الشاعرة»
        // upload was summarised from the beginning of the book only.
        // C1 (audit #2): the length AFTER the 200k cap, so a book
        // longer than the cap is not rejected as "truncated".
        payload.bookTextLength = payload.bookText.length;
        payload.bookType = 'word';
      } else {
        const text = (await file.text())
          .replace(/[^\S\n]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (!text) {
          setNotice(lang === 'ar' ? 'الملف النصي فارغ!' : 'Text file is empty!');
          return;
        }
        payload.bookText = text.slice(0, MAX_BOOK_TEXT_CHARS);
        // C1 (audit #2): the length AFTER the 200k cap (see above).
        payload.bookTextLength = payload.bookText.length;
        payload.bookType = 'word';
      }

      const headers = await authHeaders();
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
        body: JSON.stringify(payload),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server returned status ${res.status}`);
      }

      const data = await res.json();

      if (res.status === 402 || data.error === 'OUT_OF_CREDITS') {
        setCredits(0);
        setShowPricingModal(true);
        return;
      }

      if (res.status === 503 || data.error === 'AI_UNAVAILABLE') {
        setNotice(
          lang === 'ar'
            ? 'خدمة الذكاء الاصطناعي غير متاحة حالياً. حاول لاحقاً، ولم يُخصم أي رصيد.'
            : lang === 'tr'
            ? 'Yapay zeka hizmeti şu anda kullanılamıyor. Daha sonra tekrar deneyin, kredi düşülmedi.'
            : 'The AI service is unavailable right now. Try again later; no credit was deducted.'
        );
        return;
      }

      if (res.ok) {
        // H4 (audit #2): the bookmark row is now inserted server-side
        // in /api/analyze — see the link-save path above.
        if (typeof data.remainingCredits === 'number') {
          setCredits(data.remainingCredits);
        }
        // A successful save with no warning of its own clears any
        // stale notice (see the link-save path above) so an old
        // "scanned book" warning is not misread as describing the
        // book that has just been saved.
        setNotice(noticeAfterSave(!!data.contentWarning, t.contentWarning));
        await fetchBookmarks();
      } else {
        setNotice(data.error || (lang === 'ar' ? 'حدث خطأ أثناء تحليل الكتاب' : 'Failed to analyze book'));
      }
    } catch (err: any) {
      console.error('Failed to read file:', err);
      setNotice(isFetchTimeout(err) ? analyzeTimeoutMessage() : genericSaveError());
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const toggleStep = (bookmarkId: string, stepIndex: number) => {
    const key = `${bookmarkId}-${stepIndex}`;
    setCompletedSteps((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleCopyNotion = (item: Bookmark) => {
    const stepsText = (item.checklist || [])
      .map((step, idx) => `- [ ] **${idx + 1}.** ${step}`)
      .join('\n');

    const markdown = `# ${item.title}\n\n> ${stripBookChapters(item.summary)}\n\n🔗 **Source:** ${item.url}\n\n## Actionable Checklist\n${stepsText}\n\n---\n*Generated by LinkMind AI*`;

    navigator.clipboard.writeText(markdown);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // C9: titles and summaries come from external pages and from the AI, so
  // they must be escaped before being injected into the print window.
  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const handleExportPDF = (item: Bookmark) => {
    const printWindow = window.open('', '_blank', 'width=800,height=900');
    if (!printWindow) return;

    const stepsHtml = (item.checklist || [])
      .map(
        (step, idx) =>
          `<li style="margin-bottom: 12px; padding: 10px 14px; background: #faf5ff; border-radius: 8px; border-inline-start: 4px solid #9333ea;">
            <strong style="color: #7e22ce;">${idx + 1}.</strong> ${escapeHtml(step)}
          </li>`
      )
      .join('');

    printWindow.document.write(`
      <html dir="${t.dir}">
        <head>
          <title>${escapeHtml(item.title)} - LinkMind Checklist</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; color: #1e1b4b; line-height: 1.6; }
            .badge { display: inline-block; background: linear-gradient(90deg, #7e22ce, #db2777); color: #fff; padding: 4px 14px; border-radius: 999px; font-size: 12px; font-weight: bold; }
            h1 { font-size: 24px; margin: 16px 0 12px; color: #2e1065; }
            .summary { background: #f3e8ff; padding: 16px; border-radius: 10px; color: #3b0764; margin-bottom: 24px; border: 1px solid #e9d5ff; white-space: pre-line; }
            ul { list-style: none; padding: 0; }
            .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e9d5ff; font-size: 12px; color: #6b21a8; }
          </style>
        </head>
        <body>
          <span class="badge">${escapeHtml(item.category)}</span>
          <h1>${escapeHtml(item.title)}</h1>
          <div class="summary">${escapeHtml(stripBookChapters(item.summary))}</div>
          <h3>${lang === 'ar' ? 'خطوات التنفيذ والأفكار الرئيسية:' : 'Actionable Checklist & Key Ideas:'}</h3>
          <ul>${stepsHtml}</ul>
          <div class="footer">
            Source: ${escapeHtml(item.url)} <br/>
            Generated by LinkMind AI
          </div>
          <script>window.onload = () => { window.print(); }</script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // BOOK READER (2026-11-27): the structured chapters for a book —
  // from the storage envelope when present, otherwise parsed back
  // from the plain-text summary (older rows). An idea always has a
  // detail, so an expandable idea never opens an empty view.
  const bookChaptersFor = (item: Bookmark): BookChapterData[] => {
    const parsed = parseBookSummary(item.summary);
    if (parsed.chapters) return parsed.chapters;
    return parsePlainSummaryToChapters(parsed.displaySummary);
  };

  const openBookReader = (item: Bookmark) => {
    setExpandedReaderChapters({ '0': true });
    setExpandedReaderIdeas({});
    setReaderBook(item);
  };

  // WORD → PDF (2026-11-27): the download is the printable book
  // document (cover + chapters + every idea with its detail) rendered
  // by the browser and saved as PDF from the print dialog — the
  // browser shapes Arabic correctly and keeps RTL order, using the
  // system's own naskh Arabic font. Binary PDF libraries (pdf-lib /
  // jsPDF) draw Arabic letters disconnected and in the wrong order
  // because they have no shaping engine, and Vercel serverless cannot
  // run Word/LibreOffice, so there is no faithful conversion of the
  // original .docx layout (fonts, images, tables) — this document is
  // built from the extracted text and the AI summary.
  const handleDownloadBookPdf = (item: Bookmark) => {
    const chapters = bookChaptersFor(item);
    const html = buildBookPrintHtml({
      title: item.title,
      chapters,
      lang,
      siteName: 'LinkMind',
    });
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setNotice(t.pdfPopupBlocked);
      return;
    }
    printWindow.document.write(html);
    printWindow.document.close();
  };

  const handleAskMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!askQuery.trim() || bookmarks.length === 0) return;

    setAsking(true);
    setAiAnswer('');
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers,
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
        // /api/ask now deducts a credit for AI answers; keep the header
        // balance in sync. The local fallback answer deducts nothing.
        if (typeof data.remainingCredits === 'number') {
          setCredits(data.remainingCredits);
        }
      } else if (res.status === 402 || data.error === 'OUT_OF_CREDITS') {
        setCredits(0);
        setShowPricingModal(true);
      }
    } catch {
      setAiAnswer('حدث خطأ أثناء استشارة الذاكرة.');
    } finally {
      setAsking(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!user) return;
    // C3: never delete another user's row, even if RLS is misconfigured.
    const { error } = await supabase
      .from('bookmarks')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (!error) {
      setBookmarks(bookmarks.filter((b) => b.id !== id));
    }
  };

  const filteredBookmarks = bookmarks
    .map((b) => {
      const textMatch =
        b.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        stripBookChapters(b.summary).toLowerCase().includes(searchQuery.toLowerCase()) ||
        (b.checklist || []).some((step) =>
          step.toLowerCase().includes(searchQuery.toLowerCase())
        );
      const semanticScore = cosineSimilarity(queryEmbedding, b.embedding);
      return { ...b, textMatch, semanticScore };
    })
    .filter((b) => {
      const matchesCategory =
        selectedCategory === 'All' || b.category === selectedCategory;
      const matchesSource =
        selectedSource === 'all' || detectSource(b.url) === selectedSource;

      if (!searchQuery.trim()) return matchesCategory && matchesSource;
      return matchesCategory && matchesSource && (b.textMatch || b.semanticScore > 0.45);
    })
    .sort((a, b) => {
      if (!searchQuery.trim()) return 0;
      return b.semanticScore - a.semanticScore;
    });

  return (
    <div
      dir={t.dir}
      className="min-h-screen bg-[#070410] text-white font-sans relative overflow-x-hidden selection:bg-amber-400 selection:text-[#140A26]"
    >
      {/* هالات الإضاءة الخلفية */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div className="absolute -top-32 -start-32 w-[520px] h-[520px] rounded-full bg-purple-700/25 blur-[130px]" />
        <div className="absolute top-1/4 -end-32 w-[480px] h-[480px] rounded-full bg-indigo-600/20 blur-[130px]" />
        <div className="absolute -bottom-32 start-1/3 w-[560px] h-[420px] rounded-full bg-fuchsia-600/20 blur-[140px]" />
        <div className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 w-[360px] h-[360px] rounded-full bg-amber-500/5 blur-[120px]" />
      </div>

      {/* الشريط العلوي */}
      <header className="border-b border-purple-500/20 bg-[#0d071c]/75 backdrop-blur-xl sticky top-0 z-20 shadow-[0_4px_30px_rgba(88,28,135,0.2)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          {/* الشعار الذهبي المتوهج */}
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="LinkMind Logo"
              className="w-11 h-11 rounded-xl object-cover border border-amber-400/50 shadow-[0_0_20px_rgba(251,191,36,0.4)]"
            />
            <span className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-500 bg-clip-text text-transparent drop-shadow-[0_2px_10px_rgba(251,191,36,0.25)]">
              {t.appName}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* عداد الرصيد الذهبي والباقة */}
            {user && (
              <button
                onClick={() => setShowPricingModal(true)}
                className={`flex items-center gap-1.5 text-xs font-bold px-3.5 py-2 min-h-9 rounded-xl border transition cursor-pointer shadow-md ${
                  planType === 'pro'
                    ? 'bg-gradient-to-r from-amber-500/25 to-yellow-500/20 text-amber-300 border-amber-400/50 shadow-amber-500/10'
                    : credits > 0
                    ? 'bg-purple-900/50 text-amber-300 border-amber-400/35 hover:border-amber-400/70 hover:bg-purple-800/60'
                    : 'bg-fuchsia-950/70 text-fuchsia-200 border-fuchsia-500/50 animate-pulse'
                }`}
              >
                {planType === 'pro' ? (
                  <>
                    <Crown className="w-4 h-4 text-amber-400" />
                    <span>{t.proBadge}</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4 text-amber-400" />
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

            {/* قائمة اللغات المنسدلة (2026-11-27): كانت ثلاثة أزرار
                جنب بعضها؛ صارت قائمة واحدة توفّر مساحة في الترويسة. */}
            <LanguageDropdown lang={lang} onChange={setLang} />

            {/* ADMIN SIGNUPS PAGE (2026-11-26): entry to the standalone
                /admin/signups page. Rendered only after the server
                confirmed this account is the admin (isAdmin starts false
                and only a 200 from /api/admin/signups sets it true) — it
                is completely hidden from every regular user. */}
            {user && isAdmin && (
              <a
                href="/admin/signups"
                title={t.adminSignupsTitle}
                className="flex items-center gap-1.5 text-xs font-semibold bg-gradient-to-r from-amber-500/20 to-yellow-500/20 hover:from-amber-500/30 hover:to-yellow-500/30 text-amber-200 border border-amber-400/40 px-3.5 py-2 min-h-9 rounded-xl transition cursor-pointer"
              >
                <Users className="w-3.5 h-3.5 text-amber-400" />
                <span>{t.adminSignupsTitle}</span>
              </a>
            )}

            {/* زر Telegram مشروط بوجود اسم البوت فقط؛ أما زر الخروج
                فيظهر دائماً لأي مستخدم مسجّل دخوله، حتى لو غاب متغير
                اسم البوت من البيئة. */}
            {user && botUsername && (
              <button
                type="button"
                onClick={handleTelegramLink}
                disabled={telegramLinking}
                title={t.telegramBot}
                className="flex items-center gap-1.5 text-xs font-semibold bg-gradient-to-r from-indigo-600/30 to-purple-600/30 hover:from-indigo-600/50 hover:to-purple-600/50 text-amber-200 border border-purple-400/30 px-3.5 py-2 min-h-9 rounded-xl transition disabled:opacity-60 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5 text-amber-400" />
                <span>{telegramLinking ? t.telegramConnecting : 'Telegram'}</span>
              </button>
            )}

            {user && (
              <button
                onClick={handleLogout}
                className="flex items-center gap-1.5 text-xs font-medium bg-[#160b2e]/80 hover:bg-fuchsia-950/70 text-purple-200 hover:text-fuchsia-200 border border-purple-500/25 px-3 py-2 min-h-9 rounded-xl transition cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{t.logoutBtn}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* المحتوى الرئيسي */}
      <div className="relative z-10">
        {authLoading ? (
          <div className="flex justify-center items-center py-32">
            <Sparkles className="w-9 h-9 text-amber-400 animate-spin" />
          </div>
        ) : !user ? (
          /* شاشة تسجيل الدخول */
          <main className="max-w-md mx-auto px-4 py-20">
            <div className="bg-[#120926]/85 backdrop-blur-xl border border-purple-500/30 rounded-3xl p-8 shadow-[0_0_50px_rgba(147,51,234,0.25)] relative overflow-hidden">
              <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-transparent via-amber-400 to-transparent" />

              <div className="flex justify-center mb-5">
                <div className="bg-gradient-to-br from-purple-600/30 to-fuchsia-600/30 p-3.5 rounded-2xl border border-amber-400/40 shadow-[0_0_25px_rgba(251,191,36,0.2)]">
                  <Lock className="w-7 h-7 text-amber-400" />
                </div>
              </div>
              <h1 className="text-2xl font-extrabold text-center text-white mb-2">
                {t.loginTitle}
              </h1>
              <p className="text-sm text-center text-purple-200/85 mb-6">{t.tagline}</p>

              {/* N11: say plainly when Supabase is not configured instead of
                  showing cryptic network errors on every action. */}
              {!isSupabaseConfigured && (
                <div className="mb-4 p-3 rounded-xl bg-amber-500/15 border border-amber-400/40 text-xs text-amber-200 text-center">
                  {lang === 'ar'
                    ? 'Supabase غير مضبوط: أضف NEXT_PUBLIC_SUPABASE_URL و NEXT_PUBLIC_SUPABASE_ANON_KEY إلى متغيرات البيئة.'
                    : lang === 'tr'
                    ? 'Supabase yapılandırılmamış: NEXT_PUBLIC_SUPABASE_URL ve NEXT_PUBLIC_SUPABASE_ANON_KEY ortam değişkenlerini ekleyin.'
                    : 'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in the environment variables.'}
                </div>
              )}

              {authError && (
                <div className="mb-4 p-3 rounded-xl bg-fuchsia-500/15 border border-fuchsia-500/40 text-xs text-fuchsia-200 text-center">
                  {authError}
                </div>
              )}

              {authMessage && (
                <div className="mb-4 p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-200 text-center">
                  {authMessage}
                </div>
              )}

              <div className="space-y-4">
                <label htmlFor="login-email" className="sr-only">
                  {t.emailPlaceholder}
                </label>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t.emailPlaceholder}
                  className="w-full bg-[#090514] border border-purple-500/30 rounded-xl px-4 py-3 text-sm text-white placeholder-purple-300/65 focus:outline-none focus:border-amber-400 transition"
                />
                <label htmlFor="login-password" className="sr-only">
                  {t.passwordPlaceholder}
                </label>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t.passwordPlaceholder}
                  className="w-full bg-[#090514] border border-purple-500/30 rounded-xl px-4 py-3 text-sm text-white placeholder-purple-300/65 focus:outline-none focus:border-amber-400 transition"
                />

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={resetBusy}
                    className="text-xs text-amber-300/90 hover:text-amber-200 underline underline-offset-2 disabled:opacity-60 cursor-pointer"
                  >
                    {t.forgotPassword}
                  </button>
                  {resetSent && (
                    <span className="text-xs text-emerald-300">{t.resetEmailSent}</span>
                  )}
                </div>

                {/* Cloudflare Turnstile (2026-11-24): the "are you a robot"
                    check. Hidden when the site key is not configured. */}
                {turnstileSiteKey && (
                  <div className="flex justify-center pt-1">
                    <TurnstileWidget
                      ref={turnstileRef}
                      siteKey={turnstileSiteKey}
                      onVerify={(token) => setTurnstileToken(token)}
                      onExpire={() => setTurnstileToken(null)}
                      onError={() => setTurnstileToken(null)}
                    />
                  </div>
                )}

                <div className="flex flex-col gap-2.5 pt-2">
                  <button
                    onClick={() => handleAuth(false)}
                    disabled={authBusy}
                    className="w-full bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 hover:from-amber-300 hover:to-yellow-400 text-[#180a2e] font-extrabold py-3 rounded-xl transition cursor-pointer shadow-[0_0_20px_rgba(251,191,36,0.35)] disabled:opacity-60"
                  >
                    {authBusy ? t.signingIn : t.loginBtn}
                  </button>
                  <button
                    onClick={() => handleAuth(true)}
                    disabled={authBusy}
                    className="w-full bg-purple-900/50 hover:bg-purple-800/60 text-purple-100 border border-purple-500/30 font-semibold py-3 rounded-xl transition cursor-pointer disabled:opacity-60"
                  >
                    {t.signupBtn}
                  </button>
                </div>

                <div className="relative my-3 flex items-center justify-center">
                  <span className="border-t border-purple-500/20 w-full"></span>
                  <span className="bg-[#120926] px-3 text-xs text-amber-300/80 font-bold">{t.orDivider}</span>
                  <span className="border-t border-purple-500/20 w-full"></span>
                </div>

                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  className="w-full bg-white hover:bg-amber-50 text-[#140A26] font-bold py-3 rounded-xl flex items-center justify-center gap-2.5 transition cursor-pointer shadow-lg"
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
          <main className="max-w-6xl mx-auto px-4 py-8">
            {/* التصميم (2026-11-24): على الهاتف يظهر العنوان ثم نموذج
                الإضافة فوق المجرة، حتى لا يُدفع زر الحفظ تحت الشاشة. */}
            <div className="flex flex-col">
            <div className="order-3 sm:order-1">
            <OrbitalHub
              selectedSource={selectedSource}
              onSelectSource={setSelectedSource}
              counts={sourceCounts}
              lang={lang}
            />
            </div>

            <div className="order-1 sm:order-2 text-center max-w-2xl mx-auto mb-8">
              <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-purple-900/40 border border-amber-400/30 text-amber-300 text-xs font-bold mb-3 shadow-[0_0_15px_rgba(251,191,36,0.15)]">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>{t.engineBadge}</span>
              </div>
              <h1 className="text-3xl sm:text-4xl font-extrabold mb-3 text-white drop-shadow-[0_2px_15px_rgba(168,85,247,0.35)]">
                {t.tagline}
              </h1>
              <div className="h-0.5 w-40 mx-auto bg-gradient-to-r from-transparent via-amber-400 to-transparent mb-2" />
              <p className="text-xs text-purple-300/80">{user.email}</p>
            </div>

            {/* شريط إضافة رابط أو رفع كتاب PDF / Word */}
            <form
              onSubmit={handleAddBookmark}
              className="order-2 sm:order-3 max-w-3xl mx-auto mb-6 flex flex-col sm:flex-row gap-2.5 bg-[#120926]/80 backdrop-blur-xl p-2.5 rounded-2xl border border-purple-500/30 shadow-[0_0_35px_rgba(126,34,206,0.2)]"
            >
              <input
                ref={urlInputRef}
                type="url"
                required
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder={t.placeholder}
                className="flex-1 bg-[#080412] border border-purple-500/25 rounded-xl px-4 py-3 text-white placeholder-purple-300/65 focus:outline-none focus:border-amber-400 transition"
              />

              {/* زر رفع كتاب PDF أو Word */}
              <label
                title={
                  lang === 'ar'
                    ? 'ارفع كتاب PDF أو ملف Word لتلخيصه لأفكار وخطوات'
                    : 'Upload PDF or Word book to summarize'
                }
                className="bg-purple-900/60 hover:bg-purple-800/80 text-amber-300 border border-purple-400/35 px-4 py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-bold transition cursor-pointer shrink-0"
              >
                <FileText className="w-4 h-4 text-amber-400" />
                <span>
                  {lang === 'ar'
                    ? 'رفع كتاب'
                    : lang === 'tr'
                    ? 'Kitap Yükle'
                    : 'Upload Book'}
                </span>
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  onChange={handleFileUpload}
                  disabled={loading}
                  className="hidden"
                />
              </label>

              <button
                type="submit"
                disabled={loading}
                className="bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 hover:from-amber-300 hover:to-yellow-400 disabled:opacity-60 text-[#180a2e] font-extrabold px-6 py-3 rounded-xl flex items-center justify-center gap-2 transition cursor-pointer shadow-[0_0_20px_rgba(251,191,36,0.35)] shrink-0"
              >
                {loading ? (
                  <Sparkles className="w-5 h-5 animate-spin text-[#180a2e]" />
                ) : (
                  <Plus className="w-5 h-5 text-[#180a2e]" />
                )}
                <span>{loading ? t.savingBtn : t.saveBtn}</span>
              </button>
            </form>

            {/* رفع الكتاب يخصم رصيداً: أخبر المستخدم قبل أن يضغط الزر. */}
            <p className="max-w-3xl mx-auto -mt-4 mb-6 text-center text-[11px] text-purple-300/70">
              {t.uploadBookCostsCredit}
            </p>
            </div>

            {/* التصميم (2026-11-24): مؤشر تقدم أثناء التحليل الطويل،
                بدل أيقونة دوّارة بلا نص. */}
            {loading && (
              <div role="status" className="max-w-3xl mx-auto mb-6">
                <div className="h-2 rounded-full bg-purple-900/60 overflow-hidden">
                  <div className="h-full w-1/2 rounded-full bg-gradient-to-r from-amber-400 to-yellow-400 animate-pulse" />
                </div>
                <p className="text-xs text-purple-200/85 text-center mt-2">{t.savingBtn}</p>
              </div>
            )}

            {/* تنبيه عند فشل جلب محتوى الرابط: الملخص مبني على العنوان فقط */}
            {notice && (
              <div className="max-w-3xl mx-auto mb-6 p-3 rounded-xl bg-amber-500/10 border border-amber-400/40 text-xs text-amber-200 flex items-start justify-between gap-3">
                <span>{notice}</span>
                <button
                  type="button"
                  onClick={() => setNotice('')}
                  aria-label={lang === 'ar' ? 'إغلاق التنبيه' : lang === 'tr' ? 'Uyarıyı kapat' : 'Dismiss notice'}
                  className="min-w-11 min-h-11 flex items-center justify-center text-amber-300/70 hover:text-white shrink-0 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* صندوق اسأل ذاكرتك */}
            {bookmarks.length > 0 && (
              <div className="max-w-3xl mx-auto mb-8 bg-gradient-to-r from-purple-950/70 via-[#150a2c]/80 to-fuchsia-950/60 backdrop-blur-xl border border-fuchsia-500/30 rounded-2xl p-4 shadow-[0_0_30px_rgba(217,70,239,0.12)]">
                <form onSubmit={handleAskMemory} className="flex flex-col sm:flex-row gap-2.5">
                  <div className="relative flex-1">
                    <MessageSquare className="w-4 h-4 text-amber-400 absolute top-3.5 start-3.5" />
                    <input
                      type="text"
                      value={askQuery}
                      onChange={(e) => setAskQuery(e.target.value)}
                      placeholder={t.askPlaceholder}
                      className="w-full bg-[#080412]/90 border border-purple-500/30 rounded-xl ps-10 pe-4 py-2.5 text-sm text-white placeholder-purple-300/65 focus:outline-none focus:border-fuchsia-400"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={asking}
                    className="bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 disabled:opacity-60 text-white text-sm font-bold px-5 py-2.5 rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer shadow-[0_0_15px_rgba(192,38,211,0.35)]"
                  >
                    <Sparkles className="w-4 h-4 text-amber-300" />
                    <span>{asking ? t.askingBtn : t.askBtn}</span>
                  </button>
                </form>

                {/* كل سؤال يخصم رصيداً: أخبر المستخدم قبل أن يسأل. */}
                <p className="mt-2.5 text-[11px] text-purple-300/70 text-center">
                  {t.askCostsCredit}
                </p>

                {aiAnswer && (
                  <div className="mt-4 pt-4 border-t border-fuchsia-500/20 relative">
                    <button
                      onClick={() => setAiAnswer('')}
                      aria-label={lang === 'ar' ? 'إغلاق الإجابة' : lang === 'tr' ? 'Yanıtı kapat' : 'Dismiss answer'}
                      className="absolute top-3 end-3 min-w-11 min-h-11 flex items-center justify-center text-purple-300/60 hover:text-white cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <p className="text-xs font-bold text-amber-400 mb-1.5">{t.aiAnswerTitle}</p>
                    <p className="text-sm text-purple-50 leading-relaxed whitespace-pre-line">
                      {aiAnswer}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* شريط البحث والتصنيفات */}
            <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-8 bg-[#120926]/75 backdrop-blur-xl p-4 rounded-2xl border border-purple-500/25">
              <div className="relative w-full md:w-96">
                <Search className="w-4 h-4 text-amber-400 absolute top-3 start-3.5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t.searchPlaceholder}
                  className="w-full bg-[#080412] border border-purple-500/25 rounded-xl ps-10 pe-4 py-2 text-sm text-white placeholder-purple-300/65 focus:outline-none focus:border-amber-400"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {Object.entries(t.categories).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setSelectedCategory(key)}
                    className={`px-3.5 py-1.5 min-h-9 rounded-xl text-xs font-bold transition cursor-pointer ${
                      selectedCategory === key
                        ? 'bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white shadow-[0_0_15px_rgba(192,38,211,0.4)]'
                        : 'bg-[#1a0e36] text-purple-200/80 hover:text-white border border-purple-500/20'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* شبكة البطاقات */}
            {filteredBookmarks.length === 0 ? (
              <div className="text-center py-20 px-4 border border-dashed border-purple-500/30 bg-[#120926]/40 rounded-3xl">
                <p className="text-purple-300/80 mb-5">{t.emptyState}</p>
                <button
                  type="button"
                  onClick={() => urlInputRef.current?.focus()}
                  className="bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 text-[#180a2e] font-extrabold px-6 py-3 min-h-11 rounded-xl cursor-pointer shadow-[0_0_20px_rgba(251,191,36,0.35)]"
                >
                  {t.emptyStateBtn}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {filteredBookmarks.map((item) => {
                  const isUploadedFile = item.url.startsWith('file://');
                  return (
                    <div
                      key={item.id}
                      className="bg-[#120926]/85 backdrop-blur-xl border border-purple-500/25 rounded-xl overflow-hidden flex flex-col justify-between hover:border-amber-400/50 transition duration-300 shadow-[0_8px_30px_rgba(15,5,36,0.7)] group"
                    >
                      <div>
                        {item.image_url && (
                          <div className="relative overflow-hidden">
                            <img
                              src={item.image_url}
                              alt={item.title}
                              className="w-full h-24 object-cover border-b border-purple-500/25 group-hover:scale-105 transition duration-500"
                            />
                            <div className="absolute inset-0 bg-gradient-to-t from-[#120926] via-transparent to-transparent opacity-60" />
                          </div>
                        )}
                        <div className="p-3.5">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {isBloggerUrl(item.url) && (
                                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#FF5722] text-white flex items-center gap-1">
                                  <span className="font-black leading-none">B</span>
                                  Blogger
                                </span>
                              )}
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-r from-purple-600/30 to-fuchsia-600/30 text-amber-300 border border-fuchsia-500/30">
                                {t.categories[item.category as keyof typeof t.categories] ||
                                  item.category}
                              </span>
                            </div>
                            <span className="text-[11px] text-purple-300/80">{item.created_at}</span>
                          </div>
                          <h2 className="font-bold text-base text-white mb-1 line-clamp-2 group-hover:text-amber-200 transition">
                            {item.title}
                          </h2>
                          {/* BOOK READER (2026-11-27): the summary is
                              plain text with one block per chapter — the
                              line breaks are meaningful, so whitespace-
                              pre-line keeps chapters on their own lines
                              instead of collapsing them into one wall of
                              text. The storage envelope is stripped. */}
                          <p
                            className={`text-[13px] text-purple-200/85 leading-snug whitespace-pre-line ${
                              expandedSummary[item.id] ? '' : 'line-clamp-2'
                            }`}
                          >
                            {stripBookChapters(item.summary)}
                          </p>
                          {stripBookChapters(item.summary).length > 160 && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedSummary((prev) => ({
                                  ...prev,
                                  [item.id]: !prev[item.id],
                                }))
                              }
                              aria-expanded={!!expandedSummary[item.id]}
                              className="mt-1 text-xs font-bold text-amber-300 hover:text-amber-200 flex items-center gap-0.5 cursor-pointer"
                            >
                              {expandedSummary[item.id]
                                ? lang === 'ar'
                                  ? 'عرض أقل'
                                  : lang === 'tr'
                                  ? 'Daha az'
                                  : 'Show less'
                                : lang === 'ar'
                                ? 'المزيد'
                                : lang === 'tr'
                                ? 'Daha fazla'
                                : 'Show more'}
                              {expandedSummary[item.id] ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}

                          {/* قائمة الخطوات العملية والأفكار التفاعلية — مطوية افتراضياً لتصغير البطاقة */}
                          {item.checklist && item.checklist.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-purple-500/20">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedChecklist((prev) => ({
                                    ...prev,
                                    [item.id]: !prev[item.id],
                                  }))
                                }
                                aria-expanded={!!expandedChecklist[item.id]}
                                className="w-full text-xs font-bold text-amber-400 mb-1.5 flex items-center gap-1.5 cursor-pointer"
                              >
                                <CheckSquare className="w-3.5 h-3.5 text-amber-400" />
                                <span>
                                  {isUploadedFile
                                    ? lang === 'ar'
                                      ? 'أهم أفكار وخطوات الكتاب:'
                                      : 'Key Book Ideas & Steps:'
                                    : lang === 'ar'
                                    ? 'خطوات التنفيذ العملية:'
                                    : lang === 'tr'
                                    ? 'Uygulama Adımları:'
                                    : 'Actionable Checklist:'}
                                </span>
                                {/* BOOK COUNT (2026-11-27): for a book the
                                    counter is the total ideas across all
                                    chapters in the reader — the checklist
                                    column only holds 12 key items, so
                                    counting it showed 12 while the reader
                                    showed 77. Links keep the checklist
                                    count (they have no chapters). */}
                                <span className="text-purple-300/70">({isUploadedFile ? countBookIdeas(bookChaptersFor(item)) : item.checklist.length})</span>
                                {expandedChecklist[item.id] ? (
                                  <ChevronUp className="w-3.5 h-3.5 ms-auto" />
                                ) : (
                                  <ChevronDown className="w-3.5 h-3.5 ms-auto" />
                                )}
                              </button>
                              {expandedChecklist[item.id] && (
                              <ul className="space-y-1.5 max-h-40 overflow-y-auto pe-1">
                                {item.checklist.map((step, idx) => {
                                  const isDone = !!completedSteps[`${item.id}-${idx}`];
                                  return (
                                    <li
                                      key={idx}
                                      role="button"
                                      tabIndex={0}
                                      aria-pressed={isDone}
                                      onClick={() => toggleStep(item.id, idx)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.preventDefault();
                                          toggleStep(item.id, idx);
                                        }
                                      }}
                                      className={`flex items-start gap-2 text-xs p-1.5 rounded-lg cursor-pointer transition border ${
                                        isDone
                                          ? 'bg-emerald-950/30 border-emerald-500/20 text-purple-300/40 line-through'
                                          : 'bg-[#090514]/80 border-purple-500/15 text-purple-50 hover:border-amber-400/40'
                                      }`}
                                    >
                                      {isDone ? (
                                        <CheckSquare className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                                      ) : (
                                        <Square className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                                      )}
                                      <span className="leading-relaxed">{step}</span>
                                    </li>
                                  );
                                })}
                              </ul>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* شريط الإجراءات والتصدير */}
                      <div className="px-3 py-2 bg-[#090514]/90 border-t border-purple-500/20 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {isUploadedFile ? (
                            <>
                              <span className="text-xs font-bold text-fuchsia-300 flex items-center gap-1">
                                <FileText className="w-3.5 h-3.5 text-amber-400" />
                                <span>{lang === 'ar' ? 'كتاب مرفوع' : 'Uploaded Book'}</span>
                              </span>
                              {/* BOOK READER (2026-11-27): open the book
                                  in the chapter-by-chapter reader. */}
                              <button
                                onClick={() => openBookReader(item)}
                                className="text-xs bg-amber-500 hover:bg-amber-400 text-[#2e1065] font-bold border border-amber-400/60 px-2 py-1 min-h-8 rounded-lg flex items-center gap-1 transition cursor-pointer"
                              >
                                <BookOpen className="w-3.5 h-3.5" />
                                <span>{t.openBook}</span>
                              </button>
                            </>
                          ) : (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-bold text-amber-300 hover:text-amber-200 flex items-center gap-1"
                            >
                              <span>{t.visitBtn}</span>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}

                          {item.checklist && item.checklist.length > 0 && (
                            <>
                              <button
                                onClick={() => handleCopyNotion(item)}
                                title="Copy Markdown for Notion"
                                className="text-xs bg-purple-900/50 hover:bg-purple-800/70 text-purple-100 border border-purple-500/25 px-2 py-1 min-h-8 rounded-lg flex items-center gap-1 transition cursor-pointer"
                              >
                                {copiedId === item.id ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3 text-fuchsia-300" />
                                )}
                                <span>Notion</span>
                              </button>

                              <button
                                onClick={() => handleExportPDF(item)}
                                title="Export as PDF"
                                className="text-xs bg-purple-900/50 hover:bg-purple-800/70 text-purple-100 border border-purple-500/25 px-2 py-1 min-h-8 rounded-lg flex items-center gap-1 transition cursor-pointer"
                              >
                                <FileText className="w-3 h-3 text-amber-400" />
                                <span>PDF</span>
                              </button>
                            </>
                          )}
                        </div>

                        <button
                          onClick={() => setPendingDeleteId(item.id)}
                          aria-label={`${t.deleteBtn}: ${item.title}`}
                          title={t.deleteBtn}
                          className="min-w-9 min-h-9 px-2 text-xs text-fuchsia-400/80 hover:text-fuchsia-300 flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </main>
        )}
      </div>

      {/* التصميم (2026-11-24): تأكيد داخل التطبيق قبل الحذف النهائي. */}
      {pendingDeleteId && (
        <div
          className="fixed inset-0 z-50 bg-[#05020d]/85 backdrop-blur-md flex items-center justify-center p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-title"
        >
          <div className="bg-gradient-to-b from-[#1a0d38] to-[#0d061f] border border-fuchsia-500/40 rounded-3xl max-w-sm w-full p-6 relative shadow-[0_0_60px_rgba(192,38,211,0.35)]">
            <h2 id="delete-confirm-title" className="text-lg font-extrabold text-white mb-2">
              {t.deleteConfirmTitle}
            </h2>
            <p className="text-sm text-purple-200/85 mb-6">{t.deleteConfirmText}</p>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  handleDelete(pendingDeleteId);
                  setPendingDeleteId(null);
                }}
                className="flex-1 min-h-11 bg-gradient-to-r from-fuchsia-600 to-rose-600 text-white font-bold py-2.5 rounded-xl cursor-pointer"
              >
                {t.confirmDeleteBtn}
              </button>
              <button
                onClick={() => setPendingDeleteId(null)}
                className="flex-1 min-h-11 bg-purple-900/50 text-purple-100 border border-purple-500/30 font-semibold py-2.5 rounded-xl cursor-pointer"
              >
                {t.cancelBtn}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* نافذة الباقات والرصيد */}
      {showPricingModal && (
        <PricingModal
          credits={credits}
          planType={planType}
          lang={lang}
          onClose={() => setShowPricingModal(false)}
        />
      )}

      {/* نافذة سياسة الخصوصية */}
      {showPrivacyModal && (
        <div
          className="fixed inset-0 z-50 bg-[#05020d]/85 backdrop-blur-md flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="privacy-title"
        >
          <div className="bg-gradient-to-b from-[#1a0d38] to-[#0d061f] border border-amber-400/40 rounded-3xl max-w-md w-full p-6 relative shadow-[0_0_60px_rgba(251,191,36,0.2)]">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck className="w-5 h-5 text-amber-400" />
              <h2 id="privacy-title" className="text-lg font-extrabold text-white">
                {t.footerPrivacyTitle}
              </h2>
            </div>
            <p className="text-sm text-purple-200/85 leading-relaxed mb-6">
              {t.footerPrivacyText}
            </p>
            <button
              onClick={() => setShowPrivacyModal(false)}
              className="w-full min-h-11 bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white font-bold py-2.5 rounded-xl cursor-pointer"
            >
              {t.footerPrivacyClose}
            </button>
          </div>
        </div>
      )}

      {/* تذييل الموقع */}
      <footer className="relative z-10 border-t border-purple-500/20 bg-[#0d071c]/80 backdrop-blur-xl mt-10">
        <div className="max-w-6xl mx-auto px-4 py-8 flex flex-col items-center gap-5 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm font-semibold">
            <a
              href="tel:+905362515878"
              className="flex items-center gap-1.5 text-amber-300 hover:text-amber-200 transition"
              dir="ltr"
            >
              <Phone className="w-4 h-4" />
              +905362515878
            </a>
            <a
              href="mailto:saif.masx@gmail.com"
              className="flex items-center gap-1.5 text-amber-300 hover:text-amber-200 transition"
            >
              <Mail className="w-4 h-4" />
              {t.footerContact}
            </a>
            <button
              onClick={() => setShowPrivacyModal(true)}
              className="flex items-center gap-1.5 text-purple-200/85 hover:text-white transition cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4" />
              {t.footerPrivacy}
            </button>
            <a
              href="/presentation"
              className="flex items-center gap-1.5 text-purple-200/85 hover:text-white transition cursor-pointer"
            >
              <Presentation className="w-4 h-4" />
              {t.footerPresentation}
            </a>
          </div>

          {/* M8 (audit #2): only WhatsApp links to a real LinkMind
          contact — the X/Facebook/Instagram/Telegram icons pointed
          at the platforms' homepages, so they are hidden until real
          official accounts exist. */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-purple-200/60">{t.footerFollow}</span>
            {[
              { href: 'https://wa.me/905362515878', label: 'WhatsApp', Icon: WhatsAppIcon },
            ].map(({ href, label, Icon }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="w-9 h-9 flex items-center justify-center rounded-full border border-purple-500/30 bg-purple-900/40 text-amber-300 hover:text-amber-200 hover:border-amber-400/60 hover:bg-purple-800/60 transition"
              >
                <Icon className="w-4 h-4" />
              </a>
            ))}
          </div>

          <p className="text-xs text-purple-200/60">{t.footerCopyright}</p>
        </div>
      </footer>

      {/* قارئ الكتاب (2026-11-27): الملخص الكامل فصلاً بفصل — كل فصل
          وكل فكرة قابلة للتوسيع، وكل فكرة تفتح تفصيلها. */}
      {readerBook && (
        <div
          className="fixed inset-0 z-50 bg-[#05020d]/85 backdrop-blur-md flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t.bookReaderTitle}
        >
          <div className="bg-gradient-to-b from-[#1a0d38] to-[#0d061f] border border-purple-500/40 rounded-3xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-[0_0_60px_rgba(192,38,211,0.35)]">
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-purple-500/20">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-amber-300">
                  <BookOpen className="w-5 h-5 shrink-0" />
                  <span className="text-xs font-bold">{t.bookReaderTitle}</span>
                </div>
                <h2 className="text-lg font-extrabold text-white mt-1 leading-snug">
                  {readerBook.title}
                </h2>
                <p className="text-xs text-purple-200/80 mt-1">
                  {t.bookReaderSubtitle}
                </p>
              </div>
              <button
                onClick={() => setReaderBook(null)}
                aria-label={t.cancelBtn}
                className="min-w-9 min-h-9 flex items-center justify-center rounded-full text-purple-200/80 hover:text-white hover:bg-purple-800/60 transition cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-3 flex items-center justify-between gap-3 border-b border-purple-500/20">
              <span className="text-xs font-bold text-purple-200/85">
                {t.bookChapters}: {bookChaptersFor(readerBook).length}
              </span>
              <button
                onClick={() => handleDownloadBookPdf(readerBook)}
                className="text-xs bg-amber-500 hover:bg-amber-400 text-[#2e1065] font-bold px-3 py-2 min-h-9 rounded-lg flex items-center gap-1.5 transition cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>{t.downloadBookPdf}</span>
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 space-y-3">
              {bookChaptersFor(readerBook).map((chapter, chapterIndex) => {
                const chapterKey = `ch-${chapterIndex}`;
                const chapterOpen = !!expandedReaderChapters[chapterKey];
                return (
                  <div
                    key={chapterKey}
                    className="rounded-2xl border border-purple-500/25 bg-[#120826]/80 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedReaderChapters((prev) => ({
                          ...prev,
                          [chapterKey]: !prev[chapterKey],
                        }))
                      }
                      aria-expanded={chapterOpen}
                      className="w-full flex items-center gap-3 px-4 py-3 text-start cursor-pointer"
                    >
                      <span className="min-w-8 h-8 rounded-full bg-purple-600 text-white text-sm font-extrabold flex items-center justify-center shrink-0">
                        {chapterIndex + 1}
                      </span>
                      <span className="flex-1 font-bold text-white text-sm leading-snug">
                        {chapter.title}
                      </span>
                      <span className="text-[11px] text-purple-300/80 shrink-0">
                        {chapter.ideas.length} {t.bookIdeas}
                      </span>
                      {chapterOpen ? (
                        <ChevronUp className="w-4 h-4 text-amber-300 shrink-0" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-amber-300 shrink-0" />
                      )}
                    </button>
                    {chapterOpen && (
                      <div className="px-4 pb-4 space-y-2">
                        {chapter.ideas.map((idea, ideaIndex) => {
                          const ideaKey = `idea-${chapterIndex}-${ideaIndex}`;
                          const ideaOpen = !!expandedReaderIdeas[ideaKey];
                          return (
                            <div
                              key={ideaKey}
                              className="rounded-xl border border-purple-500/20 bg-[#1a0d38]/70 overflow-hidden"
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedReaderIdeas((prev) => ({
                                    ...prev,
                                    [ideaKey]: !prev[ideaKey],
                                  }))
                                }
                                aria-expanded={ideaOpen}
                                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-start cursor-pointer"
                              >
                                <span className="min-w-6 h-6 rounded-full bg-amber-500 text-[#2e1065] text-xs font-extrabold flex items-center justify-center shrink-0">
                                  {ideaIndex + 1}
                                </span>
                                <span className="flex-1 text-[13px] font-semibold text-purple-100 leading-snug">
                                  {idea.text}
                                </span>
                                {ideaOpen ? (
                                  <ChevronUp className="w-4 h-4 text-amber-300 shrink-0" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-amber-300 shrink-0" />
                                )}
                              </button>
                              {ideaOpen && (
                                <p className="px-3 pb-3 text-[13px] text-purple-200/90 leading-relaxed whitespace-pre-line">
                                  {idea.detail}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}