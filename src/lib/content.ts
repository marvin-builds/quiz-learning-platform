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

/**
 * The quiz with its number of questions, or null when it doesn't exist or is
 * hidden. The questions themselves are read once an attempt has started.
 */
export async function fetchQuiz(quizId: string) {
  if (!UUID.test(quizId)) return null;

  // Only ids: a count-only embed needs a select on the whole row, which the
  // column grants on questions refuse.
  const { data, error } = await supabase
    .from('quizzes')
    .select('id, title, description, questions(id)')
    .eq('id', quizId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { questions, ...quiz } = data;
  return { ...quiz, questionCount: questions.length };
}

/**
 * The quiz's questions with their answers, in play order. Explicit columns:
 * the solutions (`is_correct`, `explanation`) are only revealed by
 * submit_answer.
 */
export async function fetchQuizQuestions(quizId: string) {
  const { data, error } = await supabase
    .from('questions')
    .select(
      'id, text, image_path, image_alt, multiple_correct, sort_order, answers(id, text, image_path, image_alt, sort_order)',
    )
    .eq('quiz_id', quizId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
    .order('sort_order', { referencedTable: 'answers', ascending: true })
    .order('id', { referencedTable: 'answers', ascending: true });
  if (error) throw error;
  return data;
}
