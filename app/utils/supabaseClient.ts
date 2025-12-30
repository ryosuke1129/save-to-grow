import { createClient } from '@supabase/supabase-js'

// ★変更: 環境変数から読み込む
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseKey) {
    console.error("Supabase Environment Variables are missing!");
}

export const supabase = createClient(supabaseUrl, supabaseKey);