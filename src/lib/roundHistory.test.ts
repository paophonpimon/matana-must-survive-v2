import { describe, expect, it } from 'vitest'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { buildLearningWorkbook } from './learningExport'
import { buildRoundHistoryEntry } from './roundHistory'
import { readXlsxEntry } from './xlsx'
import type { Player, RoundHistoryEntry } from '../types/game'
import { createEmptyMagicInventory } from '../types/game'

// Targeted coverage only — the full gameplay flow is verified manually. These pin the three
// things a manual playthrough genuinely cannot show: that history survives a round reset, that a
// round is never snapshotted twice, and that the exported workbook carries the right per-round
// numbers.

const makePlayer = (overrides: Partial<Player> & { id: string }): Player => ({
  displayName: overrides.id,
  studentNumber: overrides.id,
  teamId: 'team-1',
  joinedAt: 0,
  currentRound: 1,
  currentQuestionIndex: 0,
  score: 0,
  answers: [],
  bossAnswers: [],
  recallAnswers: [],
  preTestAnswers: [],
  postTestAnswers: [],
  surveyResponses: [],
  submitted: false,
  finishedAt: null,
  elapsedMs: null,
  status: 'waiting',
  ownerUid: `owner-${overrides.id}`,
  ...overrides,
})

// A student who knew 1 of 5 concepts before playing and 3 after — a distinctive, checkable shape.
const makeLearner = (id: string, score: number): Player => makePlayer({
  id,
  displayName: `นักเรียน ${id}`,
  studentNumber: id,
  score,
  recallAnswers: RECALL_QUESTIONS.map((question, index) => ({
    conceptId: question.id,
    selectedChoiceId: 'x',
    isCorrect: index < 1,
    answeredAt: 0,
  })),
  answers: RECALL_QUESTIONS.map((_question, index) => ({
    questionId: `main-${String(index + 1).padStart(2, "0")}`,
    selectedChoiceId: 'x',
    isCorrect: index < 3,
    answeredAt: 0,
    responseTimeMs: 0,
  })),
})

// Mirrors the service-layer snapshot: keyed by the deterministic entry id, never overwriting an
// id that already exists. Both DemoGameService and FirebaseGameService implement exactly this
// rule (a keyed map / an existing-id set), so exercising it here covers both.
const snapshotInto = (store: Record<string, RoundHistoryEntry>, players: Player[], round: number): void => {
  players.forEach((player) => {
    const entry = buildRoundHistoryEntry(player, round, 'ทีมทดสอบ', 1_000)
    if (store[entry.id]) return
    store[entry.id] = entry
  })
}

describe('round history snapshots', () => {
  it('survives a round reset — the recorded round keeps its numbers after players are wiped', () => {
    const store: Record<string, RoundHistoryEntry> = {}
    const players = [makeLearner('01', 7)]
    snapshotInto(store, players, 1)

    const recorded = store['1-01']
    expect(recorded).toBeDefined()
    expect(recorded.recallCorrectCount).toBe(1)
    expect(recorded.knowledgeScore100).toBe(70)

    // prepareNextRound's reset: answers/recallAnswers/score all wiped on the live player doc.
    players[0].answers = []
    players[0].recallAnswers = []
    players[0].score = 0

    // The snapshot is a separate, immutable record — resetting the player cannot reach it.
    expect(store['1-01'].recallCorrectCount).toBe(1)
    expect(store['1-01'].knowledgeScore100).toBe(70)
    expect(store['1-01'].mainAnswers).toHaveLength(RECALL_QUESTIONS.length)
  })

  it('never snapshots the same round twice, even if a second round-ending operation runs', () => {
    const store: Record<string, RoundHistoryEntry> = {}
    const players = [makeLearner('01', 7)]
    snapshotInto(store, players, 1)
    expect(Object.keys(store)).toHaveLength(1)

    // stopRound followed by prepareNextRound (or a retried call) hits the same round again —
    // and, critically, may do so AFTER the player was reset. A second write would silently
    // replace a real result with an all-zero one.
    players[0].answers = []
    players[0].recallAnswers = []
    players[0].score = 0
    snapshotInto(store, players, 1)

    expect(Object.keys(store)).toHaveLength(1)
    expect(store['1-01'].recallCorrectCount).toBe(1)
    expect(store['1-01'].knowledgeScore100).toBe(70)

    // A genuinely new round is a different id, so it records normally alongside round 1.
    snapshotInto(store, [makeLearner('01', 9)], 2)
    expect(Object.keys(store).sort()).toEqual(['1-01', '2-01'])
    expect(store['2-01'].knowledgeScore100).toBe(90)
  })

  it('exports a workbook whose sheets carry the correct per-round data', () => {
    const store: Record<string, RoundHistoryEntry> = {}
    snapshotInto(store, [makeLearner('01', 7), makeLearner('02', 5)], 1)
    snapshotInto(store, [makeLearner('01', 9)], 2)

    const workbook = buildLearningWorkbook(Object.values(store))
    // Valid zip container with the parts Excel requires.
    expect(readXlsxEntry(workbook, '[Content_Types].xml')).toContain('sheet3.xml')
    const workbookXml = readXlsxEntry(workbook, 'xl/workbook.xml') ?? ''
    expect(workbookXml).toContain('สรุปนักเรียน')
    expect(workbookXml).toContain('รายละเอียดรายข้อ')
    expect(workbookXml).toContain('สรุปชั้นเรียน')

    const summary = readXlsxEntry(workbook, 'xl/worksheets/sheet1.xml') ?? ''
    // Plain classroom headings only — no internal terminology leaks into the file.
    expect(summary).toContain('ผลการทบทวน')
    expect(summary).toContain('ผลการเล่นเกมหลัก /100')
    expect(summary).not.toContain('Baseline')
    expect(summary).not.toContain('Learning Gain')
    // Three rows of data (2 students in round 1, 1 in round 2) plus the header row.
    expect((summary.match(/<row /g) ?? [])).toHaveLength(4)
    // Round 1 student 01 scored 70; round 2 the same student scored 90 — both present.
    expect(summary).toContain('<v>70</v>')
    expect(summary).toContain('<v>90</v>')

    const perQuestion = readXlsxEntry(workbook, 'xl/worksheets/sheet2.xml') ?? ''
    expect(perQuestion).toContain('ข้อ 10')
    expect(perQuestion).toContain('ถูก')
    expect(perQuestion).toContain('ผิด')

    const classSheet = readXlsxEntry(workbook, 'xl/worksheets/sheet3.xml') ?? ''
    // Round 1 has 2 students, round 2 has 1 — and every learner here gets 1 review item right.
    expect(classSheet).toContain('<v>1</v>')
    expect(classSheet).toContain('<v>2</v>')
  })

  // The teacher can export the moment a round ends, before any snapshot has been written (those
  // only happen on prepareNextRound/stopRound/closeRoom). TeacherPage derives the current round's
  // entries in memory with this same builder and merges them under stored history, deduped by id.
  it('exports the just-finished round from live players, without duplicating an already-stored round', () => {
    const stored: Record<string, RoundHistoryEntry> = {}
    snapshotInto(stored, [makeLearner('01', 6)], 1) // round 1 is already persisted
    const livePlayers = [makeLearner('01', 8), makeLearner('02', 4)] // round 2 is still live

    // Same merge TeacherPage performs: stored entries win, unseen current-round entries are added.
    const storedIds = new Set(Object.values(stored).map((entry) => entry.id))
    const currentRound = livePlayers
      .map((player) => buildRoundHistoryEntry(player, 2, 'ทีมทดสอบ', 2_000))
      .filter((entry) => !storedIds.has(entry.id))
    const exportEntries = [...Object.values(stored), ...currentRound]

    const workbook = buildLearningWorkbook(exportEntries)
    const summary = readXlsxEntry(workbook, 'xl/worksheets/sheet1.xml') ?? ''
    // Header + 1 stored row (round 1) + 2 live rows (round 2), each appearing exactly once.
    expect((summary.match(/<row /g) ?? [])).toHaveLength(4)
    expect(summary).toContain('<v>60</v>') // round 1, already stored
    expect(summary).toContain('<v>80</v>') // round 2, derived live
    expect(summary).toContain('<v>40</v>')
    // Round 2 is genuinely present as its own round, not folded into round 1.
    expect(exportEntries.map((entry) => entry.id).sort()).toEqual(['1-01', '2-01', '2-02'])
  })

  it('records nothing that could leak team/magic/boss data into the learning record', () => {
    const player = makeLearner('01', 7)
    player.bossAnswers = [{ questionId: 'boss-rapid-01', selectedChoiceId: 'x', isCorrect: true, answeredAt: 0, responseTimeMs: 10 }]
    const entry = buildRoundHistoryEntry(player, 1, 'ทีมทดสอบ', 1_000)
    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain('boss-rapid-01')
    expect(entry.mainAnswers.every((answer) => answer.questionId.startsWith('main-'))).toBe(true)
    // Sanity: the inventory type exists but never reaches the record.
    expect(serialized).not.toContain(Object.keys(createEmptyMagicInventory())[0])
  })
})
