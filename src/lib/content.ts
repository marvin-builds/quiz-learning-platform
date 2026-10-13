import { supabase } from '@/lib/supabase';

// Reads of the learner-facing content. RLS hides unpublished categories and
// quizzes (and published quizzes in unpublished categories) from learners,
// but returns them to admins, so these queries filter on `published` too:
// a signed-in admin sees the learner area like a learner.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, description')
    .eq('published', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data;
}

/** The category with its quizzes, or null when it doesn't exist or is hidden. */
export async function fetchCategoryWithQuizzes(categoryId: string) {
  // A malformed id can't name a category, so it needn't reach Postgres.
  if (!UUID.test(categoryId)) return null;

  // Two reads in parallel, like the admin's list: the quizzes by sort_order,
  // equal positions by id.
  const [category, quizzes] = await Promise.all([
    supabase
      .from('categories')
      .select('id, name, description')
      .eq('id', categoryId)
      .eq('published', true)
      .maybeSingle(),
    supabase
      .from('quizzes')
      .select('id, title, description')
      .eq('category_id', categoryId)
      .eq('published', true)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
  ]);
  if (category.error) throw category.error;
  if (quizzes.error) throw quizzes.error;
  return category.data && { ...category.data, quizzes: quizzes.data };
}

/**
 * The quiz with its category (id and name) and number of questions, or null when it doesn't exist or is
 * hidden. The questions themselves are read once an attempt has started.
 */
export async function fetchQuiz(quizId: string) {
  if (!UUID.test(quizId)) return null;

  // Only ids: a count-only embed needs a select on the whole row, which the
  // column grants on questions refuse. The inner join drops a quiz whose
  // category is unpublished.
  const { data, error } = await supabase
    .from('quizzes')
    .select('id, category_id, title, description, questions(id), categories!inner(name, published)')
    .eq('id', quizId)
    .eq('published', true)
    .eq('categories.published', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { questions, categories: category, ...quiz } = data;
  return { ...quiz, categoryName: category.name, questionCount: questions.length };
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

/**
 * The score of an attempt as the database computed it: submit_answer keeps
 * `score` up to date, so the client never sums the points itself.
 */
export async function fetchAttemptScore(attemptId: string) {
  const { data, error } = await supabase
    .from('attempts')
    .select('score, max_score')
    .eq('id', attemptId)
    .single();
  if (error) throw error;
  return data;
}
