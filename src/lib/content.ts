import { supabase } from '@/lib/supabase';

// Reads of the learner-facing content. RLS hides unpublished categories and
// quizzes (and published quizzes in unpublished categories) from learners, so
// these queries don't filter on `published` themselves.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, description')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

/** The category with its quizzes, or null when it doesn't exist or is hidden. */
export async function fetchCategoryWithQuizzes(categoryId: string) {
  // A malformed id can't name a category, so it needn't reach Postgres.
  if (!UUID.test(categoryId)) return null;

  const { data, error } = await supabase
    .from('categories')
    .select('id, name, description, quizzes(id, title, description)')
    .eq('id', categoryId)
    .order('sort_order', { referencedTable: 'quizzes', ascending: true })
    .maybeSingle();
  if (error) throw error;
  return data;
}
