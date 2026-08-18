import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ASSESSMENT_QUESTION_COUNT, POST_TEST_QUESTIONS, PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { resolveAssessmentStatus } from '../lib/assessmentClock'
import { computeEvidenceSummary, computeEvidenceSummaryFromHistory } from '../lib/evidenceSummary'
import { getAssessmentDeadline, getAssessmentRemainingMilliseconds, isAssessmentExpired, isAssessmentOpen, preTestProgressOf, preTestWindow } from '../lib/gameFlow'
import {
  BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX,
  DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION,
  MAX_ASSESSMENT_SECONDS_PER_QUESTION,
  MIN_ASSESSMENT_SECONDS_PER_QUESTION,
  PHASE_INTRO_MILLISECONDS,
  RECALL_QUESTION_COUNT,
} from '../types/game'
import type { Player, Room, RoundHistoryEntry } from '../types/game'
import { DemoGameService } from './demoService'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

describe('assessment clock helpers', () => {
  it('treats a test that has not been opened as full-time and not expired', () => {
    const closed = { startedAt: null, durationSeconds: 240 }
    expect(isAssessmentOpen(closed)).toBe(false)
    expect(isAssessmentExpired(closed)).toBe(false)
    // A null start must never read as "time is up" — that would lock out a whole class.
    expect(getAssessmentRemainingMilliseconds(closed)).toBe(240_000)
  })

  it('derives remaining time and expiry from the persisted start instant only', () => {
    const startedAt = 1_000_000
    const open = { startedAt, durationSeconds: 240 }
    expect(getAssessmentRemainingMilliseconds(open, startedAt)).toBe(240_000)
    expect(getAssessmentRemainingMilliseconds(open, startedAt + 100_000)).toBe(140_000)
    expect(isAssessmentOpen(open, startedAt + 239_999)).toBe(true)
    expect(isAssessmentExpired(open, startedAt + 240_000)).toBe(true)
    expect(getAssessmentRemainingMilliseconds(open, startedAt + 999_999)).toBe(0)
  })

  it('reports all four per-student statuses from progress, not answers', () => {
    expect(resolveAssessmentStatus(0, false)).toBe('ยังไม่เริ่ม')
    expect(resolveAssessmentStatus(4, false)).toBe('กำลังทำ')
    expect(resolveAssessmentStatus(ASSESSMENT_QUESTION_COUNT, false)).toBe('เสร็จแล้ว')
    // Unfinished + expired is timed out, not merely "in progress".
    expect(resolveAssessmentStatus(4, true)).toBe('หมดเวลา')
    expect(resolveAssessmentStatus(ASSESSMENT_QUESTION_COUNT, true)).toBe('เสร็จแล้ว')
    // Reached the end with timeouts along the way: still finished, and the caller shows the real
    // answered count beside it rather than pretending all ten were answered.
    expect(resolveAssessmentStatus(ASSESSMENT_QUESTION_COUNT, false, 8)).toBe('เสร็จแล้ว')
  })
})

describe('assessment gating and timing', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const setup = async () => {
    const service = new DemoGameService()
    const created = await service.createRoom('teacher-1')
    const code = created.roomCode
    const alpha = (await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')).player
    const beta = (await service.joinRoom({ roomCode: code, displayName: 'Beta', studentNumber: '02' }, 'uid-2')).player
    const liveRoom: { value: Room | null } = { value: null }
    const players: { value: Player[] } = { value: [] }
    const stopRoom = service.subscribeRoom(code, (value) => { liveRoom.value = value })
    const stopPlayers = service.subscribePlayers(code, (value) => { players.value = value })
    // The first snapshot must land before any assertion reads room fields, or optional chaining
    // yields undefined and every field assertion silently passes.
    await vi.waitFor(() => expect(liveRoom.value).not.toBeNull())
    return { service, code, alpha, beta, liveRoom, players, stop: () => { stopPlayers(); stopRoom() } }
  }

  const answer = (bank: typeof PRE_TEST_QUESTIONS, index: number, correct = true) => ({
    questionId: bank[index].id,
    selectedChoiceId: correct
      ? bank[index].correctChoiceId
      : bank[index].choices.find((choice) => choice.id !== bank[index].correctChoiceId)?.id ?? '',
    expectedIndex: index,
  })

  // Drives lobby -> ... -> postTest STAGE without opening the post-test.
  const reachPostTestStage = async (context: Awaited<ReturnType<typeof setup>>) => {
    const { service, code, liveRoom } = context
    await service.startPreTest(code, 'teacher-1')
    await service.startRecall(code, 'teacher-1')
    for (let index = 0; index < RECALL_QUESTION_COUNT; index += 1) {
      await service.advanceRecallQuestion(code, 'teacher-1', index)
    }
    await service.startTeamSetup(code, 'teacher-1')
    await service.randomizeTeams(code, 'teacher-1', 1)
    await service.lockTeams(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    const teamId = (liveRoom.value as Room).teams[0].id
    await service.finalizeCaptainElection(code, 'teacher-1', teamId)
    const magic: { value: Array<{ teamId: string; magicHolderPlayerId: string | null }> } = { value: [] }
    const stopMagic = service.subscribeAllTeamMagic(code, (value) => { magic.value = value })
    await vi.waitFor(() => expect(magic.value[0]?.magicHolderPlayerId).toBeTruthy())
    const captainId = magic.value[0].magicHolderPlayerId as string
    await service.setTeamGuardianName(code, teamId, captainId, 'ทีมกุหลาบ')
    await service.chooseStartingItem(code, teamId, captainId, 'power_surge')
    stopMagic()
    await service.startRoom(code, 'teacher-1', 30)
    for (let index = 0; index < 10; index += 1) {
      await service.advanceQuestion(code, 'teacher-1', index)
      if (index === BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX) {
        await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('boss'))
        for (let bossIndex = 0; bossIndex < 3; bossIndex += 1) {
          await service.advanceBossQuestion(code, 'teacher-1', bossIndex)
        }
        await vi.waitFor(() => expect(liveRoom.value?.bossAwaitingContinue).toBe(true))
        await service.continueAfterBoss(code, 'teacher-1', (liveRoom.value as Room).currentRound)
      }
    }
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('postTest'))
  }

  it('reaching the post-test stage does NOT open the test — students wait for the teacher', async () => {
    const context = await setup()
    const { service, code, alpha, liveRoom } = context
    await reachPostTestStage(context)

    // The stage is reached, but the test is closed: no start instant, and writes are refused.
    expect(liveRoom.value?.status).toBe('playing')
    expect(liveRoom.value?.postTestStartedAt).toBeNull()
    await expect(service.savePostTestAnswer(code, alpha.id, answer(POST_TEST_QUESTIONS, 0))).rejects.toThrow()

    // Only the explicit teacher action opens it.
    await service.startPostTest(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.postTestStartedAt).toBeTruthy())
    await service.savePostTestAnswer(code, alpha.id, answer(POST_TEST_QUESTIONS, 0))
    await vi.waitFor(() => expect(context.players.value.find((p) => p.id === alpha.id)?.postTestAnswers).toHaveLength(1))

    context.stop()
  })

  it('a duplicate start press cannot restart or extend the budget', async () => {
    const context = await setup()
    const { service, code, liveRoom } = context
    await reachPostTestStage(context)
    await service.startPostTest(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.postTestStartedAt).toBeTruthy())
    const first = (liveRoom.value as Room).postTestStartedAt

    await service.startPostTest(code, 'teacher-1')
    await service.startPostTest(code, 'teacher-1', 600)
    // Idempotent: the original instant stands.
    expect((liveRoom.value as Room).postTestStartedAt).toBe(first)

    context.stop()
  })

  it('the pre-test is closed until the teacher starts it, and the budget is clamped', async () => {
    const { service, code, alpha, liveRoom, stop } = await setup()
    // Still in the lobby: no start instant, and a write is refused.
    expect(liveRoom.value?.preTestStartedAt).toBeNull()
    await expect(service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, 0))).rejects.toThrow()

    // Out-of-range durations clamp rather than being accepted verbatim.
    await service.startPreTest(code, 'teacher-1', 99_999)
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('preTest'))
    expect(liveRoom.value?.assessmentSecondsPerQuestion).toBe(MAX_ASSESSMENT_SECONDS_PER_QUESTION)
    expect(liveRoom.value?.preTestStartedAt).toBeTruthy()
    await service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, 0))
    stop()
  })

  it('defaults to 30 seconds per question and accepts the configured range', async () => {
    expect(DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION).toBe(30)
    expect(MIN_ASSESSMENT_SECONDS_PER_QUESTION).toBe(10)
    expect(MAX_ASSESSMENT_SECONDS_PER_QUESTION).toBe(120)

    const { service, code, liveRoom, stop } = await setup()
    expect(liveRoom.value?.assessmentSecondsPerQuestion).toBe(DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION)
    await service.startPreTest(code, 'teacher-1', 45)
    await vi.waitFor(() => expect(liveRoom.value?.assessmentSecondsPerQuestion).toBe(45))
    stop()
  })

  it('gives every question the full time, restarting when the student moves on', async () => {
    const { service, code, alpha, liveRoom, players, stop } = await setup()
    await service.startPreTest(code, 'teacher-1', 30)
    await vi.waitFor(() => expect(liveRoom.value?.preTestStartedAt).toBeTruthy())
    const room = liveRoom.value as Room

    // Question 1 runs from the instant the teacher opened the test (plus the phase intro).
    expect(getAssessmentDeadline(preTestWindow(room, { questionStartedAt: null, progress: 0 })))
      .toBe((room.preTestStartedAt as number) + PHASE_INTRO_MILLISECONDS + 30_000)

    await service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, 0))
    await vi.waitFor(() => expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(1))
    const saved = players.value.find((entry) => entry.id === alpha.id) as Player

    // Question 2 restarts from when the student moved on — a full 30s again, no intro offset, and
    // nothing carried over from how long question 1 took.
    const second = preTestWindow(room, preTestProgressOf(saved))
    expect(second.introOffsetMs).toBe(0)
    expect(second.startedAt).toBe(saved.preTestQuestionStartedAt)
    expect(getAssessmentDeadline(second)).toBe((saved.preTestQuestionStartedAt as number) + 30_000)
    expect(getAssessmentRemainingMilliseconds(second, saved.preTestQuestionStartedAt as number)).toBe(30_000)
    stop()
  })

  it('advances past an expired question without inventing an answer', async () => {
    const { service, code, alpha, liveRoom, players, stop } = await setup()
    await service.startPreTest(code, 'teacher-1', 30)
    await vi.waitFor(() => expect(liveRoom.value?.preTestStartedAt).toBeTruthy())
    const room = liveRoom.value as Room

    // Answer question 1 for real, then let question 2 run out.
    await service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, 0))
    await vi.waitFor(() => expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(1))
    const atQ2 = players.value.find((entry) => entry.id === alpha.id) as Player
    vi.setSystemTime(new Date((getAssessmentDeadline(preTestWindow(room, preTestProgressOf(atQ2))) as number) + 1_000))

    // Answering is refused...
    await expect(service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, 1))).rejects.toThrow()
    // ...but the student is not stuck: the timeout advance moves them on.
    await service.advancePreTestQuestion(code, alpha.id, 1)
    await vi.waitFor(() => expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(2))

    const after = players.value.find((entry) => entry.id === alpha.id) as Player
    // No fake answer was created — one real answer, progress 2.
    expect(after.preTestAnswers).toHaveLength(1)
    expect(after.preTestAnswers[0].questionId).toBe(PRE_TEST_QUESTIONS[0].id)
    // Question 3 gets a full window from the advance instant.
    expect(getAssessmentDeadline(preTestWindow(room, preTestProgressOf(after))))
      .toBe((after.preTestQuestionStartedAt as number) + 30_000)

    vi.useRealTimers()
    stop()
  })

  it('timeout advance is idempotent — duplicates and reconnects cannot double-skip', async () => {
    const { service, code, alpha, liveRoom, players, stop } = await setup()
    await service.startPreTest(code, 'teacher-1', 30)
    await vi.waitFor(() => expect(liveRoom.value?.preTestStartedAt).toBeTruthy())
    const room = liveRoom.value as Room
    const atQ1 = players.value.find((entry) => entry.id === alpha.id) as Player
    vi.setSystemTime(new Date((getAssessmentDeadline(preTestWindow(room, preTestProgressOf(atQ1))) as number) + 1_000))

    // Five calls for the same index — a rerender, a second tab and a reconnect all look like this.
    await Promise.all([0, 0, 0, 0, 0].map(() => service.advancePreTestQuestion(code, alpha.id, 0)))
    await vi.waitFor(() => expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(1))
    // Exactly one question was skipped, not five.
    expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(1)

    // A stale call for the index already left is a no-op, so it cannot re-skip.
    await service.advancePreTestQuestion(code, alpha.id, 0)
    expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(1)
    // And it is not a "next" button: the fresh question has time left, so it refuses.
    vi.useRealTimers()
    await service.advancePreTestQuestion(code, alpha.id, 1)
    expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(1)
    stop()
  })

  it('a final-question timeout finishes the assessment, leaving it incomplete', async () => {
    const { service, code, alpha, liveRoom, players, stop } = await setup()
    await service.startPreTest(code, 'teacher-1', 30)
    await vi.waitFor(() => expect(liveRoom.value?.preTestStartedAt).toBeTruthy())
    const room = liveRoom.value as Room

    // Answer 8, time out on questions 9 and 10.
    for (let index = 0; index < 8; index += 1) {
      await service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, index))
    }
    await vi.waitFor(() => expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(8))
    for (const index of [8, 9]) {
      const current = players.value.find((entry) => entry.id === alpha.id) as Player
      vi.setSystemTime(new Date((getAssessmentDeadline(preTestWindow(room, preTestProgressOf(current))) as number) + 1_000))
      await service.advancePreTestQuestion(code, alpha.id, index)
      await vi.waitFor(() => expect(players.value.find((entry) => entry.id === alpha.id)?.preTestProgress).toBe(index + 1))
    }

    const done = players.value.find((entry) => entry.id === alpha.id) as Player
    // Progressed 10/10, really answered 8/10 — the flow is finished.
    expect(done.preTestProgress).toBe(ASSESSMENT_QUESTION_COUNT)
    expect(done.preTestAnswers).toHaveLength(8)
    // Past the end, nothing advances further.
    await service.advancePreTestQuestion(code, alpha.id, 10)
    expect(done.preTestProgress).toBe(ASSESSMENT_QUESTION_COUNT)
    // Teacher status: finished, but the real count is 8.
    expect(resolveAssessmentStatus(done.preTestProgress, false, done.preTestAnswers.length)).toBe('เสร็จแล้ว')

    // Evidence: incomplete, so excluded from the paired comparison — never scored 0.
    const evidence = computeEvidenceSummary([done])
    expect(evidence.prePost.comparedCount).toBe(0)
    expect(evidence.students[0]).toMatchObject({ preScore: null, difference: null })

    vi.useRealTimers()
    stop()
  })

  it('locks answers at timeout, keeps what was saved, and fabricates nothing', async () => {
    const { service, code, alpha, liveRoom, players, stop } = await setup()
    await service.startPreTest(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.preTestStartedAt).toBeTruthy())

    for (let index = 0; index < 3; index += 1) {
      await service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, index))
    }

    // Wind past the deadline, exactly as a real timeout does. Derived from the same helper the
    // service uses, so the test cannot disagree with the production deadline rule.
    const room = liveRoom.value as Room
    const current = players.value.find((p) => p.id === alpha.id) as Player
    vi.setSystemTime(new Date((getAssessmentDeadline(preTestWindow(room, preTestProgressOf(current))) as number) + 1_000))
    await expect(service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, 3))).rejects.toThrow()

    await vi.waitFor(() => {
      const saved = players.value.find((p) => p.id === alpha.id) as Player
      // The three real answers survive, and no 4th appears — no fabricated wrong answers.
      expect(saved.preTestAnswers).toHaveLength(3)
    })
    vi.useRealTimers()
    stop()
  })

  it('a timed-out student stays visible but is excluded from the paired comparison', async () => {
    // Alpha completed both tests; Beta timed out mid post-test with 4 of 10 answered.
    const entry = (playerId: string, pre: number[], post: number[]): RoundHistoryEntry => ({
      id: `1-${playerId}`,
      round: 1,
      playerId,
      displayName: playerId,
      studentNumber: playerId.slice(-2),
      teamId: 'team-1',
      teamName: 'ทีมกุหลาบ',
      knowledgeScore: 5,
      knowledgeScore100: 50,
      mainAnswers: [],
      completedAt: 1_000,
      preTestAnswers: pre.map((index) => ({
        questionId: PRE_TEST_QUESTIONS[index].id,
        selectedChoiceId: PRE_TEST_QUESTIONS[index].correctChoiceId,
      })),
      postTestAnswers: post.map((index) => ({
        questionId: POST_TEST_QUESTIONS[index].id,
        selectedChoiceId: POST_TEST_QUESTIONS[index].correctChoiceId,
      })),
    })
    const all = [...Array(10).keys()]
    const evidence = computeEvidenceSummaryFromHistory([
      entry('p01', all, all),
      entry('p02', all, [0, 1, 2, 3]),
    ])

    // Both students are still reported...
    expect(evidence.totalStudents).toBe(2)
    expect(evidence.students).toHaveLength(2)
    // ...but only the one who finished BOTH tests is in the paired averages.
    expect(evidence.prePost.comparedCount).toBe(1)
    expect(evidence.prePost.preAverage).toBe(10)
    expect(evidence.prePost.postAverage).toBe(10)
    // The timed-out student reads as unavailable, never as a zero score.
    const timedOut = evidence.students.find((student) => student.displayName === 'p02')
    expect(timedOut).toMatchObject({ preScore: 10, postScore: null, difference: null })
  })
})
