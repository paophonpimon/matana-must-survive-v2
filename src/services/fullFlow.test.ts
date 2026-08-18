import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { POST_TEST_QUESTIONS, PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { SURVEY_ITEMS } from '../data/surveyItems'
import { questionsById } from '../data/questions'
import { computeEvidenceSummaryFromHistory } from '../lib/evidenceSummary'
import { buildLearningWorkbook } from '../lib/learningExport'
import { resolveStudentRoute } from '../lib/game'
import { BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX } from '../types/game'
import type { Player, Room, RoundHistoryEntry } from '../types/game'
import { DemoGameService } from './demoService'

// End-to-end QA of the whole approved flow against the real service:
//   lobby -> preTest -> recall -> teamSetup -> main -> boss -> main -> postTest -> survey
//   -> completed -> history -> next round
//
// Exercised through the public service API only — no internal state pokes — so it verifies what
// a teacher and students actually drive.

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

const wrongChoiceOf = (question: { choices: Array<{ id: string }>; correctChoiceId: string }): string =>
  question.choices.find((choice) => choice.id !== question.correctChoiceId)?.id ?? ''

describe('Full system flow QA', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('runs the complete round, snapshots evidence, resets, and keeps the previous round readable', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const code = room.roomCode

    // --- 1. JOIN ---
    const alpha = (await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')).player
    const beta = (await service.joinRoom({ roomCode: code, displayName: 'Beta', studentNumber: '02' }, 'uid-2')).player
    const gamma = (await service.joinRoom({ roomCode: code, displayName: 'Gamma', studentNumber: '03' }, 'uid-3')).player
    // Duplicate student number is rejected.
    await expect(service.joinRoom({ roomCode: code, displayName: 'Dup', studentNumber: '01' }, 'uid-4')).rejects.toThrow()

    const liveRoom: { value: Room | null } = { value: null }
    const livePlayers: { value: Player[] } = { value: [] }
    const history: { value: RoundHistoryEntry[] } = { value: [] }
    const stopRoom = service.subscribeRoom(code, (value) => { liveRoom.value = value })
    const stopPlayers = service.subscribePlayers(code, (value) => { livePlayers.value = value })
    const stopHistory = service.subscribeRoundHistory(code, (value) => { history.value = value })
    await vi.waitFor(() => expect(livePlayers.value).toHaveLength(3))

    // --- 2. PRE-TEST ---
    await service.startPreTest(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('preTest'))
    // Students stay in the game flow during the pre-test.
    expect(resolveStudentRoute(liveRoom.value as Room, alpha)).toBe(`/game/${code}`)

    // Alpha 3/10, Beta 8/10, Gamma stops after 4 items (incomplete -> excluded from comparison).
    const answerAssessment = async (
      playerId: string,
      bank: typeof PRE_TEST_QUESTIONS,
      correctCount: number,
      answeredCount: number,
      save: 'pre' | 'post',
    ): Promise<void> => {
      for (let index = 0; index < answeredCount; index += 1) {
        const question = bank[index]
        const input = {
          questionId: question.id,
          selectedChoiceId: index < correctCount ? question.correctChoiceId : wrongChoiceOf(question),
          expectedIndex: index,
        }
        if (save === 'pre') await service.savePreTestAnswer(code, playerId, input)
        else await service.savePostTestAnswer(code, playerId, input)
      }
    }
    await answerAssessment(alpha.id, PRE_TEST_QUESTIONS, 3, 10, 'pre')
    await answerAssessment(beta.id, PRE_TEST_QUESTIONS, 8, 10, 'pre')
    await answerAssessment(gamma.id, PRE_TEST_QUESTIONS, 2, 4, 'pre')

    // Sequential + duplicate + bounds guards.
    await expect(service.savePreTestAnswer(code, alpha.id, {
      questionId: PRE_TEST_QUESTIONS[0].id, selectedChoiceId: PRE_TEST_QUESTIONS[0].correctChoiceId, expectedIndex: 10,
    })).rejects.toThrow()
    await expect(service.savePreTestAnswer(code, gamma.id, {
      questionId: PRE_TEST_QUESTIONS[9].id, selectedChoiceId: PRE_TEST_QUESTIONS[9].correctChoiceId, expectedIndex: 9,
    })).rejects.toThrow()
    await vi.waitFor(() => {
      expect(livePlayers.value.find((p) => p.id === alpha.id)?.preTestAnswers).toHaveLength(10)
      expect(livePlayers.value.find((p) => p.id === gamma.id)?.preTestAnswers).toHaveLength(4)
    })

    // --- 3. RECALL (teacher continues with Gamma unfinished) ---
    await service.startRecall(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('recall'))
    for (let index = 0; index < RECALL_QUESTIONS.length; index += 1) {
      const question = RECALL_QUESTIONS[index]
      for (const player of [alpha, beta, gamma]) {
        await service.saveRecallAnswer(code, player.id, {
          conceptId: question.id,
          selectedChoiceId: index < 4 ? question.correctChoiceId : wrongChoiceOf(question),
          expectedRecallIndex: index,
        })
      }
      await service.advanceRecallQuestion(code, 'teacher-1', index)
    }
    // Pre-test answers survived the Recall stage.
    expect(livePlayers.value.find((p) => p.id === alpha.id)?.preTestAnswers).toHaveLength(10)

    // --- 4. TEAM SETUP ---
    await service.startTeamSetup(code, 'teacher-1')
    await service.randomizeTeams(code, 'teacher-1', 1)
    await service.lockTeams(code, 'teacher-1')
    const teamId = (liveRoom.value as Room).teams[0].id
    await service.finalizeCaptainElection(code, 'teacher-1', teamId)
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    const magic: { value: Array<{ teamId: string; magicHolderPlayerId: string | null }> } = { value: [] }
    const stopMagic = service.subscribeAllTeamMagic(code, (value) => { magic.value = value })
    await vi.waitFor(() => expect(magic.value[0]?.magicHolderPlayerId).toBeTruthy())
    const captainId = magic.value[0].magicHolderPlayerId as string
    await service.setTeamGuardianName(code, teamId, captainId, 'ทีมกุหลาบ')
    await service.chooseStartingItem(code, teamId, captainId, 'power_surge')
    stopMagic()
    // Assessment data survives team setup.
    expect(livePlayers.value.find((p) => p.id === beta.id)?.preTestAnswers).toHaveLength(10)

    // --- 5/6. MAIN + BOSS ---
    await service.startRoom(code, 'teacher-1', 30)
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))
    const mainQuestionIds = (liveRoom.value as Room).questionIds
    for (let index = 0; index < 10; index += 1) {
      const question = questionsById.get(mainQuestionIds[index])
      if (question) {
        // Alpha answers everything correctly; Beta gets the first 5 right; Gamma answers none.
        await service.saveAnswer(code, alpha.id, { questionId: question.id, selectedChoiceId: question.correctChoiceId, expectedQuestionIndex: index })
        await service.saveAnswer(code, beta.id, {
          questionId: question.id,
          selectedChoiceId: index < 5 ? question.correctChoiceId : wrongChoiceOf(question),
          expectedQuestionIndex: index,
        })
      }
      await service.advanceQuestion(code, 'teacher-1', index)
      if (index === BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX) {
        await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('boss'))
        // Boss is exactly 3 questions and stays separate from the knowledge score.
        expect((liveRoom.value as Room).bossQuestionIds).toHaveLength(3)
        for (let bossIndex = 0; bossIndex < 3; bossIndex += 1) {
          await service.advanceBossQuestion(code, 'teacher-1', bossIndex)
        }
        await vi.waitFor(() => expect(liveRoom.value?.bossAwaitingContinue).toBe(true))
        await service.continueAfterBoss(code, 'teacher-1', (liveRoom.value as Room).currentRound)
        await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))
      }
    }

    // --- 7. POST-TEST: Q10 lands here, round NOT completed ---
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('postTest'))
    expect(liveRoom.value?.status).toBe('playing')
    const alphaAfterMain = livePlayers.value.find((p) => p.id === alpha.id) as Player
    // Individual knowledge stays raw /10 — magic never touches it.
    expect(alphaAfterMain.score).toBe(10)
    expect(resolveStudentRoute(liveRoom.value as Room, alphaAfterMain)).toBe(`/game/${code}`)

    // Reaching the postTest STAGE does not open the test — the teacher must start it.
    await expect(service.savePostTestAnswer(code, alpha.id, {
      questionId: POST_TEST_QUESTIONS[0].id, selectedChoiceId: POST_TEST_QUESTIONS[0].correctChoiceId, expectedIndex: 0,
    })).rejects.toThrow()
    await service.startPostTest(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.postTestStartedAt).toBeTruthy())

    // Alpha 9/10 (up from 3), Beta 8/10 (equal to 8), Gamma incomplete again.
    await answerAssessment(alpha.id, POST_TEST_QUESTIONS, 9, 10, 'post')
    await answerAssessment(beta.id, POST_TEST_QUESTIONS, 8, 10, 'post')
    await answerAssessment(gamma.id, POST_TEST_QUESTIONS, 1, 2, 'post')

    // --- 8. SURVEY ---
    await service.startSurvey(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('survey'))
    for (const player of [alpha, beta]) {
      for (let index = 0; index < SURVEY_ITEMS.length; index += 1) {
        await service.saveSurveyResponse(code, player.id, { itemId: SURVEY_ITEMS[index].id, value: '4', expectedIndex: index })
      }
    }
    // Gamma answers one item only -> excluded from satisfaction averages.
    await service.saveSurveyResponse(code, gamma.id, { itemId: SURVEY_ITEMS[0].id, value: '1', expectedIndex: 0 })
    // Out-of-scale values are rejected.
    await expect(service.saveSurveyResponse(code, gamma.id, {
      itemId: SURVEY_ITEMS[1].id, value: '9', expectedIndex: 1,
    })).rejects.toThrow()

    // --- 9. COMPLETION ---
    await service.completeRound(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.status).toBe('completed'))
    await vi.waitFor(() => expect(history.value).toHaveLength(3))
    expect(resolveStudentRoute(liveRoom.value as Room, alphaAfterMain)).toBe(`/result/${code}`)

    // --- 10. EVIDENCE against known fixture data ---
    const evidence = computeEvidenceSummaryFromHistory(history.value)
    expect(evidence.totalStudents).toBe(3)
    // Only Alpha + Beta finished both tests.
    expect(evidence.prePost.comparedCount).toBe(2)
    expect(evidence.prePost.preAverage).toBe((3 + 8) / 2)
    expect(evidence.prePost.postAverage).toBe((9 + 8) / 2)
    expect(evidence.prePost.averageDifference).toBe(((9 - 3) + (8 - 8)) / 2)
    expect(evidence.prePost.improvedCount).toBe(1)
    expect(evidence.prePost.unchangedCount).toBe(1)
    expect(evidence.prePost.declinedCount).toBe(0)
    expect(evidence.prePost.improvedPercent).toBe(50)
    // Main: raw /10 over all three students.
    expect(evidence.main.averageScore).toBe((10 + 5 + 0) / 3)
    expect(evidence.main.completedCount).toBe(2)
    // Recall: 4/5 each, reported entirely separately.
    expect(evidence.recall.averageCorrect).toBe(4)
    expect(evidence.recall.completedCount).toBe(3)
    expect(evidence.recall.totalCount).toBe(5)
    // Survey: completed surveys only (Alpha + Beta), Gamma's stray 1 excluded.
    expect(evidence.survey.completedCount).toBe(2)
    expect(evidence.survey.overallAverage).toBe(4)
    expect(evidence.survey.items.every((item) => item.responseCount === 2 && item.average === 4)).toBe(true)
    // Per-student rows: Gamma's incomplete tests read as unavailable, not zero.
    const rows = new Map(evidence.students.map((student) => [student.displayName, student]))
    expect(rows.get('Alpha')).toMatchObject({ preScore: 3, postScore: 9, difference: 6, mainScore: 10, mainCompleted: true, surveyCompleted: true })
    expect(rows.get('Beta')).toMatchObject({ preScore: 8, postScore: 8, difference: 0, mainScore: 5 })
    expect(rows.get('Gamma')).toMatchObject({ preScore: null, postScore: null, difference: null, surveyCompleted: false })

    // --- 11. NEXT ROUND ---
    await service.prepareNextRound(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.currentRound).toBe(2))
    // Live arrays reset...
    await vi.waitFor(() => {
      const reset = livePlayers.value.find((p) => p.id === alpha.id) as Player
      expect(reset.preTestAnswers).toHaveLength(0)
      expect(reset.postTestAnswers).toHaveLength(0)
      expect(reset.surveyResponses).toHaveLength(0)
      expect(reset.recallAnswers).toHaveLength(0)
      expect(reset.answers).toHaveLength(0)
      expect(reset.score).toBe(0)
    })
    // ...but round 1 evidence is unchanged, and no phantom/duplicate round appeared.
    expect(history.value).toHaveLength(3)
    expect([...new Set(history.value.map((entry) => entry.round))]).toEqual([1])
    const afterReset = computeEvidenceSummaryFromHistory(history.value.filter((entry) => entry.round === 1))
    expect(afterReset.prePost).toMatchObject({ comparedCount: 2, improvedCount: 1, unchangedCount: 1 })
    expect(afterReset.survey.overallAverage).toBe(4)

    // --- 12. EXPORT: round 1 appears exactly once ---
    const workbook = buildLearningWorkbook(history.value)
    expect(workbook.byteLength).toBeGreaterThan(0)
    expect(history.value.filter((entry) => entry.id === `1-${alpha.id}`)).toHaveLength(1)

    stopHistory()
    stopPlayers()
    stopRoom()
  })

  it('reconnects a student mid pre-test without losing their answers', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const code = room.roomCode
    const first = (await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')).player
    await service.startPreTest(code, 'teacher-1')
    for (let index = 0; index < 4; index += 1) {
      await service.savePreTestAnswer(code, first.id, {
        questionId: PRE_TEST_QUESTIONS[index].id,
        selectedChoiceId: PRE_TEST_QUESTIONS[index].correctChoiceId,
        expectedIndex: index,
      })
    }
    // Refresh / reconnect: same student number, same device identity -> same player record.
    const rejoined = (await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')).player
    expect(rejoined.id).toBe(first.id)
    expect(rejoined.preTestAnswers).toHaveLength(4)
    // Resumes at the next unanswered item rather than restarting.
    await service.savePreTestAnswer(code, rejoined.id, {
      questionId: PRE_TEST_QUESTIONS[4].id,
      selectedChoiceId: PRE_TEST_QUESTIONS[4].correctChoiceId,
      expectedIndex: 4,
    })
    const players = { value: [] as Player[] }
    const stop = service.subscribePlayers(code, (value) => { players.value = value })
    await vi.waitFor(() => expect(players.value[0]?.preTestAnswers).toHaveLength(5))
    stop()
  })

  it('snapshots partial assessment data when the teacher stops the round mid post-test', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const code = room.roomCode
    const player = (await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')).player

    await service.startPreTest(code, 'teacher-1')
    for (let index = 0; index < 10; index += 1) {
      await service.savePreTestAnswer(code, player.id, {
        questionId: PRE_TEST_QUESTIONS[index].id,
        selectedChoiceId: index < 6 ? PRE_TEST_QUESTIONS[index].correctChoiceId : wrongChoiceOf(PRE_TEST_QUESTIONS[index]),
        expectedIndex: index,
      })
    }
    await service.startRecall(code, 'teacher-1')
    for (let index = 0; index < RECALL_QUESTIONS.length; index += 1) {
      await service.advanceRecallQuestion(code, 'teacher-1', index)
    }
    await service.startTeamSetup(code, 'teacher-1')
    await service.randomizeTeams(code, 'teacher-1', 1)
    await service.lockTeams(code, 'teacher-1')
    const teamId = room.teams[0]?.id ?? ''
    const liveRoom = { value: null as Room | null }
    const stopRoomSub = service.subscribeRoom(code, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    const resolvedTeamId = teamId || (liveRoom.value as Room).teams[0].id
    await service.finalizeCaptainElection(code, 'teacher-1', resolvedTeamId)
    const magic = { value: [] as Array<{ teamId: string; magicHolderPlayerId: string | null }> }
    const stopMagic = service.subscribeAllTeamMagic(code, (value) => { magic.value = value })
    await vi.waitFor(() => expect(magic.value[0]?.magicHolderPlayerId).toBeTruthy())
    const captainId = magic.value[0].magicHolderPlayerId as string
    await service.setTeamGuardianName(code, resolvedTeamId, captainId, 'ทีมกุหลาบ')
    await service.chooseStartingItem(code, resolvedTeamId, captainId, 'power_surge')
    stopMagic()

    await service.startRoom(code, 'teacher-1', 30)
    for (let index = 0; index < 10; index += 1) {
      await service.advanceQuestion(code, 'teacher-1', index)
      if (index === BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX) {
        for (let bossIndex = 0; bossIndex < 3; bossIndex += 1) {
          await service.advanceBossQuestion(code, 'teacher-1', bossIndex)
        }
        await vi.waitFor(() => expect(liveRoom.value?.bossAwaitingContinue).toBe(true))
        await service.continueAfterBoss(code, 'teacher-1', (liveRoom.value as Room).currentRound)
      }
    }
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('postTest'))
    await service.startPostTest(code, 'teacher-1')
    await service.savePostTestAnswer(code, player.id, {
      questionId: POST_TEST_QUESTIONS[0].id,
      selectedChoiceId: POST_TEST_QUESTIONS[0].correctChoiceId,
      expectedIndex: 0,
    })

    // Emergency stop straight out of the post-test — the round must still be recorded, and the
    // room must land back on a clean lobby rather than a stranded assessment phase.
    const history = { value: [] as RoundHistoryEntry[] }
    const stopHistory = service.subscribeRoundHistory(code, (value) => { history.value = value })
    await service.stopRound(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.status).toBe('waiting'))
    expect(liveRoom.value?.phase).toBe('lobby')
    await vi.waitFor(() => expect(history.value).toHaveLength(1))
    // The completed pre-test survived; the abandoned post-test is recorded as incomplete, so
    // the evidence summary excludes this student from the paired comparison instead of
    // reporting a 1/10 "after" score.
    expect(history.value[0].preTestCorrectCount).toBe(6)
    expect(history.value[0].postTestAnswers).toHaveLength(1)
    const evidence = computeEvidenceSummaryFromHistory(history.value)
    expect(evidence.prePost.comparedCount).toBe(0)
    expect(evidence.students[0]).toMatchObject({ preScore: 6, postScore: null, difference: null })
    stopHistory()
    stopRoomSub()
  })
})
