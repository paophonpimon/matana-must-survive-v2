import { RECALL_QUESTIONS } from '../data/recallQuestions'
import type { Player } from '../types/game'

// Learning Layer: pure computation only — reads raw player.recallAnswers/player.answers
// correctness and nothing else. Deliberately never touches magic/team/boss/speed/ranking data,
// per the spec's own explicit requirement that Learning metrics use "raw individual knowledge
// correctness only." Baseline = Recall correct / 5, In-game Evidence = mapped Main correct / 5,
// Learning Gain = In-game Evidence % - Baseline %, exactly as specified.

type LearningPlayer = Pick<Player, 'recallAnswers' | 'answers'>

export interface StudentLearningEvidence {
  recallCorrectCount: number
  mainEvidenceCorrectCount: number
  baselinePercent: number
  inGameEvidencePercent: number
  learningGainPercent: number
  // Concept ids where the Recall answer was wrong but the mapped Main answer was right.
  improvedConceptIds: string[]
  // Concept ids where the mapped Main answer is still wrong (regardless of the Recall answer).
  stillIncorrectConceptIds: string[]
}

export const computeStudentLearningEvidence = (player: LearningPlayer): StudentLearningEvidence => {
  let recallCorrectCount = 0
  let mainEvidenceCorrectCount = 0
  const improvedConceptIds: string[] = []
  const stillIncorrectConceptIds: string[] = []

  RECALL_QUESTIONS.forEach((recallQuestion) => {
    const recallAnswer = player.recallAnswers.find((entry) => entry.conceptId === recallQuestion.id)
    const mainAnswer = player.answers.find((entry) => entry.questionId === recallQuestion.mappedMainQuestionId)
    const recallCorrect = Boolean(recallAnswer?.isCorrect)
    const mainCorrect = Boolean(mainAnswer?.isCorrect)
    if (recallCorrect) recallCorrectCount += 1
    if (mainCorrect) mainEvidenceCorrectCount += 1
    if (!recallCorrect && mainCorrect) improvedConceptIds.push(recallQuestion.id)
    if (!mainCorrect) stillIncorrectConceptIds.push(recallQuestion.id)
  })

  const baselinePercent = (recallCorrectCount / RECALL_QUESTIONS.length) * 100
  const inGameEvidencePercent = (mainEvidenceCorrectCount / RECALL_QUESTIONS.length) * 100
  return {
    recallCorrectCount,
    mainEvidenceCorrectCount,
    baselinePercent,
    inGameEvidencePercent,
    learningGainPercent: inGameEvidencePercent - baselinePercent,
    improvedConceptIds,
    stillIncorrectConceptIds,
  }
}

// Per-concept before/after pair for ONE student, using the exact same recall-vs-mapped-main
// comparison computeStudentLearningEvidence already performs — exposed separately because the
// round-history snapshot and the spreadsheet export need the per-concept detail, not just the
// aggregate counts. Additive: computeStudentLearningEvidence is unchanged.
export interface StudentConceptResult {
  conceptId: string
  beforeCorrect: boolean
  afterCorrect: boolean
}

export const computeStudentConceptResults = (player: LearningPlayer): StudentConceptResult[] =>
  RECALL_QUESTIONS.map((recallQuestion) => ({
    conceptId: recallQuestion.id,
    beforeCorrect: Boolean(player.recallAnswers.find((entry) => entry.conceptId === recallQuestion.id)?.isCorrect),
    afterCorrect: Boolean(player.answers.find((entry) => entry.questionId === recallQuestion.mappedMainQuestionId)?.isCorrect),
  }))

export interface ConceptClassEvidence {
  conceptId: string
  mappedMainQuestionId: string
  recallCorrectCount: number
  mainCorrectCount: number
  totalStudents: number
}

export interface ClassLearningSummary {
  baselinePercent: number
  inGameEvidencePercent: number
  learningGainPercent: number
  concepts: ConceptClassEvidence[]
  strongestConceptId: string | null
  weakestConceptId: string | null
}

// Class-wide aggregate for the teacher's Learning Summary — "strongest"/"weakest" concept are
// ranked by in-game evidence (Main) accuracy, since that's the students' understanding by the
// end of the round; Baseline is only the starting reference point the gain is measured against.
export const computeClassLearningSummary = (players: LearningPlayer[]): ClassLearningSummary => {
  const totalStudents = players.length
  const concepts: ConceptClassEvidence[] = RECALL_QUESTIONS.map((recallQuestion) => {
    let recallCorrectCount = 0
    let mainCorrectCount = 0
    players.forEach((player) => {
      const recallAnswer = player.recallAnswers.find((entry) => entry.conceptId === recallQuestion.id)
      const mainAnswer = player.answers.find((entry) => entry.questionId === recallQuestion.mappedMainQuestionId)
      if (recallAnswer?.isCorrect) recallCorrectCount += 1
      if (mainAnswer?.isCorrect) mainCorrectCount += 1
    })
    return {
      conceptId: recallQuestion.id,
      mappedMainQuestionId: recallQuestion.mappedMainQuestionId,
      recallCorrectCount,
      mainCorrectCount,
      totalStudents,
    }
  })

  const averagePercent = (pickCorrectCount: (concept: ConceptClassEvidence) => number): number => {
    if (totalStudents === 0 || concepts.length === 0) return 0
    const summedPercent = concepts.reduce((total, concept) => total + (pickCorrectCount(concept) / totalStudents) * 100, 0)
    return summedPercent / concepts.length
  }

  const baselinePercent = averagePercent((concept) => concept.recallCorrectCount)
  const inGameEvidencePercent = averagePercent((concept) => concept.mainCorrectCount)

  let strongestConceptId: string | null = null
  let strongestCount = -1
  let weakestConceptId: string | null = null
  let weakestCount = Infinity
  // With no students at all, every concept's mainCorrectCount is a meaningless 0/0 — there is no
  // real signal to rank, so both stay null rather than the loop below picking the first concept
  // in RECALL_QUESTIONS order by default.
  ;(totalStudents === 0 ? [] : concepts).forEach((concept) => {
    if (concept.mainCorrectCount > strongestCount) {
      strongestCount = concept.mainCorrectCount
      strongestConceptId = concept.conceptId
    }
    if (concept.mainCorrectCount < weakestCount) {
      weakestCount = concept.mainCorrectCount
      weakestConceptId = concept.conceptId
    }
  })

  return {
    baselinePercent,
    inGameEvidencePercent,
    learningGainPercent: inGameEvidencePercent - baselinePercent,
    concepts,
    strongestConceptId,
    weakestConceptId,
  }
}
