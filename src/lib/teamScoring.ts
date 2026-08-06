import { shuffle } from './game'
import type { Player, TeamMeta } from '../types/game'

export const buildTeamMetas = (teamCount: number): TeamMeta[] =>
  Array.from({ length: teamCount }, (_, index) => ({ id: `team-${index + 1}`, name: `ทีม ${index + 1}` }))

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
