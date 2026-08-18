import { describe, expect, it } from 'vitest'
import {
  distinctStudentCount,
  entriesForRound,
  historyToPrintablePlayers,
  questionIdsFromHistory,
  summarizeRoundHistory,
  teamNamesFromHistory,
} from './roomHistory'
import { computeEvidenceSummaryFromHistory } from './evidenceSummary'
import { buildLearningWorkbook, buildStudentEvidenceSheet } from './learningExport'
import { POST_TEST_QUESTIONS, PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import type { RoundHistoryEntry } from '../types/game'

const entry = (overrides: Partial<RoundHistoryEntry> & { round: number; playerId: string }): RoundHistoryEntry => ({
  id: `${overrides.round}-${overrides.playerId}`,
  displayName: overrides.playerId,
  studentNumber: overrides.playerId.slice(-2),
  teamId: 'team-1',
  teamName: 'ทีมกุหลาบ',
  knowledgeScore: 0,
  knowledgeScore100: 0,
  mainAnswers: [],
  completedAt: 1_000,
  ...overrides,
})

describe('room history helpers', () => {
  it('summarizes rounds newest first, counting each student once', () => {
    const entries = [
      entry({ round: 1, playerId: 'p01', completedAt: 100 }),
      entry({ round: 1, playerId: 'p02', completedAt: 150 }),
      entry({ round: 2, playerId: 'p01', completedAt: 300 }),
    ]
    expect(summarizeRoundHistory(entries)).toEqual([
      { round: 2, studentCount: 1, completedAt: 300 },
      { round: 1, studentCount: 2, completedAt: 150 },
    ])
  })

  it('reports an unrecorded room as unavailable rather than zero students', () => {
    expect(distinctStudentCount([])).toBeNull()
    expect(distinctStudentCount([entry({ round: 1, playerId: 'p01' }), entry({ round: 2, playerId: 'p01' })])).toBe(1)
  })

  it('selects only the requested round, ordered by student number', () => {
    const entries = [
      entry({ round: 1, playerId: 'p03', studentNumber: '03' }),
      entry({ round: 2, playerId: 'p09', studentNumber: '09' }),
      entry({ round: 1, playerId: 'p01', studentNumber: '01' }),
    ]
    expect(entriesForRound(entries, 1).map((item) => item.studentNumber)).toEqual(['01', '03'])
  })

  it('takes the printed question order from the round that was actually played', () => {
    // A student who dropped out early must not shorten the printed table.
    const entries = [
      entry({ round: 1, playerId: 'p01', mainAnswers: [{ questionId: 'q-a', isCorrect: true }] }),
      entry({
        round: 1,
        playerId: 'p02',
        mainAnswers: [
          { questionId: 'q-a', isCorrect: false },
          { questionId: 'q-b', isCorrect: true },
          { questionId: 'q-c', isCorrect: true },
        ],
      }),
    ]
    expect(questionIdsFromHistory(entries)).toEqual(['q-a', 'q-b', 'q-c'])
  })

  it('adapts snapshots into the printable shape without inventing data', () => {
    const entries = [entry({
      round: 3,
      playerId: 'p01',
      displayName: 'Alpha',
      studentNumber: '01',
      knowledgeScore: 7,
      mainAnswers: [{ questionId: 'q-a', isCorrect: true }],
    })]
    expect(historyToPrintablePlayers(entries)).toEqual([{
      id: '3-p01',
      displayName: 'Alpha',
      studentNumber: '01',
      teamId: 'team-1',
      score: 7,
      answers: [{ questionId: 'q-a', isCorrect: true }],
    }])
    expect(teamNamesFromHistory(entries).get('team-1')).toBe('ทีมกุหลาบ')
  })

  it('reads the team name recorded at snapshot time, not a later one', () => {
    const entries = [
      entry({ round: 1, playerId: 'p01', teamId: 'team-1', teamName: 'ชื่อเดิม' }),
      entry({ round: 2, playerId: 'p01', teamId: 'team-1', teamName: 'ชื่อใหม่' }),
    ]
    expect(teamNamesFromHistory(entriesForRound(entries, 1)).get('team-1')).toBe('ชื่อเดิม')
  })
})

// Correctness is derived from the approved banks, never read from a stored count — so these
// fixtures record real selections, exactly the way a real snapshot does.
const selections = (bank: typeof PRE_TEST_QUESTIONS, correctCount: number) =>
  bank.map((question, index) => ({
    questionId: question.id,
    selectedChoiceId: index < correctCount
      ? question.correctChoiceId
      : question.choices.find((choice) => choice.id !== question.correctChoiceId)?.id ?? '',
  }))

const withAssessment = (round: number, playerId: string, pre: number, post: number): RoundHistoryEntry => entry({
  round,
  playerId,
  preTestAnswers: selections(PRE_TEST_QUESTIONS, pre),
  postTestAnswers: selections(POST_TEST_QUESTIONS, post),
  knowledgeScore: 5,
  knowledgeScore100: 50,
  mainAnswers: Array.from({ length: 10 }, (_, index) => ({ questionId: `q${index}`, isCorrect: index < 5 })),
})

describe('historical export scoping', () => {
  const entries = [
    withAssessment(1, 'p01', 3, 9),
    withAssessment(1, 'p02', 4, 6),
    withAssessment(2, 'p01', 5, 5),
    withAssessment(2, 'p02', 6, 8),
  ]

  it('scopes the selected-round export to that round only', () => {
    const roundOne = entriesForRound(entries, 1)
    expect(roundOne).toHaveLength(2)
    // header + one row per student in that round, and nothing from round 2
    expect(buildStudentEvidenceSheet(roundOne).rows).toHaveLength(3)
    expect(computeEvidenceSummaryFromHistory(roundOne).prePost.preAverage).toBe(3.5)
  })

  it('the all-rounds export carries every round exactly once, with no duplicate rows', () => {
    expect(buildStudentEvidenceSheet(entries).rows.slice(1)).toHaveLength(4)
    // ids are `${round}-${playerId}`, so a student appears once per round and never twice in one
    expect(new Set(entries.map((item) => item.id)).size).toBe(entries.length)
    expect(buildLearningWorkbook(entries).byteLength).toBeGreaterThan(0)
  })

  it('per-round and all-round evidence differ only in scope, never in formula', () => {
    const roundTwo = entriesForRound(entries, 2)
    expect(computeEvidenceSummaryFromHistory(roundTwo).prePost).toMatchObject({
      comparedCount: 2,
      preAverage: 5.5,
      postAverage: 6.5,
    })
  })
})

describe('legacy rounds without assessment data', () => {
  // A round recorded before the assessment layer: no pre/post/survey fields at all.
  const legacy = [
    entry({
      round: 1,
      playerId: 'p01',
      displayName: 'Alpha',
      knowledgeScore: 6,
      knowledgeScore100: 60,
      mainAnswers: [{ questionId: 'q-a', isCorrect: true }],
      beforeCorrectCount: 2,
      conceptResults: [],
    }),
  ]

  it('opens, summarizes and exports without fabricating zero performance', () => {
    expect(summarizeRoundHistory(legacy)).toEqual([{ round: 1, studentCount: 1, completedAt: 1_000 }])
    const evidence = computeEvidenceSummaryFromHistory(legacy)
    // Nobody completed both tests -> excluded from the comparison, not scored 0.
    expect(evidence.prePost.comparedCount).toBe(0)
    expect(evidence.students[0]).toMatchObject({ preScore: null, postScore: null, difference: null })
    // The main score it DOES have is still reported.
    expect(evidence.main.averageScore).toBe(6)
    // And it still prints and exports.
    expect(historyToPrintablePlayers(legacy)[0].score).toBe(6)
    expect(buildLearningWorkbook(legacy).byteLength).toBeGreaterThan(0)
  })
})
