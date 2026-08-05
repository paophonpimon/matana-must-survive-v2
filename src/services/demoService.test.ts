import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { questionsById } from '../data/questions'
import type { Room, Team } from '../types/game'
import { DemoGameService } from './demoService'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

const answerAt = async (
  service: DemoGameService,
  room: Room,
  team: Team,
  questionIndex: number,
  correct: boolean,
): Promise<void> => {
  const question = questionsById.get(room.questionIds[questionIndex])
  if (!question) throw new Error('Missing test question')
  const wrongChoice = question.choices.find((choice) => choice.id !== question.correctChoiceId)
  await service.saveAnswer(room.roomCode, team.id, {
    questionId: question.id,
    selectedChoiceId: correct ? question.correctChoiceId : (wrongChoice?.id ?? ''),
    expectedQuestionIndex: questionIndex,
  })
}

describe('Demo timed classroom flow', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('creates a room, trims joins, rejects duplicate names, and shares one 10-question order', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const first = await service.joinRoom({ roomCode: ` ${room.roomCode} `, teamName: ' Alpha ', guardianName: ' One ' }, 'owner-1')
    const second = await service.joinRoom({ roomCode: room.roomCode, teamName: 'Beta', guardianName: 'Two' }, 'owner-2')

    expect(room.questionIds).toHaveLength(10)
    expect(first.room.questionIds).toEqual(room.questionIds)
    expect(second.room.questionIds).toEqual(room.questionIds)
    expect(first.team.teamName).toBe('Alpha')
    expect(first.team.guardianName).toBe('One')
    await expect(service.joinRoom({ roomCode: room.roomCode, teamName: ' alpha ', guardianName: 'Other' }, 'owner-3')).rejects.toThrow()
  })

  it('keeps every team on the shared question until the teacher timer advances it', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const first = (await service.joinRoom({ roomCode: room.roomCode, teamName: 'First', guardianName: 'One' }, 'owner-1')).team
    const second = (await service.joinRoom({ roomCode: room.roomCode, teamName: 'Second', guardianName: 'Two' }, 'owner-2')).team
    await service.startRoom(room.roomCode, 'teacher-1', 60)

    await answerAt(service, room, first, 0, true)
    await answerAt(service, room, first, 0, false)
    await answerAt(service, room, first, 0, true)
    await answerAt(service, room, second, 0, false)

    const liveRoom: { value: Room | null } = { value: null }
    const liveFirst: { value: Team | null } = { value: null }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    const stopFirst = service.subscribeTeam(room.roomCode, first.id, (value) => { liveFirst.value = value })
    await vi.waitFor(() => {
      expect(liveRoom.value?.currentQuestionIndex).toBe(0)
      expect(liveFirst.value).toMatchObject({ score: 1 })
      expect(liveFirst.value?.answers).toHaveLength(1)
    })
    expect(liveRoom.value?.winner).toBeNull()

    await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
    await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(1))
    stopRoom()
    stopFirst()
  })

  it('rejects late answers after the shared deadline', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const team = (await service.joinRoom({ roomCode: room.roomCode, teamName: 'Late', guardianName: 'One' }, 'owner-1')).team
    await service.startRoom(room.roomCode, 'teacher-1', 5)
    const liveRoom: { value: Room | null } = { value: null }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(typeof liveRoom.value?.questionStartedAt).toBe('number'))
    await answerAt(service, room, team, 0, false)
    vi.spyOn(Date, 'now').mockReturnValue((liveRoom.value?.questionStartedAt ?? 0) + 5_001)

    await expect(answerAt(service, room, team, 0, true)).rejects.toThrow('หมดเวลา')
    stopRoom()
  })

  it('completes after ten timed questions, keeps no speed winner, and submits every team with its own score', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const high = (await service.joinRoom({ roomCode: room.roomCode, teamName: 'High', guardianName: 'One' }, 'owner-1')).team
    const low = (await service.joinRoom({ roomCode: room.roomCode, teamName: 'Low', guardianName: 'Two' }, 'owner-2')).team
    await service.startRoom(room.roomCode, 'teacher-1', 60)

    for (let index = 0; index < room.questionIds.length; index += 1) {
      await answerAt(service, room, high, index, index < 9)
      if (index < 4) await answerAt(service, room, low, index, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', index)
    }

    const liveRoom: { value: Room | null } = { value: null }
    const teams: { value: Team[] } = { value: [] }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    const stopTeams = service.subscribeTeams(room.roomCode, (value) => { teams.value = value })
    await vi.waitFor(() => {
      expect(liveRoom.value).toMatchObject({ status: 'completed', currentQuestionIndex: 10, winner: null })
      expect(teams.value.every((team) => team.submitted && team.status === 'submitted')).toBe(true)
    })
    expect(teams.value.find((team) => team.id === high.id)?.score).toBe(9)
    expect(teams.value.find((team) => team.id === low.id)?.score).toBe(4)
    stopRoom()
    stopTeams()
  })

  it('rejects invalid choices, then resets scores while retaining teams', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const team = (await service.joinRoom({ roomCode: room.roomCode, teamName: 'Reset', guardianName: 'One' }, 'owner-1')).team
    await service.startRoom(room.roomCode, 'teacher-1', 30)
    const firstQuestion = questionsById.get(room.questionIds[0])
    if (!firstQuestion) throw new Error('Missing first question')
    await expect(service.saveAnswer(room.roomCode, team.id, {
      questionId: firstQuestion.id,
      selectedChoiceId: 'invalid-choice',
      expectedQuestionIndex: 0,
    })).rejects.toThrow()
    await answerAt(service, room, team, 0, true)
    for (let index = 0; index < 10; index += 1) await service.advanceQuestion(room.roomCode, 'teacher-1', index)
    await service.prepareNextRound(room.roomCode, 'teacher-1')

    const resetTeam: { value: Team | null } = { value: null }
    const resetRoom: { value: Room | null } = { value: null }
    const stopTeam = service.subscribeTeam(room.roomCode, team.id, (value) => { resetTeam.value = value })
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { resetRoom.value = value })
    await vi.waitFor(() => {
      expect(resetRoom.value).toMatchObject({ currentRound: 2, status: 'waiting', currentQuestionIndex: 0, questionStartedAt: null })
      expect(resetTeam.value).toMatchObject({ id: team.id, score: 0, currentQuestionIndex: 0, answers: [], submitted: false, status: 'waiting' })
    })
    stopTeam()
    stopRoom()
  })

  it('lets the teacher stop a stuck round and returns every existing team to a clean lobby', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const team = (await service.joinRoom({ roomCode: room.roomCode, teamName: 'Recovery', guardianName: 'One' }, 'owner-1')).team
    await service.startRoom(room.roomCode, 'teacher-1', 30)
    await answerAt(service, room, team, 0, true)
    await expect(service.stopRound(room.roomCode, 'wrong-teacher')).rejects.toThrow()
    await service.stopRound(room.roomCode, 'teacher-1')

    const resetTeam: { value: Team | null } = { value: null }
    const resetRoom: { value: Room | null } = { value: null }
    const stopTeam = service.subscribeTeam(room.roomCode, team.id, (value) => { resetTeam.value = value })
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { resetRoom.value = value })
    await vi.waitFor(() => {
      expect(resetRoom.value).toMatchObject({ status: 'waiting', currentRound: 2, currentQuestionIndex: 0, questionStartedAt: null })
      expect(resetTeam.value).toMatchObject({ id: team.id, status: 'waiting', score: 0, answers: [], submitted: false })
    })
    stopTeam()
    stopRoom()
  })

  it('rejects missing and closed rooms and resets the MATANA demo room', async () => {
    const service = new DemoGameService()
    await expect(service.joinRoom({ roomCode: 'ABC234', teamName: 'No room', guardianName: 'One' }, 'owner-1')).rejects.toThrow()
    const room = await service.createRoom('teacher-1')
    await service.closeRoom(room.roomCode, 'teacher-1')
    await expect(service.joinRoom({ roomCode: room.roomCode, teamName: 'Closed', guardianName: 'One' }, 'owner-1')).rejects.toThrow()

    await service.closeRoom('MATANA', 'demo-teacher')
    const resetRoom = await service.resetDemoRoom()
    expect(resetRoom).toMatchObject({ roomCode: 'MATANA', status: 'waiting', currentRound: 1, currentQuestionIndex: 0, winner: null })
  })

  it('shares a custom demo room across isolated browser storage contexts', async () => {
    let sharedState: unknown = null
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        sharedState = JSON.parse(String(init.body)) as unknown
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ state: sharedState }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    const teacherService = new DemoGameService()
    const room = await teacherService.createRoom('teacher-cross-context')
    vi.stubGlobal('localStorage', new MemoryStorage())
    const studentService = new DemoGameService()
    const joined = await studentService.joinRoom({ roomCode: room.roomCode, teamName: 'Separate browser', guardianName: 'Student' }, 'owner-cross-context')

    expect(joined.room.roomCode).toBe(room.roomCode)
    expect(joined.team.teamName).toBe('Separate browser')
  })
})
