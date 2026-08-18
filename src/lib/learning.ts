import { RECALL_QUESTIONS } from '../data/recallQuestions'
import type { Player } from '../types/game'

// Story Recall ("ทบทวนเรื่องราว") reporting — pure computation over raw individual correctness.
//
// Recall is a REVIEW activity, nothing more. It is deliberately NOT a baseline, NOT a pre-test,
// and it is never paired with the main-game answers to produce a before/after figure. An earlier
// revision computed exactly that (Recall = "before", mapped Main = "after", difference = learning
// gain); those functions are gone. Recall and Main are two independent measurements and are
// reported side by side, never subtracted.
//
// A genuine pre/post learning measurement belongs to the assessment layer's own pre-test and
// post-test records (see PreTestAnswerRecord / PostTestAnswerRecord), not to this file.

type RecallPlayer = Pick<Player, 'recallAnswers'>

export interface StudentRecallResult {
  correctCount: number
  totalCount: number
  answeredCount: number
}

// One student's review result: how many of the review items they got right, out of how many
// items exist. No comparison against the main game happens here or anywhere downstream.
export const computeStudentRecallResult = (player: RecallPlayer): StudentRecallResult => {
  let correctCount = 0
  let answeredCount = 0
  RECALL_QUESTIONS.forEach((recallQuestion) => {
    const recallAnswer = player.recallAnswers.find((entry) => entry.conceptId === recallQuestion.id)
    if (!recallAnswer) return
    answeredCount += 1
    if (recallAnswer.isCorrect) correctCount += 1
  })
  return { correctCount, totalCount: RECALL_QUESTIONS.length, answeredCount }
}

export interface StudentRecallItem {
  conceptId: string
  isCorrect: boolean
  answered: boolean
}

// Per-item review detail for ONE student, using the same recallAnswers lookup the aggregate above
// performs — exposed separately because the round-history snapshot and the spreadsheet export need
// item-level detail, not just the counts. `answered` is kept distinct from `isCorrect` so an item
// the student never reached stays distinguishable from one they got wrong.
export const computeStudentRecallItems = (player: RecallPlayer): StudentRecallItem[] =>
  RECALL_QUESTIONS.map((recallQuestion) => {
    const recallAnswer = player.recallAnswers.find((entry) => entry.conceptId === recallQuestion.id)
    return {
      conceptId: recallQuestion.id,
      isCorrect: Boolean(recallAnswer?.isCorrect),
      answered: Boolean(recallAnswer),
    }
  })

export interface ConceptRecallEvidence {
  conceptId: string
  recallCorrectCount: number
  totalStudents: number
}

export interface ClassRecallSummary {
  // Average number of review items answered correctly per student, out of totalCount.
  averageCorrectCount: number
  totalCount: number
  concepts: ConceptRecallEvidence[]
  // Ranked by review accuracy alone — which topics the class already recalled well, and which
  // they did not. This is a review-difficulty signal, not evidence of learning or of change.
  strongestConceptId: string | null
  weakestConceptId: string | null
}

export const computeClassRecallSummary = (players: RecallPlayer[]): ClassRecallSummary => {
  const totalStudents = players.length
  const concepts: ConceptRecallEvidence[] = RECALL_QUESTIONS.map((recallQuestion) => {
    let recallCorrectCount = 0
    players.forEach((player) => {
      const recallAnswer = player.recallAnswers.find((entry) => entry.conceptId === recallQuestion.id)
      if (recallAnswer?.isCorrect) recallCorrectCount += 1
    })
    return { conceptId: recallQuestion.id, recallCorrectCount, totalStudents }
  })

  const averageCorrectCount = totalStudents === 0
    ? 0
    : concepts.reduce((total, concept) => total + concept.recallCorrectCount, 0) / totalStudents

  let strongestConceptId: string | null = null
  let strongestCount = -1
  let weakestConceptId: string | null = null
  let weakestCount = Infinity
  // With no students there is no real signal to rank, so both stay null rather than the loop
  // below defaulting to the first concept in RECALL_QUESTIONS order.
  ;(totalStudents === 0 ? [] : concepts).forEach((concept) => {
    if (concept.recallCorrectCount > strongestCount) {
      strongestCount = concept.recallCorrectCount
      strongestConceptId = concept.conceptId
    }
    if (concept.recallCorrectCount < weakestCount) {
      weakestCount = concept.recallCorrectCount
      weakestConceptId = concept.conceptId
    }
  })

  return {
    averageCorrectCount,
    totalCount: RECALL_QUESTIONS.length,
    concepts,
    strongestConceptId,
    weakestConceptId,
  }
}
