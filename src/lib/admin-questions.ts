import { isUuid, requireWritten } from '@/lib/admin-rows';
import { adminKey, adminQuizKey, fetchAdminQuiz } from '@/lib/admin-quizzes';
import type { QuestionWithAnswersValues } from '@/lib/question-schema';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

// The admin's reads and writes of questions (#81) and their answers (#82).
// questions.explanation and answers.is_correct are solution columns that no
// role may select, admins included: the edit form reads them through the
// admin-only functions admin_question() and admin_answers(), and saves go
// through save_question(), which returns only the question's id.

export const adminQuestionKey = (id: string) => [...adminKey, 'questions', id] as const;
export const adminAnswersKey = (questionId: string) =>
  [...adminQuestionKey(questionId), 'answers'] as const;
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

/** A question's answers with is_correct, by sort_order, through admin_answers(). */
export async function fetchAdminAnswers(questionId: string) {
  const { data, error } = await supabase.rpc('admin_answers', { question_id: questionId });
  if (error) throw error;
  return data;
}

/**
 * Saves a question with its answers in one transaction through
 * save_question(): creates it in the quiz when questionId is null, else
 * updates it. Answers with an id are updated, without one inserted, and the
 * question's answers left out are deleted. Returns nothing that holds a
 * solution: only the question's id.
 */
export async function saveQuestion(
  quizId: string,
  questionId: string | null,
  values: QuestionWithAnswersValues,
) {
  // The generated types miss that question_id and explanation may be null.
  const args = { quiz_id: quizId, question_id: questionId, ...values };
  const { error } = await supabase.rpc(
    'save_question',
    args as Database['public']['Functions']['save_question']['Args'],
  );
  if (error) throw error;
}

export async function deleteQuestion(id: string) {
  const { data, error } = await supabase.from('questions').delete().eq('id', id).select('id');
  if (error) throw error;
  requireWritten(data);
}
