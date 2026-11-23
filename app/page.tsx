
'use client';

import React, { useState, useEffect } from 'react';
import { translations, Language } from '@/lib/translations';
import { supabase } from '@/lib/supabase';
import { User } from '@supabase/supabase-js';
import OrbitalHub, { SourceFilter } from '@/components/OrbitalHub';
import {
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

  // حالة تصفية المجرة المدارية
  const [selectedSource, setSelectedSource] = useState<SourceFilter>('all');

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

  // التعرف التلقائي على مصدر الرابط أو الكتاب المرفوع لأيقونات المجرة
  const detectSource = (url: string): SourceFilter => {
    const u = url.toLowerCase();
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
    if (
      u.startsWith('file://pdf/') ||
      u.endsWith('.pdf') ||
      u.includes('/pdf') ||
      u.includes('drive.google.com')
    )
      return 'pdf';
    if (
      u.startsWith('file://word/') ||
      u.startsWith('file://doc/') ||
      u.endsWith('.doc') ||
      u.endsWith('.docx') ||
      u.includes('docs.google.com')
    )
      return 'word';
    if (u.includes('instagram.com')) return 'instagram';
    if (u.includes('tiktok.com')) return 'tiktok';
    if (u.includes('linkedin.com')) return 'linkedin';
    if (u.includes('x.com') || u.includes('twitter.com')) return 'x';
    if (u.includes('t.me') || u.includes('telegram')) return 'telegram';
    return 'all';
  };

  const sourceCounts: Record<SourceFilter, number> = {
    all: bookmarks.length,
    youtube: bookmarks.filter((b) => detectSource(b.url) === 'youtube').length,
    pdf: bookmarks.filter((b) => detectSource(b.url) === 'pdf').length,
    word: bookmarks.filter((b) => detectSource(b.url) === 'word').length,
    instagram: bookmarks.filter((b) => detectSource(b.url) === 'instagram').length,
    tiktok: bookmarks.filter((b) => detectSource(b.url) === 'tiktok').length,
    linkedin: bookmarks.filter((b) => detectSource(b.url) === 'linkedin').length,
    x: bookmarks.filter((b) => detectSource(b.url) === 'x').length,
    telegram: bookmarks.filter((b) => detectSource(b.url) === 'telegram').length,
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

  // إضافة رابط ويب أو يوتيوب
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
          image_url: data.