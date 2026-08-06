import type { AnswerProgressEntry, JoinInput, JoinResult, MagicEvent, MagicItemType, Player, Room, TeamMagicState, TeamRosterSummary, Unsubscribe, Winner } from '../types/game'

export interface AnswerInput {
  questionId: string
  selectedChoiceId: string
  expectedQuestionIndex: number
}

export interface AnswerResult {
  player: Player
  winner: Winner | null
}

export interface GameService {
  readonly isDemo: boolean
  readonly demoRoomCode?: string
  resetDemoRoom?(): Promise<Room>
  ensureSession(): Promise<string>
  createRoom(teacherSessionId: string): Promise<Room>
  joinRoom(input: JoinInput, ownerUid: string): Promise<JoinResult>
  subscribeRoom(roomCode: string, listener: (room: Room | null) => void, onError: (message: string) => void): Unsubscribe
  subscribePlayers(roomCode: string, listener: (players: Player[]) => void, onError: (message: string) => void): Unsubscribe
  subscribePlayer(roomCode: string, playerId: string, listener: (player: Player | null) => void, onError: (message: string) => void): Unsubscribe
  startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number): Promise<void>
  advanceQuestion(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void>
  stopRound(roomCode: string, teacherSessionId: string): Promise<void>
  prepareNextRound(roomCode: string, teacherSessionId: string): Promise<void>
  closeRoom(roomCode: string, teacherSessionId: string): Promise<void>
  saveAnswer(roomCode: string, playerId: string, answer: AnswerInput): Promise<AnswerResult>
  randomizeTeams(roomCode: string, teacherSessionId: string, teamCount: number): Promise<void>
  lockTeams(roomCode: string, teacherSessionId: string): Promise<void>
  unlockTeams(roomCode: string, teacherSessionId: string): Promise<void>
  subscribeTeamMagic(roomCode: string, teamId: string, listener: (magic: TeamMagicState | null) => void, onError: (message: string) => void): Unsubscribe
  subscribeAllTeamMagic(roomCode: string, listener: (magic: TeamMagicState[]) => void, onError: (message: string) => void): Unsubscribe
  subscribeMagicEvents(roomCode: string, listener: (events: MagicEvent[]) => void, onError: (message: string) => void): Unsubscribe
  chooseStartingItem(roomCode: string, teamId: string, playerId: string, itemType: MagicItemType): Promise<void>
  activateItem(roomCode: string, teamId: string, playerId: string, itemType: 'power_surge' | 'score_seal', targetTeamId?: string): Promise<void>
  subscribeTeamRoster(roomCode: string, teamId: string, listener: (roster: TeamRosterSummary | null) => void, onError: (message: string) => void): Unsubscribe
  subscribeTeamAnswerProgress(roomCode: string, teamId: string, listener: (entries: AnswerProgressEntry[]) => void, onError: (message: string) => void): Unsubscribe
}

// Used by FirebaseGameService.joinRoom's catch block when the transaction's read of the
// deterministic player doc is denied by security rules (a genuinely new player can't be
// distinguished from a duplicate at the rules layer, since the doc doesn't exist yet). Given
// the room state re-read *outside* the transaction, decide whether that denial was actually
// caused by a locked room (the one case the rules intentionally deny for a brand-new player)
// — returning null means "not that specific cause," so the caller must rethrow the original
// Firebase error rather than ever inventing a false duplicate-student-number claim.
export const resolveJoinPermissionDeniedMessage = (room: Pick<Room, 'teamsLocked'> | null): string | null =>
  room?.teamsLocked ? 'ผู้ใช้:ทีมถูกล็อกแล้ว กรุณาติดต่อครู' : null

export const friendlyError = (error: unknown): string => {
  if (error instanceof Error && error.message.startsWith('ผู้ใช้:')) return error.message.replace('ผู้ใช้:', '')
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'auth/too-many-requests') return 'มีผู้เข้าใช้งานพร้อมกันจำนวนมาก กรุณารอสักครู่แล้วลองใหม่'
  if (code === 'auth/network-request-failed' || code === 'unavailable' || code === 'deadline-exceeded') {
    return 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ กรุณาตรวจสอบสัญญาณแล้วลองใหม่'
  }
  if (code === 'permission-denied' || code === 'unauthenticated') {
    return 'เซสชันหมดอายุหรือไม่มีสิทธิ์ดำเนินการ กรุณารีเฟรชหน้าแล้วลองใหม่'
  }
  return 'การเชื่อมต่อขัดข้อง กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง'
}
