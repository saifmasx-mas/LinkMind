'use client';

import React, { useEffect, useState } from 'react';
import { translations, Language } from '@/lib/translations';
import { supabase } from '@/lib/supabase';
import LanguageDropdown from '@/components/LanguageDropdown';
import {
  Bell,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  ArrowRight,
} from 'lucide-react';

// ADMIN SIGNUPS PAGE (2026-11-26): the newest signups live on this
// standalone page now, not on the main page. Only the admin (Saif) can
// ever see it:
// - The list comes from GET /api/admin/signups, which verifies on the
//   server that the caller is the admin (email vs ADMIN_EMAIL). A
//   401/403 here means "not the admin" and this page shows a refusal
//   instead of the list — the browser never decides who is admin.
// - The entry button on the main page is rendered only after the same
//   server check succeeds, so regular users never even see the button.
interface RecentSignup {
  email: string;
  created_at: string;
}

type PageStatus = 'checking' | 'login' | 'forbidden' | 'ready' | 'error';

export default function AdminSignupsPage() {
  const [lang, setLang] = useState<Language>('ar');
  const [status, setStatus] = useState<PageStatus>('checking');
  const [signups, setSignups] = useState<RecentSignup[]>([]);
  const [total, setTotal] = useState(0);
  const [telegramLinked, setTelegramLinked] = useState(true);
  const [loading, setLoading] = useState(false);

  const t = translations[lang];

  // التصميم (2026-11-24): حدّث لغة الصفحة واتجاهها عند تبديل اللغة.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = t.dir;
  }, [lang, t.dir]);

  const loadSignups = async () => {
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setStatus('login');
        return;
      }
      const res = await fetch('/api/admin/signups', {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (res.status === 401 || res.status === 403) {
        setStatus('forbidden');
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as {
        signups?: RecentSignup[];
        total?: number;
        telegramLinked?: boolean;
      };
      setSignups(Array.isArray(data.signups) ? data.signups : []);
      setTotal(typeof data.total === 'number' ? data.total : 0);
      setTelegramLinked(data.telegramLinked !== false);
      setStatus('ready');
    } catch {
      setStatus('error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSignups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[#070410] text-white font-sans relative overflow-x-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div className="absolute -top-32 -start-32 w-[520px] h-[520px] rounded-full bg-purple-700/25 blur-[130px]" />
        <div className="absolute top-1/4 -end-32 w-[480px] h-[480px] rounded-full bg-indigo-600/20 blur-[130px]" />
        <div className="absolute -bottom-32 start-1/3 w-[560px] h-[420px] rounded-full bg-fuchsia-600/20 blur-[140px]" />
      </div>

      <header className="relative z-10 border-b border-purple-500/20 bg-[#0d071c]/75 backdrop-blur-xl sticky top-0 shadow-[0_4px_30px_rgba(88,28,135,0.2)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <a href="/" className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="LinkMind Logo"
              className="w-11 h-11 rounded-xl object-cover border border-amber-400/50 shadow-[0_0_20px_rgba(251,191,36,0.4)]"
            />
            <span className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-500 bg-clip-text text-transparent drop-shadow-[0_2px_10px_rgba(251,191,36,0.25)]">
              LinkMind
            </span>
          </a>
          {/* قائمة اللغات المنسدلة (2026-11-27) — نفس مكوّن الصفحة الرئيسية. */}
          <LanguageDropdown lang={lang} onChange={setLang} />
        </div>
      </header>

      <main className="relative z-10 max-w-3xl mx-auto px-4 py-10">
        <a
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300 hover:text-amber-200 mb-6 cursor-pointer"
        >
          <ArrowRight className="w-4 h-4" />
          <span>{t.adminSubscribersBack}</span>
        </a>

        {status === 'checking' && (
          <div className="flex justify-center items-center py-24">
            <Sparkles className="w-9 h-9 text-amber-400 animate-spin" />
          </div>
        )}

        {status === 'login' && (
          <div className="bg-[#120926]/85 backdrop-blur-xl border border-purple-500/30 rounded-2xl p-6 text-center">
            <ShieldCheck className="w-8 h-8 text-amber-400 mx-auto mb-3" />
            <p className="text-sm text-purple-100">{t.adminSubscribersLogin}</p>
            <a
              href="/"
              className="inline-block mt-4 text-xs font-bold text-amber-300 hover:text-amber-200 cursor-pointer"
            >
              {t.loginBtn}
            </a>
          </div>
        )}

        {status === 'forbidden' && (
          <div className="bg-[#120926]/85 backdrop-blur-xl border border-fuchsia-500/40 rounded-2xl p-6 text-center">
            <ShieldCheck className="w-8 h-8 text-fuchsia-300 mx-auto mb-3" />
            <p className="text-sm font-bold text-fuchsia-200">
              {t.adminSubscribersForbidden}
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-[#120926]/85 backdrop-blur-xl border border-fuchsia-500/40 rounded-2xl p-6 text-center">
            <p className="text-sm text-fuchsia-200">{t.adminSignupsError}</p>
            <button
              type="button"
              onClick={loadSignups}
              className="mt-4 text-xs font-bold text-amber-300 hover:text-amber-200 cursor-pointer"
            >
              {t.adminSignupsRefresh}
            </button>
          </div>
        )}

        {status === 'ready' && (
          <div className="bg-[#120926]/85 backdrop-blur-xl border border-amber-400/40 rounded-2xl p-4 shadow-[0_0_30px_rgba(251,191,36,0.12)]">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h1 className="text-base font-extrabold text-amber-300 flex items-center gap-2">
                <Bell className="w-4 h-4 text-amber-400" />
                <span>{t.adminSignupsTitle}</span>
                <span className="text-xs font-bold text-purple-200/80">
                  {t.adminSignupsTotal}: {total}
                </span>
              </h1>
              <button
                type="button"
                onClick={loadSignups}
                disabled={loading}
                className="text-xs font-bold text-amber-300 hover:text-amber-200 flex items-center gap-1 disabled:opacity-60 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
                />
                <span>{t.adminSignupsRefresh}</span>
              </button>
            </div>
            {!telegramLinked && (
              <p className="text-xs text-amber-200/90 bg-amber-500/10 border border-amber-400/30 rounded-xl px-3 py-2 mb-3">
                {t.adminTelegramNotLinked}
              </p>
            )}
            {signups.length === 0 ? (
              <p className="text-xs text-purple-200/80">{t.adminSignupsEmpty}</p>
            ) : (
              <ul className="space-y-1.5">
                {signups.map((s) => (
                  <li
                    key={`${s.email}-${s.created_at}`}
                    className="flex items-center justify-between gap-3 text-xs bg-[#090514]/80 border border-purple-500/15 rounded-lg px-3 py-2"
                  >
                    <span className="text-purple-50 font-semibold break-all">
                      {s.email}
                    </span>
                    <span className="text-purple-300/80 shrink-0">
                      {new Date(s.created_at).toLocaleString(
                        lang === 'ar' ? 'ar' : lang === 'tr' ? 'tr' : 'en'
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
