import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ASSESSMENT_QUESTION_COUNT, POST_TEST_QUESTIONS, PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { resolveAssessmentStatus } from '../lib/assessmentClock'
import { computeEvidenceSummaryFromHistory } from '../lib/evidenceSummary'
import { getAssessmentDeadline, getAssessmentRemainingMilliseconds, isAssessmentExpired, isAssessmentOpen, preTestWindow } from '../lib/gameFlow'
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

  it('reports all four per-student statuses', () => {
    expect(resolveAssessmentStatus(0, false)).toBe('ยังไม่เริ่ม')
    expect(resolveAssessmentStatus(4, false)).toBe('กำลังทำ')
    expect(resolveAssessmentStatus(ASSESSMENT_QUESTION_COUNT, false)).toBe('เสร็จแล้ว')
    // Unfinished + expired is timed out, not merely "in progress".
    expect(resolveAssessmentStatus(4, true)).toBe('หมดเวลา')
    // Finishing before the buzzer still reads as done, even once the clock runs out.
    expect(resolveAssessmentStatus(ASSESSMENT_QUESTION_COUNT, true)).toBe('เสร็จแล้ว')
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

  it('gives every question the full time, restarting from the previous answer', async () => {
    const { service, code, alpha, liveRoom, players, stop } = await setup()
    await service.startPreTest(code, 'teacher-1', 30)
    await vi.waitFor(() => expect(liveRoom.value?.preTestStartedAt).toBeTruthy())
    const room = liveRoom.value as Room

    // Question 1 runs from the instant the teacher opened the test (plus the phase intro).
    expect(getAssessmentDeadline(preTestWindow(room, [])))
      .toBe((room.preTestStartedAt as number) + PHASE_INTRO_MILLISECONDS + 30_000)

    await service.savePreTestAnswer(code, alpha.id, answer(PRE_TEST_QUESTIONS, 0))
    await vi.waitFor(() => expect(players.value.find((p) => p.id === alpha.id)?.preTestAnswers).toHaveLength(1))
    const saved = players.value.find((p) => p.id === alpha.id) as Player

    // Question 2 restarts from when question 1 was answered — a full 30s again, with no intro
    // offset and nothing carried over from how long question 1 took.
    const second = preTestWindow(room, saved.preTestAnswers)
    expect(second.introOffsetMs).toBe(0)
    expect(getAssessmentDeadline(second)).toBe(saved.preTestAnswers[0].answeredAt + 30_000)
    expect(getAssessmentRemainingMilliseconds(second, saved.preTestAnswers[0].answeredAt)).toBe(30_000)
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
    vi.setSystemTime(new Date((getAssessmentDeadline(preTestWindow(room, current.preTestAnswers)) as number) + 1_000))
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
