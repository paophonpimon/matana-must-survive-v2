import { describe, expect, it } from 'vitest'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { computeClassLearningSummary, computeStudentLearningEvidence } from './learning'
import type { AnswerRecord, Player, RecallAnswerRecord } from '../types/game'

const makeRecallAnswer = (conceptId: string, isCorrect: boolean): RecallAnswerRecord => ({
  conceptId,
  selectedChoiceId: isCorrect ? 'x-correct' : 'x-wrong',
  isCorrect,
  answeredAt: 0,
})

const makeMainAnswer = (questionId: string, isCorrect: boolean): AnswerRecord => ({
  questionId,
  selectedChoiceId: isCorrect ? 'x-correct' : 'x-wrong',
  isCorrect,
  answeredAt: 0,
  responseTimeMs: 0,
})

type LearningPlayer = Pick<Player, 'recallAnswers' | 'answers'>

const makeLearningPlayer = (recallAnswers: RecallAnswerRecord[], answers: AnswerRecord[]): LearningPlayer => ({ recallAnswers, answers })

describe('computeStudentLearningEvidence', () => {
  it('a student who got every Recall and every mapped Main question right has Baseline == In-game Evidence == 100%, Learning Gain 0', () => {
    const player = makeLearningPlayer(
      RECALL_QUESTIONS.map((question) => makeRecallAnswer(question.id, true)),
      RECALL_QUESTIONS.map((question) => makeMainAnswer(question.mappedMainQuestionId, true)),
    )
    const evidence = computeStudentLearningEvidence(player)
    expect(evidence.recallCorrectCount).toBe(5)
    expect(evidence.mainEvidenceCorrectCount).toBe(5)
    expect(evidence.baselinePercent).toBe(100)
    expect(evidence.inGameEvidencePercent).toBe(100)
    expect(evidence.learningGainPercent).toBe(0)
    expect(evidence.improvedConceptIds).toEqual([])
    expect(evidence.stillIncorrectConceptIds).toEqual([])
  })

  it('a student who answered nothing at all scores 0/5 on both sides — never crashes on missing records', () => {
    const player = makeLearningPlayer([], [])
    const evidence = computeStudentLearningEvidence(player)
    expect(evidence.recallCorrectCount).toBe(0)
    expect(evidence.mainEvidenceCorrectCount).toBe(0)
    expect(evidence.baselinePercent).toBe(0)
    expect(evidence.inGameEvidencePercent).toBe(0)
    expect(evidence.learningGainPercent).toBe(0)
    // Every concept's mapped Main answer is missing (not correct), so every one is "still incorrect".
    expect(evidence.stillIncorrectConceptIds).toEqual(RECALL_QUESTIONS.map((question) => question.id))
  })

  it('a concept wrong at Recall but right at Main counts as improved, positive Learning Gain', () => {
    const [first, ...rest] = RECALL_QUESTIONS
    const player = makeLearningPlayer(
      [makeRecallAnswer(first.id, false), ...rest.map((question) => makeRecallAnswer(question.id, true))],
      RECALL_QUESTIONS.map((question) => makeMainAnswer(question.mappedMainQuestionId, true)),
    )
    const evidence = computeStudentLearningEvidence(player)
    expect(evidence.recallCorrectCount).toBe(4)
    expect(evidence.mainEvidenceCorrectCount).toBe(5)
    expect(evidence.improvedConceptIds).toEqual([first.id])
    expect(evidence.stillIncorrectConceptIds).toEqual([])
    expect(evidence.learningGainPercent).toBeCloseTo(20, 5) // (5/5*100) - (4/5*100)
  })

  it('a concept right at Recall but wrong at Main is NOT counted as improved, and IS still incorrect', () => {
    const [first, ...rest] = RECALL_QUESTIONS
    const player = makeLearningPlayer(
      RECALL_QUESTIONS.map((question) => makeRecallAnswer(question.id, true)),
      [makeMainAnswer(first.mappedMainQuestionId, false), ...rest.map((question) => makeMainAnswer(question.mappedMainQuestionId, true))],
    )
    const evidence = computeStudentLearningEvidence(player)
    expect(evidence.improvedConceptIds).toEqual([])
    expect(evidence.stillIncorrectConceptIds).toEqual([first.id])
    expect(evidence.learningGainPercent).toBeCloseTo(-20, 5) // (4/5*100) - (5/5*100)
  })

  // Explicit guard against the exact things the spec forbids these metrics from ever touching:
  // this only reads recallAnswers/answers, so a Player-shaped object that had magic/team/boss/
  // speed/ranking fields set to something extreme would have zero effect on the result (there is
  // nothing here that could read them even if it wanted to — the function signature itself is
  // narrowed to Pick<Player, 'recallAnswers' | 'answers'>).
  it('never reads anything beyond recallAnswers/answers (raw individual correctness only)', () => {
    const player = makeLearningPlayer(
      [makeRecallAnswer(RECALL_QUESTIONS[0].id, true)],
      [makeMainAnswer(RECALL_QUESTIONS[0].mappedMainQuestionId, true)],
    )
    const evidence = computeStudentLearningEvidence(player)
    expect(evidence.recallCorrectCount).toBe(1)
    expect(evidence.mainEvidenceCorrectCount).toBe(1)
  })
})

describe('computeClassLearningSummary', () => {
  it('aggregates recall/main correctness per concept across the whole class, and averages to a class baseline/evidence/gain', () => {
    const conceptA = RECALL_QUESTIONS[0]
    const conceptB = RECALL_QUESTIONS[1]
    // Two students: one gets concept A right (recall+main), the other gets concept A wrong on
    // both; concept B: neither ever answers it.
    const players: LearningPlayer[] = [
      makeLearningPlayer([makeRecallAnswer(conceptA.id, true)], [makeMainAnswer(conceptA.mappedMainQuestionId, true)]),
      makeLearningPlayer([makeRecallAnswer(conceptA.id, false)], [makeMainAnswer(conceptA.mappedMainQuestionId, false)]),
    ]
    const summary = computeClassLearningSummary(players)
    const conceptASummary = summary.concepts.find((concept) => concept.conceptId === conceptA.id)
    const conceptBSummary = summary.concepts.find((concept) => concept.conceptId === conceptB.id)
    expect(conceptASummary).toMatchObject({ recallCorrectCount: 1, mainCorrectCount: 1, totalStudents: 2 })
    expect(conceptBSummary).toMatchObject({ recallCorrectCount: 0, mainCorrectCount: 0, totalStudents: 2 })
  })

  it('an empty class never crashes — 0% everywhere, no strongest/weakest concept', () => {
    const summary = computeClassLearningSummary([])
    expect(summary.baselinePercent).toBe(0)
    expect(summary.inGameEvidencePercent).toBe(0)
    expect(summary.learningGainPercent).toBe(0)
    expect(summary.strongestConceptId).toBeNull()
    expect(summary.weakestConceptId).toBeNull()
  })

  it('identifies the strongest and weakest concept by in-game (Main) evidence accuracy', () => {
    const [strong, weak, ...restQuestions] = RECALL_QUESTIONS
    const players: LearningPlayer[] = [
      makeLearningPlayer(
        [],
        [
          makeMainAnswer(strong.mappedMainQuestionId, true),
          makeMainAnswer(weak.mappedMainQuestionId, false),
          ...restQuestions.map((question) => makeMainAnswer(question.mappedMainQuestionId, false)),
        ],
      ),
    ]
    const summary = computeClassLearningSummary(players)
    expect(summary.strongestConceptId).toBe(strong.id)
    expect(summary.weakestConceptId).toBe(weak.id)
  })
})
