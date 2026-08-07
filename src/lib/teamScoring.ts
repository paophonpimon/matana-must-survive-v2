import { shuffle } from './game'
import type { Player, TeamMeta } from '../types/game'

export const buildTeamMetas = (teamCount: number): TeamMeta[] =>
  Array.from({ length: teamCount }, (_, index) => ({ id: `team-${index + 1}`, name: `ทีม ${index + 1}` }))

// Team guardian name validation — shared by firebaseService.ts and demoService.ts so the rule
// can never drift between the two implementations. Trims and collapses internal whitespace
// before every check (including the empty-after-trim case), so " " alone is rejected as empty,
// not as a valid 1-space name.
export const TEAM_GUARDIAN_NAME_MIN_LENGTH = 2
export const TEAM_GUARDIAN_NAME_MAX_LENGTH = 20
// Thai script block (U+0E00-U+0E7F), Latin letters, digits, spaces, and a small set of common
// punctuation — this is a public display label shown on every screen, not free text.
const TEAM_GUARDIAN_NAME_PATTERN = /^[฀-๿A-Za-z0-9 .,'!?()_-]+$/

export const normalizeTeamGuardianName = (raw: string): string => raw.trim().replace(/\s+/g, ' ')

// existingNamesExcludingSelf: every OTHER team's current (normalized) name in the room, so a
// captain re-submitting their own unchanged name is never flagged as a duplicate of itself.
export const validateTeamGuardianName = (raw: string, existingNamesExcludingSelf: string[]): string | null => {
  const name = normalizeTeamGuardianName(raw)
  if (name.length === 0) return 'ผู้ใช้:กรุณากรอกชื่อทีม'
  if (name.length < TEAM_GUARDIAN_NAME_MIN_LENGTH || name.length > TEAM_GUARDIAN_NAME_MAX_LENGTH) {
    return `ผู้ใช้:ชื่อทีมต้องมีความยาว ${TEAM_GUARDIAN_NAME_MIN_LENGTH}-${TEAM_GUARDIAN_NAME_MAX_LENGTH} ตัวอักษร`
  }
  if (!TEAM_GUARDIAN_NAME_PATTERN.test(name)) {
    return 'ผู้ใช้:ชื่อทีมมีอักขระที่ไม่รองรับ กรุณาใช้ตัวอักษรไทย/อังกฤษ ตัวเลข และเครื่องหมายทั่วไปเท่านั้น'
  }
  if (existingNamesExcludingSelf.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
    return 'ผู้ใช้:ชื่อทีมนี้ถูกใช้แล้ว กรุณาเลือกชื่ออื่น'
  }
  return null
}

export const distributeTeamsEvenly = (
  playerIds: string[],
  teamCount: number,
  random: () => number = Math.random,
): Record<string, string> => {
  const assignment: Record<string, string> = {}
  if (teamCount <= 0) return assignment
  const shuffled = shuffle(playerIds, random)
  shuffled.forEach((playerId, index) => {
    assignment[playerId] = `team-${(index % teamCount) + 1}`
  })
  return assignment
}

export interface TeamStat {
  id: string
  name: string
  memberCount: number
  submittedCount: number
  correctCount: number
  totalScore: number
  averageScore: number
}

export const computeTeamStats = (players: Player[], teams: TeamMeta[]): TeamStat[] => {
  const stats = teams.map((team): TeamStat => {
    // Every player currently carrying this teamId counts toward the denominator, regardless
    // of submitted/online status — teamId is teacher-only and frozen once status leaves
    // 'waiting', so this is always the locked roster, not a live-filtered subset.
    const members = players.filter((player) => player.teamId === team.id)
    const totalScore = members.reduce((sum, player) => sum + player.score, 0)
    const correctCount = members.reduce(
      (sum, player) => sum + player.answers.filter((answer) => answer.isCorrect).length,
      0,
    )
    const submittedCount = members.filter((player) => player.submitted).length
    return {
      id: team.id,
      name: team.name,
      memberCount: members.length,
      submittedCount,
      correctCount,
      totalScore,
      averageScore: members.length > 0 ? totalScore / members.length : 0,
    }
  })
  return stats.sort((a, b) => b.averageScore - a.averageScore || a.name.localeCompare(b.name, 'th'))
}

export const computeCurrentQuestionStats = (
  players: Player[],
  questionId: string | undefined,
): { answeredCount: number; correctCount: number } => {
  if (!questionId) return { answeredCount: 0, correctCount: 0 }
  let answeredCount = 0
  let correctCount = 0
  for (const player of players) {
    const answer = player.answers.find((item) => item.questionId === questionId)
    if (!answer) continue
    answeredCount += 1
    if (answer.isCorrect) correctCount += 1
  }
  return { answeredCount, correctCount }
}

// Per-team current-question progress ("ตอบแล้ว X/Y"), distinct from computeTeamStats's
// submittedCount (full-game completion, "เล่นจบ X/Y") — a member who has answered only the
// current question counts toward this, not that.
export const computeTeamCurrentQuestionCounts = (
  players: Player[],
  teams: TeamMeta[],
  questionId: string | undefined,
): Map<string, number> => {
  const counts = new Map<string, number>()
  if (!questionId) {
    teams.forEach((team) => counts.set(team.id, 0))
    return counts
  }
  teams.forEach((team) => {
    const answeredCount = players.filter(
      (player) => player.teamId === team.id && player.answers.some((answer) => answer.questionId === questionId),
    ).length
    counts.set(team.id, answeredCount)
  })
  return counts
}
