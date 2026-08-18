import { ASSESSMENT_QUESTION_COUNT, POST_TEST_QUESTIONS, PRE_TEST_QUESTIONS, type AssessmentQuestion } from '../data/assessmentQuestions'

// Assessment scoring. The approved question banks are the ONLY authority on correctness — nothing
// here reads a stored isCorrect, because assessment records deliberately don't have one (see
// PreTestAnswerRecord). Every score, per item and in aggregate, is derived here from the bank at
// the moment it is needed, so a score can never drift from the answer key and a client that wrote
// a record directly can never inflate its own result.
//
// Pre and post are individual and non-competitive: nothing in this file touches team score, magic,
// boss, ranking or response time.

// The minimal shape both PreTestAnswerRecord and PostTestAnswerRecord satisfy, and also what the
// round-history raw answers carry — so one implementation serves live player data and history.
export interface SelectedAssessmentAnswer {
  questionId: string
  selectedChoiceId: string
}

export interface AssessmentItemResult {
  questionId: string
  selectedChoiceId: string | null
  isCorrect: boolean
  answered: boolean
}

export interface AssessmentResult {
  correctCount: number
  totalCount: number
  answeredCount: number
  items: AssessmentItemResult[]
}

// Per-item and aggregate result for one student's answers against one bank. Items are returned in
// the bank's own fixed order (item order is intentional and never randomized), so an unanswered
// question still occupies its slot rather than shifting later answers.
export const computeAssessmentResult = (
  answers: SelectedAssessmentAnswer[],
  bank: AssessmentQuestion[],
): AssessmentResult => {
  const items = bank.map((question) => {
    const answer = answers.find((entry) => entry.questionId === question.id)
    return {
      questionId: question.id,
      selectedChoiceId: answer?.selectedChoiceId ?? null,
      // Derived, never read from the record: a selection counts only if it matches the bank's key.
      isCorrect: Boolean(answer && answer.selectedChoiceId === question.correctChoiceId),
      answered: Boolean(answer),
    }
  })
  return {
    correctCount: items.filter((item) => item.isCorrect).length,
    totalCount: bank.length,
    answeredCount: items.filter((item) => item.answered).length,
    items,
  }
}

export const computePreTestResult = (answers: SelectedAssessmentAnswer[]): AssessmentResult =>
  computeAssessmentResult(answers, PRE_TEST_QUESTIONS)

export const computePostTestResult = (answers: SelectedAssessmentAnswer[]): AssessmentResult =>
  computeAssessmentResult(answers, POST_TEST_QUESTIONS)

export { ASSESSMENT_QUESTION_COUNT }
