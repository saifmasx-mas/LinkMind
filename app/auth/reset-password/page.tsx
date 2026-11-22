'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Lock } from 'lucide-react';

export default function ResetPassword() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    if (password.length < 6) {
      setError('يجب أن تتكون كلمة المرور من 6 أحرف على الأقل.');
      return;
    }

    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setMessage('تم تحديث كلمة المرور بنجاح.');
    setTimeout(() => router.replace('/'), 1200);
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={handleUpdate} className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        <div className="flex justify-center mb-4">
          <div className="bg-indigo-600/20 p-3 rounded-2xl border border-indigo-500/30">
            <Lock className="w-7 h-7 text-indigo-400" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center text-white mb-6">تعيين كلمة مرور جديدة</h1>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 text-center">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 text-center">
            {message}
          </div>
        )}

        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="كلمة المرور الجديدة (6 أحرف على الأقل)"
          className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full mt-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition cursor-pointer"
        >
          تحديث كلمة المرور
        </button>
      </form>
    </main>
  );
}
