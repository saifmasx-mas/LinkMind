'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { translations, Language } from '@/lib/translations';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import TurnstileWidget, {
  TurnstileWidgetHandle,
} from '@/components/TurnstileWidget';
import LanguageDropdown from '@/components/LanguageDropdown';
import { UserPlus, Sparkles } from 'lucide-react';

// SIGNUP PAGE (2026-11-28): a standalone account-creation page.
// The old «إنشاء حساب جديد» button on the login card ran signUp in
// place and, with empty fields or a missing Turnstile token, did
// nothing visible — users thought the button was dead, and Saif
// expects a new page with a Google button on it. Now the login
// button navigates here. Every failure shows a clear message,
// including a Turnstile widget that fails to load (its onError used
// to clear the token silently). Same dark-violet + gold identity as
// the login card; no colours changed.
export default function SignupPage() {
  const router = useRouter();
  const [lang, setLang] = useState<Language>('ar');
  const t = translations[lang];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  // Cloudflare Turnstile (same as the login page): the "are you a
  // robot" check. The public site key comes from the env var; when it
  // is missing the widget is skipped and signup works as before.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  // A signed-in user has no business on the signup page.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.replace('/');
      } else {
        setCheckingSession(false);
      }
    });
  }, [router]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = t.dir;
  }, [lang, t.dir]);

  // Cloudflare Turnstile: verify the token on the server before any
  // Supabase auth call. A token is single-use, so a failed attempt
  // resets the widget for a fresh challenge.
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

  // ADMIN SIGNUP NOTIFY (same as the login page): tell the server a new
  // account was created so the admin gets a Telegram message.
  // Fire-and-forget — it never blocks the UI and never shows an error
  // to the new user. The admin panel is the reliable record.
  const notifySignup = (signupEmail: string) => {
    fetch('/api/admin/notify-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: signupEmail }),
    }).catch(() => {
      // Best-effort only; the admin panel still shows the signup.
    });
  };

  const handleSignUp = async () => {
    setAuthError('');
    setAuthMessage('');
    if (!email || !password) {
      setAuthError(t.authFieldsRequired);
      return;
    }

    // Cloudflare Turnstile: no auth call before the human check passes.
    if (!(await verifyTurnstile())) return;

    setAuthBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      // I4: email confirmation must land on the dedicated callback page.
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setAuthBusy(false);
    if (error) {
      console.error('Sign-up failed:', error.message);
      // Generic on purpose: Supabase distinguishes «already
      // registered», and the login page never reveals that either.
      setAuthError(t.signupFailed);
      // The token was already spent on the server check, so it cannot
      // be reused for the next attempt.
      resetTurnstile();
    } else {
      // ADMIN SIGNUP NOTIFY: tell the server right away so the admin
      // gets a Telegram message. Works even before email confirmation,
      // because the server verifies the new account itself.
      notifySignup(email);
      if (data?.session) {
        // The session came back at once: the user is already signed
        // in, so the library opens.
        router.replace('/');
      } else {
        // No session: the user must confirm their email first, so the
        // message stays on this screen.
        setAuthMessage(t.signupSuccessConfirmEmail);
      }
    }
  };

  const handleGoogleSignup = async () => {
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
      console.error('Google sign-up failed:', error.message);
      setAuthError(t.googleFailed);
      resetTurnstile();
    }
  };

  if (checkingSession) {
    return (
      <div
        dir={t.dir}
        className="min-h-screen bg-[#070410] text-white font-sans flex justify-center items-center"
      >
        <Sparkles className="w-9 h-9 text-amber-400 animate-spin" />
      </div>
    );
  }

  return (
    <div
      dir={t.dir}
      className="min-h-screen bg-[#070410] text-white font-sans relative overflow-x-hidden selection:bg-amber-400 selection:text-[#140A26]"
    >
      {/* هالات الإضاءة الخلفية — نفسها في صفحة الدخول */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div className="absolute -top-32 -start-32 w-[520px] h-[520px] rounded-full bg-purple-700/25 blur-[130px]" />
        <div className="absolute top-1/4 -end-32 w-[480px] h-[480px] rounded-full bg-indigo-600/20 blur-[130px]" />
        <div className="absolute -bottom-32 start-1/3 w-[560px] h-[420px] rounded-full bg-fuchsia-600/20 blur-[140px]" />
        <div className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 w-[360px] h-[360px] rounded-full bg-amber-500/5 blur-[120px]" />
      </div>

      {/* الشريط العلوي: الشعار + قائمة اللغات */}
      <header className="relative z-10 border-b border-purple-500/20 bg-[#0d071c]/75 backdrop-blur-xl sticky top-0 shadow-[0_4px_30px_rgba(88,28,135,0.2)]">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <a href="/" className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="LinkMind Logo"
              className="w-11 h-11 rounded-xl object-cover border border-amber-400/50 shadow-[0_0_20px_rgba(251,191,36,0.4)]"
            />
            <span className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-500 bg-clip-text text-transparent">
              {t.appName}
            </span>
          </a>
          <LanguageDropdown lang={lang} onChange={setLang} />
        </div>
      </header>

      {/* بطاقة إنشاء الحساب — نفس تصميم بطاقة الدخول */}
      <main className="relative z-10 max-w-md mx-auto px-4 py-20">
        <div className="bg-[#120926]/85 backdrop-blur-xl border border-purple-500/30 rounded-3xl p-8 shadow-[0_0_50px_rgba(147,51,234,0.25)] relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-transparent via-amber-400 to-transparent" />

          <div className="flex justify-center mb-5">
            <div className="bg-gradient-to-br from-purple-600/30 to-fuchsia-600/30 p-3.5 rounded-2xl border border-amber-400/40 shadow-[0_0_25px_rgba(251,191,36,0.2)]">
              <UserPlus className="w-7 h-7 text-amber-400" />
            </div>
          </div>
          <h1 className="text-2xl font-extrabold text-center text-white mb-2">
            {t.signupTitle}
          </h1>
          <p className="text-sm text-center text-purple-200/85 mb-6">{t.tagline}</p>

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
            <label htmlFor="signup-email" className="sr-only">
              {t.emailPlaceholder}
            </label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t.emailPlaceholder}
              className="w-full bg-[#090514] border border-purple-500/30 rounded-xl px-4 py-3 text-sm text-white placeholder-purple-300/65 focus:outline-none focus:border-amber-400 transition"
            />
            <label htmlFor="signup-password" className="sr-only">
              {t.passwordPlaceholder}
            </label>
            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t.passwordPlaceholder}
              className="w-full bg-[#090514] border border-purple-500/30 rounded-xl px-4 py-3 text-sm text-white placeholder-purple-300/65 focus:outline-none focus:border-amber-400 transition"
            />

            {/* Cloudflare Turnstile: the "are you a robot" check.
                Hidden when the site key is not configured. If the
                widget fails to load, onError shows a clear message
                instead of failing silently. */}
            {turnstileSiteKey && (
              <div className="flex justify-center pt-1">
                <TurnstileWidget
                  ref={turnstileRef}
                  siteKey={turnstileSiteKey}
                  onVerify={(token) => setTurnstileToken(token)}
                  onExpire={() => setTurnstileToken(null)}
                  onError={() => {
                    setTurnstileToken(null);
                    setAuthError(t.turnstileLoadFailed);
                  }}
                />
              </div>
            )}

            <div className="flex flex-col gap-2.5 pt-2">
              <button
                onClick={handleSignUp}
                disabled={authBusy}
                className="w-full bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 hover:from-amber-300 hover:to-yellow-400 text-[#180a2e] font-extrabold py-3 rounded-xl transition cursor-pointer shadow-[0_0_20px_rgba(251,191,36,0.35)] disabled:opacity-60"
              >
                {authBusy ? t.creatingAccount : t.signupBtn}
              </button>
            </div>

            <div className="relative my-3 flex items-center justify-center">
              <span className="border-t border-purple-500/20 w-full"></span>
              <span className="bg-[#120926] px-3 text-xs text-amber-300/80 font-bold">{t.orDivider}</span>
              <span className="border-t border-purple-500/20 w-full"></span>
            </div>

            <button
              type="button"
              onClick={handleGoogleSignup}
              disabled={authBusy}
              className="w-full bg-white hover:bg-amber-50 text-[#140A26] font-bold py-3 rounded-xl flex items-center justify-center gap-2.5 transition cursor-pointer shadow-lg disabled:opacity-60"
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
            {/* زر جوجل ينشئ الحساب تلقائياً عند أول دخول، فوضّح
                أنه للدخول أو لإنشاء حساب جديد، وأنه لا يحتاج
                إلى كلمة مرور. */}
            <p className="text-center text-xs text-purple-200/70">{t.googleBtnNote}</p>
            <p className="text-center text-xs text-purple-200/60">{t.googleCreatesAccount}</p>

            <p className="text-center text-sm text-purple-200/80 pt-2">
              {t.alreadyHaveAccount}{' '}
              <a
                href="/"
                className="text-amber-300 font-bold hover:text-amber-200 underline underline-offset-2"
              >
                {t.backToLogin}
              </a>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
