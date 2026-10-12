import { adminCategoryKey, fetchAdminCategory } from '@/lib/admin-categories';
import { isUuid, requireWritten } from '@/lib/admin-rows';
import type { QuizValues } from '@/lib/quiz-schema';
import { supabase } from '@/lib/supabase';
import type { TablesInsert } from '@/types/database';

// The admin's reads and writes of quizzes (#81). RLS lets only an admin
// write, and the column grants only category_id (on insert), title,
// description and published; the database assigns sort_order (max + 1 within
// the category) on insert.

/** Every admin query shares this prefix, so one invalidation after a write covers them all. */
export const adminKey = ['admin'] as const;
export const adminQuizKey = (id: string) => [...adminKey, 'quizzes', id] as const;
// Under the category's key, so a change to the category refreshes the list too.
export const adminCategoryQuizzesKey = (categoryId: string) =>
  [...adminCategoryKey(categoryId), 'quizzes'] as const;

/** A category and its quizzes, published or not, by sort_order; null when the category doesn't exist. */
export async function fetchCategoryQuizzes(categoryId: string) {
  if (!isUuid(categoryId)) return null;
  const [category, quizzes] = await Promise.all([
    fetchAdminCategory(categoryId),
    supabase
      .from('quizzes')
      .select('id, title, description, sort_order, published')
      .eq('category_id', categoryId)
      .order('sort_order', { ascending: true }),
  ]);
  if (quizzes.error) throw quizzes.error;
  return category && { category, quizzes: quizzes.data };
}

/** One quiz's writable values and its category, or null when it doesn't exist. */
export async function fetchAdminQuiz(id: string) {
  if (!isUuid(id)) return null;
  const { data, error } = await supabase
    .from('quizzes')
    .select('id, category_id, title, description, published')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createQuiz(categoryId: string, values: QuizValues) {
  // sort_order is filled in by the trigger quizzes_assign_sort_order (see
  // createCategory for the cast).
  const row: Omit<TablesInsert<'quizzes'>, 'sort_order'> = { ...values, category_id: categoryId };
  const { error } = await supabase.from('quizzes').insert(row as TablesInsert<'quizzes'>);
  if (error) throw error;
}

export async function updateQuiz(id: string, values: Partial<QuizValues>) {
  const { data, error } = await supabase.from('quizzes').update(values).eq('id', id).select('id');
  if (error) throw error;
  requireWritten(data);
}

export async function deleteQuiz(id: string) {
  const { data, error } = await supabase.from('quizzes').delete().eq('id', id).select('id');
  if (error) throw error;
  requireWritten(data);
}

/** Puts a category's quizzes in the order of `ids`, all of them (see reorderCategories). */
export async function reorderQuizzes(categoryId: string, ids: string[]) {
  const { error } = await supabase.rpc('reorder_quizzes', {
    category_id: categoryId,
    quiz_ids: ids,
  });
  if (error) throw error;
}
