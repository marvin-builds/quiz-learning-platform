import { supabase } from '@/lib/supabase';

// Reads of the learner-facing content. RLS hides unpublished categories and
// quizzes (and published quizzes in unpublished categories) from learners, so
// these queries don't filter on `published` themselves.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CategorySummary = { id: string; name: string; description: string | null };
export type QuizSummary = { id: string; title: string; description: string | null };
export type CategoryWithQuizzes = CategorySummary & { quizzes: QuizSummary[] };

export async function fetchCategories(): Promise<CategorySummary[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, description')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

/** The category with its quizzes, or null when it doesn't exist or is hidden. */
export async function fetchCategoryWithQuizzes(
  categoryId: string,
): Promise<CategoryWithQuizzes | null> {
  // Postgres would reject a malformed id; it can't name a category either way.
  if (!UUID.test(categoryId)) return null;

  const [category, quizzes] = await Promise.all([
    supabase.from('categories').select('id, name, description').eq('id', categoryId).maybeSingle(),
    supabase
      .from('quizzes')
      .select('id, title, description')
      .eq('category_id', categoryId)
      .order('sort_order', { ascending: true }),
  ]);
  if (category.error) throw category.error;
  if (quizzes.error) throw quizzes.error;
  if (!category.data) return null;
  return { ...category.data, quizzes: quizzes.data };
}
