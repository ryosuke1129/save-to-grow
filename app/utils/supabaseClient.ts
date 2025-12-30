import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://qzeeivuzsopowlojnqwv.supabase.co' // ★書き換える
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6ZWVpdnV6c29wb3dsb2pucXd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5OTUyMTQsImV4cCI6MjA4MjU3MTIxNH0.8bdasn65RGeX9oGvGjhUqZvTCGm-Tfv4diyTmUWWN-A'    // ★書き換える

export const supabase = createClient(supabaseUrl, supabaseKey)