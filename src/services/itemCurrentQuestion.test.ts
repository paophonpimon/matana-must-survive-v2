import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { questionsById } from '../data/questions'
import { ILLUSION_HIDDEN_CHOICE_COUNT, MAGIC_GRIMOIRE, MAGIC_ITEM_INFO, buildTeacherSpellEventCopy } from '../lib/magic'
import { RECALL_QUESTION_COUNT } from '../types/game'
import type { MagicEvent, Player, Room, TeamMagicState } from '../types/game'
import { DemoGameService } from './demoService'

// Items now land on the question being answered RIGHT NOW. These drive the real service so the
// question index an effect targets, its consumption, and the fairness gate are all verified against
// actual behaviour rather than against the helper in isolation.

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

describe('current-question item effects', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // Two teams, one student each, in Main at question 1.
  const startMain = async (startingItem: 'power_surge' | 'score_seal' | 'illusion' = 'power_surge') => {
    const service = new DemoGameService()
    const created = await service.createRoom('teacher-1')
    const code = created.roomCode
    const alpha = (await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')).player
    const beta = (await service.joinRoom({ roomCode: code, displayName: 'Beta', studentNumber: '02' }, 'uid-2')).player

    const liveRoom: { value: Room | null } = { value: null }
    const players: { value: Player[] } = { value: [] }
    const magic: { value: TeamMagicState[] } = { value: [] }
    const events: { value: MagicEvent[] } = { value: [] }
    const stopRoom = service.subscribeRoom(code, (value) => { liveRoom.value = value })
    const stopPlayers = service.subscribePlayers(code, (value) => { players.value = value })
    await vi.waitFor(() => expect(players.value).toHaveLength(2))

    await service.startPreTest(code, 'teacher-1')
    await service.startRecall(code, 'teacher-1')
    for (let index = 0; index < RECALL_QUESTION_COUNT; index += 1) {
      await service.advanceRecallQuestion(code, 'teacher-1', index)
    }
    await service.startTeamSetup(code, 'teacher-1')
    // One team per student, so "a teammate answered" can be controlled precisely.
    await service.randomizeTeams(code, 'teacher-1', 2)
    await service.lockTeams(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    const teams = (liveRoom.value as Room).teams
    const stopMagic = service.subscribeAllTeamMagic(code, (value) => { magic.value = value })
    const stopEvents = service.subscribeMagicEvents(code, (value) => { events.value = value })
    for (const team of teams) await service.finalizeCaptainElection(code, 'teacher-1', team.id)
    await vi.waitFor(() => expect(magic.value.every((entry) => entry.magicHolderPlayerId)).toBe(true))
    const captainOf = new Map(magic.value.map((entry) => [entry.teamId, entry.magicHolderPlayerId as string]))
    for (const team of teams) {
      await service.setTeamGuardianName(code, team.id, captainOf.get(team.id) as string, `ทีม ${team.id.slice(-4)}`)
      await service.chooseStartingItem(code, team.id, captainOf.get(team.id) as string, startingItem)
    }

    await service.startRoom(code, 'teacher-1', 30)
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('main'))

    const magicOf = (teamId: string) => magic.value.find((entry) => entry.teamId === teamId) as TeamMagicState
    const currentQuestion = () => {
      const room = liveRoom.value as Room
      return questionsById.get(room.questionIds[room.currentQuestionIndex])
    }
    return {
      service, code, alpha, beta, teams, captainOf, liveRoom, players, magic, events, magicOf, currentQuestion,
      stop: () => { stopEvents(); stopMagic(); stopPlayers(); stopRoom() },
    }
  }

  it('Power Surge lands on the question being answered, not the next one', async () => {
    const ctx = await startMain('power_surge')
    const teamId = ctx.teams[0].id
    // Move to question 3 so "current" and "next" are clearly different numbers.
    for (const index of [0, 1]) await ctx.service.advanceQuestion(ctx.code, 'teacher-1', index)
    await vi.waitFor(() => expect(ctx.liveRoom.value?.currentQuestionIndex).toBe(2))

    await ctx.service.activateItem(ctx.code, teamId, ctx.captainOf.get(teamId) as string, 'power_surge')
    await vi.waitFor(() => expect(ctx.magicOf(teamId).queuedEffect).not.toBeNull())
    expect(ctx.magicOf(teamId).queuedEffect?.affectedQuestionIndex).toBe(2)
    ctx.stop()
  })

  it('Score Seal lands on the target team’s current question', async () => {
    const ctx = await startMain('score_seal')
    const [attacker, target] = ctx.teams
    for (const index of [0, 1, 2]) await ctx.service.advanceQuestion(ctx.code, 'teacher-1', index)
    await vi.waitFor(() => expect(ctx.liveRoom.value?.currentQuestionIndex).toBe(3))

    await ctx.service.activateItem(ctx.code, attacker.id, ctx.captainOf.get(attacker.id) as string, 'score_seal', target.id)
    await vi.waitFor(() => expect(ctx.magicOf(attacker.id).queuedEffect).not.toBeNull())
    const effect = ctx.magicOf(attacker.id).queuedEffect
    expect(effect?.affectedQuestionIndex).toBe(3)
    expect(effect?.targetTeamId).toBe(target.id)
    ctx.stop()
  })

  it('consumes the item exactly once, when the current question resolves', async () => {
    const ctx = await startMain('power_surge')
    const teamId = ctx.teams[0].id
    const before = ctx.magicOf(teamId).inventory.power_surge.available
    expect(before).toBe(1)

    await ctx.service.activateItem(ctx.code, teamId, ctx.captainOf.get(teamId) as string, 'power_surge')
    await vi.waitFor(() => expect(ctx.magicOf(teamId).queuedEffect).not.toBeNull())
    // Still held while queued — consumption happens at resolution.
    expect(ctx.magicOf(teamId).inventory.power_surge.available).toBe(1)

    await ctx.service.advanceQuestion(ctx.code, 'teacher-1', 0)
    await vi.waitFor(() => expect(ctx.magicOf(teamId).queuedEffect).toBeNull())
    expect(ctx.magicOf(teamId).inventory.power_surge.available).toBe(0)
    expect(ctx.magicOf(teamId).inventory.power_surge.consumed).toBe(1)

    // Leaving the next question cannot consume a second time.
    await ctx.service.advanceQuestion(ctx.code, 'teacher-1', 1)
    expect(ctx.magicOf(teamId).inventory.power_surge.consumed).toBe(1)
    ctx.stop()
  })

  it('Illusion removes exactly two wrong choices and never the correct one', async () => {
    const ctx = await startMain('illusion')
    const teamId = ctx.teams[0].id
    const question = ctx.currentQuestion()
    expect(question).toBeDefined()

    await ctx.service.activateItem(ctx.code, teamId, ctx.captainOf.get(teamId) as string, 'illusion')
    await vi.waitFor(() => expect(ctx.magicOf(teamId).queuedEffect?.hiddenChoiceIds).toBeDefined())
    const hidden = ctx.magicOf(teamId).queuedEffect?.hiddenChoiceIds as string[]

    expect(hidden).toHaveLength(ILLUSION_HIDDEN_CHOICE_COUNT)
    expect(hidden).toHaveLength(2)
    expect(hidden).not.toContain(question?.correctChoiceId)
    expect(new Set(hidden).size).toBe(2)
    // Exactly one correct + one wrong choice left visible.
    const visible = (question?.choices ?? []).filter((choice) => !hidden.includes(choice.id))
    expect(visible).toHaveLength(2)
    expect(visible.filter((choice) => choice.id === question?.correctChoiceId)).toHaveLength(1)
    ctx.stop()
  })

  it('the removed pair is stable across resubscribes — a refresh cannot reroll it', async () => {
    const ctx = await startMain('illusion')
    const teamId = ctx.teams[0].id
    await ctx.service.activateItem(ctx.code, teamId, ctx.captainOf.get(teamId) as string, 'illusion')
    await vi.waitFor(() => expect(ctx.magicOf(teamId).queuedEffect?.hiddenChoiceIds).toBeDefined())
    const first = [...(ctx.magicOf(teamId).queuedEffect?.hiddenChoiceIds as string[])]

    // A refresh is a fresh subscription reading the same persisted effect.
    for (let reload = 0; reload < 3; reload += 1) {
      const seen: { value: TeamMagicState[] } = { value: [] }
      const stop = ctx.service.subscribeAllTeamMagic(ctx.code, (value) => { seen.value = value })
      await vi.waitFor(() => expect(seen.value.length).toBeGreaterThan(0))
      const again = seen.value.find((entry) => entry.teamId === teamId)?.queuedEffect?.hiddenChoiceIds
      expect(again).toEqual(first)
      stop()
    }
    ctx.stop()
  })

  it('Illusion is blocked once any teammate has answered, and the item is NOT consumed', async () => {
    const ctx = await startMain('illusion')
    // Both students are on the same team here so one can answer for the other's team.
    const teamId = ctx.players.value.find((entry) => entry.id === ctx.alpha.id)?.teamId as string
    const captainId = ctx.captainOf.get(teamId) as string
    const question = ctx.currentQuestion()
    const teammate = ctx.players.value.find((entry) => entry.teamId === teamId) as Player

    await ctx.service.saveAnswer(ctx.code, teammate.id, {
      questionId: question?.id as string,
      selectedChoiceId: question?.correctChoiceId as string,
      expectedQuestionIndex: 0,
    })
    await vi.waitFor(() => expect(ctx.players.value.find((entry) => entry.id === teammate.id)?.answers).toHaveLength(1))

    await expect(ctx.service.activateItem(ctx.code, teamId, captainId, 'illusion'))
      .rejects.toThrow('มีเพื่อนร่วมทีมตอบข้อนี้ไปแล้ว')

    // No effect queued, and the item is still in hand.
    expect(ctx.magicOf(teamId).queuedEffect).toBeNull()
    expect(ctx.magicOf(teamId).inventory.illusion.available).toBe(1)
    expect(ctx.magicOf(teamId).inventory.illusion.consumed).toBe(0)
    ctx.stop()
  })
})

describe('attack reveal stays at team level', () => {
  it('names the attacking and target TEAMS, never a student', () => {
    const copy = buildTeacherSpellEventCopy(
      { itemType: 'score_seal', status: 'applied', actorPlayerId: 'player-secret' } as MagicEvent,
      'ทีม 2',
      'ทีม 1',
    )
    expect(copy?.headline).toContain('ทีม 2')
    expect(copy?.headline).toContain('ทีม 1')
    // The individual who cast it must never surface in the announcement.
    expect(`${copy?.headline} ${copy?.body}`).not.toContain('player-secret')
  })
})

describe('item copy matches current-question behaviour', () => {
  it('no activatable item still claims a next-question effect', () => {
    for (const itemType of ['power_surge', 'score_seal', 'illusion'] as const) {
      expect(MAGIC_ITEM_INFO[itemType].description).not.toContain('ข้อต่อไป')
      expect(MAGIC_GRIMOIRE[itemType].timing).not.toContain('ข้อต่อไป')
    }
  })

  it('states the agreed semantics for each item', () => {
    expect(MAGIC_ITEM_INFO.power_surge.description).toBe('เพิ่มคะแนนของทีมในข้อนี้เป็น 2 เท่า')
    expect(MAGIC_ITEM_INFO.score_seal.description).toContain('ผนึกคะแนนทีมเป้าหมายในข้อนี้ ให้เหลือ 50%')
    expect(MAGIC_ITEM_INFO.illusion.description).toContain('ตัดคำตอบผิดออก 2 ตัว เหลือให้เลือก 2 ตัว')
    // Illusion copy must no longer mention removing a single choice.
    expect(MAGIC_ITEM_INFO.illusion.description).not.toContain('1 ตัว')
    expect(MAGIC_GRIMOIRE.illusion.effect).not.toContain('1 ตัว')
  })

  it('describes Rose Shield as automatic and consumed on a successful block, not tied to a question', () => {
    expect(MAGIC_ITEM_INFO.rose_shield.description).toContain('อัตโนมัติ')
    expect(MAGIC_ITEM_INFO.rose_shield.description).toContain('ถูกใช้ไปทันทีที่ป้องกันสำเร็จ')
    expect(MAGIC_GRIMOIRE.rose_shield.timing).not.toContain('ข้อต่อไป')
    expect(MAGIC_GRIMOIRE.rose_shield.timing).not.toContain('ข้อนี้')
  })
})
