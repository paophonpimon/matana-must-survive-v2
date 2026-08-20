import { questions, questionsById } from '../data/questions'
import { bossQuestions } from '../data/bossQuestions'
import { ASSESSMENT_QUESTION_COUNT, POST_TEST_QUESTIONS, PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { isValidSurveyValue, SURVEY_ITEMS, SURVEY_ITEM_COUNT } from '../data/surveyItems'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { evaluateChoice, generateRoomCode, selectRoundQuestions } from '../lib/game'
import { bossQuestionTiming, getRemainingMilliseconds, isAssessmentExpired, mainQuestionTiming, postTestProgressOf, postTestWindow, preTestProgressOf, preTestWindow, recallQuestionTiming } from '../lib/gameFlow'
import { computeBossRanking, pickRandomMagicItem, selectBossQuestions } from '../lib/boss'
import { MAGIC_ITEM_TYPES, computeTeamQuestionBreakdown, getMagicActivationWindow, hasAnyMagicItem, pickElectedCaptain, pickIllusionHiddenChoices } from '../lib/magic'
import { buildRoundHistoryEntry, roundHistoryEntryId } from '../lib/roundHistory'
import { buildShowcaseDocuments, showcaseCollisionMessage, showcaseHistoryDocId } from '../lib/showcaseImport'
import { SHOWCASE_MODE_FIELD, type RosterStudent } from '../lib/showcaseRound'
import { buildTeamMetas, distributeTeamsEvenly, normalizeTeamGuardianName, validateTeamGuardianName } from '../lib/teamScoring'
import type { AnswerInput, AnswerResult, BossAnswerInput, GameService, PostTestAnswerInput, PreTestAnswerInput, RecallAnswerInput, SurveyResponseInput } from './gameService'
import {
  BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX,
  DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION,
  MAX_ASSESSMENT_SECONDS_PER_QUESTION,
  MIN_ASSESSMENT_SECONDS_PER_QUESTION,
  DEFAULT_BOSS_QUESTION_DURATION_SECONDS,
  MAX_BOSS_SECONDS_PER_QUESTION,
  MAX_RECALL_SECONDS_PER_ITEM,
  MIN_BOSS_SECONDS_PER_QUESTION,
  MIN_RECALL_SECONDS_PER_ITEM,
  RECALL_QUESTION_COUNT,
  RECALL_SECONDS_PER_ITEM,
  RECALL_TIMEOUT_CHOICE_ID,
  createEmptyMagicInventory,
} from '../types/game'
import type {
  AnswerProgressEntry,
  BossAnswerRecord,
  CaptainVote,
  CaptainVoteProgress,
  JoinInput,
  JoinResult,
  MagicEvent,
  MagicItemType,
  Player,
  QueuedMagicEffect,
  RecallAnswerRecord,
  Room,
  RoundHistoryEntry,
  TeacherRoomSummary,
  TeamGuardianName,
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
  // Milestone 4.1: one entry per VOTER (not per team) — see CaptainVote/CaptainVoteProgress's
  // doc comments in types/game.ts for the private-vs-broad split rationale.
  captainVotes: Record<string, CaptainVote>
  captainVoteProgress: Record<string, CaptainVoteProgress>
  // Team guardian names — keyed by teamId, mirroring magic/captainVotes' shape.
  teamNames: Record<string, TeamGuardianName>
  // Immutable per-round learning snapshots, keyed by `${round}-${playerId}`. Deliberately kept
  // OUTSIDE `players` so a round reset (which wipes answers/score) can never erase it.
  roundHistory: Record<string, RoundHistoryEntry>
}

interface DemoState {
  rooms: Record<string, DemoRoomState>
}

// Teacher-configured durations are clamped service-side, not just in the form, so a hand-crafted
// request can't set a 0-second or absurdly long timer.
const clampRecallDuration = (seconds: number): number =>
  Math.max(MIN_RECALL_SECONDS_PER_ITEM, Math.min(MAX_RECALL_SECONDS_PER_ITEM, Math.round(seconds)))
// Assessment budget clamp. Shared by both services so a teacher-supplied duration can never be
// out of range on one backend and valid on the other.
const clampAssessmentDuration = (seconds: number): number =>
  Math.max(MIN_ASSESSMENT_SECONDS_PER_QUESTION, Math.min(MAX_ASSESSMENT_SECONDS_PER_QUESTION, Math.round(seconds)))
const clampBossDuration = (seconds: number): number =>
  Math.max(MIN_BOSS_SECONDS_PER_QUESTION, Math.min(MAX_BOSS_SECONDS_PER_QUESTION, Math.round(seconds)))

// Round history: immutable per-round, per-student learning snapshots, keyed by the deterministic
// `${round}-${playerId}` id. Written by the teacher-only operations that end a round, BEFORE
// player data is reset — see recordRoundHistory below.
const snapshotRoundHistory = (roomState: DemoRoomState): void => {
  const { room } = roomState
  roomState.roundHistory ??= {}
  const completedAt = Date.now()
  Object.values(roomState.players).forEach((player) => {
    const id = roundHistoryEntryId(room.currentRound, player.id)
    // Idempotent: a round already recorded is never rewritten, so a second reset/close (or a
    // retried call) can't duplicate or mutate a finished round's record.
    if (roomState.roundHistory[id]) return
    const teamName = player.teamId
      ? roomState.teamNames[player.teamId]?.name?.trim() || room.teams.find((team) => team.id === player.teamId)?.name || ''
      : ''
    roomState.roundHistory[id] = buildRoundHistoryEntry(player, room.currentRound, teamName, completedAt)
  })
}

// Milestone 4: bumped from v5 — the magic inventory shape changed from an array of individual
// item instances to a per-item-type count map (see types/game.ts's MagicInventory), and Room/
// Player both gained new required fields (boss-phase state, bossAnswers). This is dev/demo data
// only, so rather than writing array-to-map migration code, older saved state under the old key
// is simply left alone and a fresh seed is created under the new key.
// Exported (not just module-private) so tests can read/write the live demo state directly
// without hardcoding a version string that silently goes stale — and stops matching what the
// service actually reads — every time this key is bumped.
export const DEMO_STORAGE_KEY = 'matana_demo_state_v6'
const STORAGE_KEY = DEMO_STORAGE_KEY
const UPDATE_EVENT = 'matana-demo-update'
const DEMO_ROOM_CODE = 'MATANA'
const SHARED_STATE_PATH = '/__matana_demo_state'

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
  bossAnswers: [],
  recallAnswers: [],
  preTestAnswers: [],
  postTestAnswers: [],
  preTestProgress: 0,
  postTestProgress: 0,
  preTestQuestionStartedAt: null,
  postTestQuestionStartedAt: null,
  surveyResponses: [],
  submitted: false,
  finishedAt: null,
  elapsedMs: null,
  status: 'waiting',
  ownerUid,
})

// Shared by createSeedState and createRoom — the boss-phase fields a brand-new room always
// starts with. Factored out so the two call sites can never drift on what "fresh" means.
// Learning Layer: `phase` defaults to 'recall' (not 'main') — the mandatory individual Story
// Recall phase every round now begins with, before startMainAfterRecall ever moves it to 'main'.
const createFreshBossFields = (): Pick<
  Room,
  'phase' | 'bossQuestionIds' | 'bossQuestionIndex' | 'bossQuestionStartedAt' | 'bossQuestionDurationSeconds' | 'bossCompleted' | 'bossWinner' | 'bossAwaitingContinue' | 'preTestStartedAt' | 'postTestStartedAt'
> => ({
  phase: 'lobby',
  // A new round re-opens both tests from scratch; startPreTest and the Main->postTest transition
  // each write a fresh instant, so clearing here just stops a finished round's deadline lingering.
  preTestStartedAt: null,
  postTestStartedAt: null,
  bossQuestionIds: [],
  bossQuestionIndex: 0,
  bossQuestionStartedAt: null,
  bossQuestionDurationSeconds: DEFAULT_BOSS_QUESTION_DURATION_SECONDS,
  bossCompleted: false,
  bossWinner: null,
  bossAwaitingContinue: false,
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
    questionClosedAt: null,
    recallQuestionDurationSeconds: RECALL_SECONDS_PER_ITEM,
    recallQuestionIndex: 0,
    recallQuestionStartedAt: null,
    assessmentSecondsPerQuestion: DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION,
    ...createFreshBossFields(),
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
  return { rooms: { [DEMO_ROOM_CODE]: { room, players, magic: {}, magicEvents: [], rosters: {}, answerProgress: {}, captainVotes: {}, captainVoteProgress: {}, teamNames: {}, roundHistory: {} } } }
}

const normalizeState = (state: DemoState): DemoState => {
  Object.values(state.rooms).forEach((roomState) => {
    const { room } = roomState
    room.currentQuestionIndex ??= 0
    room.questionDurationSeconds ??= 30
    room.questionStartedAt ??= room.status === 'playing' ? room.startedAt : null
    // Milestone 2.2: older saved demo state won't have this field at all.
    room.questionClosedAt ??= null
    room.teamCount ??= 0
    room.teamsLocked ??= false
    room.teams ??= []
    // Milestone 4: defensive defaults in case a v6 room somehow predates one of these fields
    // being added (STORAGE_KEY was already bumped for the inventory shape change, but this
    // costs nothing and matches the established pattern for every prior field addition here).
    room.phase ??= room.status === 'playing' ? 'main' : 'lobby'
    room.recallQuestionDurationSeconds ??= RECALL_SECONDS_PER_ITEM
    room.recallQuestionIndex ??= 0
    room.recallQuestionStartedAt ??= null
    room.bossQuestionIds ??= []
    room.bossQuestionIndex ??= 0
    room.bossQuestionStartedAt ??= null
    room.bossQuestionDurationSeconds ??= DEFAULT_BOSS_QUESTION_DURATION_SECONDS
    room.bossCompleted ??= false
    room.bossWinner ??= null
    // Pause-and-continue gate: older saved demo state predates this entirely.
    room.bossAwaitingContinue ??= false
    // Assessment Layer timing: saved demo state from before the total-test timer has none of
    // these. A missing duration must fall back to the default, never 0, which would read as an
    // already-expired test; a missing start instant means "not opened yet".
    room.assessmentSecondsPerQuestion ??= DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION
    room.preTestStartedAt ??= null
    room.postTestStartedAt ??= null
    roomState.magic ??= {}
    roomState.magicEvents ??= []
    // Older saved demo state (before this migration) won't have these keys at all — default
    // to empty rather than crashing.
    roomState.rosters ??= {}
    roomState.answerProgress ??= {}
    // Milestone 4.1: captain election state — older saved state predates this entirely.
    roomState.captainVotes ??= {}
    roomState.captainVoteProgress ??= {}
    // Team guardian names — older saved demo state predates this entirely.
    roomState.teamNames ??= {}
    roomState.roundHistory ??= {}
    Object.values(roomState.magic).forEach((magic) => { magic.captainElectionAttempt ??= 1 })
    // Milestone 2.1: events/progress saved before round-tracking existed won't have these
    // fields — default them to round 1 (the only round that could have existed back then)
    // rather than letting a later round's competition-score/progress filtering crash or
    // silently treat them as `undefined`.
    roomState.magicEvents.forEach((event) => { event.round ??= 1 })
    Object.values(roomState.answerProgress).forEach((entry) => { entry.currentRound ??= 1 })
    Object.values(roomState.players).forEach((player) => {
      player.bossAnswers ??= []
      // Assessment progress: saved state from before this existed had progress == answers.length.
      player.preTestProgress ??= player.preTestAnswers?.length ?? 0
      player.postTestProgress ??= player.postTestAnswers?.length ?? 0
      player.preTestQuestionStartedAt ??= null
      player.postTestQuestionStartedAt ??= null
      // Learning Layer: older saved demo state predates Story Recall entirely.
      player.recallAnswers ??= []
      // Assessment Layer: older saved demo state predates pre/post-test and the survey entirely.
      player.preTestAnswers ??= []
      player.postTestAnswers ??= []
      player.surveyResponses ??= []
    })
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
      return { available: false, state: null }
    }
    const payload = await response.json() as { state?: DemoState | null }
    return { available: true, state: payload.state ?? null }
  } catch {
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
    return response.ok
  } catch {
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
  // Write-path staleness fix (mirrors the `listen()` fix above): this must ALWAYS attempt the
  // shared push, not only when a previous fetch happened to have succeeded. This used to be
  // gated behind a module-level "is the shared endpoint available" flag that was only ever
  // recomputed as a side effect of a previous read/write succeeding — so a write attempted while
  // that flag was false (its pessimistic initial value, or latched false by any earlier
  // transient failure) was silently applied to local storage only and never even attempted
  // against the shared endpoint: invisible to the writer (their own tab looked correct) but
  // permanently withheld from every remote device, and liable to be silently reverted on the
  // writer's own device the moment some unrelated later read found the endpoint reachable again
  // and pulled back the older state that had never been overwritten. `state` is always a full
  // snapshot (never a delta), so attempting this on every write is naturally idempotent — no
  // duplicate mutations, just last-write-wins.
  await writeSharedState(state)
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
  // Realtime staleness fix: this poll must ALWAYS fire, not just while a previous fetch happened
  // to have succeeded. This used to be gated behind a module-level "is the shared endpoint
  // available" flag that was only ever recomputed as a SIDE EFFECT of actually calling
  // readSharedState()/writeSharedState() (via callback -> emit -> readState) — so gating the
  // poll on that same flag made it a stuck circuit breaker: if the very first fetch (the initial
  // `void emit()` a subscription does on subscribe) failed for any transient reason — slower/
  // less reliable than localhost, e.g. a real device joining over classroom WiFi while the dev
  // server's `--host` network path was still settling — the flag latched false and nothing ever
  // polled again to notice it had recovered, since the poll itself was the only thing that could
  // flip it back. That is exactly "same-device testing (near-zero chance the first same-origin
  // fetch fails) never reproduces it, a genuinely remote device sometimes does, and only a full
  // reload — a fresh bootstrap attempt — recovers." Always calling callback() here restores
  // retry-until-it-works, matching how the read path is supposed to behave without needing a
  // manual refresh.
  const intervalId = typeof window.setInterval === 'function'
    ? window.setInterval(() => { callback() }, 300)
    : null
  return () => {
    window.removeEventListener('storage', storageListener)
    window.removeEventListener(UPDATE_EVENT, callback)
    if (intervalId !== null) window.clearInterval(intervalId)
  }
}

const consumeInventoryItem = (magic: TeamMagicState, itemType: MagicItemType): void => {
  const entry = magic.inventory[itemType]
  if (entry.available > 0) {
    entry.available -= 1
    entry.consumed += 1
  }
}

// Runs when leaving `resolvedQuestionIndex` (either advancing to the next question or
// completing the round). Milestone 4: multiple DIFFERENT teams may each have a score_seal
// queued against the SAME target+question (stacking is now allowed — there is no longer an
// "already targeted" restriction at activation time), so resolution is split into passes:
// (1) clear every queued slot + consume each source team's own item regardless of outcome,
// (2) power_surge always applies (a team's own buff is never blockable), (3) score_seals are
// grouped by target team and resolved against that team's available shields — each available
// shield blocks exactly one seal (consuming it); any seals beyond the available shield count
// still apply. Sorted by sourceTeamId for deterministic (test-reproducible) shield-consumption
// order — which specific seal ends up 'blocked' vs 'applied' depends on this order, but the
// FINAL multiplier never does, since only the blocked-vs-applied COUNT matters there.
const resolveQuestionMagic = (roomState: DemoRoomState, resolvedQuestionIndex: number, now: number): void => {
  const effectsThisQuestion: Array<{ magic: TeamMagicState; effect: QueuedMagicEffect }> = []
  for (const team of roomState.room.teams) {
    const magic = roomState.magic[team.id]
    const effect = magic?.queuedEffect
    if (!magic || !effect || effect.affectedQuestionIndex !== resolvedQuestionIndex) continue
    effectsThisQuestion.push({ magic, effect })
  }
  if (effectsThisQuestion.length === 0) return

  for (const { magic, effect } of effectsThisQuestion) {
    magic.queuedEffect = null
    consumeInventoryItem(magic, effect.itemType)
  }

  // power_surge and illusion are both self-only buffs — never blockable by a shield, always
  // applied. Illusion contributes no score multiplier at all (see computeAppliedMagicMultipliers
  // in lib/magic.ts, which only branches on power_surge/score_seal — illusion falls through and
  // is correctly ignored there), so marking it 'applied' here only affects its visibility in the
  // event history/UI, never scoring.
  for (const { effect } of effectsThisQuestion) {
    if (effect.itemType !== 'power_surge' && effect.itemType !== 'illusion') continue
    const event = roomState.magicEvents.find((item) => item.id === effect.id)
    if (event) {
      event.status = 'applied'
      event.resolvedAt = now
    }
  }

  const sealsByTarget = new Map<string, Array<{ effect: QueuedMagicEffect }>>()
  for (const entry of effectsThisQuestion) {
    if (entry.effect.itemType !== 'score_seal') continue
    const list = sealsByTarget.get(entry.effect.targetTeamId) ?? []
    list.push({ effect: entry.effect })
    sealsByTarget.set(entry.effect.targetTeamId, list)
  }
  sealsByTarget.forEach((seals, targetTeamId) => {
    const targetMagic = roomState.magic[targetTeamId]
    const sorted = [...seals].sort((a, b) => a.effect.sourceTeamId.localeCompare(b.effect.sourceTeamId))
    for (const { effect } of sorted) {
      const event = roomState.magicEvents.find((item) => item.id === effect.id)
      if (targetMagic && targetMagic.inventory.rose_shield.available > 0) {
        targetMagic.inventory.rose_shield.available -= 1
        targetMagic.inventory.rose_shield.consumed += 1
        if (event) {
          event.status = 'blocked'
          event.resolvedAt = now
        }
      } else if (event) {
        event.status = 'applied'
        event.resolvedAt = now
      }
    }
  })
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
      questionClosedAt: null,
      recallQuestionDurationSeconds: RECALL_SECONDS_PER_ITEM,
      recallQuestionIndex: 0,
      recallQuestionStartedAt: null,
      assessmentSecondsPerQuestion: DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION,
      ...createFreshBossFields(),
      questionIds: selectRoundQuestions(questions),
      previousQuestionIds: [],
      winner: null,
      teacherSessionId,
      teamCount: 0,
      teamsLocked: false,
      teams: [],
    }
    state.rooms[roomCode] = { room, players: {}, magic: {}, magicEvents: [], rosters: {}, answerProgress: {}, captainVotes: {}, captainVoteProgress: {}, teamNames: {}, roundHistory: {} }
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

  async startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number, bossQuestionDurationSeconds?: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status === 'playing') throw new Error('ผู้ใช้:ภารกิจกำลังดำเนินอยู่แล้ว')
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:กรุณาเตรียมภารกิจรอบใหม่ก่อนเริ่ม')
    // Main can only start once Recall's shared timeline has finished this round — team setup,
    // Pre-test and Recall have all already run by this point (in that order). This is the gate
    // that makes "Recall happens directly before Main, with no second team-management
    // interruption in between" structural rather than merely the order the teacher clicks things.
    if (roomState.room.phase !== 'recall') throw new Error('ผู้ใช้:กรุณาทำแบบทดสอบก่อนเรียนและทบทวนเรื่องราวให้เสร็จก่อนเริ่มเกมหลัก')
    if (roomState.room.recallQuestionIndex < RECALL_QUESTION_COUNT) {
      throw new Error('ผู้ใช้:ต้องทำทบทวนเรื่องราวให้ครบทั้ง 5 ข้อก่อนเริ่มเกมหลัก')
    }
    if (Object.keys(roomState.players).length === 0) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังเริ่มภารกิจไม่ได้')
    // Team readiness (locked, captain, item, name) is the teamSetup -> preTest gate now (see
    // startPreTest below) — re-checked here too as a defensive backstop, since a teacher can
    // still reset/override a team's guardian name at any time (resetTeamGuardianName/
    // overrideTeamGuardianName carry no phase restriction by design).
    if (!roomState.room.teamsLocked) throw new Error('ผู้ใช้:กรุณาล็อกทีมก่อนเริ่มภารกิจ')
    // Milestone 4.1: every team must have finished electing a captain before the game can
    // start — chooseStartingItem/activateItem are already holder-gated, so without a captain
    // elected first, a team could never have picked a starting item anyway; this check exists
    // to surface a clear, specific error instead of relying on that indirect consequence.
    const teamsWithoutCaptain = roomState.room.teams.filter((team) => roomState.magic[team.id]?.magicHolderPlayerId == null)
    if (teamsWithoutCaptain.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องเลือกหัวหน้าทีมก่อนเริ่มภารกิจ')
    const teamsWithoutStartingItem = roomState.room.teams.filter((team) => !hasAnyMagicItem(roomState.magic[team.id]?.inventory ?? createEmptyMagicInventory()))
    if (teamsWithoutStartingItem.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องเลือกไอเทมเริ่มต้นก่อนเริ่มภารกิจ')
    const teamsWithoutName = roomState.room.teams.filter((team) => !(roomState.teamNames[team.id]?.name ?? '').trim())
    if (teamsWithoutName.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องตั้งชื่อทีมก่อนเริ่มภารกิจ')
    roomState.room.status = 'playing'
    roomState.room.startedAt = Date.now()
    roomState.room.phase = 'main'
    roomState.room.currentQuestionIndex = 0
    roomState.room.questionDurationSeconds = Math.max(5, Math.min(600, Math.round(questionDurationSeconds)))
    if (bossQuestionDurationSeconds != null) {
      roomState.room.bossQuestionDurationSeconds = clampBossDuration(bossQuestionDurationSeconds)
    }
    roomState.room.questionStartedAt = roomState.room.startedAt
    roomState.room.questionClosedAt = null
    Object.values(roomState.players).forEach((player) => {
      player.status = 'playing'
    })
    await writeState(state)
  }

  // Pre-game stage 2 -> 3: 'teamSetup' -> 'preTest'. Teacher-only, fired once team setup
  // (randomize -> lock -> captain -> guardian name -> starting item) is complete. This is the
  // readiness gate that used to live on startRoom, moved here since team setup now completes
  // BEFORE the pre-test rather than immediately before Main — the class must never enter the
  // individual assessment phase with an unfinished team. Idempotent by stage check: a
  // stale/duplicate call once already past 'teamSetup' is a safe no-op.
  async startPreTest(roomCode: string, teacherSessionId: string, assessmentSecondsPerQuestion?: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:เริ่มแบบทดสอบก่อนเรียนได้เฉพาะช่วงห้องรอ')
    if (roomState.room.phase !== 'teamSetup') return
    if (!roomState.room.teamsLocked) throw new Error('ผู้ใช้:กรุณาล็อกทีมก่อนเริ่มภารกิจ')
    // Milestone 4.1: every team must have finished electing a captain, chosen a starting item,
    // and been given a guardian name before the class may leave team setup — chooseStartingItem/
    // castCaptainVote/setTeamGuardianName are all holder-gated AND phase-gated to 'teamSetup', so
    // once this check passes, none of the three can silently un-set themselves during the
    // pre-test or recall that follow.
    const teamsWithoutCaptain = roomState.room.teams.filter((team) => roomState.magic[team.id]?.magicHolderPlayerId == null)
    if (teamsWithoutCaptain.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องเลือกหัวหน้าทีมก่อนเริ่มภารกิจ')
    const teamsWithoutStartingItem = roomState.room.teams.filter((team) => !hasAnyMagicItem(roomState.magic[team.id]?.inventory ?? createEmptyMagicInventory()))
    if (teamsWithoutStartingItem.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องเลือกไอเทมเริ่มต้นก่อนเริ่มภารกิจ')
    const teamsWithoutName = roomState.room.teams.filter((team) => !(roomState.teamNames[team.id]?.name ?? '').trim())
    if (teamsWithoutName.length > 0) throw new Error('ผู้ใช้:ทุกทีมต้องตั้งชื่อทีมก่อนเริ่มภารกิจ')
    roomState.room.phase = 'preTest'
    if (assessmentSecondsPerQuestion != null) {
      roomState.room.assessmentSecondsPerQuestion = clampAssessmentDuration(assessmentSecondsPerQuestion)
    }
    // Offset by the phase-intro cutscene so the budget does not tick while the intro plays. This
    // is the authoritative instant every client derives its deadline from.
    roomState.room.preTestStartedAt = Date.now()
    await writeState(state)
  }

  async startRecall(roomCode: string, teacherSessionId: string, recallQuestionDurationSeconds?: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:เริ่มทบทวนเรื่องราวได้เฉพาะช่วงห้องรอ')
    // Recall now follows the pre-test, so this is the preTest -> recall step. A stale/duplicate
    // click from any other stage is a safe no-op, exactly as the lobby guard used to be.
    if (roomState.room.phase !== 'preTest') return
    if (Object.keys(roomState.players).length === 0) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังเริ่มทบทวนเรื่องราวไม่ได้')
    roomState.room.phase = 'recall'
    if (recallQuestionDurationSeconds != null) {
      roomState.room.recallQuestionDurationSeconds = clampRecallDuration(recallQuestionDurationSeconds)
    }
    // Question 1 starts for the whole room at this instant — the shared timeline begins here.
    roomState.room.recallQuestionIndex = 0
    roomState.room.recallQuestionStartedAt = Date.now()
    await writeState(state)
  }

  // Room-synchronized Recall advance, mirroring advanceQuestion's shape exactly: the caller names
  // the index it believes is live, and anything else is a silent no-op. That expected-index guard
  // is what makes duplicate timer callbacks (several teacher tabs, a re-render, a retry) unable to
  // skip a question. Advancing past the last item leaves recallQuestionIndex at
  // RECALL_QUESTION_COUNT with no start time — the "sequence finished" state.
  async advanceRecallQuestion(roomCode: string, teacherSessionId: string, expectedRecallIndex: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (
      roomState.room.status !== 'waiting'
      || roomState.room.phase !== 'recall'
      || roomState.room.recallQuestionIndex !== expectedRecallIndex
      || roomState.room.recallQuestionIndex >= RECALL_QUESTION_COUNT
    ) {
      return
    }
    const nextIndex = roomState.room.recallQuestionIndex + 1
    roomState.room.recallQuestionIndex = nextIndex
    roomState.room.recallQuestionStartedAt = nextIndex >= RECALL_QUESTION_COUNT ? null : Date.now()
    await writeState(state)
  }

  // Pre-game stage 1 -> 2: 'lobby' -> 'teamSetup'. Teacher-only, fired once enough students have
  // joined. Hands off to the EXISTING team workflow completely unchanged (randomize -> lock ->
  // captain -> guardian name -> starting item), which all already gate on status === 'waiting'
  // and therefore needed no changes at all — only their phase check now requires 'teamSetup'
  // (see randomizeTeams/lockTeams/chooseStartingItem/castCaptainVote/setTeamGuardianName below),
  // which is what makes "no second team-management interruption" after Pre-test/Recall true by
  // construction. Idempotent by stage check: a stale/duplicate call once already past 'lobby' is
  // a safe no-op rather than a restart that would wipe progress.
  async startTeamSetup(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:จัดทีมได้เฉพาะช่วงห้องรอ')
    if (roomState.room.phase !== 'lobby') return
    if (Object.keys(roomState.players).length === 0) throw new Error('ผู้ใช้:ยังไม่มีผู้เล่นเข้าร่วม จึงยังจัดทีมไม่ได้')
    roomState.room.phase = 'teamSetup'
    await writeState(state)
  }

  // Learning Layer: individual, non-competitive, first-answer-locked — mirrors saveBossAnswer's
  // idempotent "already answered -> silent no-op" shape, but with its own no-skip guard
  // (expectedRecallIndex must be exactly player.recallAnswers.length, and must name the concept
  // RECALL_QUESTIONS actually holds at that position) instead of a room-synchronized index/timer,
  // since Recall has neither: every student progresses through the same fixed 5 questions at
  // their own pace. Never touches player.answers/score/bossAnswers, never reads magic/team data —
  // this is what makes "no competitive points, no team-score impact, no magic, no speed scoring"
  // true by construction, the same way BossAnswerRecord's separation already does for boss.
  async saveRecallAnswer(roomCode: string, playerId: string, answer: RecallAnswerInput): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const player = roomState?.players[playerId]
    if (!roomState || !player) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    // Recall runs while the room is still 'waiting' (nothing competitive has started) — phase is
    // the authority on the stage, status merely confirms Main/Boss aren't running.
    if (roomState.room.status !== 'waiting' || roomState.room.phase !== 'recall') {
      throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงทบทวนเรื่องราว')
    }
    // Idempotent: a duplicate submit for a concept already answered is a safe no-op — the FIRST
    // answer is what's persisted, matching the spec's "first answer is persisted" requirement.
    if (player.recallAnswers.some((item) => item.conceptId === answer.conceptId)) return
    // The ROOM's current question is the authority now, not the player's own progress: a student
    // who missed earlier items is still on the same shared question as everyone else, so their
    // recallAnswers.length no longer tracks the index.
    const expectedQuestion = RECALL_QUESTIONS[roomState.room.recallQuestionIndex]
    if (
      roomState.room.recallQuestionIndex !== answer.expectedRecallIndex
      || !expectedQuestion
      || expectedQuestion.id !== answer.conceptId
    ) {
      throw new Error('ผู้ใช้:ลำดับคำถามไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
    }
    // Answers lock when the shared countdown expires, the same way saveAnswer guards Main.
    const recallTiming = recallQuestionTiming(roomState.room)
    if (!roomState.room.recallQuestionStartedAt || getRemainingMilliseconds(recallTiming, Date.now()) <= 0) {
      throw new Error('ผู้ใช้:หมดเวลาตอบข้อนี้แล้ว')
    }
    // Countdown expiry: the client submits RECALL_TIMEOUT_CHOICE_ID instead of a real choice, and
    // the item is persisted as unanswered -> incorrect in the review result. Handled before
    // evaluateChoice because the sentinel is deliberately not a valid choice id.
    const isTimeout = answer.selectedChoiceId === RECALL_TIMEOUT_CHOICE_ID
    const evaluated = isTimeout ? { valid: true, isCorrect: false } : evaluateChoice(expectedQuestion, answer.selectedChoiceId)
    if (!evaluated.valid) throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
    const record: RecallAnswerRecord = {
      conceptId: answer.conceptId,
      selectedChoiceId: answer.selectedChoiceId,
      isCorrect: evaluated.isCorrect,
      answeredAt: Date.now(),
    }
    player.recallAnswers = [...player.recallAnswers, record]
    await writeState(state)
  }

  // Assessment Layer (Milestone 1). All three follow saveRecallAnswer's shape: locate the player,
  // require the room to be in this write's own phase, reject an out-of-order submit via the
  // expected-index token, then append one record to that write's own array. Nothing here reads or
  // writes player.score, player.answers, team, magic or boss state.
  async savePreTestAnswer(roomCode: string, playerId: string, answer: PreTestAnswerInput): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const player = roomState?.players[playerId]
    if (!roomState || !player) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    if (roomState.room.phase !== 'preTest') throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงแบบทดสอบก่อนเรียน')
    if (roomState.room.preTestStartedAt == null) throw new Error('ผู้ใช้:ครูยังไม่ได้เริ่มแบบทดสอบก่อนเรียน')
    // The CURRENT question's window — keyed on this student's own progress, not on the room.
    if (isAssessmentExpired(preTestWindow(roomState.room, preTestProgressOf(player)))) {
      throw new Error('ผู้ใช้:หมดเวลาข้อนี้แล้ว')
    }
    // Progress — NOT answers.length — is the current question index, so a timed-out item can
    // never hold the student on the same question.
    const index = player.preTestProgress
    const expectedQuestion = PRE_TEST_QUESTIONS[index]
    if (index >= ASSESSMENT_QUESTION_COUNT || !expectedQuestion) {
      throw new Error('ผู้ใช้:ทำแบบทดสอบครบทุกข้อแล้ว')
    }
    // Idempotent: the first answer for a question is the one that counts.
    if (player.preTestAnswers.some((item) => item.questionId === answer.questionId)) return
    if (index !== answer.expectedIndex || expectedQuestion.id !== answer.questionId) {
      throw new Error('ผู้ใช้:ลำดับคำถามไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
    }
    const evaluated = evaluateChoice(expectedQuestion, answer.selectedChoiceId)
    if (!evaluated.valid) throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
    const now = Date.now()
    player.preTestAnswers = [...player.preTestAnswers, {
      questionId: answer.questionId,
      selectedChoiceId: answer.selectedChoiceId,
      answeredAt: now,
    }]
    // Advance, and start the next question's full window from this instant.
    player.preTestProgress = index + 1
    player.preTestQuestionStartedAt = now
    await writeState(state)
  }

  // Timeout advance. Creates NO answer record — the item simply stays unanswered, and the gap
  // between progress and answers.length is what marks it as timed out.
  //
  // Idempotent by expected-index token: a duplicate call, a second tab, or a reconnect that
  // re-detects the same expiry all find progress already moved and no-op.
  async advancePreTestQuestion(roomCode: string, playerId: string, expectedIndex: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const player = roomState?.players[playerId]
    if (!roomState || !player) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    if (roomState.room.phase !== 'preTest') return
    if (roomState.room.preTestStartedAt == null) return
    const index = player.preTestProgress
    if (index !== expectedIndex || index >= ASSESSMENT_QUESTION_COUNT) return
    // Only a genuinely expired question may be skipped — this is not a "next" button.
    if (!isAssessmentExpired(preTestWindow(roomState.room, preTestProgressOf(player)))) return
    player.preTestProgress = index + 1
    player.preTestQuestionStartedAt = Date.now()
    await writeState(state)
  }

  async savePostTestAnswer(roomCode: string, playerId: string, answer: PostTestAnswerInput): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const player = roomState?.players[playerId]
    if (!roomState || !player) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    if (roomState.room.phase !== 'postTest') throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงแบบทดสอบหลังเรียน')
    if (roomState.room.postTestStartedAt == null) throw new Error('ผู้ใช้:ครูยังไม่ได้เริ่มแบบทดสอบหลังเรียน')
    // The CURRENT question's window — keyed on this student's own progress, not on the room.
    if (isAssessmentExpired(postTestWindow(roomState.room, postTestProgressOf(player)))) {
      throw new Error('ผู้ใช้:หมดเวลาข้อนี้แล้ว')
    }
    // Progress — NOT answers.length — is the current question index, so a timed-out item can
    // never hold the student on the same question.
    const index = player.postTestProgress
    const expectedQuestion = POST_TEST_QUESTIONS[index]
    if (index >= ASSESSMENT_QUESTION_COUNT || !expectedQuestion) {
      throw new Error('ผู้ใช้:ทำแบบทดสอบครบทุกข้อแล้ว')
    }
    // Idempotent: the first answer for a question is the one that counts.
    if (player.postTestAnswers.some((item) => item.questionId === answer.questionId)) return
    if (index !== answer.expectedIndex || expectedQuestion.id !== answer.questionId) {
      throw new Error('ผู้ใช้:ลำดับคำถามไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
    }
    const evaluated = evaluateChoice(expectedQuestion, answer.selectedChoiceId)
    if (!evaluated.valid) throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
    const now = Date.now()
    player.postTestAnswers = [...player.postTestAnswers, {
      questionId: answer.questionId,
      selectedChoiceId: answer.selectedChoiceId,
      answeredAt: now,
    }]
    // Advance, and start the next question's full window from this instant.
    player.postTestProgress = index + 1
    player.postTestQuestionStartedAt = now
    await writeState(state)
  }

  // Timeout advance. Creates NO answer record — the item simply stays unanswered, and the gap
  // between progress and answers.length is what marks it as timed out.
  //
  // Idempotent by expected-index token: a duplicate call, a second tab, or a reconnect that
  // re-detects the same expiry all find progress already moved and no-op.
  async advancePostTestQuestion(roomCode: string, playerId: string, expectedIndex: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const player = roomState?.players[playerId]
    if (!roomState || !player) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    if (roomState.room.phase !== 'postTest') return
    if (roomState.room.postTestStartedAt == null) return
    const index = player.postTestProgress
    if (index !== expectedIndex || index >= ASSESSMENT_QUESTION_COUNT) return
    // Only a genuinely expired question may be skipped — this is not a "next" button.
    if (!isAssessmentExpired(postTestWindow(roomState.room, postTestProgressOf(player)))) return
    player.postTestProgress = index + 1
    player.postTestQuestionStartedAt = Date.now()
    await writeState(state)
  }

  async saveSurveyResponse(roomCode: string, playerId: string, response: SurveyResponseInput): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const player = roomState?.players[playerId]
    if (!roomState || !player) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    if (roomState.room.phase !== 'survey') throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงแบบประเมินกิจกรรม')
    const expectedItem = SURVEY_ITEMS[player.surveyResponses.length]
    if (player.surveyResponses.length >= SURVEY_ITEM_COUNT || !expectedItem) {
      throw new Error('ผู้ใช้:ทำแบบประเมินครบทุกข้อแล้ว')
    }
    // Idempotent: the first response for an item is the one that counts.
    if (player.surveyResponses.some((item) => item.itemId === response.itemId)) return
    // Sequential: the submitted item must be the next unanswered one, and the caller's expected
    // index must agree with the server's own count.
    if (player.surveyResponses.length !== response.expectedIndex || expectedItem.id !== response.itemId) {
      throw new Error('ผู้ใช้:ลำดับคำถามไม่ถูกต้อง กรุณาโหลดหน้าใหม่')
    }
    // Only the 5 scale points are storable — never an arbitrary value.
    if (!isValidSurveyValue(response.value)) throw new Error('ผู้ใช้:กรุณาเลือกคำตอบจากตัวเลือกที่กำหนด')
    player.surveyResponses = [...player.surveyResponses, {
      itemId: response.itemId,
      value: response.value,
      answeredAt: Date.now(),
    }]
    await writeState(state)
  }

  // postTest -> survey. Teacher-only and idempotent: only fires from the post-test stage, so a
  // stale/duplicate press is a safe no-op. No timer — the survey is self-paced.
  // postTest stage -> post-test OPEN. Teacher-only and idempotent: once postTestStartedAt is set,
  // a duplicate press is a safe no-op that cannot restart or extend the budget.
  async startPostTest(roomCode: string, teacherSessionId: string, assessmentSecondsPerQuestion?: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing' || roomState.room.phase !== 'postTest') return
    if (roomState.room.postTestStartedAt != null) return
    if (assessmentSecondsPerQuestion != null) {
      roomState.room.assessmentSecondsPerQuestion = clampAssessmentDuration(assessmentSecondsPerQuestion)
    }
    roomState.room.postTestStartedAt = Date.now()
    await writeState(state)
  }

  async startSurvey(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing' || roomState.room.phase !== 'postTest') return
    roomState.room.phase = 'survey'
    await writeState(state)
  }

  // survey -> completed. Teacher-only and idempotent: only fires from the post-test stage, so a
  // stale/duplicate press is a safe no-op. Sets nothing but the round-ending fields — winner,
  // scores, teams and every Main/Boss result are left exactly as they already are.
  async completeRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing' || roomState.room.phase !== 'survey') return
    // Record this round's history HERE, while every player's answers/recall/pre/post/survey
    // arrays are still intact. The round-reset operations snapshot too, but a teacher may close
    // the browser after finishing and never run one — snapshotting at completion is what makes
    // the assessment data durable immediately. Keyed by `${round}-${playerId}`, so the later
    // snapshots see the id already present and skip it rather than overwriting.
    snapshotRoundHistory(roomState)
    roomState.room.status = 'completed'
    roomState.room.completedAt = Date.now()
    await writeState(state)
  }

  async advanceQuestion(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    // Milestone 4: phase !== 'main' guards against a stale/duplicate call landing WHILE the
    // boss phase is in progress — currentQuestionIndex deliberately does not change during
    // boss, so without this the index-match check alone would not catch a second call.
    if (roomState.room.status !== 'playing' || roomState.room.phase !== 'main' || roomState.room.currentQuestionIndex !== expectedQuestionIndex) return
    const now = Date.now()
    resolveQuestionMagic(roomState, expectedQuestionIndex, now)

    // Milestone 4 section 3: persist every team's raw/magic/competition breakdown for the
    // question just left — not just magic-touched teams — so every team member can see it
    // (students can't compute this themselves; see TeamMagicBreakdown's doc comment in
    // types/game.ts for why it has to be stored, not derived client-side).
    const resolvedQuestionId = roomState.room.questionIds[expectedQuestionIndex]
    if (resolvedQuestionId) {
      const allPlayers = Object.values(roomState.players)
      roomState.room.teams.forEach((team) => {
        const magic = roomState.magic[team.id]
        if (!magic) return
        magic.lastResolvedBreakdown = computeTeamQuestionBreakdown(
          allPlayers,
          team,
          resolvedQuestionId,
          expectedQuestionIndex,
          roomState.magicEvents,
          roomState.room.currentRound,
        )
      })
    }

    if (expectedQuestionIndex === BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX && !roomState.room.bossCompleted) {
      // "ศึกด่านชิงมนตรา" — inserted before main question 6, reusing the same synchronized
      // question/timer architecture via bossQuestionIds/bossQuestionIndex/bossQuestionStartedAt.
      // currentQuestionIndex stays at 4 for the duration; advanceBossQuestion is what eventually
      // moves it to 5 once the 3rd boss question resolves.
      roomState.room.phase = 'boss'
      roomState.room.bossQuestionIds = selectBossQuestions(bossQuestions, roomState.room.questionIds)
      roomState.room.bossQuestionIndex = 0
      roomState.room.bossQuestionStartedAt = now
      await writeState(state)
      return
    }

    const nextQuestionIndex = expectedQuestionIndex + 1
    if (nextQuestionIndex >= roomState.room.questionIds.length) {
      // Assessment Layer: finishing Main question 10 no longer ends the round. The room moves to
      // the post-test with status still 'playing' — completion is now an explicit teacher action
      // (completeRound). Every Main result below is written exactly as before: scores, submitted,
      // finishedAt and elapsedMs are untouched, so the eventual result screen is unchanged.
      roomState.room.phase = 'postTest'
      // Reaching the stage is NOT starting the test. postTestStartedAt stays null so students
      // land on a waiting screen and every write is rejected until the teacher explicitly opens
      // it via startPostTest. This is the gate that used to be missing entirely.
      roomState.room.postTestStartedAt = null
      roomState.room.currentQuestionIndex = roomState.room.questionIds.length
      roomState.room.questionStartedAt = null
      roomState.room.questionClosedAt = null
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
      roomState.room.questionClosedAt = null
    }
    await writeState(state)
  }

  // Milestone 4: parallel to saveAnswer, but writes to player.bossAnswers only — never
  // player.answers/score, which is what makes "boss answers do not affect the 100-point
  // knowledge score" true by construction. Uses the SAME getRemainingMilliseconds helper,
  // fed a boss-shaped {questionStartedAt, questionDurationSeconds, questionClosedAt: null}
  // object, so the deadline math is identical to the main flow's (boss has no early-close, so
  // questionClosedAt is always null here).
  async saveBossAnswer(roomCode: string, playerId: string, answer: BossAnswerInput): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const player = roomState?.players[playerId]
    if (!roomState || !player) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    if (roomState.room.status !== 'playing' || roomState.room.phase !== 'boss') {
      throw new Error('ผู้ใช้:ไม่ได้อยู่ในช่วงศึกด่านชิงมนตรา')
    }
    if (roomState.room.bossQuestionIndex !== answer.expectedBossIndex) {
      throw new Error('ผู้ใช้:ลำดับคำถามเปลี่ยนแล้ว กรุณารอข้อถัดไป')
    }
    const bossTiming = bossQuestionTiming(roomState.room)
    if (!roomState.room.bossQuestionStartedAt || getRemainingMilliseconds(bossTiming, Date.now()) <= 0) {
      throw new Error('ผู้ใช้:หมดเวลาตอบคำถามข้อนี้แล้ว')
    }
    if (roomState.room.bossQuestionIds[answer.expectedBossIndex] !== answer.questionId) {
      throw new Error('ผู้ใช้:ลำดับคำถามไม่ตรงกับรอบปัจจุบัน กรุณาโหลดหน้าใหม่')
    }
    // Rapid Boss is first-answer-locked, matching the Firebase service and UI.
    if (player.bossAnswers.some((item) => item.questionId === answer.questionId)) return
    const question = questionsById.get(answer.questionId)
    const evaluated = evaluateChoice(question, answer.selectedChoiceId)
    if (!evaluated.valid) throw new Error('ผู้ใช้:ไม่พบตัวเลือกคำตอบนี้ กรุณาโหลดหน้าใหม่')
    const record: BossAnswerRecord = {
      questionId: answer.questionId,
      selectedChoiceId: answer.selectedChoiceId,
      isCorrect: evaluated.isCorrect,
      answeredAt: Date.now(),
      responseTimeMs: Date.now() - (roomState.room.bossQuestionStartedAt ?? Date.now()),
    }
    const existingIndex = player.bossAnswers.findIndex((item) => item.questionId === answer.questionId)
    if (existingIndex >= 0) player.bossAnswers[existingIndex] = record
    else player.bossAnswers.push(record)
    await writeState(state)
  }

  // Milestone 4: parallel to advanceQuestion, but for the 3-question boss phase. On the 3rd
  // question, resolves ranking + reward exactly once (guarded by room.bossCompleted — a
  // stale/duplicate call after the first successful resolution is a silent no-op, so a refresh
  // or retry can never reroll the tie-break or award a second item), then returns the room to
  // phase 'main' at the question right after where boss was triggered.
  async advanceBossQuestion(roomCode: string, teacherSessionId: string, expectedBossIndex: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (
      roomState.room.status !== 'playing'
      || roomState.room.phase !== 'boss'
      || roomState.room.bossQuestionIndex !== expectedBossIndex
      || roomState.room.bossAwaitingContinue === true
    ) return
    const now = Date.now()
    const nextBossIndex = expectedBossIndex + 1

    if (nextBossIndex >= roomState.room.bossQuestionIds.length) {
      if (!roomState.room.bossCompleted) {
        const ranking = computeBossRanking(Object.values(roomState.players), roomState.room.bossQuestionIds, roomState.room.bossQuestionDurationSeconds)
        if (ranking.winner) {
          const winnerPlayer = roomState.players[ranking.winner.playerId]
          const magic = winnerPlayer?.teamId ? roomState.magic[winnerPlayer.teamId] : undefined
          const rewardItemType = pickRandomMagicItem()
          if (magic) magic.inventory[rewardItemType].available += 1
          // Denormalized onto the room (not just a bare playerId) — see BossWinner's doc
          // comment in types/game.ts for why: a student can't look up an opposing team's
          // player doc by id once teams are locked, so the announcement fields have to live
          // somewhere already broadly readable.
          roomState.room.bossWinner = {
            playerId: ranking.winner.playerId,
            displayName: ranking.winner.displayName,
            studentNumber: ranking.winner.studentNumber,
            teamId: ranking.winner.teamId,
            teamName: roomState.room.teams.find((team) => team.id === ranking.winner?.teamId)?.name ?? null,
            correctCount: ranking.winner.correctCount,
            totalTimeMs: ranking.winner.totalTimeMs,
            rewardItemType,
          }
        }
        roomState.room.bossCompleted = true
      }
      // Pause-and-continue gate: phase stays 'boss' and currentQuestionIndex stays put here —
      // continueAfterBoss (fired only by the teacher's explicit "เล่นต่อ" action) is now the
      // sole place that advances phase/currentQuestionIndex past the boss round.
      roomState.room.bossAwaitingContinue = true
    } else {
      roomState.room.bossQuestionIndex = nextBossIndex
      roomState.room.bossQuestionStartedAt = now
    }
    await writeState(state)
  }

  // Pause-and-continue gate: the only method that ever clears bossAwaitingContinue. Fired
  // solely by the teacher's explicit "เล่นต่อ" action (never a polling effect) — see
  // bossAwaitingContinue's doc comment in types/game.ts. Guarded exactly like advanceQuestion/
  // advanceBossQuestion (status + phase + an "expected token", here expectedRound) so a stale/
  // duplicate call is a silent no-op. On success, writes exactly what advanceBossQuestion used
  // to write unconditionally when resolving the last boss question.
  async continueAfterBoss(roomCode: string, teacherSessionId: string, expectedRound: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (
      roomState.room.status !== 'playing'
      || roomState.room.phase !== 'boss'
      || roomState.room.bossAwaitingContinue !== true
      || roomState.room.currentRound !== expectedRound
    ) return
    roomState.room.phase = 'main'
    roomState.room.currentQuestionIndex = BOSS_TRIGGER_AFTER_MAIN_QUESTION_INDEX + 1
    roomState.room.questionStartedAt = Date.now()
    roomState.room.questionClosedAt = null
    roomState.room.bossAwaitingContinue = false
    await writeState(state)
  }

  // Milestone 2.2: transactional (single-writeState, all-or-nothing like every other demo
  // mutation) early-close — the teacher may cut answering short once everyone currently
  // registered has answered. Setting questionClosedAt is what makes getQuestionDeadline (and
  // therefore every timer derived from it, on both the teacher and student side) treat the
  // question as over immediately: answers lock, reveal begins, and the reveal countdown runs
  // from this timestamp instead of the original deadline. Guarded exactly like advanceQuestion
  // (status + expectedQuestionIndex) so a stale/duplicate click is a silent no-op, and
  // additionally guarded on questionClosedAt already being set so a second click can never
  // "re-close" (and therefore never re-run the all-answered check against changed state).
  async closeQuestionEarly(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing' || roomState.room.currentQuestionIndex !== expectedQuestionIndex) return
    if (roomState.room.questionClosedAt != null) return
    const questionId = roomState.room.questionIds[expectedQuestionIndex]
    const allAnswered = Object.values(roomState.players).every((player) => player.answers.some((answer) => answer.questionId === questionId))
    if (!allAnswered) throw new Error('ผู้ใช้:ยังมีผู้เล่นบางคนยังไม่ได้ตอบคำถามข้อนี้')
    roomState.room.questionClosedAt = Date.now()
    await writeState(state)
  }

  async prepareNextRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status === 'playing') throw new Error('ผู้ใช้:ยุติรอบปัจจุบันให้เรียบร้อยก่อนเตรียมรอบใหม่')
    // Record this round BEFORE any player data is reset below — once answers/recallAnswers are
    // wiped the results are unrecoverable. Idempotent per round.
    snapshotRoundHistory(roomState)
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
      questionClosedAt: null,
      // Milestone 4: a new round starts with a clean boss/magic state — bossCompleted resets
      // so the boss phase can trigger again after main question 5 this round.
      ...createFreshBossFields(),
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
        bossAnswers: [],
        recallAnswers: [],
        preTestAnswers: [],
        postTestAnswers: [],
        preTestProgress: 0,
        postTestProgress: 0,
        preTestQuestionStartedAt: null,
        postTestQuestionStartedAt: null,
        surveyResponses: [],
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
    Object.values(roomState.magic).forEach((magic) => {
      magic.inventory = createEmptyMagicInventory()
      magic.lastResolvedBreakdown = null
      // Milestone 4.1: a new round needs a fresh captain election too — the old captain does
      // not automatically carry over (matches "starting-item choice happens fresh each round").
      magic.magicHolderPlayerId = null
      magic.captainElectionAttempt += 1
    })
    await writeState(state)
  }

  async stopRound(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'playing') throw new Error('ผู้ใช้:ภารกิจไม่ได้กำลังดำเนินอยู่')
    // Record this round BEFORE any player data is reset below — once answers/recallAnswers are
    // wiped the results are unrecoverable. Idempotent per round.
    snapshotRoundHistory(roomState)
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
      questionClosedAt: null,
      // Milestone 4: a new round starts with a clean boss/magic state — bossCompleted resets
      // so the boss phase can trigger again after main question 5 this round.
      ...createFreshBossFields(),
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
        bossAnswers: [],
        recallAnswers: [],
        preTestAnswers: [],
        postTestAnswers: [],
        preTestProgress: 0,
        postTestProgress: 0,
        preTestQuestionStartedAt: null,
        postTestQuestionStartedAt: null,
        surveyResponses: [],
        submitted: false,
        finishedAt: null,
        elapsedMs: null,
        status: 'waiting',
      })
    })
    expireQueuedEffects(roomState, Date.now())
    Object.values(roomState.magic).forEach((magic) => {
      magic.inventory = createEmptyMagicInventory()
      magic.lastResolvedBreakdown = null
      // Milestone 4.1: a new round needs a fresh captain election too — the old captain does
      // not automatically carry over (matches "starting-item choice happens fresh each round").
      magic.magicHolderPlayerId = null
      magic.captainElectionAttempt += 1
    })
    await writeState(state)
  }

  async closeRoom(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    // Closing ends the round too, so record it first — this is what keeps a finished round's
    // history available after the room is closed.
    snapshotRoundHistory(roomState)
    roomState.room.status = 'closed'
    Object.values(roomState.players).forEach((player) => {
      player.status = 'stopped'
    })
    expireQueuedEffects(roomState, Date.now())
    await writeState(state)
  }

  // Teacher-only showcase import. Same document set as the Firebase path (one shared builder),
  // and the same refusal to overwrite a non-showcase room. No player records are created.
  async importShowcaseRound(roomCode: string, teacherSessionId: string, roster: RosterStudent[]): Promise<void> {
    const documents = buildShowcaseDocuments(roomCode, teacherSessionId, roster)
    const state = await readState()
    const existing = state.rooms[roomCode]
    if (existing && existing.room[SHOWCASE_MODE_FIELD as keyof typeof existing.room] !== true) {
      throw new Error(showcaseCollisionMessage(roomCode))
    }
    const room = { ...documents.initialRoom, ...documents.completedRoomUpdate } as unknown as Room
    state.rooms[roomCode] = {
      room,
      // Deliberately empty: the showcase renders entirely from roundHistory.
      players: {},
      magic: {},
      magicEvents: [],
      rosters: Object.fromEntries(documents.rosters.map((entry) => [entry.teamId, entry.roster])),
      answerProgress: {},
      captainVotes: {},
      captainVoteProgress: {},
      teamNames: Object.fromEntries(documents.teamNames.map((entry) => [entry.teamId, entry])),
      roundHistory: Object.fromEntries(documents.historyEntries.map((entry) => [showcaseHistoryDocId(entry), entry])),
    }
    await writeState(state)
  }

  async randomizeTeams(roomCode: string, teacherSessionId: string, teamCount: number): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:จัดทีมได้เฉพาะช่วงห้องรอ')
    // Teams may only be created during the dedicated team-setup stage — this is what makes "no
    // team-management interruption during Pre-test/Recall" a structural guarantee, not a UI
    // convention.
    if (roomState.room.phase !== 'teamSetup') throw new Error('ผู้ใช้:จัดทีมได้เฉพาะช่วงจัดทีมเท่านั้น')
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
    if (roomState.room.phase !== 'teamSetup') throw new Error('ผู้ใช้:จัดทีมได้เฉพาะช่วงจัดทีมเท่านั้น')
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

    // Success: give every team a fresh magic doc with NO captain yet — Milestone 4.1 replaces
    // the old random holder pick with a team vote (see castCaptainVote/finalizeCaptainElection
    // below). captainElectionAttempt is bumped, never reused, so any vote docs cast under a
    // PRIOR attempt for this team id — including ones from before an unlock+re-randomize — are
    // simply never counted again without needing to delete them (see CaptainVote's doc comment
    // in types/game.ts for why deletion isn't how this codebase scopes stale data).
    const previousAttempts = new Map(Object.values(latestRoomState.magic).map((magic) => [magic.teamId, magic.captainElectionAttempt]))
    latestRoomState.magic = {}
    latestRoomState.room.teams.forEach((team) => {
      latestRoomState.magic[team.id] = {
        teamId: team.id,
        magicHolderPlayerId: null,
        captainElectionAttempt: (previousAttempts.get(team.id) ?? 0) + 1,
        inventory: createEmptyMagicInventory(),
        queuedEffect: null,
        lastResolvedBreakdown: null,
      }
      // Team guardian names reset every time teams are (re-)locked — same cadence as captain
      // election/inventory above.
      delete latestRoomState.teamNames[team.id]
    })
    await writeState(latestState)
  }

  async unlockTeams(roomCode: string, teacherSessionId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:ปลดล็อกทีมได้เฉพาะช่วงห้องรอ')
    if (roomState.room.phase !== 'teamSetup') throw new Error('ผู้ใช้:ปลดล็อกทีมได้เฉพาะช่วงจัดทีมเท่านั้น')
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
    // getRemainingMilliseconds (not manual deadline math) so a teacher's early close
    // (questionClosedAt) is honored here too — otherwise a late/slow client could still submit
    // an answer up until the ORIGINAL deadline even after the teacher closed the question early.
    if (!roomState.room.questionStartedAt || getRemainingMilliseconds(mainQuestionTiming(roomState.room), Date.now()) <= 0) {
      throw new Error('ผู้ใช้:หมดเวลาตอบคำถามข้อนี้แล้ว')
    }
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
        currentRound: roomState.room.currentRound,
        answeredAt: record.answeredAt,
      }
    }
    await writeState(state)
    return { player, winner: null }
  }

  // Milestone: the captain may change this pick any number of times while the room is still
  // 'waiting' (a fresh pick or a change are the exact same operation — both just replace
  // whatever the inventory currently holds). Once room.status leaves 'waiting' this method is
  // unreachable (guarded below), which is what makes the choice permanent the moment the
  // mission actually starts. Pre-start, inventory can only ever hold the single starting pick
  // (boss rewards — the only other inventory mutation — are 'playing'-only), so replacing is
  // always just "zero every other type, set the requested type to exactly 1" — it can never
  // leave two types both holding an item.
  async chooseStartingItem(roomCode: string, teamId: string, playerId: string, itemType: MagicItemType): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    const magic = roomState.magic[teamId]
    if (!magic) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
    if (magic.magicHolderPlayerId !== playerId) throw new Error('ผู้ใช้:คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')
    if (roomState.room.status !== 'waiting' || !roomState.room.teamsLocked || roomState.room.phase !== 'teamSetup') {
      throw new Error('ผู้ใช้:เลือกไอเทมเริ่มต้นได้เฉพาะช่วงจัดทีมหลังล็อกทีมแล้ว')
    }
    MAGIC_ITEM_TYPES.forEach((type) => {
      if (type !== itemType) magic.inventory[type].available = 0
    })
    magic.inventory[itemType].available = 1
    await writeState(state)
  }

  async activateItem(
    roomCode: string,
    teamId: string,
    playerId: string,
    itemType: 'power_surge' | 'score_seal' | 'illusion',
    targetTeamId?: string,
  ): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    const magic = roomState.magic[teamId]
    if (!magic) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
    if (magic.magicHolderPlayerId !== playerId) throw new Error('ผู้ใช้:คุณไม่ใช่ผู้ถือคทาเวทมนตร์ของทีมนี้')
    // Milestone 4: magic is a main-phase-only concept — the boss mini-game has its own,
    // separate 3-question flow, and status stays 'playing' throughout both, so this check is
    // what actually prevents activation from leaking into the boss phase. This also covers
    // Milestone 4.1's "illusion cannot affect boss questions" — activation is unavailable in
    // the boss phase for every item, not just illusion.
    if (roomState.room.phase !== 'main') throw new Error('ผู้ใช้:ไม่สามารถใช้ไอเทมได้ในขณะนี้ กรุณารอช่วงพักหรือรอบถัดไป')

    const window = getMagicActivationWindow(roomState.room)
    if (!window.valid || window.affectedQuestionIndex == null) {
      throw new Error('ผู้ใช้:ไม่สามารถใช้ไอเทมได้ในขณะนี้ กรุณารอช่วงพักหรือรอบถัดไป')
    }
    const affectedQuestionIndex = window.affectedQuestionIndex

    if (magic.inventory[itemType].available <= 0) throw new Error('ผู้ใช้:ไม่มีไอเทมนี้ในคลังของทีม')

    // Milestone 4.1: illusion is a self-only buff, exactly like power_surge — it never has an
    // opposing-team target.
    const resolvedTargetTeamId = itemType === 'score_seal' ? targetTeamId : teamId
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
        round: roomState.room.currentRound,
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
      // Milestone 4: multiple teams may seal the same target — seals stack multiplicatively
      // (see computeHostileMultiplier in lib/magic.ts), so there is no longer an
      // "already targeted" rejection here.
    }

    // Illusion is a fairness-sensitive item: it changes what the question LOOKS like, so it may
    // only be cast while the whole team is still undecided. Once any member has locked an answer
    // for this question, casting it would either waste the effect or retroactively change the
    // board under a teammate who already committed.
    //
    // Rejected BEFORE anything is written, so the item is not consumed and the team keeps it.
    const illusionQuestionId = roomState.room.questionIds[affectedQuestionIndex]
    if (itemType === 'illusion') {
      const someoneAnswered = Object.values(roomState.players)
        .some((member) => member.teamId === teamId
          && member.answers.some((entry) => entry.questionId === illusionQuestionId))
      if (someoneAnswered) {
        throw new Error('ผู้ใช้:มีเพื่อนร่วมทีมตอบข้อนี้ไปแล้ว จึงใช้มนตร์ลวงตากับข้อนี้ไม่ได้')
      }
    }

    // The hidden choices are chosen exactly ONCE, right here, and stored on the queued effect —
    // never recomputed later (resolution only marks the event 'applied' and consumes the item, it
    // never touches hiddenChoiceIds again). That is what makes every team member see the identical
    // two removed choices and makes a refresh/retry unable to reroll them.
    let hiddenChoiceIds: string[] | undefined
    if (itemType === 'illusion') {
      const targetQuestion = illusionQuestionId ? questionsById.get(illusionQuestionId) : undefined
      if (!targetQuestion) {
        rejectEvent()
        await writeState(state)
        throw new Error('ผู้ใช้:ไม่พบคำถามข้อที่จะมีผล กรุณาลองใหม่')
      }
      hiddenChoiceIds = pickIllusionHiddenChoices(targetQuestion)
    }

    const effectId = `magic-${createId()}`
    magic.queuedEffect = {
      id: effectId,
      itemType,
      sourceTeamId: teamId,
      targetTeamId: resolvedTargetTeamId as string,
      affectedQuestionIndex,
      createdAt: now,
      ...(hiddenChoiceIds ? { hiddenChoiceIds } : {}),
    }
    roomState.magicEvents.push({
      id: effectId,
      itemType,
      actorPlayerId: playerId,
      sourceTeamId: teamId,
      targetTeamId: resolvedTargetTeamId ?? null,
      affectedQuestionIndex,
      status: 'queued',
      round: roomState.room.currentRound,
      createdAt: now,
      resolvedAt: null,
    })
    await writeState(state)
  }

  // Milestone 4.1: student-authored — writes ONLY the voter's own vote (+ its broadly-readable
  // progress counterpart), never the finalization result. "Auto-finalize once everyone has
  // voted" is deliberately driven by the TEACHER's client polling vote progress (see
  // TeacherPage.tsx), mirroring how main-question/boss auto-advance are already
  // teacher-client-driven rather than student-triggered — see gameService.ts's doc comment on
  // why a student-triggered finalize could never be safely validated by security rules.
  async castCaptainVote(roomCode: string, playerId: string, targetPlayerId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    const voter = roomState?.players[playerId]
    if (!roomState || !voter) throw new Error('ผู้ใช้:ไม่พบข้อมูลผู้เล่นของคุณ')
    if (roomState.room.status !== 'waiting' || !roomState.room.teamsLocked || roomState.room.phase !== 'teamSetup') {
      throw new Error('ผู้ใช้:โหวตหัวหน้าทีมได้เฉพาะช่วงจัดทีมหลังล็อกทีมแล้ว')
    }
    if (!voter.teamId) throw new Error('ผู้ใช้:คุณยังไม่ได้อยู่ในทีมใด')
    const target = roomState.players[targetPlayerId]
    // Self-voting is allowed — targetPlayerId === playerId simply passes this same check.
    if (!target || target.teamId !== voter.teamId) throw new Error('ผู้ใช้:โหวตได้เฉพาะสมาชิกในทีมของคุณเอง')
    const magic = roomState.magic[voter.teamId]
    if (!magic) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
    if (magic.magicHolderPlayerId != null) throw new Error('ผู้ใช้:ทีมนี้เลือกหัวหน้าทีมเรียบร้อยแล้ว')
    const votedAt = Date.now()
    // Overwrite (never append) — this is what makes "students may change their vote until
    // finalized" true: casting a second vote just replaces this same playerId-keyed doc.
    roomState.captainVotes[playerId] = { playerId, teamId: voter.teamId, targetPlayerId, electionAttempt: magic.captainElectionAttempt, votedAt }
    roomState.captainVoteProgress[playerId] = { playerId, teamId: voter.teamId, electionAttempt: magic.captainElectionAttempt, votedAt }
    await writeState(state)
  }

  // Milestone 4.1: teacher-authored, idempotent (a stale/duplicate call after the captain is
  // already set is a silent no-op — refresh/retry can never reroll the tie-break). Also the
  // manual "finalize early" path for teams with missing voters, and the implicit target of the
  // teacher's auto-finalize-on-all-voted effect (see TeacherPage.tsx).
  async finalizeCaptainElection(roomCode: string, teacherSessionId: string, teamId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    const magic = roomState.magic[teamId]
    if (!magic || magic.magicHolderPlayerId != null) return
    const roster = roomState.rosters[teamId]
    const memberIds = roster ? roster.members.map((member) => member.playerId) : []
    const votesByVoter: Record<string, string> = {}
    Object.values(roomState.captainVotes).forEach((vote) => {
      if (vote.teamId !== teamId || vote.electionAttempt !== magic.captainElectionAttempt) return
      votesByVoter[vote.playerId] = vote.targetPlayerId
    })
    // pickElectedCaptain falls back to a uniform random draw across the WHOLE roster when no
    // votes were cast at all (every tally is 0, so everyone is "tied for highest") — a team can
    // never get permanently stuck with no captain, even if the teacher force-finalizes before
    // anyone voted.
    const captainId = pickElectedCaptain(memberIds, votesByVoter)
    if (!captainId) return
    magic.magicHolderPlayerId = captainId
    await writeState(state)
  }

  // Milestone 4.1: teacher-authored, only while the room hasn't started playing yet ("reopen the
  // election before the game starts"). Bumps captainElectionAttempt rather than deleting vote
  // docs — see CaptainVote's doc comment in types/game.ts.
  async resetCaptainElection(roomCode: string, teacherSessionId: string, teamId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    if (roomState.room.status !== 'waiting') throw new Error('ผู้ใช้:รีเซ็ตการเลือกตั้งหัวหน้าทีมได้เฉพาะก่อนเริ่มภารกิจ')
    // Restricted to the team-setup stage: once the class has moved on to Pre-test/Recall, a
    // captain reset must never silently re-open (magicHolderPlayerId is part of what "persists
    // unchanged through Pre -> Recall -> Main" promises).
    if (roomState.room.phase !== 'teamSetup') throw new Error('ผู้ใช้:รีเซ็ตการเลือกตั้งหัวหน้าทีมได้เฉพาะช่วงจัดทีมเท่านั้น')
    const magic = roomState.magic[teamId]
    if (!magic) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
    magic.magicHolderPlayerId = null
    magic.captainElectionAttempt += 1
    await writeState(state)
  }

  subscribeCaptainVote(roomCode: string, playerId: string, listener: (vote: CaptainVote | null) => void): Unsubscribe {
    const emit = async (): Promise<void> => listener((await readState()).rooms[roomCode.toUpperCase()]?.captainVotes[playerId] ?? null)
    void emit()
    return listen(() => { void emit() })
  }

  subscribeTeamCaptainVoteProgress(roomCode: string, teamId: string, listener: (entries: CaptainVoteProgress[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const entries = Object.values((await readState()).rooms[roomCode.toUpperCase()]?.captainVoteProgress ?? {}).filter((entry) => entry.teamId === teamId)
      listener(entries)
    }
    void emit()
    return listen(() => { void emit() })
  }

  subscribeAllCaptainVoteProgress(roomCode: string, listener: (entries: CaptainVoteProgress[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const entries = Object.values((await readState()).rooms[roomCode.toUpperCase()]?.captainVoteProgress ?? {})
      listener(entries)
    }
    void emit()
    return listen(() => { void emit() })
  }

  // Team guardian name: mirrors subscribeAllTeamMagic's "all X for a room" shape, pointed at
  // the new teamNames record.
  subscribeAllTeamGuardianNames(roomCode: string, listener: (names: TeamGuardianName[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const names = Object.values((await readState()).rooms[roomCode.toUpperCase()]?.teamNames ?? {})
      listener(names)
    }
    void emit()
    return listen(() => { void emit() })
  }

  // Ownership filter mirrors the Firebase query exactly: only rooms this teacher created, and
  // only fields that live on the room document itself — no roundHistory is touched here.
  async listTeacherRooms(teacherSessionId: string): Promise<TeacherRoomSummary[]> {
    const state = await readState()
    return Object.values(state.rooms)
      .filter((roomState) => roomState.room.teacherSessionId === teacherSessionId)
      .map((roomState) => ({
        roomCode: roomState.room.roomCode,
        createdAt: roomState.room.createdAt,
        status: roomState.room.status,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  subscribeRoundHistory(roomCode: string, listener: (entries: RoundHistoryEntry[]) => void): Unsubscribe {
    const emit = async (): Promise<void> => {
      const entries = Object.values((await readState()).rooms[roomCode.toUpperCase()]?.roundHistory ?? {})
      listener([...entries].sort((a, b) => a.round - b.round || a.studentNumber.localeCompare(b.studentNumber)))
    }
    void emit()
    return listen(() => { void emit() })
  }

  // Captain-authored path. Only the team's finalized captain (magicHolderPlayerId) may set the
  // name, and only in the waiting-room window after teams are locked — see lockTeams, which
  // resets teamNames every time it (re-)runs.
  async setTeamGuardianName(roomCode: string, teamId: string, playerId: string, name: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    if (roomState.room.status !== 'waiting' || !roomState.room.teamsLocked || roomState.room.phase !== 'teamSetup') {
      throw new Error('ผู้ใช้:ตั้งชื่อทีมได้เฉพาะช่วงจัดทีมหลังล็อกทีมแล้ว')
    }
    const magic = roomState.magic[teamId]
    if (!magic) throw new Error('ผู้ใช้:ไม่พบข้อมูลทีมนี้')
    if (magic.magicHolderPlayerId !== playerId) throw new Error('ผู้ใช้:เฉพาะหัวหน้าทีมที่ได้รับเลือกเท่านั้นที่ตั้งชื่อทีมได้')

    const otherNames = Object.values(roomState.teamNames)
      .filter((entry) => entry.teamId !== teamId)
      .map((entry) => entry.name)
    const validationError = validateTeamGuardianName(name, otherNames)
    if (validationError) throw new Error(validationError)

    roomState.teamNames[teamId] = {
      teamId,
      name: normalizeTeamGuardianName(name),
      updatedAt: Date.now(),
      updatedByPlayerId: playerId,
    }
    await writeState(state)
  }

  // Teacher-only. Deletes the entry entirely — absence means "unnamed", matching
  // setTeamGuardianName never having been called yet.
  async resetTeamGuardianName(roomCode: string, teacherSessionId: string, teamId: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)
    delete roomState.teamNames[teamId]
    await writeState(state)
  }

  // Teacher-only. Same validation/write shape as setTeamGuardianName, but skips the
  // captain-ownership check entirely — the teacher is always authorized to set any team's name.
  async overrideTeamGuardianName(roomCode: string, teacherSessionId: string, teamId: string, name: string): Promise<void> {
    const state = await readState()
    const roomState = state.rooms[roomCode]
    if (!roomState) throw new Error('ผู้ใช้:ไม่พบรหัสห้องนี้')
    verifyTeacher(roomState.room, teacherSessionId)

    const otherNames = Object.values(roomState.teamNames)
      .filter((entry) => entry.teamId !== teamId)
      .map((entry) => entry.name)
    const validationError = validateTeamGuardianName(name, otherNames)
    if (validationError) throw new Error(validationError)

    roomState.teamNames[teamId] = {
      teamId,
      name: normalizeTeamGuardianName(name),
      updatedAt: Date.now(),
      updatedByPlayerId: teacherSessionId,
    }
    await writeState(state)
  }
}
