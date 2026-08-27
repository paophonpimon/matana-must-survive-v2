import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { questionsById } from '../data/questions'
import { getTeacherVisiblePlayer, isCurrentQuestionRevealed } from '../lib/gameFlow'
import { buildLearningWorkbook } from '../lib/learningExport'
import type { Player, Room, RoundHistoryEntry, TeamMagicState } from '../types/game'
import { getTeacherSession, saveTeacherSession } from './sessionStorage'
import {
  DEMO_STORAGE_KEY,
  DemoGameService,
  PRESENTATION_DEMO_PARTICIPANT_ID,
  PRESENTATION_DEMO_ROOM_CODE,
  PRESENTATION_DEMO_TEACHER_ID,
} from './demoService'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

interface StoredDemoRoom {
  room: Room
  players: Record<string, Player>
  magic: Record<string, TeamMagicState>
  magicEvents: Array<{ itemType: string; affectedQuestionIndex: number | null; status: string }>
  roundHistory: Record<string, RoundHistoryEntry>
}

const storedRoom = (roomCode = PRESENTATION_DEMO_ROOM_CODE): StoredDemoRoom => {
  const state = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY) ?? '{"rooms":{}}') as { rooms: Record<string, StoredDemoRoom> }
  const room = state.rooms[roomCode]
  if (!room) throw new Error(`Missing stored demo room ${roomCode}`)
  return room
}

describe('presentation demo mode', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
    // The local demo endpoint is optional. A failed endpoint must fall back to isolated browser
    // storage and, critically, no Firebase URL should ever be contacted.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('is isolated from production persistence and ordinary teacher history', async () => {
    const service = new DemoGameService({ presentation: true })
    const room = await service.resetDemoRoom()

    expect(service.isPresentationDemo).toBe(true)
    expect(room.roomCode).toBe(PRESENTATION_DEMO_ROOM_CODE)
    expect(await service.listTeacherRooms('production-teacher')).toEqual([])
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index))).toEqual([DEMO_STORAGE_KEY])

    const fetchCalls = vi.mocked(fetch).mock.calls.map(([input]) => String(input))
    expect(fetchCalls.every((url) => url === '/__matana_demo_state')).toBe(true)
    expect(fetchCalls.some((url) => /firestore|googleapis|\/rooms/i.test(url))).toBe(false)

    saveTeacherSession({ teacherSessionId: 'real-teacher', roomCode: 'REAL01', role: 'teacher' })
    saveTeacherSession({ teacherSessionId: PRESENTATION_DEMO_TEACHER_ID, roomCode: PRESENTATION_DEMO_ROOM_CODE, role: 'teacher' }, 'presentation-demo')
    expect(getTeacherSession()).toMatchObject({ teacherSessionId: 'real-teacher', roomCode: 'REAL01' })
    expect(getTeacherSession('presentation-demo')).toMatchObject({ teacherSessionId: PRESENTATION_DEMO_TEACHER_ID, roomCode: PRESENTATION_DEMO_ROOM_CODE })
  })

  it('resets to the exact same eight-student, two-team deterministic scenario', async () => {
    const service = new DemoGameService({ presentation: true })
    await service.resetDemoRoom()
    const firstSeed = JSON.stringify(storedRoom())

    await service.startTeamSetup(PRESENTATION_DEMO_ROOM_CODE, PRESENTATION_DEMO_TEACHER_ID)
    await service.startPreTest(PRESENTATION_DEMO_ROOM_CODE, PRESENTATION_DEMO_TEACHER_ID, 120)
    await service.fastForwardDemo(PRESENTATION_DEMO_ROOM_CODE, PRESENTATION_DEMO_TEACHER_ID)
    expect(storedRoom().room.phase).toBe('preTest')

    await service.resetDemoRoom()
    expect(JSON.stringify(storedRoom())).toBe(firstSeed)
    expect(Object.values(storedRoom().players)).toHaveLength(8)
    expect(storedRoom().room.teams).toHaveLength(2)
    expect(storedRoom().room.teamsLocked).toBe(true)
  })

  it('drives the complete real phase model and produces exportable evidence', async () => {
    const service = new DemoGameService({ presentation: true })
    await service.resetDemoRoom()
    const code = PRESENTATION_DEMO_ROOM_CODE
    const teacher = PRESENTATION_DEMO_TEACHER_ID

    await service.startTeamSetup(code, teacher)
    expect(storedRoom().room.phase).toBe('teamSetup')

    await service.startPreTest(code, teacher, 120)
    await service.fastForwardDemo(code, teacher)
    expect(Object.values(storedRoom().players).every((player) => player.preTestProgress === 10)).toBe(true)

    await service.startRecall(code, teacher, 120)
    for (let index = 0; index < 5; index += 1) await service.fastForwardDemo(code, teacher)
    expect(storedRoom().room.recallQuestionIndex).toBe(5)
    expect(Object.values(storedRoom().players).some((player) => player.recallAnswers.some((answer) => answer.selectedChoiceId === '__timeout__'))).toBe(true)

    await service.startRoom(code, teacher, 600, 60)
    for (let index = 0; index < 5; index += 1) await service.fastForwardDemo(code, teacher)
    expect(storedRoom().room.phase).toBe('boss')
    expect(storedRoom().magicEvents.some((event) => event.itemType === 'power_surge' && event.affectedQuestionIndex === 0)).toBe(true)

    for (let index = 0; index < 3; index += 1) await service.fastForwardDemo(code, teacher)
    expect(storedRoom().room.bossAwaitingContinue).toBe(true)
    expect(storedRoom().room.bossWinner?.rewardItemType).toBe('rose_shield')

    await service.continueAfterBoss(code, teacher, 1)
    for (let index = 5; index < 10; index += 1) await service.fastForwardDemo(code, teacher)
    expect(storedRoom().room.phase).toBe('postTest')
    expect(storedRoom().magicEvents.some((event) => event.itemType === 'score_seal' && event.affectedQuestionIndex === 5)).toBe(true)

    await service.startPostTest(code, teacher, 120)
    await service.fastForwardDemo(code, teacher)
    await service.startSurvey(code, teacher)
    await service.fastForwardDemo(code, teacher)
    await service.completeRound(code, teacher)

    const completed = storedRoom()
    expect(completed.room.status).toBe('completed')
    expect(Object.values(completed.players).every((player) => player.postTestProgress === 10)).toBe(true)
    expect(Object.values(completed.players).every((player) => player.surveyResponses.length === 6)).toBe(true)
    expect(Object.values(completed.players).some((player) => player.answers.length < 10)).toBe(true)
    const history = Object.values(completed.roundHistory)
    expect(history).toHaveLength(8)

    const workbookText = new TextDecoder().decode(buildLearningWorkbook(history, { demo: true }))
    expect(workbookText).toContain('ข้อมูลสาธิต')
  })

  it('can deterministically demonstrate the real no-winner Boss resolution', async () => {
    const service = new DemoGameService({ presentation: true })
    const code = PRESENTATION_DEMO_ROOM_CODE
    const teacher = PRESENTATION_DEMO_TEACHER_ID
    await service.resetDemoRoom()
    await service.startTeamSetup(code, teacher)
    await service.startPreTest(code, teacher, 120)
    await service.fastForwardDemo(code, teacher)
    await service.startRecall(code, teacher, 120)
    for (let index = 0; index < 5; index += 1) await service.fastForwardDemo(code, teacher)
    await service.startRoom(code, teacher, 600, 60)
    for (let index = 0; index < 5; index += 1) await service.fastForwardDemo(code, teacher)
    for (let index = 0; index < 3; index += 1) {
      await service.fastForwardDemo(code, teacher, { bossOutcome: 'no-winner' })
    }

    expect(storedRoom().room.bossAwaitingContinue).toBe(true)
    expect(storedRoom().room.bossWinner).toBeNull()
  })

  it('leaves the ordinary demo backend behavior unchanged', async () => {
    const service = new DemoGameService()
    const room = await service.resetDemoRoom()

    expect(service.isPresentationDemo).toBe(false)
    expect(room.roomCode).toBe('MATANA')
    expect(Object.values(storedRoom('MATANA').players)).toHaveLength(3)
    await expect(service.fastForwardDemo('MATANA', 'demo-teacher')).rejects.toThrow('เฉพาะห้องสาธิต')
  })
})

describe('presentation demo — judge student participation', () => {
  const code = PRESENTATION_DEMO_ROOM_CODE
  const teacher = PRESENTATION_DEMO_TEACHER_ID
  const participant = PRESENTATION_DEMO_PARTICIPANT_ID

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // Drive the deterministic scenario up to a live Main question 1 (index 0), the interactive
  // showcase moment, using only the same public service calls the presenter uses. The window is
  // wide open (600s) and the presenter has not advanced the question yet.
  const reachMainQuestionZero = async (service: DemoGameService): Promise<void> => {
    await service.resetDemoRoom()
    await service.startTeamSetup(code, teacher)
    await service.startPreTest(code, teacher, 120)
    await service.fastForwardDemo(code, teacher)
    await service.startRecall(code, teacher, 120)
    for (let index = 0; index < 5; index += 1) await service.fastForwardDemo(code, teacher)
    await service.startRoom(code, teacher, 600, 60)
    expect(storedRoom().room.phase).toBe('main')
    expect(storedRoom().room.currentQuestionIndex).toBe(0)
  }

  const mutateRoom = (mutate: (roomState: { room: Room; players: Record<string, Player> }) => void): void => {
    const state = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY) ?? '{"rooms":{}}') as {
      rooms: Record<string, { room: Room; players: Record<string, Player> }>
    }
    mutate(state.rooms[PRESENTATION_DEMO_ROOM_CODE])
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state))
  }

  const wrongChoiceFor = (questionId: string): string => {
    const question = questionsById.get(questionId)
    if (!question) throw new Error(`missing question ${questionId}`)
    return question.choices.find((choice) => choice.id !== question.correctChoiceId)?.id ?? question.correctChoiceId
  }

  it('lets the interactive participant submit a live Main answer that lands in shared demo state', async () => {
    const service = new DemoGameService({ presentation: true })
    await reachMainQuestionZero(service)
    const room = storedRoom().room
    const questionId = room.questionIds[room.currentQuestionIndex]

    await service.saveAnswer(code, participant, {
      questionId,
      selectedChoiceId: wrongChoiceFor(questionId),
      expectedQuestionIndex: room.currentQuestionIndex,
    })

    const stored = storedRoom().players[participant].answers.find((answer) => answer.questionId === questionId)
    expect(stored?.selectedChoiceId).toBe(wrongChoiceFor(questionId))
    expect(stored?.isCorrect).toBe(false)
  })

  it('does not overwrite an already-submitted interactive answer when the presenter fast-forwards', async () => {
    const service = new DemoGameService({ presentation: true })
    await reachMainQuestionZero(service)
    const index = storedRoom().room.currentQuestionIndex
    const questionId = storedRoom().room.questionIds[index]
    const judgeChoice = wrongChoiceFor(questionId)

    await service.saveAnswer(code, participant, { questionId, selectedChoiceId: judgeChoice, expectedQuestionIndex: index })
    await service.fastForwardDemo(code, teacher)

    // Presenter advanced the room, but the judge's own wrong answer for that question is intact —
    // the seeded fill would have made index 5 correct for player 0.
    const preserved = storedRoom().players[participant].answers.find((answer) => answer.questionId === questionId)
    expect(preserved?.selectedChoiceId).toBe(judgeChoice)
    expect(preserved?.isCorrect).toBe(false)
    expect(storedRoom().room.currentQuestionIndex).toBe(index + 1)
  })

  it('fills the participant deterministically when they did not answer, so the demo never stalls', async () => {
    const service = new DemoGameService({ presentation: true })
    await reachMainQuestionZero(service)
    const index = storedRoom().room.currentQuestionIndex
    const questionId = storedRoom().room.questionIds[index]

    expect(storedRoom().players[participant].answers.some((answer) => answer.questionId === questionId)).toBe(false)
    await service.fastForwardDemo(code, teacher)

    expect(storedRoom().players[participant].answers.some((answer) => answer.questionId === questionId)).toBe(true)
    expect(storedRoom().room.currentQuestionIndex).toBe(index + 1)
  })

  it('rejects a submission for a stale question index after the phase moved on', async () => {
    const service = new DemoGameService({ presentation: true })
    await reachMainQuestionZero(service)
    const staleIndex = storedRoom().room.currentQuestionIndex
    const staleQuestionId = storedRoom().room.questionIds[staleIndex]
    await service.fastForwardDemo(code, teacher)

    await expect(service.saveAnswer(code, participant, {
      questionId: staleQuestionId,
      selectedChoiceId: wrongChoiceFor(staleQuestionId),
      expectedQuestionIndex: staleIndex,
    })).rejects.toThrow()
  })

  it('rejects a submission once the answer window has closed (post-reveal lock)', async () => {
    const service = new DemoGameService({ presentation: true })
    await reachMainQuestionZero(service)
    const index = storedRoom().room.currentQuestionIndex
    const questionId = storedRoom().room.questionIds[index]
    // Force the current question's window to be long expired without advancing the room.
    mutateRoom((roomState) => { roomState.room.questionStartedAt = 1 })

    await expect(service.saveAnswer(code, participant, {
      questionId,
      selectedChoiceId: wrongChoiceFor(questionId),
      expectedQuestionIndex: index,
    })).rejects.toThrow()
  })

  it('keeps the interactive answer hidden from the teacher view until reveal, then shows it', async () => {
    const service = new DemoGameService({ presentation: true })
    await reachMainQuestionZero(service)
    const index = storedRoom().room.currentQuestionIndex
    const questionId = storedRoom().room.questionIds[index]
    await service.saveAnswer(code, participant, { questionId, selectedChoiceId: wrongChoiceFor(questionId), expectedQuestionIndex: index })

    const liveRoom = storedRoom().room
    expect(isCurrentQuestionRevealed(liveRoom, Date.now())).toBe(false)
    const hiddenView = getTeacherVisiblePlayer(liveRoom, storedRoom().players[participant], Date.now())
    expect(hiddenView.answers.some((answer) => answer.questionId === questionId)).toBe(false)

    mutateRoom((roomState) => { roomState.room.questionStartedAt = 1 })
    const revealedRoom = storedRoom().room
    expect(isCurrentQuestionRevealed(revealedRoom, Date.now())).toBe(true)
    const revealedView = getTeacherVisiblePlayer(revealedRoom, storedRoom().players[participant], Date.now())
    expect(revealedView.answers.some((answer) => answer.questionId === questionId)).toBe(true)
  })

  it('clears the interactive answer on a deterministic reset', async () => {
    const service = new DemoGameService({ presentation: true })
    await reachMainQuestionZero(service)
    const index = storedRoom().room.currentQuestionIndex
    const questionId = storedRoom().room.questionIds[index]
    await service.saveAnswer(code, participant, { questionId, selectedChoiceId: wrongChoiceFor(questionId), expectedQuestionIndex: index })
    expect(storedRoom().players[participant].answers.length).toBeGreaterThan(0)

    await service.resetDemoRoom()
    expect(storedRoom().players[participant].answers).toEqual([])
    expect(Object.values(storedRoom().players)).toHaveLength(8)
    expect(storedRoom().room.currentQuestionIndex).toBe(0)
  })

  it('carries the participant’s actual submitted answer into the round-history evidence', async () => {
    const service = new DemoGameService({ presentation: true })
    await reachMainQuestionZero(service)
    const wrongQuestionId = storedRoom().room.questionIds[0]
    // The seeded fill would have made question 1 CORRECT for the participant; the judge answers
    // it wrong by hand instead.
    await service.saveAnswer(code, participant, { questionId: wrongQuestionId, selectedChoiceId: wrongChoiceFor(wrongQuestionId), expectedQuestionIndex: 0 })

    // Finish the round through the normal presenter path (Main 1–5, Boss, Main 6–10, POST, Survey).
    for (let index = 0; index < 5; index += 1) await service.fastForwardDemo(code, teacher)
    expect(storedRoom().room.phase).toBe('boss')
    for (let index = 0; index < 3; index += 1) await service.fastForwardDemo(code, teacher)
    await service.continueAfterBoss(code, teacher, 1)
    for (let index = 5; index < 10; index += 1) await service.fastForwardDemo(code, teacher)
    await service.startPostTest(code, teacher, 120)
    await service.fastForwardDemo(code, teacher)
    await service.startSurvey(code, teacher)
    await service.fastForwardDemo(code, teacher)
    await service.completeRound(code, teacher)

    const history = Object.values(storedRoom().roundHistory) as RoundHistoryEntry[]
    const entry = history.find((item) => item.playerId === participant)
    expect(entry).toBeDefined()
    const recorded = entry?.mainAnswers.find((answer) => answer.questionId === wrongQuestionId)
    expect(recorded?.isCorrect).toBe(false)
  })
})
