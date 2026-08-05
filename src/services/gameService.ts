import type { JoinInput, JoinResult, Room, Team, Unsubscribe, Winner } from '../types/game'

export interface AnswerInput {
  questionId: string
  selectedChoiceId: string
  expectedQuestionIndex: number
}

export interface AnswerResult {
  team: Team
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
  subscribeTeams(roomCode: string, listener: (teams: Team[]) => void, onError: (message: string) => void): Unsubscribe
  subscribeTeam(roomCode: string, teamId: string, listener: (team: Team | null) => void, onError: (message: string) => void): Unsubscribe
  startRoom(roomCode: string, teacherSessionId: string, questionDurationSeconds: number): Promise<void>
  advanceQuestion(roomCode: string, teacherSessionId: string, expectedQuestionIndex: number): Promise<void>
  stopRound(roomCode: string, teacherSessionId: string): Promise<void>
  prepareNextRound(roomCode: string, teacherSessionId: string): Promise<void>
  closeRoom(roomCode: string, teacherSessionId: string): Promise<void>
  saveAnswer(roomCode: string, teamId: string, answer: AnswerInput): Promise<AnswerResult>
}

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
