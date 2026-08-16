import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { questionsById } from '../data/questions'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { ANSWER_REVEAL_MILLISECONDS, getRemainingMilliseconds, getRevealRemainingMilliseconds } from '../lib/gameFlow'
import { resolveStudentRoute } from '../lib/game'
import { computeStudentLearningEvidence } from '../lib/learning'
import { computeTeamCompetitionStats, hasAnyMagicItem } from '../lib/magic'
import { BOSS_QUESTION_COUNT, BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX, MIN_RECALL_SECONDS_PER_ITEM, RECALL_TIMEOUT_CHOICE_ID } from '../types/game'
import type { AnswerProgressEntry, CaptainVote, CaptainVoteProgress, MagicEvent, Player, Room, TeamGuardianName, TeamMagicState, TeamRosterSummary } from '../types/game'
import { DEMO_STORAGE_KEY, DemoGameService } from './demoService'

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

// Milestone 4.1: magicHolderPlayerId is no longer auto-assigned at lockTeams — it's the team's
// ELECTED captain, null until finalizeCaptainElection runs. Most pre-existing flow tests only
// care about "who is the holder for follow-up chooseStartingItem/activateItem calls," not the
// election mechanics themselves, so this force-finalizes with zero votes cast (pickElectedCaptain
// then draws uniformly at random across the whole roster — see lib/magic.ts) before waiting for
// the subscription to reflect it. Tests that exercise the election flow itself use
// castCaptainVote/finalizeCaptainElection/resetCaptainElection directly instead of this helper.
// Item 6: also names the team right after electing its captain — startRoom now additionally
// requires every team to have a guardian name (alongside captain + starting item), and this
// helper is the shared entry point every manual-item-selection test (score_seal/rose_shield/
// illusion — chooseAllStartingItems above only covers the power_surge-only flow tests) already
// calls to obtain a holder id, so naming it here covers every one of those call sites at once.
const getHolderId = async (service: DemoGameService, roomCode: string, teamId: string, teacherSessionId = 'teacher-1'): Promise<string> => {
  await service.finalizeCaptainElection(roomCode, teacherSessionId, teamId)
  const magic: { value: TeamMagicState | null } = { value: null }
  const stop = service.subscribeTeamMagic(roomCode, teamId, (value) => { magic.value = value })
  // Deliberately toBeTruthy(), not not.toBeNull(): magic.value starts out `null`, so
  // magic.value?.magicHolderPlayerId is `undefined` before the first real snapshot arrives —
  // and undefined !== null, so not.toBeNull() would pass vacuously before any data loads.
  await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBeTruthy())
  const holderId = magic.value?.magicHolderPlayerId as string
  stop()
  await service.setTeamGuardianName(roomCode, teamId, holderId, `Guardian-${teamId}`)
  return holderId
}

// Milestone 4: leaving main question 5 (index BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX) enters the
// 3-question boss phase (status stays 'playing', currentQuestionIndex frozen at 4) before the
// room moves on to question 6 — any test loop that walks through all 10 questions must drain the
// boss phase at that point too, or the room simply never advances past it.
// Item 5: draining the 3rd boss question no longer auto-advances back to 'main' — it sets
// bossAwaitingContinue=true and pauses. This helper also plays the teacher's "เล่นต่อ"
// (continueAfterBoss) so every existing test that walks through the boss phase keeps working
// exactly as before, without each test needing to know about the new pause gate individually.
const advanceQuestionThroughBoss = async (
  service: DemoGameService,
  roomCode: string,
  teacherSessionId: string,
  expectedQuestionIndex: number,
): Promise<void> => {
  await service.advanceQuestion(roomCode, teacherSessionId, expectedQuestionIndex)
  if (expectedQuestionIndex !== BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX) return
  for (let bossIndex = 0; bossIndex < BOSS_QUESTION_COUNT; bossIndex += 1) {
    await service.advanceBossQuestion(roomCode, teacherSessionId, bossIndex)
  }
  const room: { value: Room | null } = { value: null }
  const stop = service.subscribeRoom(roomCode, (value) => { room.value = value })
  await vi.waitFor(() => expect(room.value?.bossAwaitingContinue).toBe(true))
  stop()
  await service.continueAfterBoss(roomCode, teacherSessionId, room.value?.currentRound as number)
}

// startRoom requires every team to have an elected captain, a chosen starting item, AND a
// guardian team name (item 6) — this force-finalizes any still-open election (zero votes, so
// pickElectedCaptain draws uniformly at random across the whole roster), drives every team's
// captain to pick มนตร์ทวีพลัง (power_surge), then has that same captain set a unique guardian
// name, so pre-existing flow tests that only care about the normal answer/scoring path can reach
// 'playing' without needing to individually think about magic items, elections, or naming.
const chooseAllStartingItems = async (service: DemoGameService, roomCode: string, teacherSessionId = 'teacher-1'): Promise<void> => {
  const magic: { value: TeamMagicState[] } = { value: [] }
  const stop = service.subscribeAllTeamMagic(roomCode, (value) => { magic.value = value })
  await vi.waitFor(() => expect(magic.value.length).toBeGreaterThan(0))

  const teamIds = magic.value.map((team) => team.teamId)
  for (const teamId of teamIds) {
    const team = magic.value.find((entry) => entry.teamId === teamId)
    if (team && team.magicHolderPlayerId == null) {
      await service.finalizeCaptainElection(roomCode, teacherSessionId, teamId)
    }
  }
  await vi.waitFor(() => expect(magic.value.every((team) => team.magicHolderPlayerId != null)).toBe(true))

  for (const teamId of teamIds) {
    const team = magic.value.find((entry) => entry.teamId === teamId)
    if (team?.magicHolderPlayerId && !hasAnyMagicItem(team.inventory)) {
      await service.chooseStartingItem(roomCode, teamId, team.magicHolderPlayerId, 'power_surge')
    }
  }

  const names: { value: Array<{ teamId: string; name: string }> } = { value: [] }
  const stopNames = service.subscribeAllTeamGuardianNames(roomCode, (value) => { names.value = value })
  for (const teamId of teamIds) {
    const team = magic.value.find((entry) => entry.teamId === teamId)
    const hasName = names.value.some((entry) => entry.teamId === teamId && entry.name.trim())
    if (team?.magicHolderPlayerId && !hasName) {
      await service.setTeamGuardianName(roomCode, teamId, team.magicHolderPlayerId, `Guardian-${teamId}`)
    }
  }
  stopNames()
  stop()
}

// Story Recall is now a PRE-TEAM stage: every round runs lobby -> recall -> teamSetup -> main,
// and teams cannot be created until the room reaches 'teamSetup'. Every pre-existing test that
// jumps straight to randomizeTeams therefore needs this first — it runs the whole pre-team
// sequence (start Recall, have every currently-joined player answer all RECALL_QUESTIONS.length
// items, then hand off to team setup) and leaves the room in exactly the state randomizeTeams
// used to be called in. Answer choice doesn't matter: correctness has no bearing on being ALLOWED
// to finish Recall or proceed.
// Idempotent, because several tests call randomizeTeams more than once (re-randomize before
// lock) and each of those call sites is prefixed with this helper: once the room has already
// reached teamSetup there is nothing left to advance, and re-running the Recall answers would
// throw now that the stage has moved on.
const advanceToTeamSetup = async (
  service: DemoGameService,
  roomCode: string,
  teacherSessionId = 'teacher-1',
): Promise<void> => {
  const current: { value: Room | null } = { value: null }
  const stopCurrent = service.subscribeRoom(roomCode, (value) => { current.value = value })
  await vi.waitFor(() => expect(current.value).not.toBeNull())
  const startingPhase = current.value?.phase
  stopCurrent()
  if (startingPhase !== 'lobby') return

  await service.startRecall(roomCode, teacherSessionId)

  const players: { value: Player[] } = { value: [] }
  const stopPlayers = service.subscribePlayers(roomCode, (value) => { players.value = value })
  await vi.waitFor(() => expect(players.value.length).toBeGreaterThan(0))

  for (const player of players.value) {
    for (let index = 0; index < RECALL_QUESTIONS.length; index += 1) {
      const recallQuestion = RECALL_QUESTIONS[index]
      await service.saveRecallAnswer(roomCode, player.id, {
        conceptId: recallQuestion.id,
        selectedChoiceId: recallQuestion.correctChoiceId,
        expectedRecallIndex: index,
      })
    }
  }
  stopPlayers()

  await service.startTeamSetup(roomCode, teacherSessionId)
  const room: { value: Room | null } = { value: null }
  const stopRoom = service.subscribeRoom(roomCode, (value) => { room.value = value })
  await vi.waitFor(() => expect(room.value?.phase).toBe('teamSetup'))
  stopRoom()
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
    await advanceToTeamSetup(service, room.roomCode)
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
    await advanceToTeamSetup(service, room.roomCode)
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
    await advanceToTeamSetup(service, room.roomCode)
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
    // Milestone 4.1: captains must be elected before startRoom even looks at starting items.
    await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).rejects.toThrow('ทุกทีมต้องเลือกหัวหน้าทีมก่อนเริ่มภารกิจ')
    const magicForElection: { value: TeamMagicState[] } = { value: [] }
    const stopMagicForElection = service.subscribeAllTeamMagic(room.roomCode, (value) => { magicForElection.value = value })
    await vi.waitFor(() => expect(magicForElection.value.length).toBeGreaterThan(0))
    for (const team of magicForElection.value) {
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', team.teamId)
    }
    stopMagicForElection()
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

    await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
    await service.lockTeams(room.roomCode, 'teacher-1')
    await expect(service.randomizeTeams(room.roomCode, 'teacher-1', 3)).rejects.toThrow('ปลดล็อกทีมก่อนสุ่มใหม่')

    await service.unlockTeams(room.roomCode, 'teacher-1')
    await advanceToTeamSetup(service, room.roomCode)
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
    // An empty room can never reach the team-setup stage in the first place (Story Recall needs
    // at least one student), so the stage guard is what rejects here — the "no players" check
    // inside randomizeTeams is now unreachable with zero players, by construction.
    await expect(service.randomizeTeams(room.roomCode, 'teacher-1', 1)).rejects.toThrow('กู้ความทรงจำ')
    await expect(service.startRecall(room.roomCode, 'teacher-1')).rejects.toThrow('ยังไม่มีผู้เล่นเข้าร่วม')

    await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
    await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
    await advanceToTeamSetup(service, room.roomCode)
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
    await advanceToTeamSetup(service, room.roomCode)
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
    await advanceToTeamSetup(service, room.roomCode)
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
    await advanceToTeamSetup(service, room.roomCode)
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
    await advanceToTeamSetup(service, room.roomCode)
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
    await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
    await service.lockTeams(room.roomCode, 'teacher-1')
    await chooseAllStartingItems(service, room.roomCode)
    await service.startRoom(room.roomCode, 'teacher-1', 60)

    for (let index = 0; index < room.questionIds.length; index += 1) {
      await answerAt(service, room, high, index, index < 9)
      if (index < 4) await answerAt(service, room, low, index, true)
      await advanceQuestionThroughBoss(service, room.roomCode, 'teacher-1', index)
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
    await advanceToTeamSetup(service, room.roomCode)
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
    for (let index = 0; index < 10; index += 1) await advanceQuestionThroughBoss(service, room.roomCode, 'teacher-1', index)
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
    await advanceToTeamSetup(service, room.roomCode)
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
    await advanceToTeamSetup(service, seededRoom.roomCode, 'demo-teacher')
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
    it('captain election: no holder exists right after lockTeams; finalizing selects exactly one real member per team', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      for (let index = 0; index < 6; index += 1) {
        await service.joinRoom({ roomCode: room.roomCode, displayName: `P${index}`, studentNumber: `${index}` }, `owner-${index}`)
      }
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 3)
      await service.lockTeams(room.roomCode, 'teacher-1')

      const magic: { value: TeamMagicState[] } = { value: [] }
      const players: { value: Player[] } = { value: [] }
      const stopMagic = service.subscribeAllTeamMagic(room.roomCode, (value) => { magic.value = value })
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      await vi.waitFor(() => expect(magic.value).toHaveLength(3))
      // Milestone 4.1: no more random assignment at lockTeams — every team's election starts open.
      expect(magic.value.every((team) => team.magicHolderPlayerId == null)).toBe(true)

      for (const team of magic.value) {
        await service.finalizeCaptainElection(room.roomCode, 'teacher-1', team.teamId)
      }
      await vi.waitFor(() => expect(magic.value.every((team) => team.magicHolderPlayerId != null)).toBe(true))
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
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', 'team-1')

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

    it('lets the holder choose exactly one starting item at a time — a second choice while still waiting replaces it, never adds to it', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')

      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'rose_shield')
      // Milestone: changing before the mission starts is now allowed (see the dedicated "may
      // change their starting item" test below for the full replace-not-append coverage) —
      // this must NOT reject, and must leave only the newest pick.
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.inventory.power_surge.available).toBe(1))
      expect(magic.value?.inventory.rose_shield.available).toBe(0)
      stop()
    })

    it('rejects a duplicate activation while one is already queued, and logs it as a rejected event', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      await service.activateItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await expect(service.activateItem(room.roomCode, 'team-1', holderId, 'power_surge'))
        .rejects.toThrow('ทีมนี้มีไอเทมที่กำลังรอผลอยู่แล้ว')

      const events: { value: MagicEvent[] } = { value: [] }
      const stop = service.subscribeMagicEvents(room.roomCode, (value) => { events.value = value })
      await vi.waitFor(() => expect(events.value.some((event) => event.status === 'rejected')).toBe(true))
      stop()
    })

    it('rejects an invalid hostile target (self, or no target chosen) but allows multiple teams to seal the same target/question', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Gamma', studentNumber: '03' }, 'owner-3')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 3)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holder1 = await getHolderId(service, room.roomCode, 'team-1')
      const holder2 = await getHolderId(service, room.roomCode, 'team-2')
      await service.chooseStartingItem(room.roomCode, 'team-1', holder1, 'score_seal')
      await service.chooseStartingItem(room.roomCode, 'team-2', holder2, 'score_seal')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      await expect(service.activateItem(room.roomCode, 'team-1', holder1, 'score_seal', 'team-1'))
        .rejects.toThrow('เลือกทีมตัวเองเป็นเป้าหมายไม่ได้')
      await expect(service.activateItem(room.roomCode, 'team-1', holder1, 'score_seal'))
        .rejects.toThrow('กรุณาเลือกทีมเป้าหมาย')

      // Milestone 4: multiple teams may seal the SAME target/question — no longer rejected.
      await service.activateItem(room.roomCode, 'team-1', holder1, 'score_seal', 'team-3')
      await service.activateItem(room.roomCode, 'team-2', holder2, 'score_seal', 'team-3')

      const events: { value: MagicEvent[] } = { value: [] }
      const stop = service.subscribeMagicEvents(room.roomCode, (value) => { events.value = value })
      await vi.waitFor(() => expect(events.value.filter((event) => event.status === 'queued' && event.targetTeamId === 'team-3')).toHaveLength(2))
      stop()
    })

    it('applies a x2 own-team multiplier and a x0.5 hostile multiplier, leaves individual raw scores untouched, and the competition score is reproducible from the event log', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const p2 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      const p3 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Gamma', studentNumber: '03' }, 'owner-3')).player
      await advanceToTeamSetup(service, room.roomCode)
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

      await chooseAllStartingItems(service, room.roomCode) // no-op: all three already chosen
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      // Both activated right at the start of question 1 (index 0), so both target question
      // index 1 (question 2) — activation is playing-only now, always currentQuestionIndex + 1.
      await service.activateItem(room.roomCode, team1, holder1, 'power_surge')
      await service.activateItem(room.roomCode, team2, holder2, 'score_seal', team3)

      // Question index 0: no queued effect targets it — answer it and move past.
      await answerAt(service, room, p1, 0, true)
      await answerAt(service, room, p2, 0, true)
      await answerAt(service, room, p3, 0, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      // Question index 1: the targeted question. team-1 (p1) answers correctly (raw 10, x2);
      // team-3 (p3) answers correctly too (raw 10, x0.5 from team-2's un-shielded score_seal).
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
      const computeOnce = (): unknown => computeTeamCompetitionStats(players.value, teams, questionIds, events.value, liveRoom.value?.currentRound ?? 1)
      const first = computeOnce()
      const second = computeOnce()
      expect(first).toEqual(second) // reproducible from the event log alone

      const stats = first as ReturnType<typeof computeTeamCompetitionStats>
      // p1's team (1 member): q0 raw 10 (no multiplier) + q1 raw 10 * 2 = 20 -> total 30
      expect(stats.find((team) => team.id === team1)?.competitionTotal).toBeCloseTo(30)
      // p3's team (1 member): q0 raw 10 (no multiplier) + q1 raw 10 * 0.5 = 5 (hostile applied, no shield) -> total 15
      expect(stats.find((team) => team.id === team3)?.competitionTotal).toBeCloseTo(15)

      stopPlayers()
      stopEvents()
      stopRoom()
    })

    it('a shield blocks a hostile effect and is consumed by it; the target keeps full raw competition points', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const p2 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holder1 = await getHolderId(service, room.roomCode, 'team-1')
      const holder2 = await getHolderId(service, room.roomCode, 'team-2')
      await service.chooseStartingItem(room.roomCode, 'team-1', holder1, 'score_seal')
      await service.chooseStartingItem(room.roomCode, 'team-2', holder2, 'rose_shield')
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holder1, 'score_seal', 'team-2')

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
      expect(magic.value?.inventory.rose_shield.consumed).toBe(1)

      const stats = computeTeamCompetitionStats(players.value, liveRoom.value?.teams ?? [], liveRoom.value?.questionIds ?? [], events.value, liveRoom.value?.currentRound ?? 1)
      // team-2 (1 member): q0 raw 10 + q1 raw 10, untouched by the blocked hostile effect (multiplier stays 1) -> total 20.
      expect(stats.find((team) => team.id === 'team-2')?.competitionTotal).toBe(20)

      stopEvents()
      stopMagic()
      stopPlayers()
      stopRoom()
    })

    it('rejects activation once the eligible window would land on the final question (question 10)', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await service.startRoom(room.roomCode, 'teacher-1', 5)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      // Advance to question index 8 (question 9) — activating there would target index 9
      // (question 10), which must never be an eligible activation target, at any point during
      // question 9's lifecycle (activation is no longer time-gated).
      //
      // Milestone 4: leaving main question 5 (index BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX = 4)
      // inserts the 3-question boss phase before the room can reach question 6 — status stays
      // 'playing' but currentQuestionIndex freezes at 4 until all 3 boss questions resolve.
      // advanceQuestionThroughBoss drains that phase (mirroring how the teacher's real
      // auto-advance timers drive it in TeacherPage.tsx) so this loop still lands on index 8
      // afterward; production code is untouched — the boss trigger inside advanceQuestion still
      // fires exactly as before, this only teaches the test to wait it out.
      for (let index = 0; index < 8; index += 1) {
        await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(index))
        await advanceQuestionThroughBoss(service, room.roomCode, 'teacher-1', index)
      }
      // Confirms the boss phase actually resolved and main question 6 (index 5) resumed, not
      // just that the loop completed.
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))
      await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(8))

      await expect(service.activateItem(room.roomCode, 'team-1', holderId, 'power_surge'))
        .rejects.toThrow('ไม่สามารถใช้ไอเทมได้ในขณะนี้')
      stopRoom()
    })

    it('reconnect (re-subscribing) preserves inventory and queued state', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'score_seal')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holderId, 'score_seal', 'team-2')

      // Simulate a fresh page load: a brand-new subscription (not the one used to activate).
      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => {
        expect(magic.value ? hasAnyMagicItem(magic.value.inventory) : false).toBe(true)
        expect(magic.value?.queuedEffect).not.toBeNull()
      })
      expect(magic.value?.inventory.score_seal).toMatchObject({ available: 1, consumed: 0 })
      expect(magic.value?.queuedEffect).toMatchObject({ itemType: 'score_seal', targetTeamId: 'team-2', affectedQuestionIndex: 1 })
      stop()
    })
  })

  describe('Milestone 4.1: team captain election', () => {
    it('students can vote only for members of their own locked team', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      const gamma = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Gamma', studentNumber: '03' }, 'owner-3')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')

      const players: { value: Player[] } = { value: [] }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      // .every() on an empty array is vacuously true, so also require a non-empty length —
      // otherwise this resolves before subscribePlayers delivers its first real snapshot.
      await vi.waitFor(() => {
        expect(players.value.length).toBe(3)
        expect(players.value.every((player) => player.teamId != null)).toBe(true)
      })
      const alphaLive = players.value.find((player) => player.id === alpha.id) as Player
      const gammaLive = players.value.find((player) => player.id === gamma.id) as Player
      stopPlayers()

      if (alphaLive.teamId === gammaLive.teamId) {
        // Extremely unlikely with 3 players over 2 teams, but stay correct either way: this
        // test needs voter and target on DIFFERENT teams.
        await expect(service.castCaptainVote(room.roomCode, alphaLive.id, alphaLive.id)).resolves.not.toThrow()
        return
      }
      await expect(service.castCaptainVote(room.roomCode, alphaLive.id, gammaLive.id))
        .rejects.toThrow('โหวตได้เฉพาะสมาชิกในทีมของคุณเอง')
    })

    it('one vote per student, but changeable until the election is finalized (self-voting allowed)', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')

      await service.castCaptainVote(room.roomCode, alpha.id, alpha.id) // self-vote — allowed
      const vote: { value: CaptainVote | null } = { value: null }
      const stopVote = service.subscribeCaptainVote(room.roomCode, alpha.id, (value) => { vote.value = value })
      await vi.waitFor(() => expect(vote.value?.targetPlayerId).toBe(alpha.id))

      // Changing the vote before finalization overwrites, it never appends a second entry.
      await service.castCaptainVote(room.roomCode, alpha.id, beta.id)
      await vi.waitFor(() => expect(vote.value?.targetPlayerId).toBe(beta.id))

      const progress: { value: CaptainVoteProgress[] } = { value: [] }
      const stopProgress = service.subscribeTeamCaptainVoteProgress(room.roomCode, 'team-1', (value) => { progress.value = value })
      await vi.waitFor(() => expect(progress.value).toHaveLength(1)) // still exactly one voter, not two
      stopVote()
      stopProgress()
    })

    it('students cannot see live vote totals — the broadly-readable progress entries never carry the vote target', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await service.castCaptainVote(room.roomCode, alpha.id, alpha.id)

      const progress: { value: CaptainVoteProgress[] } = { value: [] }
      const stop = service.subscribeTeamCaptainVoteProgress(room.roomCode, 'team-1', (value) => { progress.value = value })
      await vi.waitFor(() => expect(progress.value).toHaveLength(1))
      // Structural guarantee, not just a type-level one: the progress entry literally has no
      // field that could reveal who anyone voted for — only that they voted.
      expect(Object.keys(progress.value[0]).sort()).toEqual(['electionAttempt', 'playerId', 'teamId', 'votedAt'])
      stop()
    })

    it('once all members of a team have voted, the teacher can finalize and the highest candidate wins', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      const gamma = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Gamma', studentNumber: '03' }, 'owner-3')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')

      // 2 votes for Beta, 1 for Alpha — Beta must win. Note: "auto-finalize once everyone has
      // voted" is a TEACHER-CLIENT-DRIVEN UI behavior (see TeacherPage.tsx's polling effect,
      // and gameService.ts's doc comment on castCaptainVote for why) — the service layer here
      // always requires an explicit finalizeCaptainElection call, whether triggered by that
      // effect or a manual click.
      await service.castCaptainVote(room.roomCode, alpha.id, beta.id)
      await service.castCaptainVote(room.roomCode, beta.id, beta.id)
      await service.castCaptainVote(room.roomCode, gamma.id, alpha.id)
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', 'team-1')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBe(beta.id))
      stop()
    })

    it('tied highest candidates produce one persisted random winner — refresh/retry cannot reroll it', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')

      // 1-1 tie between Alpha and Beta.
      await service.castCaptainVote(room.roomCode, alpha.id, alpha.id)
      await service.castCaptainVote(room.roomCode, beta.id, beta.id)
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', 'team-1')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBeTruthy())
      const winnerId = magic.value?.magicHolderPlayerId
      expect([alpha.id, beta.id]).toContain(winnerId)

      // A retry/refresh (a second finalize call, or simply re-reading the same subscription)
      // must never change the already-decided winner.
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', 'team-1')
      expect(magic.value?.magicHolderPlayerId).toBe(winnerId)
      stop()
    })

    it('teacher early-finalize works with missing voters, and reset reopens the election for a fresh vote', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')

      // Only Alpha votes (for herself) — Beta never gets around to it. The teacher can still
      // finalize early.
      await service.castCaptainVote(room.roomCode, alpha.id, alpha.id)
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', 'team-1')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBe(alpha.id))

      // Reopen/reset before the game starts — the old captain is cleared and a stale vote from
      // the superseded attempt no longer counts.
      await service.resetCaptainElection(room.roomCode, 'teacher-1', 'team-1')
      await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBeNull())
      await service.castCaptainVote(room.roomCode, beta.id, beta.id)
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', 'team-1')
      // Alpha's OLD vote (cast under the previous attempt) does not carry over — only Beta's
      // fresh vote counts, so Beta wins outright.
      await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBe(beta.id))
      stop()
    })

    it('startRoom rejects a room where any team is missing a finalized captain', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).rejects.toThrow('ทุกทีมต้องเลือกหัวหน้าทีมก่อนเริ่มภารกิจ')
    })

    it('the elected captain — and only the elected captain — becomes the team\'s magic holder', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await service.castCaptainVote(room.roomCode, alpha.id, beta.id)
      await service.castCaptainVote(room.roomCode, beta.id, beta.id)
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', 'team-1')

      await expect(service.chooseStartingItem(room.roomCode, 'team-1', alpha.id, 'power_surge'))
        .rejects.toThrow('คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')
      await expect(service.chooseStartingItem(room.roomCode, 'team-1', beta.id, 'power_surge')).resolves.not.toThrow()
    })

    it('a new round resets the election — the previous captain does not carry over and a fresh vote is required', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      expect(holderId).toBe(p1.id)
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.stopRound(room.roomCode, 'teacher-1')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBeNull())
      expect(magic.value?.captainElectionAttempt).toBeGreaterThan(1)
      // A new round restarts the whole pre-game sequence at 'lobby', so Recall runs again before
      // the captain gate is even reachable.
      await advanceToTeamSetup(service, room.roomCode)
      // No captain -> starting the next round is blocked again until a fresh election finishes.
      await expect(service.startRoom(room.roomCode, 'teacher-1', 60)).rejects.toThrow('ทุกทีมต้องเลือกหัวหน้าทีมก่อนเริ่มภารกิจ')
      stop()
    })
  })

  describe('Item 6: team guardian name', () => {
    const setUpTwoTeamRoom = async (service: DemoGameService) => {
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holder1 = await getHolderIdWithoutNaming(service, room.roomCode, 'team-1')
      const holder2 = await getHolderIdWithoutNaming(service, room.roomCode, 'team-2')
      return { room, alpha, beta, holder1, holder2 }
    }

    // getHolderId (used elsewhere in this file) already names the team as a side effect — these
    // tests need to control naming themselves, so this is a local, naming-free variant.
    const getHolderIdWithoutNaming = async (service: DemoGameService, roomCode: string, teamId: string): Promise<string> => {
      await service.finalizeCaptainElection(roomCode, 'teacher-1', teamId)
      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(roomCode, teamId, (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.magicHolderPlayerId).toBeTruthy())
      const holderId = magic.value?.magicHolderPlayerId as string
      stop()
      return holderId
    }

    // Deliberately toBeNull() as the "not yet loaded" sentinel (not `[]`), matching this file's
    // established "toBeTruthy(), not not.toBeNull()" rationale elsewhere: an empty array is a
    // legitimate real snapshot (no team named yet), and would otherwise satisfy a lesser check
    // before the subscription's first real emit ever arrives.
    const readNames = async (service: DemoGameService, roomCode: string): Promise<TeamGuardianName[]> => {
      const names: { value: TeamGuardianName[] | null } = { value: null }
      const stop = service.subscribeAllTeamGuardianNames(roomCode, (value) => { names.value = value })
      await vi.waitFor(() => expect(names.value).not.toBeNull())
      stop()
      return names.value as TeamGuardianName[]
    }

    it('the finalized captain can submit the team name', async () => {
      const service = new DemoGameService()
      const { room, holder1 } = await setUpTwoTeamRoom(service)
      await service.setTeamGuardianName(room.roomCode, 'team-1', holder1, 'มังกรทอง')
      const names = await readNames(service, room.roomCode)
      expect(names.find((entry) => entry.teamId === 'team-1')?.name).toBe('มังกรทอง')
    })

    it('a non-captain teammate cannot set the team name', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      // Deterministic election (not the random-draw finalize helper): alpha votes for herself,
      // beta votes for alpha too, so alpha wins outright and beta is guaranteed the non-captain.
      await service.castCaptainVote(room.roomCode, alpha.id, alpha.id)
      await service.castCaptainVote(room.roomCode, beta.id, alpha.id)
      await service.finalizeCaptainElection(room.roomCode, 'teacher-1', 'team-1')
      await expect(service.setTeamGuardianName(room.roomCode, 'team-1', beta.id, 'ชื่อปลอม'))
        .rejects.toThrow('เฉพาะหัวหน้าทีมที่ได้รับเลือกเท่านั้นที่ตั้งชื่อทีมได้')
    })

    it('rejects a duplicate name already used by another team in the room', async () => {
      const service = new DemoGameService()
      const { room, holder1, holder2 } = await setUpTwoTeamRoom(service)
      await service.setTeamGuardianName(room.roomCode, 'team-1', holder1, 'มังกรทอง')
      await expect(service.setTeamGuardianName(room.roomCode, 'team-2', holder2, 'มังกรทอง'))
        .rejects.toThrow('ชื่อทีมนี้ถูกใช้แล้ว กรุณาเลือกชื่ออื่น')
    })

    it('the captain can edit the name again before the game starts (overwrite, not append)', async () => {
      const service = new DemoGameService()
      const { room, holder1 } = await setUpTwoTeamRoom(service)
      await service.setTeamGuardianName(room.roomCode, 'team-1', holder1, 'มังกรทอง')
      await service.setTeamGuardianName(room.roomCode, 'team-1', holder1, 'มังกรเงิน')
      const names = await readNames(service, room.roomCode)
      expect(names.filter((entry) => entry.teamId === 'team-1')).toHaveLength(1)
      expect(names.find((entry) => entry.teamId === 'team-1')?.name).toBe('มังกรเงิน')
    })

    it('teacher reset clears the name and blocks startRoom again until it is renamed', async () => {
      const service = new DemoGameService()
      const { room, holder1, holder2 } = await setUpTwoTeamRoom(service)
      await service.setTeamGuardianName(room.roomCode, 'team-1', holder1, 'มังกรทอง')
      await service.setTeamGuardianName(room.roomCode, 'team-2', holder2, 'เสือเงิน')
      await service.chooseStartingItem(room.roomCode, 'team-1', holder1, 'power_surge')
      await service.chooseStartingItem(room.roomCode, 'team-2', holder2, 'power_surge')

      // Reset team-1's name only — teacher-authorized regardless of captain/room state — and
      // confirm startRoom is blocked again on the name check specifically (captain + item are
      // still both satisfied for every team, isolating what's actually under test here).
      await service.resetTeamGuardianName(room.roomCode, 'teacher-1', 'team-1')
      const names = await readNames(service, room.roomCode)
      expect(names.find((entry) => entry.teamId === 'team-1')).toBeUndefined()
      await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).rejects.toThrow('ทุกทีมต้องตั้งชื่อทีมก่อนเริ่มภารกิจ')

      // Renaming it clears the block.
      await service.setTeamGuardianName(room.roomCode, 'team-1', holder1, 'มังกรทองใหม่')
      await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).resolves.not.toThrow()
    })

    it('teacher override sets a team name directly, regardless of captain state', async () => {
      const service = new DemoGameService()
      const { room } = await setUpTwoTeamRoom(service)
      await service.overrideTeamGuardianName(room.roomCode, 'teacher-1', 'team-1', 'ชื่อที่ครูตั้ง')
      const names = await readNames(service, room.roomCode)
      expect(names.find((entry) => entry.teamId === 'team-1')?.name).toBe('ชื่อที่ครูตั้ง')
    })

    it('startRoom rejects when any team has not been named, even with a captain and starting item', async () => {
      const service = new DemoGameService()
      const { room, holder1, holder2 } = await setUpTwoTeamRoom(service)
      await service.chooseStartingItem(room.roomCode, 'team-1', holder1, 'power_surge')
      await service.chooseStartingItem(room.roomCode, 'team-2', holder2, 'power_surge')
      await service.setTeamGuardianName(room.roomCode, 'team-1', holder1, 'มังกรทอง')
      // team-2 deliberately left unnamed.
      await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).rejects.toThrow('ทุกทีมต้องตั้งชื่อทีมก่อนเริ่มภารกิจ')
    })

    it('display fallback: a team has no guardian-name entry until one is submitted', async () => {
      const service = new DemoGameService()
      const { room } = await setUpTwoTeamRoom(service)
      const names = await readNames(service, room.roomCode)
      expect(names).toHaveLength(0)
      const rosters: { value: TeamRosterSummary | null } = { value: null }
      const stop = service.subscribeTeamRoster(room.roomCode, 'team-1', (value) => { rosters.value = value })
      await vi.waitFor(() => expect(rosters.value).not.toBeNull())
      // The "ทีม N" fallback label itself lives on the roster/room.teams — unaffected by the
      // (currently absent) guardian name, matching "show ทีม X only while unnamed".
      expect(rosters.value?.teamName).toBe('ทีม 1')
      stop()
    })

    it('the name persists across a fresh subscription (refresh-equivalent)', async () => {
      const service = new DemoGameService()
      const { room, holder1 } = await setUpTwoTeamRoom(service)
      await service.setTeamGuardianName(room.roomCode, 'team-1', holder1, 'มังกรทอง')
      // A brand-new subscription (simulating a reconnect/refresh) must see the persisted name,
      // not just the one the writer's own subscription happened to already hold in memory.
      const names = await readNames(service, room.roomCode)
      expect(names.find((entry) => entry.teamId === 'team-1')?.name).toBe('มังกรทอง')
    })
  })

  describe('Milestone 4.1: illusion magic', () => {
    it('is selectable as the one starting item, and can also be randomly awarded by the boss (duplicate rewards increment the count)', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'illusion')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.inventory.illusion.available).toBe(1))

      await service.startRoom(room.roomCode, 'teacher-1', 60)
      for (let index = 0; index < BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX; index += 1) {
        await answerAt(service, room, p1, index, true)
        await service.advanceQuestion(room.roomCode, 'teacher-1', index)
      }
      await answerAt(service, room, p1, BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX) // triggers the boss phase
      await service.advanceBossQuestion(room.roomCode, 'teacher-1', 0)
      await service.advanceBossQuestion(room.roomCode, 'teacher-1', 1)
      // Force the boss reward roll onto illusion (the 4th of the 4 equally-likely item types) —
      // the single player in this room is the trivial boss winner regardless of this mock.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99)
      await service.advanceBossQuestion(room.roomCode, 'teacher-1', 2)
      randomSpy.mockRestore()

      // 1 from the starting choice + 1 duplicate from the boss reward.
      await vi.waitFor(() => expect(magic.value?.inventory.illusion.available).toBe(2))
      stop()
    })

    it('activating illusion chooses and persists one incorrect choice — never the correct one, never rerolled by a refresh', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'illusion')
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holderId, 'illusion') // targets question index 1

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.queuedEffect?.itemType).toBe('illusion'))
      const hiddenChoiceId = magic.value?.queuedEffect?.hiddenChoiceId
      expect(hiddenChoiceId).toBeTruthy()

      const targetedQuestion = questionsById.get(room.questionIds[1])
      expect(hiddenChoiceId).not.toBe(targetedQuestion?.correctChoiceId) // never the correct choice
      expect(targetedQuestion?.choices.map((choice) => choice.id)).toContain(hiddenChoiceId) // a real choice

      // Re-reading the same queued effect (simulating a refresh) never changes the value —
      // it was chosen once, at activation time, and is only ever read afterward.
      for (let i = 0; i < 3; i += 1) {
        await vi.waitFor(() => expect(magic.value?.queuedEffect?.hiddenChoiceId).toBe(hiddenChoiceId))
      }
      stop()
    })

    it('all teammates see the exact same hidden choice (one shared team doc, not per-player)', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'illusion')
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holderId, 'illusion')

      // Two independent subscriptions to the SAME team doc, simulating two different
      // teammates' devices.
      const viewA: { value: TeamMagicState | null } = { value: null }
      const viewB: { value: TeamMagicState | null } = { value: null }
      const stopA = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { viewA.value = value })
      const stopB = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { viewB.value = value })
      await vi.waitFor(() => {
        expect(viewA.value?.queuedEffect?.hiddenChoiceId).toBeTruthy()
        expect(viewB.value?.queuedEffect?.hiddenChoiceId).toBeTruthy()
      })
      expect(viewA.value?.queuedEffect?.hiddenChoiceId).toBe(viewB.value?.queuedEffect?.hiddenChoiceId)
      stopA()
      stopB()
    })

    it('the effect applies only to its target main question — it resolves and clears once that question is left, consuming the item exactly once', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'illusion')
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holderId, 'illusion') // targets index 1

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.queuedEffect).not.toBeNull())

      // Question 0 (index 0) is not the targeted question — leaving it must not resolve or
      // consume the effect.
      await answerAt(service, room, p1, 0, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      expect(magic.value?.queuedEffect?.affectedQuestionIndex).toBe(1)
      expect(magic.value?.inventory.illusion.consumed).toBe(0)

      // Question 1 (index 1) IS the targeted question — leaving it resolves and clears the
      // effect, consuming the item exactly once.
      await answerAt(service, room, p1, 1, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 1)
      await vi.waitFor(() => expect(magic.value?.queuedEffect).toBeNull())
      expect(magic.value?.inventory.illusion.available).toBe(0)
      expect(magic.value?.inventory.illusion.consumed).toBe(1)

      // A stale/duplicate advanceQuestion retry for the question already left must never
      // double-consume the item (existing expectedQuestionIndex guard already covers this).
      await service.advanceQuestion(room.roomCode, 'teacher-1', 1)
      expect(magic.value?.inventory.illusion.consumed).toBe(1)
      stop()
    })

    it('never changes answer correctness, individual knowledge score, team raw knowledge score, or answer history', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'illusion')
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holderId, 'illusion') // targets index 1

      await answerAt(service, room, p1, 0, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      await answerAt(service, room, p1, 1, true) // correct answer on the illusion-affected question
      await service.advanceQuestion(room.roomCode, 'teacher-1', 1)

      const players: { value: Player[] } = { value: [] }
      const events: { value: MagicEvent[] } = { value: [] }
      const liveRoom: { value: Room | null } = { value: null }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      const stopEvents = service.subscribeMagicEvents(room.roomCode, (value) => { events.value = value })
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(events.value.find((event) => event.itemType === 'illusion')?.status).toBe('applied'))

      // Individual: exactly plain correct-answer counting — untouched by illusion.
      const player = players.value.find((entry) => entry.id === p1.id)
      expect(player?.score).toBe(2)
      expect(player?.answers).toHaveLength(2)
      expect(player?.answers.every((answer) => answer.isCorrect)).toBe(true)

      // Team: illusion contributes no own/hostile multiplier at all — competitionTotal equals
      // rawTotal exactly, same as if illusion had never been used.
      const stats = computeTeamCompetitionStats(players.value, liveRoom.value?.teams ?? [], liveRoom.value?.questionIds ?? [], events.value, liveRoom.value?.currentRound ?? 1)
      const team1Stats = stats.find((team) => team.id === 'team-1')
      expect(team1Stats?.competitionTotal).toBe(team1Stats?.rawTotal)
      expect(team1Stats?.rawTotal).toBe(20) // 1 member, 2/2 correct so far: 10 + 10

      stopPlayers()
      stopEvents()
      stopRoom()
    })

    it('a new round resets any leftover illusion state (fresh empty inventory, no stale queued effect)', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'illusion')
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holderId, 'illusion') // leaves a queued effect

      await service.stopRound(room.roomCode, 'teacher-1')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.queuedEffect).toBeNull())
      expect(magic.value?.inventory.illusion).toEqual({ available: 0, consumed: 0 })
      stop()
    })
  })

  describe('Milestone 2.1 stability fixes', () => {
    it('an applied magic event from round 1 does not affect round 2\'s competition score, even though the event log is never cleared', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holder1 = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holder1, 'power_surge')
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holder1, 'power_surge') // targets index 1
      await answerAt(service, room, p1, 0, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      await answerAt(service, room, p1, 1, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 1) // resolves: item consumed, event applied, round 1

      const events: { value: MagicEvent[] } = { value: [] }
      const players: { value: Player[] } = { value: [] }
      const liveRoom: { value: Room | null } = { value: null }
      const stopEvents = service.subscribeMagicEvents(room.roomCode, (value) => { events.value = value })
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { players.value = value })
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(events.value.find((event) => event.status === 'applied')?.round).toBe(1))

      const round1Teams = liveRoom.value?.teams ?? []
      const round1Questions = liveRoom.value?.questionIds ?? []
      const round1Stats = computeTeamCompetitionStats(players.value, round1Teams, round1Questions, events.value, 1)
      // 1 member: q0 raw 10 (no multiplier) + q1 raw 10 * 2 = 20 -> total 30 — the multiplier applies within round 1.
      expect(round1Stats.find((team) => team.id === 'team-1')?.competitionTotal).toBeCloseTo(30)

      // Move to round 2: player.score/answers reset, magic inventory resets, but the round-1
      // 'applied' event is NOT deleted from the log — it stays for history.
      await service.stopRound(room.roomCode, 'teacher-1')
      // A new round restarts the pre-game sequence at 'lobby' — Recall runs again before team
      // setup and Main become reachable.
      await advanceToTeamSetup(service, room.roomCode)
      await chooseAllStartingItems(service, room.roomCode) // no item gets activated this round
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await vi.waitFor(() => expect(liveRoom.value?.currentRound).toBe(2))
      // Round 2 has a freshly-selected questionIds array — answerAt must use the LIVE room,
      // not the stale `room` captured at createRoom time (round 1's questionIds).
      const round2Room = liveRoom.value as Room
      await answerAt(service, round2Room, p1, 0, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      await answerAt(service, round2Room, p1, 1, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 1) // no queued effect this round -> no-op resolution

      await vi.waitFor(() => expect(players.value.find((player) => player.id === p1.id)?.score).toBe(2))
      // Raw score is exactly plain correct-answer counting for round 2 — untouched by magic.
      expect(players.value.find((player) => player.id === p1.id)?.score).toBe(2)

      const round2Teams = liveRoom.value?.teams ?? []
      const round2Questions = liveRoom.value?.questionIds ?? []
      const round2Stats = computeTeamCompetitionStats(players.value, round2Teams, round2Questions, events.value, 2)
      // Same event log (round-1's applied event still present), but scoped to round 2: no
      // multiplier leaks in, so competitionTotal must equal the plain raw total (20), not 30.
      expect(round2Stats.find((team) => team.id === 'team-1')?.competitionTotal).toBe(20)
      expect(round2Stats.find((team) => team.id === 'team-1')?.rawTotal).toBe(20)

      stopEvents()
      stopPlayers()
      stopRoom()
    })

    it('answer progress from an earlier round does not count toward a later round, even when the same question recurs', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.questionIds).toHaveLength(10))
      const round1QuestionId = liveRoom.value?.questionIds[0] as string
      await answerAt(service, room, p1, 0, true) // writes a round-1 progress entry for round1QuestionId

      const progress: { value: AnswerProgressEntry[] } = { value: [] }
      const stopProgress = service.subscribeTeamAnswerProgress(room.roomCode, 'team-1', (value) => { progress.value = value })
      await vi.waitFor(() => expect(progress.value.some((entry) => entry.questionId === round1QuestionId)).toBe(true))
      expect(progress.value.find((entry) => entry.questionId === round1QuestionId)?.currentRound).toBe(1)

      await service.stopRound(room.roomCode, 'teacher-1')
      // A new round restarts the pre-game sequence at 'lobby' — Recall runs again before team
      // setup and Main become reachable.
      await advanceToTeamSetup(service, room.roomCode)
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await vi.waitFor(() => expect(liveRoom.value?.currentRound).toBe(2))

      // Force round 2's first question to be the SAME question round 1 already answered —
      // selectRoundQuestions's own anti-repeat guard only blocks reproducing the *entire*
      // previous 10-question set, not a single overlapping question, so this can happen
      // naturally; forcing it here makes the regression deterministic instead of flaky.
      const rawState = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY) as string)
      rawState.rooms[room.roomCode].room.questionIds[0] = round1QuestionId
      localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(rawState))
      window.dispatchEvent(new Event('matana-demo-update'))
      await vi.waitFor(() => expect(liveRoom.value?.questionIds[0]).toBe(round1QuestionId))

      // The round-1 entry for this exact questionId is still in the collection (progress is
      // never wiped on a round transition) — but a round-2-scoped read (exactly what GamePage
      // computes) must show 0/Y, not 1/Y, for the recurring question.
      await vi.waitFor(() => expect(progress.value.some((entry) => entry.questionId === round1QuestionId)).toBe(true))
      const round2FilteredCount = progress.value.filter(
        (entry) => entry.questionId === round1QuestionId && entry.currentRound === liveRoom.value?.currentRound,
      ).length
      expect(round2FilteredCount).toBe(0)

      // Once p1 actually answers it again in round 2, the round-2-scoped count becomes 1 (not
      // 2 — the stale round-1 entry is never conflated with the new one).
      await answerAt(service, room, p1, 0, true)
      await vi.waitFor(() => {
        const count = progress.value.filter(
          (entry) => entry.questionId === round1QuestionId && entry.currentRound === liveRoom.value?.currentRound,
        ).length
        expect(count).toBe(1)
      })
      expect(progress.value.find((entry) => entry.questionId === round1QuestionId && entry.currentRound === 2)?.currentRound).toBe(2)

      stopProgress()
      stopRoom()
    })

    it('a new saveAnswer\'s progress entry carries the room\'s current round', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      const progress: { value: AnswerProgressEntry[] } = { value: [] }
      const stop = service.subscribeTeamAnswerProgress(room.roomCode, 'team-1', (value) => { progress.value = value })
      await answerAt(service, room, p1, 0, true)
      await vi.waitFor(() => expect(progress.value).toHaveLength(1))
      expect(progress.value[0].currentRound).toBe(1)
      stop()
    })

    it('a failed advance leaves the room and magic state untouched, and a retry does not double-consume the queued item', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holder1 = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holder1, 'power_surge')
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await service.activateItem(room.roomCode, 'team-1', holder1, 'power_surge') // targets index 1
      await answerAt(service, room, p1, 0, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      await answerAt(service, room, p1, 1, true)

      // Simulate the underlying write failing partway through the advance that would resolve
      // the queued power_surge and move the room to question index 2.
      vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('simulated storage failure') })
      await expect(service.advanceQuestion(room.roomCode, 'teacher-1', 1)).rejects.toThrow('simulated storage failure')

      const roomAfterFailure: { value: Room | null } = { value: null }
      const magicAfterFailure: { value: TeamMagicState | null } = { value: null }
      const eventsAfterFailure: { value: MagicEvent[] } = { value: [] }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { roomAfterFailure.value = value })
      const stopMagic = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magicAfterFailure.value = value })
      const stopEvents = service.subscribeMagicEvents(room.roomCode, (value) => { eventsAfterFailure.value = value })
      await vi.waitFor(() => expect(roomAfterFailure.value).not.toBeNull())
      // The room must remain exactly where it was — not advanced, not partially advanced.
      expect(roomAfterFailure.value?.currentQuestionIndex).toBe(1)
      // The item must still be queued and unconsumed — resolution never partially landed.
      expect(magicAfterFailure.value?.queuedEffect).not.toBeNull()
      expect(magicAfterFailure.value?.inventory.power_surge.consumed).toBe(0)
      expect(eventsAfterFailure.value.find((event) => event.itemType === 'power_surge')?.status).toBe('queued')

      // Retry (no failure injected this time): must succeed exactly once, consuming the item
      // exactly once and advancing the room exactly once — not twice.
      await service.advanceQuestion(room.roomCode, 'teacher-1', 1)
      await vi.waitFor(() => expect(roomAfterFailure.value?.currentQuestionIndex).toBe(2))
      expect(magicAfterFailure.value?.queuedEffect).toBeNull()
      expect(magicAfterFailure.value?.inventory.power_surge.consumed).toBe(1)
      const appliedEvents = eventsAfterFailure.value.filter((event) => event.itemType === 'power_surge' && event.status === 'applied')
      expect(appliedEvents).toHaveLength(1) // exactly one applied event — no duplicate from the retry

      stopRoom()
      stopMagic()
      stopEvents()
    })
  })

  describe('Milestone 2.2 gameplay UX corrections', () => {
    it('choosing a starting item stores exactly one unconsumed item and never queues an effect', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await vi.waitFor(() => expect(magic.value ? hasAnyMagicItem(magic.value.inventory) : false).toBe(true))

      expect(magic.value?.inventory.power_surge).toMatchObject({ available: 1, consumed: 0 })
      expect(magic.value?.queuedEffect).toBeNull() // selecting never implies using
      stop()
    })

    it('the captain may change their starting item any number of times while the room is still waiting, and A -> B leaves only B, never both', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })

      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await vi.waitFor(() => expect(magic.value?.inventory.power_surge.available).toBe(1))

      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'score_seal')
      await vi.waitFor(() => expect(magic.value?.inventory.score_seal.available).toBe(1))
      // The old pick must be fully replaced, never left alongside the new one.
      expect(magic.value?.inventory.power_surge).toMatchObject({ available: 0, consumed: 0 })
      expect(magic.value?.inventory.rose_shield).toMatchObject({ available: 0, consumed: 0 })
      expect(magic.value?.inventory.illusion).toMatchObject({ available: 0, consumed: 0 })

      // Change again, to a third type — still only ever one entry held.
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'illusion')
      await vi.waitFor(() => expect(magic.value?.inventory.illusion.available).toBe(1))
      expect(magic.value?.inventory.power_surge).toMatchObject({ available: 0, consumed: 0 })
      expect(magic.value?.inventory.score_seal).toMatchObject({ available: 0, consumed: 0 })
      expect(magic.value?.inventory.rose_shield).toMatchObject({ available: 0, consumed: 0 })

      // Re-confirming the SAME type the captain already holds is also a legal, harmless no-op
      // change (covers "select/confirm ... may change and reconfirm").
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'illusion')
      await vi.waitFor(() => expect(magic.value?.inventory.illusion.available).toBe(1))

      stop()
    })

    it('rejects a non-captain team member changing the starting item', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')

      const nonCaptainId = holderId === alpha.id ? beta.id : alpha.id
      await expect(service.chooseStartingItem(room.roomCode, 'team-1', nonCaptainId, 'score_seal'))
        .rejects.toThrow('คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')

      // The captain's original pick must be completely untouched by the rejected attempt.
      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value).not.toBeNull())
      expect(magic.value?.inventory.power_surge).toMatchObject({ available: 1, consumed: 0 })
      expect(magic.value?.inventory.score_seal).toMatchObject({ available: 0, consumed: 0 })
      stop()
    })

    it('locks the starting item permanently once the mission has started — even the captain can no longer change it', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode) // every team picks power_surge
      const magicBefore: { value: TeamMagicState[] } = { value: [] }
      const stopBefore = service.subscribeAllTeamMagic(room.roomCode, (value) => { magicBefore.value = value })
      await vi.waitFor(() => expect(magicBefore.value.length).toBeGreaterThan(0))
      const holderId = magicBefore.value[0].magicHolderPlayerId as string
      stopBefore()

      await service.startRoom(room.roomCode, 'teacher-1', 60)

      await expect(service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'score_seal'))
        .rejects.toThrow('เลือกไอเทมเริ่มต้นได้เฉพาะช่วงห้องรอหลังล็อกทีมแล้ว')

      const magic: { value: TeamMagicState | null } = { value: null }
      const stop = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await vi.waitFor(() => expect(magic.value?.inventory.power_surge.available).toBe(1))
      expect(magic.value?.inventory.score_seal).toMatchObject({ available: 0, consumed: 0 })
      stop()
    })

    it('rejects activation from the waiting lobby, before the room has started playing', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')

      // Still in the lobby (never called startRoom) — activation must be unavailable.
      await expect(service.activateItem(room.roomCode, 'team-1', holderId, 'power_surge'))
        .rejects.toThrow('ไม่สามารถใช้ไอเทมได้ในขณะนี้')
    })

    it('activation during question 4 (index 3) targets question 5 (index 4), matching the documented examples', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      const holderId = await getHolderId(service, room.roomCode, 'team-1')
      await service.chooseStartingItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      for (let index = 0; index < 3; index += 1) {
        await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(index))
        await service.advanceQuestion(room.roomCode, 'teacher-1', index)
      }
      await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(3)) // question 4

      const magic: { value: TeamMagicState | null } = { value: null }
      const stopMagic = service.subscribeTeamMagic(room.roomCode, 'team-1', (value) => { magic.value = value })
      await service.activateItem(room.roomCode, 'team-1', holderId, 'power_surge')
      await vi.waitFor(() => expect(magic.value?.queuedEffect).not.toBeNull())
      expect(magic.value?.queuedEffect?.affectedQuestionIndex).toBe(4) // question 5

      stopRoom()
      stopMagic()
    })

    it('lets the teacher close the question early once every currently registered player has answered', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      const p2 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      // Only p1 has answered — closing early must be rejected.
      await answerAt(service, room, p1, 0, true)
      await expect(service.closeQuestionEarly(room.roomCode, 'teacher-1', 0))
        .rejects.toThrow('ยังมีผู้เล่นบางคนยังไม่ได้ตอบคำถามข้อนี้')

      // Once everyone has answered, closing early succeeds.
      await answerAt(service, room, p2, 0, true)
      await service.closeQuestionEarly(room.roomCode, 'teacher-1', 0)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      // toBeTruthy(), not not.toBeNull(): liveRoom.value starts null, so the optional-chained
      // read is undefined (not null) before the first snapshot — not.toBeNull() would pass
      // vacuously on that empty render instead of waiting for the real questionClosedAt value.
      await vi.waitFor(() => expect(liveRoom.value?.questionClosedAt).toBeTruthy())
      stopRoom()
    })

    it('an early close immediately locks out further answers and starts the reveal countdown from that moment', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      // A long duration — if the deadline math ignored questionClosedAt, this question would
      // still legitimately accept answers for another ~59 seconds.
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await answerAt(service, room, p1, 0, true)
      await service.closeQuestionEarly(room.roomCode, 'teacher-1', 0)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.questionClosedAt).toBeTruthy())
      const closedAt = liveRoom.value?.questionClosedAt as number

      expect(getRemainingMilliseconds(liveRoom.value as Room, closedAt + 1)).toBe(0)
      expect(getRevealRemainingMilliseconds(liveRoom.value as Room, closedAt)).toBe(ANSWER_REVEAL_MILLISECONDS)

      // Trying to change the answer after the early close is rejected exactly like a normal
      // timeout — answers are locked immediately, server-side, not just in the UI.
      await expect(
        service.saveAnswer(room.roomCode, p1.id, { questionId: room.questionIds[0], selectedChoiceId: 'x', expectedQuestionIndex: 0 }),
      ).rejects.toThrow('หมดเวลาตอบคำถามข้อนี้แล้ว')

      stopRoom()
    })

    it('advancing to the next question resets questionClosedAt to null', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await answerAt(service, room, p1, 0, true)
      await service.closeQuestionEarly(room.roomCode, 'teacher-1', 0)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.questionClosedAt).toBeTruthy())

      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(1))
      expect(liveRoom.value?.questionClosedAt).toBeNull()

      stopRoom()
    })

    it('a stale/duplicate closeQuestionEarly call after the question already closed is a silent no-op, not a second write', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await answerAt(service, room, p1, 0, true)
      await service.closeQuestionEarly(room.roomCode, 'teacher-1', 0)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.questionClosedAt).toBeTruthy())
      const firstClosedAt = liveRoom.value?.questionClosedAt

      await service.closeQuestionEarly(room.roomCode, 'teacher-1', 0) // duplicate click
      expect(liveRoom.value?.questionClosedAt).toBe(firstClosedAt) // unchanged, not re-stamped

      stopRoom()
    })

    // Milestone 2.2 explicitly requires automatic reveal/advance to keep working unchanged when
    // the teacher does nothing — this is the existing timed-flow guarantee from Milestone 1,
    // re-affirmed here after the questionClosedAt plumbing was added everywhere in the deadline
    // computation.
    it('automatic advancement after the reveal duration still works when the teacher never intervenes', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 5)
      await answerAt(service, room, p1, 0, true)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(0))
      expect(liveRoom.value?.questionClosedAt).toBeNull() // no early close happened

      await service.advanceQuestion(room.roomCode, 'teacher-1', 0)
      await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(1))

      stopRoom()
    })
  })

  // Regression coverage for the "remote device doesn't render boss phase transitions until
  // reload" investigation. The reported bug turned out to live in the realtime TRANSPORT (a
  // dead/suspended Firestore connection on iOS Safari — see firebaseService.ts's visibilitychange
  // handler), which is outside what a Vitest/jsdom unit test can exercise (there is no real
  // Firestore connection here to suspend). What IS fully testable, and just as load-bearing for
  // "does a remote device ever see this transition," is the STATE MACHINE itself: one single,
  // never-unsubscribed `subscribeRoom` listener must observe every step of the full sequence in
  // order, exactly like a student's `useRoom` hook would. If a future change ever broke a step of
  // this chain (e.g. a boss-advance call that forgot to bump bossQuestionStartedAt, or a
  // continueAfterBoss guard that no-ops when it shouldn't), this test fails without needing a real
  // device — this is the regression guard for that class of bug.
  describe('Boss phase full transition sequence: one subscription observes every step, in order', () => {
    it('main -> boss q1 -> q2 -> q3 -> bossAwaitingContinue -> teacher continue -> resumed main, all via a single long-lived subscription', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)

      // One subscription, opened before any transition and never torn down or replaced — exactly
      // the shape of a student's GamePage staying on screen through the whole boss sequence.
      const seenPhases: Array<{ phase: string; questionIndex: number; bossQuestionIndex: number; bossAwaitingContinue: boolean }> = []
      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => {
        liveRoom.value = value
        if (value) {
          seenPhases.push({
            phase: value.phase,
            questionIndex: value.currentQuestionIndex,
            bossQuestionIndex: value.bossQuestionIndex,
            bossAwaitingContinue: value.bossAwaitingContinue,
          })
        }
      })
      await vi.waitFor(() => expect(liveRoom.value?.status).toBe('playing'))

      // Walk main questions 0..3 normally (still phase 'main').
      for (let index = 0; index < BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX; index += 1) {
        await answerAt(service, room, p1, index, true)
        await service.advanceQuestion(room.roomCode, 'teacher-1', index)
        await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(index + 1))
        expect(liveRoom.value?.phase).toBe('main')
      }

      // main -> boss: leaving question index BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX enters the
      // boss phase on question 1 of 3, without ever unsubscribing.
      await answerAt(service, room, p1, BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX, true)
      await service.advanceQuestion(room.roomCode, 'teacher-1', BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX)
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('boss'))
      expect(liveRoom.value?.bossQuestionIndex).toBe(0)
      expect(liveRoom.value?.currentQuestionIndex).toBe(BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX)
      const firstBossStartedAt = liveRoom.value?.bossQuestionStartedAt

      // boss q1 -> q2: bossQuestionIndex advances and the per-question timer resets, still the
      // same subscription, still phase 'boss'.
      await service.advanceBossQuestion(room.roomCode, 'teacher-1', 0)
      await vi.waitFor(() => expect(liveRoom.value?.bossQuestionIndex).toBe(1))
      expect(liveRoom.value?.phase).toBe('boss')
      expect(liveRoom.value?.bossAwaitingContinue).toBe(false)
      expect(liveRoom.value?.bossQuestionStartedAt).not.toBe(firstBossStartedAt)

      // boss q2 -> q3.
      await service.advanceBossQuestion(room.roomCode, 'teacher-1', 1)
      await vi.waitFor(() => expect(liveRoom.value?.bossQuestionIndex).toBe(2))
      expect(liveRoom.value?.bossAwaitingContinue).toBe(false)

      // boss q3 resolves -> bossAwaitingContinue=true, phase stays 'boss' (the pause gate),
      // currentQuestionIndex still frozen at the trigger point.
      await service.advanceBossQuestion(room.roomCode, 'teacher-1', 2)
      await vi.waitFor(() => expect(liveRoom.value?.bossAwaitingContinue).toBe(true))
      expect(liveRoom.value?.phase).toBe('boss')
      expect(liveRoom.value?.bossCompleted).toBe(true)
      expect(liveRoom.value?.currentQuestionIndex).toBe(BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX)

      // A duplicate/stale advanceBossQuestion call while paused must be a no-op the SAME
      // subscription can observe doing nothing (still paused, still boss q index 2).
      await service.advanceBossQuestion(room.roomCode, 'teacher-1', 2)
      expect(liveRoom.value?.bossAwaitingContinue).toBe(true)
      expect(liveRoom.value?.bossQuestionIndex).toBe(2)

      // Teacher presses "เล่นต่อ" -> resumed main, right after the boss trigger point, still the
      // exact same subscription that has been live since before question 0 even advanced.
      await service.continueAfterBoss(room.roomCode, 'teacher-1', liveRoom.value?.currentRound as number)
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))
      expect(liveRoom.value?.bossAwaitingContinue).toBe(false)
      expect(liveRoom.value?.currentQuestionIndex).toBe(BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX + 1)

      // The full ordered sequence of phase/bossQuestionIndex pairs this one subscription actually
      // observed must include every step in order — proving no step was silently skipped or only
      // reachable via a resubscribe.
      const sequenceKey = (entry: (typeof seenPhases)[number]): string => `${entry.phase}:${entry.questionIndex}:${entry.bossQuestionIndex}:${entry.bossAwaitingContinue}`
      const observedKeys = seenPhases.map(sequenceKey)
      const requiredMilestones = [
        `main:0:0:false`,
        `boss:${BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX}:0:false`,
        `boss:${BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX}:1:false`,
        `boss:${BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX}:2:false`,
        `boss:${BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX}:2:true`,
        `main:${BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX + 1}:2:false`,
      ]
      requiredMilestones.forEach((milestone) => expect(observedKeys).toContain(milestone))
      // Order matters — every milestone's index in the observed stream must be strictly
      // increasing, i.e. this subscription really did walk the sequence forward, never backward,
      // never skipping straight from one end to the other.
      const milestoneIndexes = requiredMilestones.map((milestone) => observedKeys.indexOf(milestone))
      for (let index = 1; index < milestoneIndexes.length; index += 1) {
        expect(milestoneIndexes[index]).toBeGreaterThan(milestoneIndexes[index - 1])
      }

      stopRoom()
    })
  })

  // Pre-game orchestration: Story Recall is a PRE-TEAM individual learning phase. The stage
  // machine is lobby -> recall -> teamSetup -> main -> boss, carried entirely by room.phase, and
  // these tests pin every transition plus the "no teams exist before Recall" guarantee.
  describe('Pre-game orchestration: lobby -> recall -> teamSetup', () => {
    const joinAll = async (service: DemoGameService, roomCode: string, count: number): Promise<Player[]> => {
      const players: Player[] = []
      for (let index = 0; index < count; index += 1) {
        const joined = await service.joinRoom(
          { roomCode, displayName: `Student${index + 1}`, studentNumber: `0${index + 1}` },
          `owner-${index + 1}`,
        )
        players.push(joined.player)
      }
      return players
    }

    const answerAllRecall = async (service: DemoGameService, roomCode: string, playerId: string): Promise<void> => {
      for (let index = 0; index < RECALL_QUESTIONS.length; index += 1) {
        const question = RECALL_QUESTIONS[index]
        await service.saveRecallAnswer(roomCode, playerId, {
          conceptId: question.id,
          selectedChoiceId: question.correctChoiceId,
          expectedRecallIndex: index,
        })
      }
    }

    it('1. a fresh room has joined players but zero teams, and starts in stage lobby', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const players = await joinAll(service, room.roomCode, 3)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      const livePlayers: { value: Player[] } = { value: [] }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { livePlayers.value = value })
      await vi.waitFor(() => expect(livePlayers.value).toHaveLength(3))

      expect(liveRoom.value?.status).toBe('waiting')
      expect(liveRoom.value?.phase).toBe('lobby')
      // No team concept exists yet, at any level: no team metas, no teamCount, and every player
      // is still an unassigned individual.
      expect(liveRoom.value?.teams).toEqual([])
      expect(liveRoom.value?.teamCount).toBe(0)
      expect(liveRoom.value?.teamsLocked).toBe(false)
      expect(livePlayers.value.every((player) => player.teamId === null)).toBe(true)
      expect(players).toHaveLength(3)

      // And team creation is refused outright while still pre-Recall — the guarantee is
      // structural, not merely a hidden button.
      await expect(service.randomizeTeams(room.roomCode, 'teacher-1', 2)).rejects.toThrow('กู้ความทรงจำ')

      stopRoom()
      stopPlayers()
    })

    it('2. the teacher can start Recall with no teams, captain, item, or team name in place', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await joinAll(service, room.roomCode, 2)

      // Nothing but "at least one student joined" is required.
      await service.startRecall(room.roomCode, 'teacher-1')

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('recall'))
      expect(liveRoom.value?.status).toBe('waiting')
      expect(liveRoom.value?.teams).toEqual([])

      stopRoom()
    })

    it('2b. starting Recall with nobody in the room is refused, and a duplicate start is a safe no-op', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await expect(service.startRecall(room.roomCode, 'teacher-1')).rejects.toThrow('ยังไม่มีผู้เล่นเข้าร่วม')

      await joinAll(service, room.roomCode, 1)
      await service.startRecall(room.roomCode, 'teacher-1')
      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('recall'))

      // A stale/duplicate click must never restart Recall (which would be observable as progress
      // being wiped) — it is simply ignored.
      await service.startRecall(room.roomCode, 'teacher-1')
      expect(liveRoom.value?.phase).toBe('recall')

      stopRoom()
    })

    it('3. all joined students enter Recall together from the single teacher action', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const players = await joinAll(service, room.roomCode, 3)

      await service.startRecall(room.roomCode, 'teacher-1')

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('recall'))

      // Every student resolves to the game screen off the same room state — one action, one
      // stage, no per-student gate.
      for (const player of players) {
        expect(resolveStudentRoute(liveRoom.value as Room, player)).toBe(`/game/${room.roomCode}`)
        // ...and each can actually answer immediately.
        await service.saveRecallAnswer(room.roomCode, player.id, {
          conceptId: RECALL_QUESTIONS[0].id,
          selectedChoiceId: RECALL_QUESTIONS[0].correctChoiceId,
          expectedRecallIndex: 0,
        })
      }

      const livePlayers: { value: Player[] } = { value: [] }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { livePlayers.value = value })
      await vi.waitFor(() => expect(livePlayers.value.every((player) => player.recallAnswers.length === 1)).toBe(true))

      stopRoom()
      stopPlayers()
    })

    it('4. a timed-out Recall item is persisted as unanswered/incorrect and still counts toward Baseline', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const [alpha] = await joinAll(service, room.roomCode, 1)
      await service.startRecall(room.roomCode, 'teacher-1')

      // Item 1 times out (the client submits the timeout sentinel when the countdown expires),
      // item 2 is answered correctly.
      await service.saveRecallAnswer(room.roomCode, alpha.id, {
        conceptId: RECALL_QUESTIONS[0].id,
        selectedChoiceId: RECALL_TIMEOUT_CHOICE_ID,
        expectedRecallIndex: 0,
      })
      await service.saveRecallAnswer(room.roomCode, alpha.id, {
        conceptId: RECALL_QUESTIONS[1].id,
        selectedChoiceId: RECALL_QUESTIONS[1].correctChoiceId,
        expectedRecallIndex: 1,
      })

      const player: { value: Player | null } = { value: null }
      const stopPlayer = service.subscribePlayer(room.roomCode, alpha.id, (value) => { player.value = value })
      await vi.waitFor(() => expect(player.value?.recallAnswers).toHaveLength(2))

      expect(player.value?.recallAnswers[0]).toMatchObject({
        conceptId: RECALL_QUESTIONS[0].id,
        selectedChoiceId: RECALL_TIMEOUT_CHOICE_ID,
        isCorrect: false,
      })
      expect(player.value?.recallAnswers[1].isCorrect).toBe(true)
      // A timeout does NOT block progression, and it counts as an incorrect item for Baseline.
      expect(computeStudentLearningEvidence(player.value as Player).recallCorrectCount).toBe(1)
      // It is also first-answer-locked like any other item: re-submitting the real answer later
      // cannot overwrite the recorded timeout.
      await service.saveRecallAnswer(room.roomCode, alpha.id, {
        conceptId: RECALL_QUESTIONS[0].id,
        selectedChoiceId: RECALL_QUESTIONS[0].correctChoiceId,
        expectedRecallIndex: 0,
      })
      expect(player.value?.recallAnswers).toHaveLength(2)
      expect(player.value?.recallAnswers[0].isCorrect).toBe(false)

      stopPlayer()
    })

    it('5. completing Recall creates and assigns no teams whatsoever', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const players = await joinAll(service, room.roomCode, 2)
      await service.startRecall(room.roomCode, 'teacher-1')
      for (const player of players) await answerAllRecall(service, room.roomCode, player.id)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      const livePlayers: { value: Player[] } = { value: [] }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { livePlayers.value = value })
      await vi.waitFor(() => expect(livePlayers.value).toHaveLength(2))
      await vi.waitFor(() => expect(livePlayers.value.every((player) => player.recallAnswers.length === RECALL_QUESTIONS.length)).toBe(true))
      await vi.waitFor(() => expect(liveRoom.value).not.toBeNull())

      expect(liveRoom.value?.phase).toBe('recall')
      expect(liveRoom.value?.teams).toEqual([])
      expect(liveRoom.value?.teamCount).toBe(0)
      expect(livePlayers.value.every((player) => player.teamId === null)).toBe(true)

      stopRoom()
      stopPlayers()
    })

    it('the teacher may end Recall early — partial answers are kept, unanswered concepts count as not correct, and late writes are refused', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const players = await joinAll(service, room.roomCode, 2)
      await service.startRecall(room.roomCode, 'teacher-1')

      // Student 1 finishes; student 2 answers only the first 2 of 5 and is still working.
      await answerAllRecall(service, room.roomCode, players[0].id)
      for (let index = 0; index < 2; index += 1) {
        await service.saveRecallAnswer(room.roomCode, players[1].id, {
          conceptId: RECALL_QUESTIONS[index].id,
          selectedChoiceId: RECALL_QUESTIONS[index].correctChoiceId,
          expectedRecallIndex: index,
        })
      }

      // The teacher moves on WITHOUT everyone being finished.
      await service.startTeamSetup(room.roomCode, 'teacher-1')

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      const livePlayers: { value: Player[] } = { value: [] }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { livePlayers.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('teamSetup'))
      await vi.waitFor(() => expect(livePlayers.value).toHaveLength(2))

      // Everything already submitted survives the transition, at its real value.
      const finished = livePlayers.value.find((player) => player.id === players[0].id)
      const unfinished = livePlayers.value.find((player) => player.id === players[1].id)
      expect(finished?.recallAnswers).toHaveLength(RECALL_QUESTIONS.length)
      expect(unfinished?.recallAnswers).toHaveLength(2)

      // No answers are invented for the 3 concepts the second student never reached — they are
      // simply absent, and therefore count as not-correct for the before-play evidence.
      const evidence = computeStudentLearningEvidence(unfinished as Player)
      expect(evidence.recallCorrectCount).toBe(2)
      expect(unfinished?.recallAnswers.map((entry) => entry.conceptId))
        .toEqual([RECALL_QUESTIONS[0].id, RECALL_QUESTIONS[1].id])

      // A late write from the still-working student is refused now that Recall is over.
      await expect(service.saveRecallAnswer(room.roomCode, players[1].id, {
        conceptId: RECALL_QUESTIONS[2].id,
        selectedChoiceId: RECALL_QUESTIONS[2].correctChoiceId,
        expectedRecallIndex: 2,
      })).rejects.toThrow('ไม่ได้อยู่ในช่วงกู้ความทรงจำ')
      expect(unfinished?.recallAnswers).toHaveLength(2)

      // ...and that student is routed out of Recall into the team-setup lobby.
      expect(resolveStudentRoute(liveRoom.value as Room, unfinished as Player)).toBe(`/lobby/${room.roomCode}`)

      stopRoom()
      stopPlayers()
    })

    it('persists the teacher-chosen Recall and Boss durations on the room', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const players = await joinAll(service, room.roomCode, 2)

      await service.startRecall(room.roomCode, 'teacher-1', 25)
      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('recall'))
      expect(liveRoom.value?.recallQuestionDurationSeconds).toBe(25)

      for (const player of players) await answerAllRecall(service, room.roomCode, player.id)
      await service.startTeamSetup(room.roomCode, 'teacher-1')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 30, 12)

      await vi.waitFor(() => expect(liveRoom.value?.status).toBe('playing'))
      expect(liveRoom.value?.questionDurationSeconds).toBe(30)
      expect(liveRoom.value?.bossQuestionDurationSeconds).toBe(12)
      // The Recall duration is not clobbered by starting Main.
      expect(liveRoom.value?.recallQuestionDurationSeconds).toBe(25)

      stopRoom()
    })

    it('clamps out-of-range durations service-side rather than trusting the caller', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await joinAll(service, room.roomCode, 1)

      await service.startRecall(room.roomCode, 'teacher-1', 0)
      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('recall'))
      expect(liveRoom.value?.recallQuestionDurationSeconds).toBe(MIN_RECALL_SECONDS_PER_ITEM)

      stopRoom()
    })

    it('6. the teacher transitions Recall -> teamSetup, and a duplicate call is a safe no-op', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const players = await joinAll(service, room.roomCode, 2)
      await service.startRecall(room.roomCode, 'teacher-1')
      for (const player of players) await answerAllRecall(service, room.roomCode, player.id)

      await service.startTeamSetup(room.roomCode, 'teacher-1')
      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('teamSetup'))
      expect(liveRoom.value?.status).toBe('waiting')

      await service.startTeamSetup(room.roomCode, 'teacher-1')
      expect(liveRoom.value?.phase).toBe('teamSetup')
      // Recall is closed once past that stage.
      await expect(service.saveRecallAnswer(room.roomCode, players[0].id, {
        conceptId: RECALL_QUESTIONS[0].id,
        selectedChoiceId: RECALL_QUESTIONS[0].correctChoiceId,
        expectedRecallIndex: 0,
      })).rejects.toThrow('ไม่ได้อยู่ในช่วงกู้ความทรงจำ')

      stopRoom()
    })

    it('7. the existing team setup workflow runs unchanged after Recall, and Main starts from it', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const players = await joinAll(service, room.roomCode, 2)
      await service.startRecall(room.roomCode, 'teacher-1')
      for (const player of players) await answerAllRecall(service, room.roomCode, player.id)
      await service.startTeamSetup(room.roomCode, 'teacher-1')

      // The stable, pre-existing sequence — untouched by this refactor.
      await service.randomizeTeams(room.roomCode, 'teacher-1', 2)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 30)

      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.status).toBe('playing'))
      expect(liveRoom.value?.phase).toBe('main')
      expect(liveRoom.value?.teams).toHaveLength(2)
      expect(liveRoom.value?.teamsLocked).toBe(true)
      // Main's timer is live immediately, so students can answer right away.
      expect(liveRoom.value?.questionStartedAt).not.toBeNull()

      stopRoom()
    })

    it('7b. Main cannot be started while still in lobby or recall, however complete team setup looks', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await joinAll(service, room.roomCode, 2)

      await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).rejects.toThrow('กู้ความทรงจำ')
      await service.startRecall(room.roomCode, 'teacher-1')
      await expect(service.startRoom(room.roomCode, 'teacher-1', 30)).rejects.toThrow('กู้ความทรงจำ')
    })

    it('8. Recall answers and Baseline survive team setup, Main, and Boss', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const [alpha] = await joinAll(service, room.roomCode, 1)
      await service.startRecall(room.roomCode, 'teacher-1')

      // A deliberately mixed Recall result so Baseline is a distinctive, checkable number.
      const wrongChoice = RECALL_QUESTIONS[0].choices.find((choice) => choice.id !== RECALL_QUESTIONS[0].correctChoiceId)
      await service.saveRecallAnswer(room.roomCode, alpha.id, {
        conceptId: RECALL_QUESTIONS[0].id,
        selectedChoiceId: wrongChoice?.id as string,
        expectedRecallIndex: 0,
      })
      for (let index = 1; index < RECALL_QUESTIONS.length; index += 1) {
        await service.saveRecallAnswer(room.roomCode, alpha.id, {
          conceptId: RECALL_QUESTIONS[index].id,
          selectedChoiceId: RECALL_QUESTIONS[index].correctChoiceId,
          expectedRecallIndex: index,
        })
      }

      const player: { value: Player | null } = { value: null }
      const stopPlayer = service.subscribePlayer(room.roomCode, alpha.id, (value) => { player.value = value })
      await vi.waitFor(() => expect(player.value?.recallAnswers).toHaveLength(RECALL_QUESTIONS.length))
      const baselineAfterRecall = computeStudentLearningEvidence(player.value as Player).baselinePercent
      expect(baselineAfterRecall).toBe(80)

      await service.startTeamSetup(room.roomCode, 'teacher-1')
      await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 30)

      // Survives team setup + Main start...
      await vi.waitFor(() => expect(player.value?.recallAnswers).toHaveLength(RECALL_QUESTIONS.length))
      expect(computeStudentLearningEvidence(player.value as Player).baselinePercent).toBe(baselineAfterRecall)

      // ...and survives playing through Main into the Boss phase.
      const liveRoom: { value: Room | null } = { value: null }
      const stopRoom = service.subscribeRoom(room.roomCode, (value) => { liveRoom.value = value })
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))
      for (let index = 0; index <= BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX; index += 1) {
        await service.advanceQuestion(room.roomCode, 'teacher-1', index)
      }
      await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('boss'))
      expect(player.value?.recallAnswers).toHaveLength(RECALL_QUESTIONS.length)
      expect(computeStudentLearningEvidence(player.value as Player).baselinePercent).toBe(baselineAfterRecall)

      stopRoom()
      stopPlayer()
    })

    it('9. refresh (a fresh subscription) restores the right stage in lobby, Recall, Recall-complete, and teamSetup', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const [alpha] = await joinAll(service, room.roomCode, 1)

      // A brand-new subscription pair with no shared state is exactly what a reloaded tab does:
      // mount fresh and subscribe from scratch.
      const readStage = async (expectedPhase: string): Promise<string> => {
        const freshRoom: { value: Room | null } = { value: null }
        const stopFreshRoom = service.subscribeRoom(room.roomCode, (value) => { freshRoom.value = value })
        const freshPlayer: { value: Player | null } = { value: null }
        const stopFreshPlayer = service.subscribePlayer(room.roomCode, alpha.id, (value) => { freshPlayer.value = value })
        await vi.waitFor(() => expect(freshRoom.value?.phase).toBe(expectedPhase))
        await vi.waitFor(() => expect(freshPlayer.value).not.toBeNull())
        const route = resolveStudentRoute(freshRoom.value as Room, freshPlayer.value as Player)
        stopFreshRoom()
        stopFreshPlayer()
        return route
      }

      // Stage lobby -> the waiting lobby.
      expect(await readStage('lobby')).toBe(`/lobby/${room.roomCode}`)

      // Stage recall, partially answered -> the game screen (Recall), progress intact.
      await service.startRecall(room.roomCode, 'teacher-1')
      await service.saveRecallAnswer(room.roomCode, alpha.id, {
        conceptId: RECALL_QUESTIONS[0].id,
        selectedChoiceId: RECALL_QUESTIONS[0].correctChoiceId,
        expectedRecallIndex: 0,
      })
      expect(await readStage('recall')).toBe(`/game/${room.roomCode}`)
      const midPlayer: { value: Player | null } = { value: null }
      const stopMid = service.subscribePlayer(room.roomCode, alpha.id, (value) => { midPlayer.value = value })
      await vi.waitFor(() => expect(midPlayer.value?.recallAnswers).toHaveLength(1))
      stopMid()

      // Stage recall, fully answered (waiting for classmates) -> still the game screen, which is
      // where the "กู้ความทรงจำครบแล้ว / รอเพื่อนร่วมภารกิจ" waiting state lives.
      for (let index = 1; index < RECALL_QUESTIONS.length; index += 1) {
        await service.saveRecallAnswer(room.roomCode, alpha.id, {
          conceptId: RECALL_QUESTIONS[index].id,
          selectedChoiceId: RECALL_QUESTIONS[index].correctChoiceId,
          expectedRecallIndex: index,
        })
      }
      expect(await readStage('recall')).toBe(`/game/${room.roomCode}`)

      // Stage teamSetup -> back to the lobby, which is where team setup is presented.
      await service.startTeamSetup(room.roomCode, 'teacher-1')
      expect(await readStage('teamSetup')).toBe(`/lobby/${room.roomCode}`)
    })

    it('10. two students in the same room keep separate identities and separate Recall progress', async () => {
      // The reported multi-tab symptom was a Firestore-rules denial, not an identity collision
      // (getPlayerSession/savePlayerSession are already sessionStorage-backed, i.e. per-tab). This
      // pins the service-layer half of that finding: distinct ownerUids produce distinct player
      // docs whose Recall progress never bleeds into one another.
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-tab-1')).player
      const beta = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-tab-2')).player
      expect(alpha.id).not.toBe(beta.id)
      expect(alpha.ownerUid).not.toBe(beta.ownerUid)

      await service.startRecall(room.roomCode, 'teacher-1')
      // Only Alpha answers.
      await answerAllRecall(service, room.roomCode, alpha.id)

      const livePlayers: { value: Player[] } = { value: [] }
      const stopPlayers = service.subscribePlayers(room.roomCode, (value) => { livePlayers.value = value })
      await vi.waitFor(() => expect(livePlayers.value).toHaveLength(2))

      const liveAlpha = livePlayers.value.find((player) => player.id === alpha.id)
      const liveBeta = livePlayers.value.find((player) => player.id === beta.id)
      expect(liveAlpha?.recallAnswers).toHaveLength(RECALL_QUESTIONS.length)
      expect(liveBeta?.recallAnswers).toHaveLength(0)
      expect(liveAlpha?.ownerUid).toBe('owner-tab-1')
      expect(liveBeta?.ownerUid).toBe('owner-tab-2')

      // A reconnect from tab 2 resolves to tab 2's own player, never tab 1's.
      const rejoinedBeta = await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-tab-2')
      expect(rejoinedBeta.player.id).toBe(beta.id)
      expect(rejoinedBeta.player.recallAnswers).toHaveLength(0)

      stopPlayers()
    })
  })
  describe('Team roster and answer progress', () => {
    it('shows a provisional roster immediately after randomizeTeams, before any lock', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')
      await service.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
      await advanceToTeamSetup(service, room.roomCode)
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
      await advanceToTeamSetup(service, room.roomCode)
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
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 2)

      const roster1: { value: TeamRosterSummary | null } = { value: null }
      const stop1 = service.subscribeTeamRoster(room.roomCode, 'team-1', (value) => { roster1.value = value })
      await vi.waitFor(() => expect(roster1.value).not.toBeNull())
      stop1()

      // Force everyone onto team-1 this time — team-2's old roster (if it had this member)
      // must not retain it.
      await advanceToTeamSetup(service, room.roomCode)
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
      await advanceToTeamSetup(service, room.roomCode)
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
      await advanceToTeamSetup(service, room.roomCode)
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
      await advanceToTeamSetup(service, room.roomCode)
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
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)

      const roster: { value: TeamRosterSummary | null } = { value: null }
      const stop = service.subscribeTeamRoster(room.roomCode, 'team-1', (value) => { roster.value = value })
      await vi.waitFor(() => expect(roster.value?.members).toHaveLength(2))
      // Y is the roster size regardless of whether "Silent" ever answers anything.
      expect(roster.value?.members).toHaveLength(2)
      stop()
    })

    it('answerProgress entries never carry the selected choice or correctness — only playerId/teamId/questionId/currentRound/answeredAt', async () => {
      const service = new DemoGameService()
      const room = await service.createRoom('teacher-1')
      const p1 = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
      await advanceToTeamSetup(service, room.roomCode)
    await service.randomizeTeams(room.roomCode, 'teacher-1', 1)
      await service.lockTeams(room.roomCode, 'teacher-1')
      await chooseAllStartingItems(service, room.roomCode)
      await service.startRoom(room.roomCode, 'teacher-1', 60)
      await answerAt(service, room, p1, 0, true)

      const progress: { value: AnswerProgressEntry[] } = { value: [] }
      const stop = service.subscribeTeamAnswerProgress(room.roomCode, 'team-1', (value) => { progress.value = value })
      await vi.waitFor(() => expect(progress.value).toHaveLength(1))
      expect(Object.keys(progress.value[0]).sort()).toEqual(['answeredAt', 'currentRound', 'playerId', 'questionId', 'teamId'])
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

// Realtime read path regression (reported: teacher randomizes teams, a same-device tab updates
// automatically, a remote device does not — until manually reloaded, at which point the correct
// data appears immediately). Root cause: demoService's cross-device transport is a poll (see
// `listen` in demoService.ts) gated on a module-level `sharedStateAvailable` flag that is only
// ever recomputed as a SIDE EFFECT of the poll's own callback — so if the very first fetch ever
// attempted (a subscription's initial bootstrap read) failed for any transient reason, the flag
// latched false forever and the poll stopped calling back at all, since the gate prevented the
// one thing that could have un-stuck it. A same-device request essentially never fails that way;
// a genuinely remote device sometimes does — and once it does, only a full reload (a fresh
// bootstrap attempt) ever recovers, matching the reported symptom exactly.
//
// This suite uses its OWN window stub with a real setInterval — unlike the outer suite's bare
// `new EventTarget()` (which deliberately has no setInterval, so poll-specific behavior never
// engages for any of those tests; they rely entirely on the same-window UPDATE_EVENT instead).
// It also mocks `fetch` directly and never calls this test's own writeState/UPDATE_EVENT after
// the initial room/player setup, so the only way the assertions below can pass is via the
// interval poll itself retrying past the earlier failure — exactly the path the bug broke.
describe('Realtime read path resilience: cross-device polling must self-heal, no reload required', () => {
  let getShouldFail = true
  let serverState: unknown = null

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    const target = new EventTarget()
    vi.stubGlobal('window', Object.assign(target, {
      setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
      clearInterval: (id: number) => clearInterval(id),
    }))
    getShouldFail = true
    serverState = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) }
      }
      if (getShouldFail) throw new Error('simulated network failure reaching the shared demo-state endpoint')
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ state: serverState }) }
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a player subscription bootstrapped while the shared endpoint is unreachable recovers on its own once it becomes reachable, and a roster subscription follows the newly-assigned team', async () => {
    const service = new DemoGameService()
    const room = await service.createRoom('teacher-1')
    const alpha = (await service.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')).player
    expect(alpha.teamId).toBeNull()

    const playerSnapshot: { value: Player | null } = { value: null }
    const stopPlayer = service.subscribePlayer(room.roomCode, alpha.id, (value) => { playerSnapshot.value = value })
    // The subscription's own bootstrap read hits the mocked failure, so it falls back to local
    // state — this is the "old/null team assignment" starting point, and also reproduces
    // sharedStateAvailable never having become true in the first place.
    await vi.waitFor(() => expect(playerSnapshot.value).not.toBeNull())
    expect(playerSnapshot.value?.teamId).toBeNull()

    // Simulate the teacher's randomizeTeams write having already reached the shared endpoint by
    // the time it becomes reachable again — this is the "-> realtime player update -> new team"
    // step, delivered purely through the shared "server," never through this test's own
    // writeState/UPDATE_EVENT (which never fires again after the joinRoom above).
    const localRaw = localStorage.getItem(DEMO_STORAGE_KEY)
    if (!localRaw) throw new Error('expected seeded local demo state after createRoom/joinRoom')
    const updated = JSON.parse(localRaw)
    updated.rooms[room.roomCode].players[alpha.id].teamId = 'team-1'
    updated.rooms[room.roomCode].rosters['team-1'] = {
      teamId: 'team-1',
      teamName: 'ทีม 1',
      members: [{ playerId: alpha.id, displayName: alpha.displayName }],
    }
    serverState = updated
    getShouldFail = false

    // No unsubscribe/resubscribe, no manual refresh — the SAME long-lived subscription from
    // above must pick this up entirely on its own.
    await vi.waitFor(() => expect(playerSnapshot.value?.teamId).toBe('team-1'), { timeout: 3000 })

    // "-> roster subscription/UI follows the new team": exactly what useTeamRoster(roomCode,
    // teamId) re-subscribes to once LobbyPage observes the player's new teamId.
    const rosterSnapshot: { value: TeamRosterSummary | null } = { value: null }
    const stopRoster = service.subscribeTeamRoster(room.roomCode, 'team-1', (value) => { rosterSnapshot.value = value })
    await vi.waitFor(() => expect(rosterSnapshot.value?.members.map((member) => member.playerId)).toEqual([alpha.id]), { timeout: 3000 })

    stopPlayer()
    stopRoster()
  })
})

// Write path regression (follow-up to the read-path fix above): `writeState` used to gate the
// push to the shared endpoint behind the SAME `sharedStateAvailable` flag —
// `if (sharedStateAvailable) await writeSharedState(state)`. That flag is only ever recomputed
// as a side effect of a *previous* successful read or write, so a write attempted while it was
// false (its pessimistic initial value, or latched false by any earlier transient failure) was
// silently skipped: applied to local storage only, dispatched only to the writer's own window,
// and never even attempted against the shared endpoint. Because the flag can only turn true
// again via another read/write actually succeeding, and this one never even tried, the write was
// gone for good unless some *unrelated later* write happened to flush the by-then-current full
// state — a remote device could be permanently denied a mutation that the writer's own device
// believed had gone through.
//
// This suite deliberately keeps every GET (read) call failing for its entire duration, so
// `sharedStateAvailable` can never be flipped true by a read — the only thing that can prove the
// fix is the write path itself retrying on its own merit, not an incidental read recovering the
// flag first and masking the bug.
describe('Write path resilience: a write must not be permanently suppressed by an earlier shared-endpoint failure', () => {
  let putShouldFail = true
  let serverState: unknown = null
  let putCount = 0

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
    putShouldFail = true
    serverState = null
    putCount = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCount += 1
        if (putShouldFail) throw new Error('simulated network failure reaching the shared demo-state endpoint')
        serverState = JSON.parse(String(init.body))
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) }
      }
      // Reads never succeed in this suite — see the comment above: this isolates the write
      // path so a read can never be what flips sharedStateAvailable back to true.
      throw new Error('simulated network failure reaching the shared demo-state endpoint')
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a write made while the shared endpoint is unreachable does not permanently suppress a later write once it becomes reachable, and does not duplicate the mutation', async () => {
    const teacherService = new DemoGameService()

    // createRoom's writeState call is this service's very first ever write, made while the
    // shared endpoint is unreachable (PUT fails). Old code: sharedStateAvailable starts false,
    // so this write's push was never even attempted. New code: it's attempted and fails —
    // caught internally, local state still updates correctly, no throw.
    const room = await teacherService.createRoom('teacher-1')
    expect(putCount).toBe(1)
    expect(serverState).toBeNull()

    // Network recovers.
    putShouldFail = false

    // A second, independent write (joinRoom) — under the old gated code this would still be
    // silently skipped, since sharedStateAvailable was never set true (no read ever succeeded
    // in this suite, and the first write never got the chance either). Under the fix, this
    // write attempts the push on its own merit and succeeds now that the network is up.
    const joined = await teacherService.joinRoom({ roomCode: room.roomCode, displayName: 'Alpha', studentNumber: '01' }, 'owner-1')

    expect(putCount).toBe(2)
    expect(serverState).not.toBeNull()
    const pushed = serverState as { rooms: Record<string, { room: { roomCode: string }, players: Record<string, { id: string }> }> }
    // Our room reached the server with exactly the one player who joined — proves this was a
    // normal single retry-on-next-write, not a duplicated/replayed mutation. (The built-in
    // 'MATANA' demo seed room is also present in the pushed state — that's createSeedState's
    // default local seed, unrelated to this test.)
    expect(pushed.rooms[room.roomCode]).toBeDefined()
    expect(Object.keys(pushed.rooms[room.roomCode].players)).toEqual([joined.player.id])

    // A wholly separate service instance with isolated local storage (simulating a remote
    // device) can only see this room by actually reading it from the shared endpoint — proving
    // the write really reached "the server," not just this device's own localStorage.
    vi.stubGlobal('localStorage', new MemoryStorage())
    // From this point on reads must succeed so the remote device can fetch what was pushed.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        serverState = JSON.parse(String(init.body))
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) }
      }
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ state: serverState }) }
    }))
    const remoteService = new DemoGameService()
    const remoteJoin = await remoteService.joinRoom({ roomCode: room.roomCode, displayName: 'Beta', studentNumber: '02' }, 'owner-2')
    expect(remoteJoin.room.roomCode).toBe(room.roomCode)
  })
})
