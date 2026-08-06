import { questions, questionsById } from '../data/questions'
import { evaluateChoice, generateRoomCode, selectRoundQuestions } from '../lib/game'
import { getMagicActivationWindow, pickHolders } from '../lib/magic'
import { buildTeamMetas, distributeTeamsEvenly } from '../lib/teamScoring'
import type { AnswerInput, AnswerResult, GameService } from './gameService'
import type {
  AnswerProgressEntry,
  JoinInput,
  JoinResult,
  MagicEvent,
  MagicItemType,
  Player,
  Room,
  TeamMagicState,
  TeamRosterSummary,
  Unsubscribe,
} from '../types/game'

interface DemoRoomState {
  room: Room
  players: Record<string, Player>
  magic: Record<string, TeamMagicState>
  magicEvents: MagicEvent[]
  rosters: Record<string, TeamRosterSummary>
  answerProgress: Record<string, AnswerProgressEntry>
}

interface DemoState {
  rooms: Record<string, DemoRoomState>
}

const STORAGE_KEY = 'matana_demo_state_v5'
const UPDATE_EVENT = 'matana-demo-update'
const DEMO_ROOM_CODE = 'MATANA'
const SHARED_STATE_PATH = '/__matana_demo_state'
let sharedStateAvailable = false

const createId = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`

const stablePlayerId = (studentNumber: string): string => {
  let hash = 2166136261
  for (const character of studentNumber.trim().toLocaleLowerCase('th')) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `player-${(hash >>> 0).toString(36)}`
}

const createPlayer = (
  id: string,
  displayName: string,
  studentNumber: string,
  ownerUid: string,
  round = 1,
): Player => ({
  id,
  displayName,
  studentNumber,
  teamId: null,
  joinedAt: Date.now(),
  currentRound: round,
  currentQuestionIndex: 0,
  score: 0,
  answers: [],
  submitted: false,
  finishedAt: null,
  elapsedMs: null,
  status: 'waiting',
  ownerUid,
})

const createSeedState = (): DemoState => {
  const room: Room = {
    roomCode: DEMO_ROOM_CODE,
    status: 'waiting',
    currentRound: 1,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    currentQuestionIndex: 0,
    questionDurationSeconds: 30,
    questionStartedAt: null,
    questionIds: selectRoundQuestions(questions),
    previousQuestionIds: [],
    winner: null,
    teacherSessionId: 'demo-teacher',
    teamCount: 0,
    teamsLocked: false,
    teams: [],
  }
  const players: Record<string, Player> = {}
  const demoStudents: Array<[string, string]> = [
    ['พิมพ์ชนก', '01'],
    ['ณัฐวุฒิ', '02'],
    ['ศิรินภา', '03'],
  ]
  demoStudents.forEach(([displayName, studentNumber], index) => {
    // Use the same deterministic id scheme as a real join (stablePlayerId), not a literal
    // seed id — otherwise joinRoom's studentNumber lookup can never find these seed players,
    // breaking reconnect for the built-in demo dataset specifically.
    const id = stablePlayerId(studentNumber)
    players[id] = createPlayer(id, displayName, studentNumber, `demo-student-${index + 1}`)
  })
  return { rooms: { [DEMO_ROOM_CODE]: { room, players, magic: {}, magicEvents: [], rosters: {}, answerProgress: {} } } }
}

const normalizeState = (state: DemoState): DemoState => {
  Object.values(state.rooms).forEach((roomState) => {
    const { room } = roomState
    room.currentQuestionIndex ??= 0
    room.questionDurationSeconds ??= 30
    room.questionStartedAt ??= room.status === 'playing' ? room.startedAt : null
    room.teamCount ??= 0
    room.teamsLocked ??= false
    room.teams ??= []
    roomState.magic ??= {}
    roomState.magicEvents ??= []
    // Older saved demo state (before this migration) won't have these keys at all — default
    // to empty rather than crashing.
    roomState.rosters ??= {}
    roomState.answerProgress ??= {}
  })
  return state
}

const readLocalState = (): DemoState => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return normalizeState(JSON.parse(saved) as DemoState)
  } catch {
    localStorage.removeItem(STORAGE_KEY)
  }
  const seeded = createSeedState()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
  return seeded
}

const writeLocalState = (state: DemoState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

const readSharedState = async (): Promise<{ available: boolean; state: DemoState | null }> => {
  try {
    const response = await fetch(SHARED_STATE_PATH, { cache: 'no-store' })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      sharedStateAvailable = false
      return { available: false, state: null }
    }
    const payload = await response.json() as { state?: DemoState | null }
    sharedStateAvailable = true
    return { available: true, state: payload.state ?? null }
  } catch {
    sharedStateAvailable = false
    return { available: false, state: null }
  }
}

const writeSharedState = async (state: DemoState): Promise<boolean> => {
  try {
    const response = await fetch(SHARED_STATE_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    })
    sharedStateAvailable = response.ok
    return response.ok
  } catch {
    sharedStateAvailable = false
    return false
  }
}

const readState = async (): Promise<DemoState> => {
  const shared = await readSharedState()
  if (shared.available) {
    if (shared.state) {
      const normalized = normalizeState(shared.state)
      writeLocalState(normalized)
      return normalized
    }
    const initial = readLocalState()
    await writeSharedState(initial)
    return initial
  }
  return readLocalState()
}

const writeState = async (state: DemoState): Promise<void> => {
  if (sharedStateAvailable) await writeSharedState(state)
  writeLocalState(state)
  window.dispatchEvent(new Event(UPDATE_EVENT))
}

const verifyTeacher = (room: Room, teacherSessionId: string): void => {
  if (room.teacherSessionId !== teacherSessionId) throw new Error('ผู้ใช้:เซสชันครูไม่ตรงกับห้องนี้ กรุณาสร้างห้องใหม่')
}

const listen = (callback: () => void): Unsubscribe => {
  const storageListener = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) callback()
  }
  window.addEventListener('storage', storageListener)
  window.addEventListener(UPDATE_EVENT, callback)
  const intervalId = typeof window.setInterval === 'function'
    ? window.setInterval(() => {
        if (sharedStateAvailable) callback()
      }, 300)
    : null
  return () => {
    window.removeEventListener('storage', storageListener)
    window.removeEventListener(UPDATE_EVENT, callback)
    if (intervalId !== null) window.clearInterval(intervalId)
  }
}

const consumeInventoryItem = (magic: TeamMagicState, itemType: MagicItemType, now: number): void => {
  const item = magic.inventory.find((entry) => entry.itemType === itemType && !entry.consumed)
  if (item) {
    item.consumed = true
    item.consumedAt = now
  }
}

// Runs when leaving `resolvedQuestionIndex` (either advancing to the next question or
// completing the round). For every team whose queuedEffect targeted that question: resolve it
// against the current player answers, update the matching magicEvents record in place, and
// clear the queued slot. Shields only ever block a hostile score_seal — never a team's own
// power_surge — and a shield check never touches the source team's own item consumption.
const resolveQuestionMagic = (roomState: DemoRoomState, resolvedQuestionIndex: number, now: number): void => {
  for (const team of roomState.room.teams) {
    const magic = roomState.magic[team.id]
    const effect = magic?.queuedEffect
    if (!magic || !effect || effect.affectedQuestionIndex !== resolvedQuestionIndex) continue
    const event = roomState.magicEvents.find((item) => item.id === effect.id)
    if (effect.itemType === 'power_surge') {
      consumeInventoryItem(magic, 'power_surge', now)
      if (event) {
        event.status = 'applied'
        event.resolvedAt = now
      }
    } else {
      const targetMagic = roomState.magic[effect.targetTeamId]
      const shieldItem = targetMagic?.inventory.find((item) => item.itemType === 'rose_shield' && !item.consumed)
      consumeInventoryItem(magic, 'score_seal', now)
      if (shieldItem) {
        shieldItem.consumed = true
        shieldItem.consumedAt = now
        if (event) {
          event.status = 'blocked'
          event.resolvedAt = now
        }
      } else if (event) {
        event.status = 'applied'
        event.resolvedAt = now
      }
    }
    magic.queuedEffect = null
  }
}

// Round reset (prepareNextRound/stopRound/closeRoom): any effect still 'queued' never got the
// chance to resolve — mark it 'expired' rather than silently dropping it, so the audit trail
// stays complete.
const expireQueuedEffects = (roomState: DemoRoomState, now: number): void => {
  for (const magic of Object.values(roomState.magic)) {
    if (!magic.queuedEffect) continue
    const event = roomState.magicEvents.find((item) => item.id === magic.queuedEffect?.id)
    if (event) {
      event.status = 'expired'
      event.resolvedAt = now
    }
    magic.queuedEffect = null
  }
}

export class DemoGameService implements GameService {
  readonly isDemo = true
  readonly demoRoomCode = DEMO_ROOM_CODE

  async resetDemoRoom(): Promise<Room> {
    const state = await readState()
    const seededRoom = createSeedState().rooms[DEMO_ROOM_CODE]
    state.rooms[DEMO_ROOM_CODE] = seededRoom
    await writeState(state)
    return seededRoom.room
  }

  async ensureSession(): Promise<string> {
    const existing = sessionStorage.getItem('matana_demo_uid')
    if (existing) return existing
    const uid = `demo-${createId()}`
    sessionStorage.setItem('matana_demo_uid', uid)
    return uid
  }

  async createRoom(teacherSessionId: string): Promise<Room> {
    const state = await readState()
    let roomCode = generateRoomCode()
    while (state.rooms[roomCode]) roomCode = generateRoomCode()
    const room: Room = {
      roomCode,
      status: 'waiting',
      currentRound: 1,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      currentQuestionIndex: 0,
      questionDurationSeconds: 30,
      questionStartedAt: null,
      questionIds: selectRoundQuestions(questions),
      previousQuestionIds: [],
      winner: null,
      teacherSessionId,
      teamCount: 0,
      teamsLocked: false,
      teams: [],
    }
    state.rooms[roomCode] = { room, players: {}, magic: {}, magicEvents: [], rosters: {}, answerProgress: {} }
    await writeState(state)
    return room
  }

  async joinRoom(input: JoinInput, ownerUid: string): Promise<JoinResult> {
    const state = await readState()
    const roomCode = input.roomCode.trim().toUpperCase()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    if (roomState.room.status === 'closed') throw new Error('ผู้ใช้:ห้องกิจกรรมสิ้นสุดแล้ว')

    const playerId = stablePlayerId(input.studentNumber)
    const existing = roomState.players[playerId]
    if (existing) {
      // Reconnect/refresh: same student on the same device returns their own record
      // untouched, regardless of whether teams are locked — a returning student must never
      // be blocked by a lock that happened after they joined.
      if (existing.ownerUid === ownerUid) return { room: roomState.room, player: existing }
      // A different owner tried to use the same student number — reject explicitly rather
      // than ever returning someone else's record.
      throw new Error('ผู้ใช้:เลขที่นักเรียนนี้ถูกใช้แล้ว')
    }

    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:เกมกำลังดำเนินอยู่ ไม่สามารถเข้าร่วมรอบนี้ได้')
    if (roomState.room.teamsLocked) throw new Error('ผู้ใช้:ทีมถูกล็อกแล้ว กรุณาติดต่อครู')

    const player = createPlayer(playerId, input.displayName.trim(), input.studentNumber.trim(), ownerUid, roomState.room.currentRound)
    roomState.players[playerId] = player
    await writeState(state)
    return { room: roomState.room, player }
  }

  subscribeRoom(roomCode: string, listener: (room: Room | null) => void): Unsubscribe {
    const emit = async (): Promise<void> => listener((await readState()).rooms[roomCode.toUpperCase()]?.room ?? null)
    void emit()
    return listen(() => { void emit() })
  }

  subscribePlayers(roomCode: string, listener: (players: Player[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const players = Object.values((await readState()).rooms[roomCode.toUpperCase()]?.players ?? {}).sort((a, b) => a.joinedAt - b.joinedAt)
      listener(players)
    }
    void emit()
    return listen(() => { void emit() })
  }

  subscribePlayer(roomCode: string, playerId: string, listener: (player: Player | null) => void): Unsubscribe {
    const emit = async (): Promise<void> => listener((await readState()).rooms[roomCode.toUpperCase()]?.players[playerId] ?? null)
    void emit()
    return listen(() => { void emit() })
  }

  subscribeTeamMagic(roomCode: string, teamId: string, listener: (magic: TeamMagicState | null) => void): Unsubscribe {
    const emit = async (): Promise<void> => listener((await readState()).rooms[roomCode.toUpperCase()]?.magic[teamId] ?? null)
    void emit()
    return listen(() => { void emit() })
  }

  subscribeAllTeamMagic(roomCode: string, listener: (magic: TeamMagicState[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const magic = Object.values((await readState()).rooms[roomCode.toUpperCase()]?.magic ?? {})
      listener(magic)
    }
    void emit()
    return listen(() => { void emit() })
  }

  subscribeMagicEvents(roomCode: string, listener: (events: MagicEvent[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const events = [...((await readState()).rooms[roomCode.toUpperCase()]?.magicEvents ?? [])].sort((a, b) => b.createdAt - a.createdAt)
      listener(events)
    }
    void emit()
    return listen(() => { void emit() })
  }

  subscribeTeamRoster(roomCode: string, teamId: string, listener: (roster: TeamRosterSummary | null) => void): Unsubscribe {
    const emit = async (): Promise<void> => listener((await readState()).rooms[roomCode.toUpperCase()]?.rosters[teamId] ?? null)
    void emit()
    return listen(() => { void emit() })
  }

  subscribeTeamAnswerProgress(roomCode: string, teamId: string, listener: (entries: AnswerProgressEntry[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const entries = Object.values((await readState()).rooms[roomCode.toUpperCase()]?.answerProgress ?? {}).filter((entry) => entry.teamId === teamId)
      listener(entries)
    }
    void emit()
    return listen(() => { void emit() })
  }

  async startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status === 'playing') throw new Error('ผู้ใช้:ภารกิจกำลังดำเนินอยู่แล้ว')
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:กรุณาเตรียมภารกิจรอบใหม่ก่อนเริ่ม')
    if (Object.keys(roomState.players).length === 0) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังเริ่มภารกิจไม่ได้')
    if (!roomState.room.teamsLocked) throw new Error('ผู้ใช้:กรุณาล็อกทีมก่อนเริ่มภารกิจ')
    const teamsWithoutStartingItem = roomState.room.teams.filter((team) => (roomState.magic[team.id]?.inventory.length ?? 0) === 0)
    if (teamsWithoutStartingItem.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องเลือกไอเทมเริ่มต้นก่อนเริ่มภารกิจ')
    roomState.room.status = 'playing'
    roomState.room.startedAt = Date.now()
    roomState.room.currentQuestionIndex = 0
    roomState.room.questionDurationSeconds = Math.max(5, Math.min(600, Math.round(questionDurationSeconds)))
    roomState.room.questionStartedAt = roomState.room.startedAt
    Object.values(roomState.players).forEach((player) => {
      player.status = 'playing'
    })
    await writeState(state)
  }

  async advanceQuestion(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing' || roomState.room.currentQuestionIndex !== expectedQuestionIndex) return
    const nextQuestionIndex = expectedQuestionIndex + 1
    const now = Date.now()
    resolveQuestionMagic(roomState, expectedQuestionIndex, now)
    if (nextQuestionIndex >= roomState.room.questionIds.length) {
      roomState.room.status = 'completed'
      roomState.room.completedAt = now
      roomState.room.currentQuestionIndex = roomState.room.questionIds.length
      roomState.room.questionStartedAt = null
      Object.values(roomState.players).forEach((player) => {
        player.currentQuestionIndex = roomState.room.questionIds.length
        player.submitted = true
        player.status = 'submitted'
        player.finishedAt = now
        player.elapsedMs = Math.max(0, now - (roomState.room.startedAt ?? now))
      })
    } else {
      roomState.room.currentQuestionIndex = nextQuestionIndex
      roomState.room.questionStartedAt = now
    }
    await writeState(state)
  }

  async prepareNextRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status === 'playing') throw new Error('ผู้ใช้:ยุติรอบปัจจุบันให้เรียบร้อยก่อนเตรียมรอบใหม่')
    const previousQuestionIds = roomState.room.questionIds
    const currentRound = roomState.room.currentRound + 1
    roomState.room = {
      ...roomState.room,
      status: 'waiting',
      currentRound,
      startedAt: null,
      completedAt: null,
      currentQuestionIndex: 0,
      questionStartedAt: null,
      previousQuestionIds,
      questionIds: selectRoundQuestions(questions, previousQuestionIds),
      winner: null,
    }
    Object.values(roomState.players).forEach((player) => {
      Object.assign(player, {
        currentRound,
        currentQuestionIndex: 0,
        score: 0,
        answers: [],
        submitted: false,
        finishedAt: null,
        elapsedMs: null,
        status: 'waiting',
      })
    })
    // A new round means Q1-Q10 indices reset, so any still-queued effect from the old round is
    // meaningless — expire it for the audit trail. Inventory resets too: requirement 2 frames
    // starting-item choice as happening fresh each time "before the teacher starts the game".
    // The holder itself is untouched — only a fresh lockTeams re-picks holders.
    expireQueuedEffects(roomState, Date.now())
    Object.values(roomState.magic).forEach((magic) => { magic.inventory = [] })
    await writeState(state)
  }

  async stopRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing') throw new Error('ผู้ใช้:ภารกิจไม่ได้กำลังดำเนินอยู่')
    const previousQuestionIds = roomState.room.questionIds
    const currentRound = roomState.room.currentRound + 1
    roomState.room = {
      ...roomState.room,
      status: 'waiting',
      currentRound,
      startedAt: null,
      completedAt: null,
      currentQuestionIndex: 0,
      questionStartedAt: null,
      previousQuestionIds,
      questionIds: selectRoundQuestions(questions, previousQuestionIds),
      winner: null,
    }
    Object.values(roomState.players).forEach((player) => {
      Object.assign(player, {
        currentRound,
        currentQuestionIndex: 0,
        score: 0,
        answers: [],
        submitted: false,
        finishedAt: null,
        elapsedMs: null,
        status: 'waiting',
      })
    })
    expireQueuedEffects(roomState, Date.now())
    Object.values(roomState.magic).forEach((magic) => { magic.inventory = [] })
    await writeState(state)
  }

  async closeRoom(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    roomState.room.status = 'closed'
    Object.values(roomState.players).forEach((player) => {
      player.status = 'stopped'
    })
    expireQueuedEffects(roomState, Date.now())
    await writeState(state)
  }

  async randomizeTeams(roomCode: string, teacherSessionId: string, teamCount: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:จัดทีมได้เฉพาะช่วงห้องรอ')
    if (roomState.room.teamsLocked) throw new Error('ผู้ใช้:กรุณาปลดล็อกทีมก่อนสุ่มใหม่')
    if (!Number.isFinite(teamCount) || teamCount < 1) throw new Error('ผู้ใช้:จำนวนทีมต้องมีอย่างน้อย 1 ทีม')

    const playerIds = Object.keys(roomState.players)
    if (playerIds.length === 0) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังจัดทีมไม่ได้')
    if (teamCount > playerIds.length) throw new Error('ผู้ใช้:จำนวนทีมต้องไม่เกินจำนวนผู้เล่น')
    const assignment = distributeTeamsEvenly(playerIds, teamCount)
    const teams = buildTeamMetas(teamCount)
    // Apply the room's team labels, every player's teamId, AND the display-only roster
    // summary together before the single writeState call below, so no observer ever sees
    // teams assigned while players (or the roster built from them) aren't — this is the
    // in-memory equivalent of one atomic Firestore batch. The roster is rebuilt wholesale
    // from this exact assignment every time, including re-randomizes before lock, so it can
    // never observably lag or diverge from what it was built from.
    roomState.room.teamCount = teamCount
    roomState.room.teams = teams
    playerIds.forEach((playerId) => {
      roomState.players[playerId].teamId = assignment[playerId]
    })
    const rosters: Record<string, TeamRosterSummary> = {}
    teams.forEach((team) => { rosters[team.id] = { teamId: team.id, teamName: team.name, members: [] } })
    playerIds.forEach((playerId) => {
      const teamId = assignment[playerId]
      const player = roomState.players[playerId]
      rosters[teamId]?.members.push({ playerId, displayName: player.displayName })
    })
    roomState.rosters = rosters
    await writeState(state)
  }

  async lockTeams(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.teams.length === 0) throw new Error('ผู้ใช้:กรุณาสุ่มทีมก่อนล็อกทีม')
    // Lock FIRST, before re-checking the roster. A join that reads the room after this write
    // sees teamsLocked=true and is rejected as a new join (reconnects are unaffected — they
    // never check teamsLocked). Only after the lock is committed do we re-read every player;
    // this closes the race where a student finishes joining in the brief window between the
    // "any unassigned?" check and the lock write actually landing.
    roomState.room.teamsLocked = true
    await writeState(state)

    const latestState = await readState()
    const latestRoomState = latestState.rooms[roomCode]
    if (!latestRoomState) return
    const hasUnassigned = Object.values(latestRoomState.players).some((player) => player.teamId == null)
    if (hasUnassigned) {
      latestRoomState.room.teamsLocked = false
      await writeState(latestState)
      throw new Error('ผู้ใช้:มีผู้เล่นบางคนยังไม่ได้จัดทีม กรุณาสุ่มทีมอีกครั้ง')
    }

    // Success: (re)select exactly one holder per team and give every team a fresh, empty
    // magic state — "re-locking after unlock may select holders again."
    const memberIdsByTeam: Record<string, string[]> = {}
    latestRoomState.room.teams.forEach((team) => { memberIdsByTeam[team.id] = [] })
    Object.values(latestRoomState.players).forEach((player) => {
      if (player.teamId && memberIdsByTeam[player.teamId]) memberIdsByTeam[player.teamId].push(player.id)
    })
    const holders = pickHolders(memberIdsByTeam)
    latestRoomState.magic = {}
    latestRoomState.room.teams.forEach((team) => {
      latestRoomState.magic[team.id] = {
        teamId: team.id,
        magicHolderPlayerId: holders[team.id] ?? null,
        inventory: [],
        queuedEffect: null,
      }
    })
    await writeState(latestState)
  }

  async unlockTeams(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:ปลดล็อกทีมได้เฉพาะช่วงห้องรอ')
    roomState.room.teamsLocked = false
    await writeState(state)
  }

  async saveAnswer(roomCode: string, playerId: string, answer: AnswerInput): Promise<AnswerResult> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const player = roomState?.players[playerId]
    if (!roomState || !player) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    if (roomState.room.status === 'completed') throw new Error('ผู้ใช้:ภารกิจรอบนี้สิ้นสุดแล้ว')
    if (roomState.room.status !== 'playing') throw new Error('ผู้ใช้:ภารกิจยังไม่เริ่มหรือสิ้นสุดแล้ว')
    if (player.submitted || roomState.room.currentQuestionIndex !== answer.expectedQuestionIndex) throw new Error('ผู้ใช้:ลำดับคำถามเปลี่ยนแล้ว กรุณารอข้อถัดไป')
    const deadline = (roomState.room.questionStartedAt ?? 0) + roomState.room.questionDurationSeconds * 1_000
    if (!roomState.room.questionStartedAt || Date.now() >= deadline) throw new Error('ผู้ใช้:หมดเวลาตอบคำถามข้อนี้แล้ว')
    if (roomState.room.questionIds[answer.expectedQuestionIndex] !== answer.questionId) {
      throw new Error('ผู้ใช้:ลำดับคำถามไม่ตรงกับรอบปัจจุบัน กรุณาโหลดหน้าใหม่')
    }

    const question = questionsById.get(answer.questionId)
    const evaluated = evaluateChoice(question, answer.selectedChoiceId)
    if (!evaluated.valid) {
      throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
    }
    const isCorrect = evaluated.isCorrect
    const existingAnswerIndex = player.answers.findIndex((item) => item.questionId === answer.questionId)
    const existingAnswer = existingAnswerIndex >= 0 ? player.answers[existingAnswerIndex] : undefined

    const record = {
      questionId: answer.questionId,
      selectedChoiceId: answer.selectedChoiceId,
      isCorrect,
      answeredAt: Date.now(),
      responseTimeMs: Date.now() - (roomState.room.questionStartedAt ?? Date.now()),
    }
    if (existingAnswerIndex >= 0) player.answers[existingAnswerIndex] = record
    else player.answers.push(record)
    player.score += (isCorrect ? 1 : 0) - (existingAnswer?.isCorrect ? 1 : 0)
    // Overwrite (never append) this player's own progress entry — first answer or changing
    // the choice for the same question both land here, so "X" can never double-count a
    // teammate. Once the room moves to the next question, this entry's questionId no longer
    // matches room.currentQuestionIndex's question, so it stops counting toward the new
    // question's total with no explicit reset needed.
    if (player.teamId) {
      roomState.answerProgress[playerId] = {
        playerId,
        teamId: player.teamId,
        questionId: answer.questionId,
        answeredAt: record.answeredAt,
      }
    }
    await writeState(state)
    return { player, winner: null }
  }

  async chooseStartingItem(roomCode: string, teamId: string, playerId: string, itemType: MagicItemType): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    const magic = roomState.magic[teamId]
    if (!magic) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
    if (magic.magicHolderPlayerId !== playerId) throw new Error('ผู้ใช้:คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')
    if (roomState.room.status !== 'waiting' || !roomState.room.teamsLocked) {
      throw new Error('ผู้ใช้:เลือกไอเทมเริ่มต้นได้เฉพาะช่วงห้องรอหลังล็อกทีมแล้ว')
    }
    if (magic.inventory.length > 0) throw new Error('ผู้ใช้:ทีมนี้เลือกไอเทมเริ่มต้นไปแล้ว')
    magic.inventory = [{ itemType, acquiredAt: Date.now(), consumed: false, consumedAt: null }]
    await writeState(state)
  }

  async activateItem(
    roomCode: string,
    teamId: string,
    playerId: string,
    itemType: 'power_surge' | 'score_seal',
    targetTeamId?: string,
  ): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    const magic = roomState.magic[teamId]
    if (!magic) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
    if (magic.magicHolderPlayerId !== playerId) throw new Error('ผู้ใช้:คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')

    const window = getMagicActivationWindow(roomState.room)
    if (!window.valid || window.affectedQuestionIndex == null) {
      throw new Error('ผู้ใช้:ไม่สามารถใช้ไอเทมได้ในขณะนี้ กรุณารอช่วงพักหรือรอบถัดไป')
    }
    const affectedQuestionIndex = window.affectedQuestionIndex

    const inventoryItem = magic.inventory.find((item) => item.itemType === itemType && !item.consumed)
    if (!inventoryItem) throw new Error('ผู้ใช้:ไม่มีไอเทมนี้ในคลังของทีม')

    const resolvedTargetTeamId = itemType === 'power_surge' ? teamId : targetTeamId
    const now = Date.now()

    // A legitimate holder attempt that fails validation still gets an audit record — this is
    // what makes "duplicate activation rejected" / "wrong target rejected" visible in the
    // teacher's event history, not just a toast the student saw.
    const rejectEvent = (): void => {
      roomState.magicEvents.push({
        id: `magic-${createId()}`,
        itemType,
        actorPlayerId: playerId,
        sourceTeamId: teamId,
        targetTeamId: resolvedTargetTeamId ?? null,
        affectedQuestionIndex,
        status: 'rejected',
        createdAt: now,
        resolvedAt: now,
      })
    }

    if (magic.queuedEffect) {
      rejectEvent()
      await writeState(state)
      throw new Error('ผู้ใช้:ทีมนี้มีไอเทมที่กำลังรอผลอยู่แล้ว')
    }

    if (itemType === 'score_seal') {
      if (!targetTeamId) {
        rejectEvent()
        await writeState(state)
        throw new Error('ผู้ใช้:กรุณาเลือกทีมเป้าหมาย')
      }
      if (targetTeamId === teamId) {
        rejectEvent()
        await writeState(state)
        throw new Error('ผู้ใช้:เลือกทีมตัวเองเป็นเป้าหมายไม่ได้')
      }
      if (!roomState.room.teams.some((team) => team.id === targetTeamId)) {
        rejectEvent()
        await writeState(state)
        throw new Error('ผู้ใช้:ไม่พบทีมเป้าหมาย')
      }
      const alreadyTargeted = Object.values(roomState.magic).some((otherMagic) =>
        otherMagic.queuedEffect?.itemType === 'score_seal'
        && otherMagic.queuedEffect.targetTeamId === targetTeamId
        && otherMagic.queuedEffect.affectedQuestionIndex === affectedQuestionIndex,
      )
      if (alreadyTargeted) {
        rejectEvent()
        await writeState(state)
        throw new Error('ผู้ใช้:ทีมเป้าหมายถูกใช้ไอเทมฝ่ายตรงข้ามในข้อนี้ไปแล้ว')
      }
    }

    const effectId = `magic-${createId()}`
    magic.queuedEffect = {
      id: effectId,
      itemType,
      sourceTeamId: teamId,
      targetTeamId: resolvedTargetTeamId as string,
      affectedQuestionIndex,
      createdAt: now,
    }
    roomState.magicEvents.push({
      id: effectId,
      itemType,
      actorPlayerId: playerId,
      sourceTeamId: teamId,
      targetTeamId: resolvedTargetTeamId ?? null,
      affectedQuestionIndex,
      status: 'queued',
      createdAt: now,
      resolvedAt: null,
    })
    await writeState(state)
  }
}
