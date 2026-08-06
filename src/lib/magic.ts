import { shuffle } from './game'
import type { MagicEvent, MagicInventory, MagicItemType, Player, Room, TeamMagicBreakdown, TeamMeta } from '../types/game'

export const MAGIC_ITEM_INFO: Record<MagicItemType, { label: string; description: string }> = {
  power_surge: { label: 'มนตร์ทวีพลัง', description: 'ทีมของคุณได้รับคะแนนแข่งขัน 2 เท่าในคำถามข้อถัดไปที่ใช้ได้' },
  score_seal: { label: 'มนตร์ผนึกคะแนน', description: 'ทีมเป้าหมายได้รับคะแนนแข่งขันเพียงครึ่งหนึ่งในคำถามข้อถัดไปที่ใช้ได้ (ผนึกซ้อนกันได้จากหลายทีม)' },
  rose_shield: { label: 'เกราะกุหลาบ', description: 'ปิดกั้นไอเทมฝ่ายตรงข้ามที่เข้ามาหนึ่งครั้งต่อเกราะหนึ่งชิ้น แล้วถูกใช้ไปทันที' },
}

export const MAGIC_ITEM_TYPES: MagicItemType[] = ['power_surge', 'score_seal', 'rose_shield']

// True once a team has ever received ANY starting item (available or already consumed) — used
// to gate "choose exactly one starting item" (must be false beforehand) without caring about
// exactly which type or how many, since the boss mini-game can add more of the same type later
// without that counting as a fresh "starting item" choice.
export const hasAnyMagicItem = (inventory: MagicInventory): boolean =>
  MAGIC_ITEM_TYPES.some((itemType) => inventory[itemType].available > 0 || inventory[itemType].consumed > 0)

export const totalAvailableMagicItems = (inventory: MagicInventory): number =>
  MAGIC_ITEM_TYPES.reduce((sum, itemType) => sum + inventory[itemType].available, 0)

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
}

export interface MagicActivationWindow {
  valid: boolean
  affectedQuestionIndex: number | null
}

// Milestone 2.2: activation is a `room.status === 'playing'` concept only — selecting a
// starting item (in the waiting lobby, via chooseStartingItem) is a separate action from
// activating it, and never implies immediate use. Once playing, the holder may activate at any
// point in the CURRENT question's lifecycle (answering or reveal — this is deliberately no
// longer time-gated; a team.status shouldn't have to race a clock to use its own item), and the
// effect always targets the very next question (currentQuestionIndex + 1). Question 1 (index 0)
// can never be a target because activation itself requires status === 'playing', which only
// starts once question 1 (index 0) is already underway; the final question is excluded by
// isEligibleQuestionIndex. Once the target would be (or past) the final question, there is no
// eligible next question left and activation is unavailable for the rest of the round.
//
// Milestone 4: this window is deliberately unaware of the boss phase — callers that could be in
// either phase (e.g. GamePage) must additionally check room.phase === 'main' before treating a
// `valid: true` result as actionable, since boss questions are never part of questionIds and
// magic is not usable during the boss mini-game.
export const getMagicActivationWindow = (room: ActivationWindowRoom): MagicActivationWindow => {
  if (room.status !== 'playing') return { valid: false, affectedQuestionIndex: null }
  const affectedQuestionIndex = room.currentQuestionIndex + 1
  return { valid: isEligibleQuestionIndex(affectedQuestionIndex, room.questionIds.length), affectedQuestionIndex }
}

export interface TeamCompetitionStat {
  id: string
  name: string
  memberCount: number
  rawTotal: number
  // Milestone 4: the per-question raw formula (correct locked-roster members / total
  // locked-roster members * 10) already normalizes for team size, so a perfect team's rawTotal
  // is 100 regardless of headcount — there is no further "divide by member count" step left to
  // apply. rawAverage/competitionAverage are kept as fields (rather than removed) purely so the
  // existing sort/display call sites (TeacherPage's `.competitionAverage` sort key and `.toFixed`
  // display) keep working unchanged; they are now equal to rawTotal/competitionTotal, not a
  // further per-member division.
  rawAverage: number
  competitionTotal: number
  competitionAverage: number
}

interface AppliedMagicMultipliers {
  // key: `${targetTeamId}:${questionIndex}` -> 2 if an own power_surge applied there.
  ownMultiplierByKey: Map<string, number>
  // key: `${targetTeamId}:${questionIndex}` -> count of *unblocked* (applied) score_seal
  // events landing there. Multiple different source teams can each land a seal on the same
  // target+question — each contributes one more factor of 0.5 (see computeHostileMultiplier).
  sealCountByKey: Map<string, number>
}

// Shared by computeTeamCompetitionStats (every team x every question, in bulk) and
// computeTeamQuestionBreakdown (one team x one question, for the post-reveal UI breakdown) so
// the exact same event-to-multiplier interpretation is never duplicated/able to drift between
// the two call sites.
const computeAppliedMagicMultipliers = (events: MagicEvent[], currentRound: number): AppliedMagicMultipliers => {
  const ownMultiplierByKey = new Map<string, number>()
  const sealCountByKey = new Map<string, number>()
  for (const event of events) {
    if (event.status !== 'applied' || event.round !== currentRound || event.targetTeamId == null || event.affectedQuestionIndex == null) continue
    const key = `${event.targetTeamId}:${event.affectedQuestionIndex}`
    if (event.itemType === 'power_surge') {
      ownMultiplierByKey.set(key, 2)
    } else if (event.itemType === 'score_seal') {
      sealCountByKey.set(key, (sealCountByKey.get(key) ?? 0) + 1)
    }
  }
  return { ownMultiplierByKey, sealCountByKey }
}

// Milestone 4: seals stack multiplicatively — 1 seal = x0.5, 2 = x0.25, 3 = x0.125, and so on.
// Only *applied* (unblocked) events reach this point at all: a seal a shield blocked was
// recorded with status 'blocked', never 'applied', so it's already excluded upstream in
// computeAppliedMagicMultipliers and never contributes to sealCount here.
export const computeHostileMultiplier = (appliedSealCount: number): number => 0.5 ** appliedSealCount

// Milestone 4: team knowledge score, per question, is now
// (correct locked-roster members / total locked-roster members) * 10 — fair regardless of team
// size, and a perfect team's total across 10 questions is exactly 100. "Locked-roster members"
// is every player currently carrying this teamId (frozen once status leaves 'waiting'), so an
// unanswered member counts toward the denominator but contributes 0 to the numerator — never
// excluded from it.
//
// Pure and reproducible: competition scores are never accumulated in a mutable field, they are
// always recomputed from players (raw truth, untouched by magic) + the magic event log (the
// only source of truth for multipliers). Calling this twice with the same inputs always
// produces the same output.
//
// currentRound is required (not defaulted) so every caller consciously scopes to the live
// round: magicEvents is never wiped on a round transition (kept for history/audit), so an
// 'applied' event from a finished round must never contribute to a later round's competition
// score just because it shares a target/question-index key.
export const computeTeamCompetitionStats = (
  players: Player[],
  teams: TeamMeta[],
  questionIds: string[],
  events: MagicEvent[],
  currentRound: number,
): TeamCompetitionStat[] => {
  const { ownMultiplierByKey, sealCountByKey } = computeAppliedMagicMultipliers(events, currentRound)

  const stats = teams.map((team): TeamCompetitionStat => {
    const members = players.filter((player) => player.teamId === team.id)
    let rawTotal = 0
    let competitionTotal = 0
    questionIds.forEach((questionId, index) => {
      const correctCount = members.reduce(
        (sum, player) => sum + (player.answers.find((answer) => answer.questionId === questionId)?.isCorrect ? 1 : 0),
        0,
      )
      const rawQuestionScore = members.length > 0 ? (correctCount / members.length) * 10 : 0
      rawTotal += rawQuestionScore
      const key = `${team.id}:${index}`
      // Documented canonical order: own multiplier (x2) applied first, hostile multiplier
      // (x0.5 per stacked seal) applied second. Multiplication is commutative so the resulting
      // value is the same regardless of order, but the order is still fixed so this formula
      // reads identically everywhere it's referenced (UI, tests, audit).
      const ownMultiplier = ownMultiplierByKey.get(key) ?? 1
      const hostileMultiplier = computeHostileMultiplier(sealCountByKey.get(key) ?? 0)
      competitionTotal += rawQuestionScore * ownMultiplier * hostileMultiplier
    })
    return {
      id: team.id,
      name: team.name,
      memberCount: members.length,
      rawTotal,
      rawAverage: rawTotal,
      competitionTotal,
      // Deliberately uncapped — Competition score may exceed 100; do not cap it.
      competitionAverage: competitionTotal,
    }
  })
  return stats.sort((a, b) => b.competitionAverage - a.competitionAverage || a.name.localeCompare(b.name, 'th'))
}

// Milestone 4 section 3: "after reveal, show a clear calculation" — one team, one question,
// broken into exactly the pieces the UI needs to render "Raw team score: 8.0 / Magic: x2 / x0.5
// / Competition score: 16.0". Shares computeAppliedMagicMultipliers with
// computeTeamCompetitionStats so the numbers showed here can never drift from what's actually
// used for the leaderboard. Return type is TeamMagicBreakdown (types/game.ts) because the same
// shape is also what gets persisted onto TeamMagicState.lastResolvedBreakdown for students, who
// can't run this computation themselves (no `list` access to teammates' answers).
export const computeTeamQuestionBreakdown = (
  players: Player[],
  team: TeamMeta,
  questionId: string,
  questionIndex: number,
  events: MagicEvent[],
  currentRound: number,
): TeamMagicBreakdown => {
  const members = players.filter((player) => player.teamId === team.id)
  const correctCount = members.reduce(
    (sum, player) => sum + (player.answers.find((answer) => answer.questionId === questionId)?.isCorrect ? 1 : 0),
    0,
  )
  const rawScore = members.length > 0 ? (correctCount / members.length) * 10 : 0
  const { ownMultiplierByKey, sealCountByKey } = computeAppliedMagicMultipliers(events, currentRound)
  const key = `${team.id}:${questionIndex}`
  const ownMultiplier = ownMultiplierByKey.get(key) ?? 1
  const sealCount = sealCountByKey.get(key) ?? 0
  const hostileMultiplier = computeHostileMultiplier(sealCount)
  return {
    questionIndex,
    memberCount: members.length,
    correctCount,
    rawScore,
    ownMultiplier,
    sealCount,
    hostileMultiplier,
    competitionScore: rawScore * ownMultiplier * hostileMultiplier,
  }
}
