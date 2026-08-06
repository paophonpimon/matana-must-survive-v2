import { shuffle } from './game'
import { getRemainingMilliseconds, getRevealRemainingMilliseconds } from './gameFlow'
import type { MagicEvent, MagicItemType, Player, Room, TeamMeta } from '../types/game'

export const MAGIC_ITEM_INFO: Record<MagicItemType, { label: string; description: string }> = {
  power_surge: { label: 'มนตร์ทวีพลัง', description: 'ทีมของคุณได้รับคะแนนแข่งขัน 150% ในคำถามข้อถัดไปที่ใช้ได้' },
  score_seal: { label: 'มนตร์ผนึกคะแนน', description: 'ทีมเป้าหมายได้รับคะแนนแข่งขันเพียง 50% ในคำถามข้อถัดไปที่ใช้ได้' },
  rose_shield: { label: 'เกราะกุหลาบ', description: 'ปิดกั้นไอเทมฝ่ายตรงข้ามที่เข้ามาหนึ่งครั้ง แล้วถูกใช้ไปทันที' },
}

// One random member of each team becomes the magic holder. Teams with no members are skipped
// (shouldn't happen once teams are locked, since randomizeTeams already rejects teamCount >
// player count, but this keeps the function total rather than throwing on bad input).
export const pickHolders = (
  teamMemberIdsByTeam: Record<string, string[]>,
  random: () => number = Math.random,
): Record<string, string> => {
  const holders: Record<string, string> = {}
  for (const [teamId, memberIds] of Object.entries(teamMemberIdsByTeam)) {
    if (memberIds.length === 0) continue
    holders[teamId] = shuffle(memberIds, random)[0]
  }
  return holders
}

// Question 1 (index 0) and the final question (index length-1, "question 10" in a 10-question
// round) can never be affected by an item.
export const isEligibleQuestionIndex = (index: number, totalQuestions: number): boolean =>
  index > 0 && index < totalQuestions - 1

interface ActivationWindowRoom {
  status: Room['status']
  currentQuestionIndex: number
  questionIds: string[]
  questionStartedAt: number | null
  questionDurationSeconds: number
}

export interface MagicActivationWindow {
  valid: boolean
  affectedQuestionIndex: number | null
}

// Items may be queued only (a) in the lobby before question 1 starts, or (b) during the
// answer-reveal/intermission window of the currently playing question. Both windows have one
// deterministic "next eligible question" — the holder never picks it. Any other time (mid-
// question, or the round is completed/closed) is not a valid activation window at all.
export const getMagicActivationWindow = (room: ActivationWindowRoom, now: number = Date.now()): MagicActivationWindow => {
  const totalQuestions = room.questionIds.length
  if (room.status === 'waiting') {
    const affectedQuestionIndex = 1
    return { valid: isEligibleQuestionIndex(affectedQuestionIndex, totalQuestions), affectedQuestionIndex }
  }
  if (room.status === 'playing') {
    const remainingMs = getRemainingMilliseconds(room, now)
    const revealRemainingMs = getRevealRemainingMilliseconds(room, now)
    if (remainingMs === 0 && revealRemainingMs > 0) {
      const affectedQuestionIndex = room.currentQuestionIndex + 1
      return { valid: isEligibleQuestionIndex(affectedQuestionIndex, totalQuestions), affectedQuestionIndex }
    }
  }
  return { valid: false, affectedQuestionIndex: null }
}

export interface TeamCompetitionStat {
  id: string
  name: string
  memberCount: number
  rawTotal: number
  rawAverage: number
  competitionTotal: number
  competitionAverage: number
}

// Pure and reproducible: competition scores are never accumulated in a mutable field, they are
// always recomputed from players (raw truth, untouched by magic) + the magic event log (the
// only source of truth for multipliers). Calling this twice with the same inputs always
// produces the same output.
export const computeTeamCompetitionStats = (
  players: Player[],
  teams: TeamMeta[],
  questionIds: string[],
  events: MagicEvent[],
): TeamCompetitionStat[] => {
  const ownMultiplierByKey = new Map<string, number>()
  const hostileMultiplierByKey = new Map<string, number>()
  for (const event of events) {
    if (event.status !== 'applied' || event.targetTeamId == null || event.affectedQuestionIndex == null) continue
    const key = `${event.targetTeamId}:${event.affectedQuestionIndex}`
    if (event.itemType === 'power_surge') ownMultiplierByKey.set(key, 1.5)
    else if (event.itemType === 'score_seal') hostileMultiplierByKey.set(key, 0.5)
  }

  const stats = teams.map((team): TeamCompetitionStat => {
    const members = players.filter((player) => player.teamId === team.id)
    let rawTotal = 0
    let competitionTotal = 0
    questionIds.forEach((questionId, index) => {
      const rawTeamQuestionPoints = members.reduce(
        (sum, player) => sum + (player.answers.find((answer) => answer.questionId === questionId)?.isCorrect ? 1 : 0),
        0,
      )
      rawTotal += rawTeamQuestionPoints
      const key = `${team.id}:${index}`
      // Documented canonical order: own multiplier (x1.5) applied first, hostile multiplier
      // (x0.5) applied second. Multiplication is commutative so the resulting value is the
      // same regardless of order, but the order is still fixed so this formula reads
      // identically everywhere it's referenced (UI, tests, audit).
      const ownMultiplier = ownMultiplierByKey.get(key) ?? 1
      const hostileMultiplier = hostileMultiplierByKey.get(key) ?? 1
      competitionTotal += rawTeamQuestionPoints * ownMultiplier * hostileMultiplier
    })
    return {
      id: team.id,
      name: team.name,
      memberCount: members.length,
      rawTotal,
      rawAverage: members.length > 0 ? rawTotal / members.length : 0,
      competitionTotal,
      competitionAverage: members.length > 0 ? competitionTotal / members.length : 0,
    }
  })
  return stats.sort((a, b) => b.competitionAverage - a.competitionAverage || a.name.localeCompare(b.name, 'th'))
}
