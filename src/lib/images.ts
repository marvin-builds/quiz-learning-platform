import { supabase } from '@/lib/supabase';

// Images of questions and answers live in a public bucket, so their URL needs
// no session and no signing.
const BUCKET = 'quiz-images';

export function quizImageUrl(path: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}
