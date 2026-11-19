import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl! : 'http://127.0.0.1:54321',
  isSupabaseConfigured ? supabaseAnonKey! : 'missing-anon-key'
);