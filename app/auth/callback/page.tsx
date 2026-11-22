'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Sparkles } from 'lucide-react';

export default function AuthCallback() {
  const router = useRouter();
  const [error, setError] = useState('');

  useEffect(() => {
    const completeSignIn = async () => {
      const code = new URL(window.location.href).searchParams.get('code');
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          setError(exchangeError.message);
          return;
        }
      }

      const { data } = await supabase.auth.getSession();
      if (data.session) {
        router.replace('/');
      } else {
        setError('تعذر إكمال تسجيل الدخول. حاول مرة أخرى.');
      }
    };

    completeSignIn();
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center">
        {error ? (
          <p className="text-sm text-rose-300">{error}</p>
        ) : (
          <Sparkles className="w-8 h-8 text-indigo-500 animate-spin mx-auto" />
        )}
      </div>
    </main>
  );
}
