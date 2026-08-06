export type QuestionCategory = 'basic' | 'characters' | 'plot' | 'poetry' | 'theme'
export type Difficulty = 'easy' | 'medium' | 'hard'

export interface QuestionChoice {
  id: string
  text: string
}

export interface Question {
  id: string
  category: QuestionCategory
  question: string
  choices: QuestionChoice[]
  correctChoiceId: string
  explanation: string
  difficulty: Difficulty
}

export type RoomStatus = 'waiting' | 'playing' | 'completed' | 'closed'
export type PlayerStatus = 'waiting' | 'playing' | 'submitted' | 'stopped'

export interface AnswerRecord {
  questionId: string
  selectedChoiceId: string
  isCorrect: boolean
  answeredAt: number
  // Derived from the client clock at answer time. Informational only in Milestone 1 —
  // never read by scoring/ranking. A future fastest-answer round needs server-side timing.
  responseTimeMs: number
}

export interface Winner {
  teamId: string
  teamName: string
  guardianName: string
  score: number
  finishedAt: number
  elapsedMs: number
  round: number
}

export interface TeamMeta {
  id: string
  name: string
}

export interface Room {
  roomCode: string
  status: RoomStatus
  currentRound: number
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  currentQuestionIndex: number
  questionDurationSeconds: number
  questionStartedAt: number | null
  questionIds: string[]
  previousQuestionIds: string[]
  winner: Winner | null
  teacherSessionId: string
  teamCount: number
  teamsLocked: boolean
  teams: TeamMeta[]
}

export interface Player {
  id: string
  displayName: string
  studentNumber: string
  teamId: string | null
  joinedAt: number
  currentRound: number
  currentQuestionIndex: number
  score: number
  answers: AnswerRecord[]
  submitted: boolean
  finishedAt: number | null
  elapsedMs: number | null
  status: PlayerStatus
  ownerUid: string
}

export interface PlayerSession {
  roomCode: string
  playerId: string
  displayName: string
  studentNumber: string
  role: 'student'
}

export interface TeacherSession {
  teacherSessionId: string
  roomCode?: string
  role: 'teacher'
}

export interface JoinInput {
  roomCode: string
  displayName: string
  studentNumber: string
}

export interface JoinResult {
  room: Room
  player: Player
}

export type Unsubscribe = () => void

// Milestone 2: team magic items. These affect only the competition score shown on the
// teacher leaderboard — never player.score, answer.isCorrect, or any individual record.
export type MagicItemType = 'power_surge' | 'score_seal' | 'rose_shield'
// power_surge  = มนตร์ทวีพลัง (own team, next eligible question: x1.5)
// score_seal   = มนตร์ผนึกคะแนน (chosen opponent, next eligible question: x0.5)
// rose_shield  = เกราะกุหลาบ (passive: blocks + consumes one incoming score_seal)

export type MagicEventStatus = 'queued' | 'applied' | 'blocked' | 'expired' | 'rejected'

export interface MagicInventoryItem {
  itemType: MagicItemType
  acquiredAt: number
  consumed: boolean
  consumedAt: number | null
}

export interface QueuedMagicEffect {
  id: string
  itemType: 'power_surge' | 'score_seal'
  sourceTeamId: string
  targetTeamId: string
  affectedQuestionIndex: number
  createdAt: number
}

export interface TeamMagicState {
  teamId: string
  magicHolderPlayerId: string | null
  inventory: MagicInventoryItem[]
  queuedEffect: QueuedMagicEffect | null
}

export interface MagicEvent {
  id: string
  itemType: MagicItemType
  actorPlayerId: string
  sourceTeamId: string
  targetTeamId: string | null
  affectedQuestionIndex: number | null
  status: MagicEventStatus
  createdAt: number
  resolvedAt: number | null
}

// Safe, display-only aggregates for the student lobby/game — built atomically by
// randomizeTeams/saveAnswer, never carrying ownerUid, answers, score, selected choices,
// correctness, or any other private player field. Students cannot `list` the private
// `players` collection, so these are what the live team roster and "teammates answered"
// counter are built from instead.
export interface TeamRosterMember {
  playerId: string
  displayName: string
}

export interface TeamRosterSummary {
  teamId: string
  teamName: string
  members: TeamRosterMember[]
}

export interface AnswerProgressEntry {
  playerId: string
  teamId: string
  questionId: string
  answeredAt: number
}
