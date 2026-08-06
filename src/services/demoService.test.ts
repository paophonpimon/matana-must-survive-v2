import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { questionsById } from '../data/questions'
import { computeTeamCompetitionStats } from '../lib/magic'
import type { AnswerProgressEntry, MagicEvent, Player, Room, TeamMagicState, TeamRosterSummary } from '../types/game'
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

const getHolderId = async (service: DemoGameService, roomCode: string, teamId: string): Promise<string> => {
  const magic: { value: TeamMagicState | null } = { value: null }
  const stop = service.subscribeTeamMagic(roomCode, teamId, (value) => { magic.value = value })
  // Deliberately toBeTruthy(), not not.toBeNull(): magic.value starts out `null`, so
  // magic.value?.magicHolderPlayerId is `undefined` before the first real snapshot arrives —
  // and undefined !== null, so not.toBeNull() would pass vacuously before any data loads.
  await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBeTruthy())
  const holderId = magic.value?.magicHolderPlayerId as string
  stop()
  return holderId
}

// startRoom requires every team's holder to have chosen a starting item — this drives every
// currently-empty team's holder to pick มนตร์ทวีพลัง (power_surge) so pre-existing flow tests
// that only care about the normal answer/scoring path can reach 'playing' without needing to
// individually think about magic items.
const chooseAllStartingItems = async (service: DemoGameService, roomCode: string): Promise<void> => {
  const magic: { value: TeamMagicState[] } = { value: [] }
  const stop = service.subscribeAllTeamMagic(roomCode, (value) => { magic.value = value })
  await vi.waitFor(() => expect(magic.value.length).toBeGreaterThan(0))
  for (const team of magic.value) {
    if (team.magicHolderPlayerId && team.inventory.length === 0) {
      await service.chooseStartingItem(roomCode, team.teamId, team.magicHolderPlayerId, 'power_surge')
    }
  }
  stop()
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
    await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).rejects.toThrow('ทุกทีมต้องเลือกไอเทมเริ่มต้นก่อนเริ่มภารกิจ')
    await chooseAllStartingItems(service, room.roomCode)
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
    await chooseAllStartingItems(service, room.roomCode)
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
    await chooseAllStartingItems(service, room.roomCode)
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
    await chooseAllStartingItems(service, room.roomCode)
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
    await chooseAllStartingItems(service, room.roomCode)
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
    await chooseAllStartingItems(service, room.roomCode)
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

  describe('Magic items', () => {
    it('selects exactly one holder per team, each a real member of that team', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      for (let index = 0; index < 6; index += 1) {
        await service.joinRoom({ roomCode: room.roomCode, displayName: `P${index}`, studentNumber: `${index}` }, `owner-${index}`)
      }
      await service.randomizeTeams(room.roomCode, 'teacher-1', 3)
      await service.lockTeams(room.roomCode, 'teacher-1')

      const magic: { value: TeamMagicState[] } = { value: [] }
      const players: { value: Player[] } = { value: [] }
      const stopMagic = service.subscribeAllTeamMagic(room.roomCode, (value) => { magic.value = value })
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      await vi.waitFor(() => {
        expect(magic.value).toHaveLength(3)
        expect(magic.value.every((team) => team.magicHolderPlayerId != null)).toBe(true)
      })
      for (const team of magic.value) {
        const holder = players.value.find((player) => player.id === team.magicHolderPlayerId)
        expect(holder?.teamId).toBe(team.teamId)
      }
      stopMagic()
      stopPlayers()
    })

    it('rejects activation from a player who is not the holder', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      // toBeTruthy(), not not.toBeNull(): magic.value starts null, so the optional-chained
      // read is undefined (not null) before the first snapshot — not.toBeNull() would pass
      // vacuously on that empty render instead of waiting for real holder data.
      await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBeTruthy())
      const holderId = magic.value?.magicHolderPlayerId
      const nonHolder = [alpha, beta].find((player) => player.id !== holderId)
      stop()

      await expect(service.chooseStartingItem(room.roomCode, 'team-1', nonHolder?.id ?? '', 'power_surge'))
        .rejects.toThrow('คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')
    })

    it('lets the holder choose exactly one starting item — a second choice is rejected', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')

      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'rose_shield')
      await expect(service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge'))
        .rejects.toThrow('ทีมนี้เลือกไอเทมเริ่มต้นไปแล้ว')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.inventory).toHaveLength(1))
      expect(magic.value?.inventory[0].itemType).toBe('rose_shield')
      stop()
    })

    it('rejects a duplicate activation while one is already queued, and logs it as a rejected event', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')

      await service.activateItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await expect(service.activateItem(room.roomCode, 'team-1', holderId, 'power_surge'))
        .rejects.toThrow('ทีมนี้มีไอเทมที่กำลังรอผลอยู่แล้ว')

      const events: { value: MagicEvent[] } = { value: [] }
      const stop = service.subscribeMagicEvents(room.roomCode, (value) => { events.value = value })
      await vi.waitFor(() => expect(events.value.some((event) => event.status === 'rejected')).toBe(true))
      stop()
    })

    it('rejects an invalid hostile target (self, or a team already targeted this question)', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Gamma', studentNumber: '03' }, 'owner-3')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 3)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holder1 = await getHolderId(service, room.roomCode, 'team-1')
      const holder2 = await getHolderId(service, room.roomCode, 'team-2')
      await service.chooseStartingItem(room.roomCode, 'team-1', holder1, 'score_seal')
      await service.chooseStartingItem(room.roomCode, 'team-2', holder2, 'score_seal')

      await expect(service.activateItem(room.roomCode, 'team-1', holder1, 'score_seal', 'team-1'))
        .rejects.toThrow('เลือกทีมตัวเองเป็นเป้าหมายไม่ได้')
      await expect(service.activateItem(room.roomCode, 'team-1', holder1, 'score_seal'))
        .rejects.toThrow('กรุณาเลือกทีมเป้าหมาย')

      // team-1 successfully targets team-3 for question index 1 (the lobby's next-eligible
      // question) — team-2 then can't also target team-3 for the same question.
      await service.activateItem(room.roomCode, 'team-1', holder1, 'score_seal', 'team-3')
      await expect(service.activateItem(room.roomCode, 'team-2', holder2, 'score_seal', 'team-3'))
        .rejects.toThrow('ทีมเป้าหมายถูกใช้ไอเทมฝ่ายตรงข้ามในข้อนี้ไปแล้ว')
    })

    it('applies a 150% own-team multiplier and a 50% hostile multiplier, leaves individual raw scores untouched, and the competition score is reproducible from the event log', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const p2 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      const p3 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Gamma', studentNumber: '03' }, 'owner-3')).player
      await service.randomizeTeams(room.roomCode, 'teacher-1', 3)
      await service.lockTeams(room.roomCode, 'teacher-1')

      // 3 players over 3 teams always splits one-each, but *which* label each player lands on
      // depends on the shuffle — read it back rather than assuming p1/p2/p3 map to
      // team-1/team-2/team-3 in order. With one member per team, that sole member is
      // necessarily the holder.
      const teamLookup: { value: Player[] } = { value: [] }
      const stopTeamLookup = service.subscribePlayers(room.roomCode, (value) => { teamLookup.value = value })
      // .every() on an empty array is vacuously true, so also require a non-empty length —
      // otherwise this resolves before subscribePlayers delivers its first real snapshot.
      await vi.waitFor(() => {
        expect(teamLookup.value.length).toBe(3)
        expect(teamLookup.value.every((player) => player.teamId != null)).toBe(true)
      })
      const teamOf = (playerId: string): string => teamLookup.value.find((player) => player.id === playerId)?.teamId as string
      const team1 = teamOf(p1.id)
      const team2 = teamOf(p2.id)
      const team3 = teamOf(p3.id)
      stopTeamLookup()

      const holder1 = await getHolderId(service, room.roomCode, team1)
      const holder2 = await getHolderId(service, room.roomCode, team2)
      const holder3 = await getHolderId(service, room.roomCode, team3)
      await service.chooseStartingItem(room.roomCode, team1, holder1, 'power_surge')
      await service.chooseStartingItem(room.roomCode, team2, holder2, 'score_seal')
      await service.chooseStartingItem(room.roomCode, team3, holder3, 'power_surge')

      // Both activated from the lobby, so both target question index 1 (question 2).
      await service.activateItem(room.roomCode, team1, holder1, 'power_surge')
      await service.activateItem(room.roomCode, team2, holder2, 'score_seal', team3)

      await chooseAllStartingItems(service, room.roomCode) // no-op: all three already chosen
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      // Question index 0: no queued effect targets it — answer it and move past.
      await answerAt(service, room, p1, 0, true)
      await answerAt(service, room, p2, 0, true)
      await answerAt(service, room, p3, 0, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      // Question index 1: the targeted question. team-1 (p1) answers correctly (raw 1, x1.5);
      // team-3 (p3) answers correctly too (raw 1, x0.5 from team-2's un-shielded score_seal).
      await answerAt(service, room, p1, 1, true)
      await answerAt(service, room, p3, 1, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 1)

      const players: { value: Player[] } = { value: [] }
      const events: { value: MagicEvent[] } = { value: [] }
      const liveRoom: { value: Room | null } = { value: null }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      const stopEvents = service.subscribeMagicEvents(room.roomCode, (value) => { events.value = value })
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => {
        expect(events.value.filter((event) => event.status === 'applied')).toHaveLength(2)
      })

      // Individual raw scores are exactly what plain correct-answer counting produces —
      // magic never touched them.
      expect(players.value.find((player) => player.id === p1.id)?.score).toBe(2)
      expect(players.value.find((player) => player.id === p3.id)?.score).toBe(2)

      const teams = liveRoom.value?.teams ?? []
      const questionIds = liveRoom.value?.questionIds ?? []
      const computeOnce = (): unknown => computeTeamCompetitionStats(players.value, teams, questionIds, events.value)
      const first = computeOnce()
      const second = computeOnce()
      expect(first).toEqual(second) // reproducible from the event log alone

      const stats = first as ReturnType<typeof computeTeamCompetitionStats>
      // p1's team: q0 raw 1 (no multiplier) + q1 raw 1 * 1.5 = 2.5
      expect(stats.find((team) => team.id === team1)?.competitionTotal).toBeCloseTo(2.5)
      // p3's team: q0 raw 1 (no multiplier) + q1 raw 1 * 0.5 = 1.5 (hostile applied, no shield)
      expect(stats.find((team) => team.id === team3)?.competitionTotal).toBeCloseTo(1.5)

      stopPlayers()
      stopEvents()
      stopRoom()
    })

    it('a shield blocks a hostile effect and is consumed by it; the target keeps full raw competition points', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const p2 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holder1 = await getHolderId(service, room.roomCode, 'team-1')
      const holder2 = await getHolderId(service, room.roomCode, 'team-2')
      await service.chooseStartingItem(room.roomCode, 'team-1', holder1, 'score_seal')
      await service.chooseStartingItem(room.roomCode, 'team-2', holder2, 'rose_shield')
      await service.activateItem(room.roomCode, 'team-1', holder1, 'score_seal', 'team-2')
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      await answerAt(service, room, p1, 0, true)
      await answerAt(service, room, p2, 0, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      await answerAt(service, room, p1, 1, true)
      await answerAt(service, room, p2, 1, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 1)

      const events: { value: MagicEvent[] } = { value: [] }
      const magic: { value: TeamMagicState | null } = { value: null }
      const players: { value: Player[] } = { value: [] }
      const liveRoom: { value: Room | null } = { value: null }
      const stopEvents = service.subscribeMagicEvents(room.roomCode, (value) => { events.value = value })
      const stopMagic = service.subscribeTeamMagic(room.roomCode, 'team-2', (value) => { magic.value = value })
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => {
        expect(events.value.find((event) => event.itemType === 'score_seal')?.status).toBe('blocked')
      })
      expect(magic.value?.inventory.find((item) => item.itemType === 'rose_shield')?.consumed).toBe(true)

      const stats = computeTeamCompetitionStats(players.value, liveRoom.value?.teams ?? [], liveRoom.value?.questionIds ?? [], events.value)
      // team-2's q1 raw point is untouched by the blocked hostile effect (multiplier stays 1).
      expect(stats.find((team) => team.id === 'team-2')?.competitionTotal).toBe(2)

      stopEvents()
      stopMagic()
      stopPlayers()
      stopRoom()
    })

    it('rejects activation once the eligible window would land on the final question (question 10)', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await service.startRoom(room.roomCode, 'teacher-1', 5)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      // Advance to question index 8 (question 9) — the reveal window there would target
      // index 9 (question 10), which must never be an eligible activation target.
      for (let index = 0; index < 8; index += 1) {
        await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(index))
        await service.advanceQuestion(room.roomCode, 'teacher-1', index)
      }
      await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(8))
      vi.spyOn(Date, 'now').mockReturnValue((liveRoom.value?.questionStartedAt ?? 0) + 5_001)

      await expect(service.activateItem(room.roomCode, 'team-1', holderId, 'power_surge'))
        .rejects.toThrow('ไม่สามารถใช้ไอเทมได้ในขณะนี้')
      stopRoom()
    })

    it('reconnect (re-subscribing) preserves inventory and queued state', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'score_seal')
      await service.activateItem(room.roomCode, 'team-1', holderId, 'score_seal', 'team-2')

      // Simulate a fresh page load: a brand-new subscription (not the one used to activate).
      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => {
        expect(magic.value?.inventory).toHaveLength(1)
        expect(magic.value?.queuedEffect).not.toBeNull()
      })
      expect(magic.value?.inventory[0]).toMatchObject({ itemType: 'score_seal', consumed: false })
      expect(magic.value?.queuedEffect).toMatchObject({ itemType: 'score_seal', targetTeamId: 'team-2', affectedQuestionIndex: 1 })
      stop()
    })
  })

  describe('Team roster and answer progress', () => {
    it('shows a provisional roster immediately after randomizeTeams, before any lock', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)

      const roster: { value: TeamRosterSummary | null } = { value: null }
      const liveRoom: { value: Room | null } = { value: null }
      const stopRoster = service.subscribeTeamRoster(room.roomCode, 'team-1', (value) => { roster.value = value })
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(roster.value?.members).toHaveLength(2))
      expect(liveRoom.value?.teamsLocked).toBe(false) // still provisional
      stopRoster()
      stopRoom()
    })

    it('a team roster never includes another team\'s member, and every assigned player appears exactly once across all rosters', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const joined = []
      for (let index = 0; index < 6; index += 1) {
        joined.push((await service.joinRoom({ roomCode: room.roomCode, displayName: `P${index}`, studentNumber: `${index}` }, `owner-${index}`)).player)
      }
      await service.randomizeTeams(room.roomCode, 'teacher-1', 3)

      const players: { value: Player[] } = { value: [] }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      // .every() on an empty array is vacuously true, so also require a non-empty length —
      // otherwise this resolves before subscribePlayers delivers its first real snapshot,
      // and the per-player cross-team check below would silently iterate zero times.
      await vi.waitFor(() => {
        expect(players.value.length).toBe(6)
        expect(players.value.every((player) => player.teamId != null)).toBe(true)
      })
      const teamIds = ['team-1', 'team-2', 'team-3']
      const rosterByTeam = new Map<string, TeamRosterSummary | null>()
      const stops = teamIds.map((teamId) => service.subscribeTeamRoster(room.roomCode, teamId, (value) => rosterByTeam.set(teamId, value)))
      await vi.waitFor(() => expect(teamIds.every((teamId) => rosterByTeam.get(teamId)?.members.length)).toBeTruthy())

      const allRosterIds = teamIds.flatMap((teamId) => rosterByTeam.get(teamId)?.members.map((member) => member.playerId) ?? [])
      expect(new Set(allRosterIds).size).toBe(allRosterIds.length) // no duplicates
      expect(allRosterIds.sort()).toEqual(joined.map((player) => player.id).sort()) // no omissions

      for (const player of players.value) {
        const roster = rosterByTeam.get(player.teamId as string)
        expect(roster?.members.some((member) => member.playerId === player.id)).toBe(true)
        const otherTeamIds = teamIds.filter((teamId) => teamId !== player.teamId)
        for (const otherTeamId of otherTeamIds) {
          expect(rosterByTeam.get(otherTeamId)?.members.some((member) => member.playerId === player.id)).toBe(false)
        }
      }
      stopPlayers()
      stops.forEach((stop) => stop())
    })

    it('re-randomizing replaces the previous roster wholesale, not incrementally', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 2)

      const roster1: { value: TeamRosterSummary | null } = { value: null }
      const stop1 = service.subscribeTeamRoster(room.roomCode, 'team-1', (value) => { roster1.value = value })
      await vi.waitFor(() => expect(roster1.value).not.toBeNull())
      stop1()

      // Force everyone onto team-1 this time — team-2's old roster (if it had this member)
      // must not retain it.
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      const roster1Again: { value: TeamRosterSummary | null } = { value: null }
      const roster2: { value: TeamRosterSummary | null } = { value: null }
      const stopAgain = service.subscribeTeamRoster(room.roomCode, 'team-1', (value) => { roster1Again.value = value })
      await vi.waitFor(() => expect(roster1Again.value?.members).toHaveLength(2))
      stopAgain()
      expect(roster2.value).toBeNull() // never subscribed, but team-2 no longer exists in room.teams either
    })

    it('normalizeState defaults missing rosters/answerProgress to empty instead of crashing (older saved demo state)', async () => {
      const legacyState = {
        rooms: {
          MATANA: {
            room: {
              roomCode: 'MATANA', status: 'waiting', currentRound: 1, createdAt: 0, startedAt: null, completedAt: null,
              currentQuestionIndex: 0, questionDurationSeconds: 30, questionStartedAt: null, questionIds: [], previousQuestionIds: [],
              winner: null, teacherSessionId: 'demo-teacher', teamCount: 0, teamsLocked: false, teams: [],
            },
            players: {},
            magic: {},
            magicEvents: [],
            // rosters/answerProgress deliberately omitted — simulates state saved before this
            // migration existed.
          },
        },
      }
      localStorage.setItem('matana_demo_state_v5', JSON.stringify(legacyState))
      const service = new DemoGameService()
      expect(async () => {
        const roster: { value: TeamRosterSummary | null } = { value: null }
        const stop = service.subscribeTeamRoster('MATANA', 'team-1', (value) => { roster.value = value })
        await vi.waitFor(() => expect(roster.value).toBeNull())
        stop()
      }).not.toThrow()
    })

    it('the first saved answer moves the count from 0/Y to 1/Y; changing the same answer does not double-count', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      const progress: { value: AnswerProgressEntry[] } = { value: [] }
      const stop = service.subscribeTeamAnswerProgress(room.roomCode, 'team-1', (value) => { progress.value = value })
      await vi.waitFor(() => expect(progress.value).toHaveLength(0))

      await answerAt(service, room, p1, 0, true)
      await vi.waitFor(() => expect(progress.value.filter((entry) => entry.questionId === room.questionIds[0])).toHaveLength(1))

      // Changing the choice for the same question overwrites, never appends.
      await answerAt(service, room, p1, 0, false)
      await vi.waitFor(() => {
        expect(progress.value.filter((entry) => entry.questionId === room.questionIds[0])).toHaveLength(1)
      })
      stop()
    })

    it('another team\'s answer does not affect this team\'s progress count', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const p2 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      // 2 players over 2 teams always splits one-each, but *which* label ("team-1" vs
      // "team-2") each lands on depends on the shuffle — read it back rather than assuming.
      const players: { value: Player[] } = { value: [] }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      // .every() on an empty array is vacuously true, so also require a non-empty length —
      // otherwise this resolves before subscribePlayers delivers its first real snapshot.
      await vi.waitFor(() => {
        expect(players.value.length).toBe(2)
        expect(players.value.every((player) => player.teamId != null)).toBe(true)
      })
      const p1TeamId = players.value.find((player) => player.id === p1.id)?.teamId as string
      stopPlayers()

      const progressP1Team: { value: AnswerProgressEntry[] } = { value: [] }
      const stop = service.subscribeTeamAnswerProgress(room.roomCode, p1TeamId, (value) => { progressP1Team.value = value })
      await answerAt(service, room, p2, 0, true) // p2 is on the *other* team
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(progressP1Team.value).toHaveLength(0)
      stop()
    })

    it('progress resets to 0 for the next question with no explicit reset, and holds steady through the reveal window', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      const progress: { value: AnswerProgressEntry[] } = { value: [] }
      const stop = service.subscribeTeamAnswerProgress(room.roomCode, 'team-1', (value) => { progress.value = value })
      await answerAt(service, room, p1, 0, true)
      await vi.waitFor(() => expect(progress.value.filter((entry) => entry.questionId === room.questionIds[0])).toHaveLength(1))
      // Reveal window: nothing resets the entry, the question-0 count is still readable.
      expect(progress.value.filter((entry) => entry.questionId === room.questionIds[0])).toHaveLength(1)

      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      await vi.waitFor(() => {
        expect(progress.value.filter((entry) => entry.questionId === room.questionIds[1])).toHaveLength(0)
      })
      stop()
    })

    it('a locked team member who never answers still counts toward Y (roster-derived, not presence-derived)', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Silent', studentNumber: '02' }, 'owner-2')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)

      const roster: { value: TeamRosterSummary | null } = { value: null }
      const stop = service.subscribeTeamRoster(room.roomCode, 'team-1', (value) => { roster.value = value })
      await vi.waitFor(() => expect(roster.value?.members).toHaveLength(2))
      // Y is the roster size regardless of whether "Silent" ever answers anything.
      expect(roster.value?.members).toHaveLength(2)
      stop()
    })

    it('answerProgress entries never carry the selected choice or correctness — only playerId/teamId/questionId/answeredAt', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await answerAt(service, room, p1, 0, true)

      const progress: { value: AnswerProgressEntry[] } = { value: [] }
      const stop = service.subscribeTeamAnswerProgress(room.roomCode, 'team-1', (value) => { progress.value = value })
      await vi.waitFor(() => expect(progress.value).toHaveLength(1))
      expect(Object.keys(progress.value[0]).sort()).toEqual(['answeredAt', 'playerId', 'questionId', 'teamId'])
      stop()
    })
  })

  // Kept last deliberately: this test stubs `fetch` to succeed, which flips demoService's
  // module-level `sharedStateAvailable` flag to true as a side effect that `vi.unstubAllGlobals()`
  // does not reset. Any test declared *after* this one would otherwise have its
  // subscriptions polled against a real (unstubbed, failing) `fetch` via the shared-state
  // interval, which is exactly what made several of the tests above flaky when this was
  // positioned earlier — see git history if this needs to move again.
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
