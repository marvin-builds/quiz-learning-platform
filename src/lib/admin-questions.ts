import { isUuid, requireWritten } from '@/lib/admin-rows';
import { adminKey, adminQuizKey, fetchAdminQuiz } from '@/lib/admin-quizzes';
import type { QuestionValues } from '@/lib/question-schema';
import { supabase } from '@/lib/supabase';
import type { TablesInsert } from '@/types/database';

// The admin's reads and writes of questions (#81). questions.explanation is
// a solution column that no role may select, admins included: the edit form
// reads it through the admin-only function admin_question(), and writes send
// it without asking for it back (they return only the id).

export const adminQuestionKey = (id: string) => [...adminKey, 'questions', id] as const;
// Under the quiz's key, so a change to the quiz refreshes the list too.
export const adminQuizQuestionsKey = (quizId: string) =>
  [...adminQuizKey(quizId), 'questions'] as const;

/** A quiz and its questions by sort_order, without explanations; null when the quiz doesn't exist. */
export async function fetchQuizQuestions(quizId: string) {
  if (!isUuid(quizId)) return null;
  const [quiz, questions] = await Promise.all([
    fetchAdminQuiz(quizId),
    supabase
      .from('questions')
      .select('id, text, sort_order')
      .eq('quiz_id', quizId)
      .order('sort_order', { ascending: true }),
  ]);
  if (questions.error) throw questions.error;
  return quiz && { quiz, questions: questions.data };
}

/** One question with its explanation, through admin_question(); null when it doesn't exist. */
export async function fetchAdminQuestion(id: string) {
  if (!isUuid(id)) return null;
  const { data, error } = await supabase.rpc('admin_question', { question_id: id });
  if (error) throw error;
  const [question] = data;
  if (!question) return null;
  // The generated type misses that a question may have no explanation.
  return { ...question, explanation: question.explanation as string | null };
}

export async function createQuestion(quizId: string, values: QuestionValues) {
  // sort_order is filled in by the trigger questions_assign_sort_order (see
  // createCategory for the cast). No select: the row holds the explanation.
  const row: Omit<TablesInsert<'questions'>, 'sort_order'> = { ...values, quiz_id: quizId };
  const { error } = await supabase.from('questions').insert(row as TablesInsert<'questions'>);
  if (error) throw error;
}

export async function updateQuestion(id: string, values: QuestionValues) {
  const { data, error } = await supabase.from('questions').update(values).eq('id', id).select('id');
  if (error) throw error;
  requireWritten(data);
}

export async function deleteQuestion(id: string) {
  const { data, error } = await supabase.from('questions').delete().eq('id', id).select('id');
  if (error) throw error;
  requireWritten(data);
}
