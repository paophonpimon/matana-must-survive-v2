import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { questionsById } from '../data/questions'
import type { Player, Room } from '../types/game'
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
  player: Player,
  questionIndex: number,
  correct: boolean,
): Promise<void> => {
  const question = questionsById.get(room.questionIds[questionIndex])
  if (!question) throw new Error('Missing test question')
  const wrongChoice = question.choices.find((choice) => choice.id !== question.correctChoiceId)
  await service.saveAnswer(room.roomCode, player.id, {
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

  it('creates a room, trims joins, rejects duplicate student numbers, and shares one 10-question order', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const first = await service.joinRoom({ roomCode: ` ${room.roomCode} `, displayName: ' Alpha ', studentNumber: ' 01 ' }, 'owner-1')
    const second = await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')

    expect(room.questionIds).toHaveLength(10)
    expect(first.room.questionIds).toEqual(room.questionIds)
    expect(second.room.questionIds).toEqual(room.questionIds)
    expect(first.player.displayName).toBe('Alpha')
    expect(first.player.studentNumber).toBe('01')
    expect(first.player.teamId).toBeNull()
    // A different owner reusing the same student number is rejected, and must never come
    // back with Alpha's own record.
    await expect(service.joinRoom({ roomCode: room.roomCode, displayName: 'Impostor', studentNumber: ' 01 ' }, 'owner-3')).rejects.toThrow('เลขที่นักเรียนนี้ถูกใช้แล้ว')
  })

  it('restores the same player on refresh/reconnect (same owner, same student number)', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const joined = await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')

    const livePlayer: { value: Player | null } = { value: null }
    const stopPlayer = service.subscribePlayer(room.roomCode, joined.player.id, (value) => { livePlayer.value = value })
    await vi.waitFor(() => expect(livePlayer.value?.teamId).toBeTruthy())
    const assignedTeamId = livePlayer.value?.teamId
    stopPlayer()

    const reconnected = await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
    expect(reconnected.player.id).toBe(joined.player.id)
    expect(reconnected.player.teamId).toBe(assignedTeamId)
  })

  it('blocks a genuinely new join after teams are locked, but never blocks a returning player', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const existing = await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')

    await expect(service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).rejects.toThrow('ทีมถูกล็อกแล้ว')
    const reconnected = await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
    expect(reconnected.player.id).toBe(existing.player.id)
  })

  it('randomizeTeams distributes evenly and is all-or-nothing with lockTeams gating start', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    for (let index = 0; index < 5; index += 1) {
      await service.joinRoom({ roomCode: room.roomCode, displayName: `P${index}`, studentNumber: `${index}` }, `owner-${index}`)
    }
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)

    const players: { value: Player[] } = { value: [] }
    const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
    await vi.waitFor(() => {
      expect(players.value).toHaveLength(5)
      expect(players.value.every((player) => player.teamId != null)).toBe(true)
    })
    const counts = new Map<string, number>()
    for (const player of players.value) counts.set(player.teamId as string, (counts.get(player.teamId as string) ?? 0) + 1)
    expect([...counts.values()].sort()).toEqual([2, 3])
    stopPlayers()

    // Cannot start until locked.
    await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).rejects.toThrow('กรุณาล็อกทีมก่อนเริ่มภารกิจ')
    await service.lockTeams(room.roomCode, 'teacher-1')
    await service.startRoom(room.roomCode, 'teacher-1', 30)
    const liveRoom: { value: Room | null } = { value: null }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(liveRoom.value?.status).toBe('playing'))
    stopRoom()
  })

  it('lockTeams rejects unassigned players; unlockTeams allows re-randomizing', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
    await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
    await service.joinRoom({ roomCode: room.roomCode, displayName: 'Gamma', studentNumber: '03' }, 'owner-3')
    await expect(service.lockTeams(room.roomCode, 'teacher-1')).rejects.toThrow('กรุณาสุ่มทีมก่อนล็อกทีม')

    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
    await service.lockTeams(room.roomCode, 'teacher-1')
    await expect(service.randomizeTeams(room.roomCode, 'teacher-1', 3)).rejects.toThrow('ปลดล็อกทีมก่อนสุ่มใหม่')

    await service.unlockTeams(room.roomCode, 'teacher-1')
    await service.randomizeTeams(room.roomCode, 'teacher-1', 3)
    await service.lockTeams(room.roomCode, 'teacher-1')
    const liveRoom: { value: Room | null } = { value: null }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    expect(liveRoom.value?.teamCount).toBe(3)
    stopRoom()
  })

  it('randomizeTeams rejects zero players and a team count larger than the player count', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    await expect(service.randomizeTeams(room.roomCode, 'teacher-1', 1)).rejects.toThrow('ยังไม่มีผู้เล่นเข้าร่วม')

    await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
    await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
    await expect(service.randomizeTeams(room.roomCode, 'teacher-1', 3)).rejects.toThrow('จำนวนทีมต้องไม่เกินจำนวนผู้เล่น')

    // Exactly as many teams as players is the boundary and must succeed.
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
    const liveRoom: { value: Room | null } = { value: null }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(liveRoom.value?.teamCount).toBe(2))
    stopRoom()
  })

  it('lockTeams locks first, then reverts and rejects if a player joined unassigned before the re-check — existing players can still reconnect meanwhile', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)

    // Beta joins after randomizeTeams ran, so Beta is unassigned (teamId: null) — simulating
    // a student who completes joining right before the teacher locks. Since teams.length > 0
    // and the room is still 'waiting' and unlocked, this join is legitimately accepted.
    await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')

    await expect(service.lockTeams(room.roomCode, 'teacher-1')).rejects.toThrow('มีผู้เล่นบางคนยังไม่ได้จัดทีม กรุณาสุ่มทีมอีกครั้ง')

    // The failed lock attempt must revert teamsLocked back to false, not leave the room
    // stuck locked with an unassigned player.
    const liveRoom: { value: Room | null } = { value: null }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(false))
    stopRoom()

    // Alpha (already assigned) can still reconnect while the room sits in this reverted state.
    const reconnectedAlpha = await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
    expect(reconnectedAlpha.player.id).toBe(alpha.id)
    expect(reconnectedAlpha.player.teamId).not.toBeNull()

    // The teacher can re-randomize (now covering Beta) and lock successfully.
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')
    const relockedRoom: { value: Room | null } = { value: null }
    const stopRelocked = service.subscribeRoom(room.roomCode, (value) => { relockedRoom.value = value })
    await vi.waitFor(() => expect(relockedRoom.value?.teamsLocked).toBe(true))
    stopRelocked()
  })

  it('keeps every player on the shared question until the teacher timer advances it, one answer per player per question', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const first = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'First', studentNumber: '01' }, 'owner-1')).player
    const second = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Second', studentNumber: '02' }, 'owner-2')).player
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')
    await service.startRoom(room.roomCode, 'teacher-1', 60)

    await answerAt(service, room, first, 0, true)
    await answerAt(service, room, first, 0, false)
    await answerAt(service, room, first, 0, true)
    await answerAt(service, room, second, 0, false)

    const liveRoom: { value: Room | null } = { value: null }
    const liveFirst: { value: Player | null } = { value: null }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    const stopFirst = service.subscribePlayer(room.roomCode, first.id, (value) => { liveFirst.value = value })
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
    const player = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Late', studentNumber: '01' }, 'owner-1')).player
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')
    await service.startRoom(room.roomCode, 'teacher-1', 5)
    const liveRoom: { value: Room | null } = { value: null }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(typeof liveRoom.value?.questionStartedAt).toBe('number'))
    await answerAt(service, room, player, 0, false)
    vi.spyOn(Date, 'now').mockReturnValue((liveRoom.value?.questionStartedAt ?? 0) + 5_001)

    await expect(answerAt(service, room, player, 0, true)).rejects.toThrow('หมดเวลา')
    stopRoom()
  })

  it('completes after ten timed questions and scores every player independently', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const high = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'High', studentNumber: '01' }, 'owner-1')).player
    const low = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Low', studentNumber: '02' }, 'owner-2')).player
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')
    await service.startRoom(room.roomCode, 'teacher-1', 60)

    for (let index = 0; index < room.questionIds.length; index += 1) {
      await answerAt(service, room, high, index, index < 9)
      if (index < 4) await answerAt(service, room, low, index, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', index)
    }

    const liveRoom: { value: Room | null } = { value: null }
    const players: { value: Player[] } = { value: [] }
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
    const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
    await vi.waitFor(() => {
      expect(liveRoom.value).toMatchObject({ status: 'completed', currentQuestionIndex: 10, winner: null })
      expect(players.value.every((player) => player.submitted && player.status === 'submitted')).toBe(true)
    })
    expect(players.value.find((player) => player.id === high.id)?.score).toBe(9)
    expect(players.value.find((player) => player.id === low.id)?.score).toBe(4)
    stopRoom()
    stopPlayers()
  })

  it('rejects invalid choices, then resets scores while retaining players and team assignment', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const player = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Reset', studentNumber: '01' }, 'owner-1')).player
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')
    await service.startRoom(room.roomCode, 'teacher-1', 30)
    const firstQuestion = questionsById.get(room.questionIds[0])
    if (!firstQuestion) throw new Error('Missing first question')
    await expect(service.saveAnswer(room.roomCode, player.id, {
      questionId: firstQuestion.id,
      selectedChoiceId: 'invalid-choice',
      expectedQuestionIndex: 0,
    })).rejects.toThrow()
    await answerAt(service, room, player, 0, true)
    for (let index = 0; index < 10; index += 1) await service.advanceQuestion(room.roomCode, 'teacher-1', index)
    await service.prepareNextRound(room.roomCode, 'teacher-1')

    const resetPlayer: { value: Player | null } = { value: null }
    const resetRoom: { value: Room | null } = { value: null }
    const stopPlayer = service.subscribePlayer(room.roomCode, player.id, (value) => { resetPlayer.value = value })
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { resetRoom.value = value })
    await vi.waitFor(() => {
      expect(resetRoom.value).toMatchObject({ currentRound: 2, status: 'waiting', currentQuestionIndex: 0, questionStartedAt: null, teamsLocked: true })
      expect(resetPlayer.value).toMatchObject({ id: player.id, score: 0, currentQuestionIndex: 0, answers: [], submitted: false, status: 'waiting', teamId: 'team-1' })
    })
    stopPlayer()
    stopRoom()
  })

  it('lets the teacher stop a stuck round and returns every existing player to a clean lobby', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const player = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Recovery', studentNumber: '01' }, 'owner-1')).player
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')
    await service.startRoom(room.roomCode, 'teacher-1', 30)
    await answerAt(service, room, player, 0, true)
    await expect(service.stopRound(room.roomCode, 'wrong-teacher')).rejects.toThrow()
    await service.stopRound(room.roomCode, 'teacher-1')

    const resetPlayer: { value: Player | null } = { value: null }
    const resetRoom: { value: Room | null } = { value: null }
    const stopPlayer = service.subscribePlayer(room.roomCode, player.id, (value) => { resetPlayer.value = value })
    const stopRoom = service.subscribeRoom(room.roomCode, (value) => { resetRoom.value = value })
    await vi.waitFor(() => {
      expect(resetRoom.value).toMatchObject({ status: 'waiting', currentRound: 2, currentQuestionIndex: 0, questionStartedAt: null })
      expect(resetPlayer.value).toMatchObject({ id: player.id, status: 'waiting', score: 0, answers: [], submitted: false })
    })
    stopPlayer()
    stopRoom()
  })

  it('resetDemoRoom seeds players whose ids match their studentNumber, so reconnect works for the seeded demo dataset too', async () => {
    const service = new DemoGameService()
    const seededRoom = await service.resetDemoRoom()
    await service.randomizeTeams(seededRoom.roomCode, 'demo-teacher', 2)
    await service.lockTeams(seededRoom.roomCode, 'demo-teacher')

    // A seeded demo student reconnecting by their own studentNumber+ownerUid must find their
    // existing seed record — not fall through to the "new player" path and get rejected by
    // the late-join guard, which is exactly the bug a mismatched seed id would cause.
    const reconnected = await service.joinRoom(
      { roomCode: seededRoom.roomCode, displayName: 'พิมพ์ชนก', studentNumber: '01' },
      'demo-student-1',
    )
    expect(reconnected.player.teamId).not.toBeNull()
  })

  it('rejects missing and closed rooms and resets the MATANA demo room', async () => {
    const service = new DemoGameService()
    await expect(service.joinRoom({ roomCode: 'ABC234', displayName: 'No room', studentNumber: '01' }, 'owner-1')).rejects.toThrow()
    const room = await service.createRoom('teacher-1')
    await service.closeRoom(room.roomCode, 'teacher-1')
    await expect(service.joinRoom({ roomCode: room.roomCode, displayName: 'Closed', studentNumber: '01' }, 'owner-1')).rejects.toThrow()

    await service.closeRoom('MATANA', 'demo-teacher')
    const resetRoom = await service.resetDemoRoom()
    expect(resetRoom).toMatchObject({ roomCode: 'MATANA', status: 'waiting', currentRound: 1, currentQuestionIndex: 0, winner: null, teamsLocked: false })
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
    const joined = await studentService.joinRoom({ roomCode: room.roomCode, displayName: 'Separate browser', studentNumber: '01' }, 'owner-cross-context')

    expect(joined.room.roomCode).toBe(room.roomCode)
    expect(joined.player.displayName).toBe('Separate browser')
  })
})
