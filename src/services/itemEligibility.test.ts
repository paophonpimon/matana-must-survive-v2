import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { getMagicActivationWindow } from '../lib/magic'
import { BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX, RECALL_QUESTION_COUNT } from '../types/game'
import type { Player, Room, TeamMagicState } from '../types/game'
import { DemoGameService } from './demoService'

// Item eligibility across the real Main -> Boss -> Main sequence. This mirrors exactly what
// GamePage derives (`getMagicActivationWindow(room).valid && room.phase === 'main'`) plus the
// MagicPanel gate, so a regression in any of them shows up here as a wrong question number.

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

describe('Magic item eligibility across the boss transition', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stays usable on every eligible Main question before and after the boss', async () => {
    const service = new DemoGameService()
    const created = await service.createRoom('teacher-1')
    const code = created.roomCode
    await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')
    await service.joinRoom({ roomCode: code, displayName: 'Beta', studentNumber: '02' }, 'uid-2')

    const liveRoom: { value: Room | null } = { value: null }
    const players: { value: Player[] } = { value: [] }
    const magic: { value: TeamMagicState[] } = { value: [] }
    const stopRoom = service.subscribeRoom(code, (value) => { liveRoom.value = value })
    const stopPlayers = service.subscribePlayers(code, (value) => { players.value = value })
    await vi.waitFor(() => expect(players.value).toHaveLength(2))

    await service.startPreTest(code, 'teacher-1')
    await service.startRecall(code, 'teacher-1')
    for (let index = 0; index < RECALL_QUESTION_COUNT; index += 1) {
      await service.advanceRecallQuestion(code, 'teacher-1', index)
    }
    await service.startTeamSetup(code, 'teacher-1')
    await service.randomizeTeams(code, 'teacher-1', 2)
    await service.lockTeams(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    const teams = (liveRoom.value as Room).teams
    const stopMagic = service.subscribeAllTeamMagic(code, (value) => { magic.value = value })
    for (const team of teams) await service.finalizeCaptainElection(code, 'teacher-1', team.id)
    await vi.waitFor(() => expect(magic.value.every((entry) => entry.magicHolderPlayerId)).toBe(true))
    const captainOf = new Map(magic.value.map((entry) => [entry.teamId, entry.magicHolderPlayerId as string]))
    for (const team of teams) {
      await service.setTeamGuardianName(code, team.id, captainOf.get(team.id) as string, `ทีม ${team.id.slice(-4)}`)
      await service.chooseStartingItem(code, team.id, captainOf.get(team.id) as string, 'power_surge')
    }

    await service.startRoom(code, 'teacher-1', 30)
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))

    // Walk the whole round, recording at each step whether GamePage would offer activation.
    const usableOn: number[] = []
    const bossUsable: boolean[] = []
    for (let index = 0; index < 10; index += 1) {
      await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(index))
      const room = liveRoom.value as Room
      if (getMagicActivationWindow(room).valid && room.phase === 'main') usableOn.push(index + 1)

      await service.advanceQuestion(code, 'teacher-1', index)
      if (index === BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX) {
        await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('boss'))
        for (let bossIndex = 0; bossIndex < 3; bossIndex += 1) {
          const bossRoom = liveRoom.value as Room
          bossUsable.push(getMagicActivationWindow(bossRoom).valid && bossRoom.phase === 'main')
          await service.advanceBossQuestion(code, 'teacher-1', bossIndex)
        }
        await vi.waitFor(() => expect(liveRoom.value?.bossAwaitingContinue).toBe(true))
        await service.continueAfterBoss(code, 'teacher-1', (liveRoom.value as Room).currentRound)
        await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))
      }
    }

    // Items land on the question being answered, so every Main question is usable — including Q1
    // and Q10, which the old next-question model excluded. Critically Q6-Q10, every question after
    // the boss, must be present.
    expect(usableOn).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // The boss mini-game itself stays item-disabled, as designed.
    expect(bossUsable).toEqual([false, false, false])

    stopMagic()
    stopPlayers()
    stopRoom()
  })

  it('a captain who never spent their item can still activate it on Main Q6, right after the boss', async () => {
    const service = new DemoGameService()
    const created = await service.createRoom('teacher-1')
    const code = created.roomCode
    await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')
    await service.joinRoom({ roomCode: code, displayName: 'Beta', studentNumber: '02' }, 'uid-2')

    const liveRoom: { value: Room | null } = { value: null }
    const magic: { value: TeamMagicState[] } = { value: [] }
    const stopRoom = service.subscribeRoom(code, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(liveRoom.value).not.toBeNull())

    await service.startPreTest(code, 'teacher-1')
    await service.startRecall(code, 'teacher-1')
    for (let index = 0; index < RECALL_QUESTION_COUNT; index += 1) {
      await service.advanceRecallQuestion(code, 'teacher-1', index)
    }
    await service.startTeamSetup(code, 'teacher-1')
    await service.randomizeTeams(code, 'teacher-1', 2)
    await service.lockTeams(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    const teams = (liveRoom.value as Room).teams
    const stopMagic = service.subscribeAllTeamMagic(code, (value) => { magic.value = value })
    for (const team of teams) await service.finalizeCaptainElection(code, 'teacher-1', team.id)
    await vi.waitFor(() => expect(magic.value.every((entry) => entry.magicHolderPlayerId)).toBe(true))
    const captainOf = new Map(magic.value.map((entry) => [entry.teamId, entry.magicHolderPlayerId as string]))
    for (const team of teams) {
      await service.setTeamGuardianName(code, team.id, captainOf.get(team.id) as string, `ทีม ${team.id.slice(-4)}`)
      await service.chooseStartingItem(code, team.id, captainOf.get(team.id) as string, 'power_surge')
    }

    await service.startRoom(code, 'teacher-1', 30)
    for (let index = 0; index <= BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX; index += 1) {
      await service.advanceQuestion(code, 'teacher-1', index)
    }
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('boss'))
    for (let bossIndex = 0; bossIndex < 3; bossIndex += 1) {
      await service.advanceBossQuestion(code, 'teacher-1', bossIndex)
    }
    await vi.waitFor(() => expect(liveRoom.value?.bossAwaitingContinue).toBe(true))
    await service.continueAfterBoss(code, 'teacher-1', (liveRoom.value as Room).currentRound)
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))

    // Main Q6. The unspent item must still be there, and must still be activatable.
    const room = liveRoom.value as Room
    expect(room.currentQuestionIndex).toBe(BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX + 1)
    const teamId = teams[0].id
    const before = magic.value.find((entry) => entry.teamId === teamId) as TeamMagicState
    expect(before.inventory.power_surge.available).toBeGreaterThanOrEqual(1)
    expect(before.queuedEffect).toBeNull()

    await service.activateItem(code, teamId, captainOf.get(teamId) as string, 'power_surge')
    await vi.waitFor(() => {
      const after = magic.value.find((entry) => entry.teamId === teamId) as TeamMagicState
      // Lands on the question being answered right now (Q6), not the one after it.
      expect(after.queuedEffect?.affectedQuestionIndex).toBe(BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX + 1)
    })

    stopMagic()
    stopRoom()
  })

  // The reported scenario: an item activated on the last Main question before the boss. Its
  // effect is queued across the whole boss mini-game, and a queued effect blocks further
  // activation by design — so if the boss transition ever left that effect stranded, the item
  // count would stay untouched while activation stayed permanently blocked, which is exactly
  // "still x1 but unusable from Q5-Q6 onward".
  it('resolves an effect queued just before the boss, and unblocks activation again afterwards', async () => {
    const service = new DemoGameService()
    const created = await service.createRoom('teacher-1')
    const code = created.roomCode
    await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')
    await service.joinRoom({ roomCode: code, displayName: 'Beta', studentNumber: '02' }, 'uid-2')

    const liveRoom: { value: Room | null } = { value: null }
    const magic: { value: TeamMagicState[] } = { value: [] }
    const stopRoom = service.subscribeRoom(code, (value) => { liveRoom.value = value })
    await vi.waitFor(() => expect(liveRoom.value).not.toBeNull())

    await service.startPreTest(code, 'teacher-1')
    await service.startRecall(code, 'teacher-1')
    for (let index = 0; index < RECALL_QUESTION_COUNT; index += 1) {
      await service.advanceRecallQuestion(code, 'teacher-1', index)
    }
    await service.startTeamSetup(code, 'teacher-1')
    await service.randomizeTeams(code, 'teacher-1', 2)
    await service.lockTeams(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    const teams = (liveRoom.value as Room).teams
    const stopMagic = service.subscribeAllTeamMagic(code, (value) => { magic.value = value })
    for (const team of teams) await service.finalizeCaptainElection(code, 'teacher-1', team.id)
    await vi.waitFor(() => expect(magic.value.every((entry) => entry.magicHolderPlayerId)).toBe(true))
    const captainOf = new Map(magic.value.map((entry) => [entry.teamId, entry.magicHolderPlayerId as string]))
    for (const team of teams) {
      await service.setTeamGuardianName(code, team.id, captainOf.get(team.id) as string, `ทีม ${team.id.slice(-4)}`)
      await service.chooseStartingItem(code, team.id, captainOf.get(team.id) as string, 'power_surge')
    }
    const teamId = teams[0].id
    const captainId = captainOf.get(teamId) as string
    const magicOf = (): TeamMagicState => magic.value.find((entry) => entry.teamId === teamId) as TeamMagicState

    await service.startRoom(code, 'teacher-1', 30)
    // Advance to Main Q5 (index 4) — the last question before the boss.
    for (let index = 0; index < BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX; index += 1) {
      await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(index))
      await service.advanceQuestion(code, 'teacher-1', index)
    }
    await vi.waitFor(() => expect(liveRoom.value?.currentQuestionIndex).toBe(BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX))

    // Activate on Q5. The effect targets Q5 itself — the question being answered.
    await service.activateItem(code, teamId, captainId, 'power_surge')
    await vi.waitFor(() => expect(magicOf().queuedEffect?.affectedQuestionIndex).toBe(BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX))

    await service.advanceQuestion(code, 'teacher-1', BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX)
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('boss'))
    for (let bossIndex = 0; bossIndex < 3; bossIndex += 1) {
      await service.advanceBossQuestion(code, 'teacher-1', bossIndex)
    }
    await vi.waitFor(() => expect(liveRoom.value?.bossAwaitingContinue).toBe(true))
    // Q5 was already left when the boss triggered, so the effect resolved and was consumed there —
    // a current-question effect never lingers across the boss.
    expect(magicOf().queuedEffect).toBeNull()
    await service.continueAfterBoss(code, 'teacher-1', (liveRoom.value as Room).currentRound)
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))
    // ...so the team is never left permanently blocked with an unresolvable queued effect.
    const inventory = magicOf().inventory
    const remaining = inventory.power_surge.available + inventory.score_seal.available
      + inventory.rose_shield.available + inventory.illusion.available
    if (remaining > 0) {
      const room = liveRoom.value as Room
      expect(getMagicActivationWindow(room).valid && room.phase === 'main').toBe(true)
    }

    stopMagic()
    stopRoom()
  })
})
