import { shuffle } from './game'
import type { MagicEvent, MagicInventory, MagicItemType, Player, Question, Room, TeamMagicBreakdown, TeamMeta } from '../types/game'

// Milestone: icon is the single source every render site looks up for a per-item glyph —
// previously the correct emoji existed but only as scattered hardcoded literals wired to a few
// one-off spots (toasts, a GamePage-local boss-reward map), so most generic list-rendering sites
// (inventory lists, choice buttons, teacher's per-team panel) had nothing to render and fell back
// to a decorative generic glyph or nothing at all. See MagicItemIcon.tsx, the shared component
// every render site should use instead of reading `.icon` directly.
// Grimoire follow-up: "ข้อต่อไป" (not "ข้อถัดไป" — synonymous, but the grimoire's exact quoted
// copy uses "ข้อต่อไป" throughout, so these short descriptions now match it verbatim instead of
// a near-synonym, per the "terminology consistent with the grimoire" requirement.
export const MAGIC_ITEM_INFO: Record<MagicItemType, { label: string; description: string; icon: string }> = {
  power_surge: { label: 'มนตร์ทวีพลัง', description: 'ทีมของคุณได้รับคะแนนแข่งขัน 2 เท่าในคำถามข้อต่อไปที่ใช้ได้', icon: '⚡' },
  score_seal: { label: 'มนตร์ผนึกคะแนน', description: 'ทีมเป้าหมายได้รับคะแนนแข่งขันเพียงครึ่งหนึ่งในคำถามข้อต่อไปที่ใช้ได้ (ผนึกซ้อนกันได้จากหลายทีม)', icon: '🔒' },
  rose_shield: { label: 'เกราะกุหลาบ', description: 'ปิดกั้นไอเทมฝ่ายตรงข้ามที่เข้ามาหนึ่งครั้งต่อเกราะหนึ่งชิ้น แล้วถูกใช้ไปทันที', icon: '🛡️' },
  illusion: { label: 'มนตร์ลวงตา', description: 'ตัดตัวเลือกที่ผิดออก 1 ตัวเลือกให้ทุกคนในทีมในคำถามข้อต่อไปที่ใช้ได้ (ไม่มีผลต่อคะแนน)', icon: '🔮' },
}

export const MAGIC_ITEM_TYPES: MagicItemType[] = ['power_surge', 'score_seal', 'rose_shield', 'illusion']

// Grimoire ("คัมภีร์มนตรา"): the detailed, structured explanation shown in the reference modal —
// deliberately a separate table from MAGIC_ITEM_INFO.description (which stays the short,
// single-line summary used in choice buttons/inventory), keyed by the same MagicItemType so both
// tables can never drift into naming a 5th item or disagreeing on which types exist. Every line
// here is exact copy, not paraphrased, so the wording audited into badges/popups elsewhere in the
// app can be checked against this as the canonical source. rose_shield's `activation`/`timing`/
// `effect` slots are populated with the same meaning as the other three (who/how it triggers,
// when/how long, what it does) even though its mechanic reads in a different order than the
// three next-question items — never described as "next question only" (it persists until it
// blocks a Score Seal, then is consumed).
export interface MagicGrimoireEntry {
  activation: string
  timing: string
  effect: string
  note?: string
}

export const MAGIC_GRIMOIRE: Record<MagicItemType, MagicGrimoireEntry> = {
  power_surge: {
    activation: 'หัวหน้าทีมกดใช้',
    timing: 'มีผลในคำถามข้อต่อไปเพียง 1 ข้อ',
    effect: 'คะแนนที่ทีมทำได้ในข้อนั้น ×2',
  },
  score_seal: {
    activation: 'หัวหน้าทีมเลือกทีมเป้าหมายแล้วกดใช้',
    timing: 'มีผลในคำถามข้อต่อไปเพียง 1 ข้อ',
    effect: 'คะแนนของทีมเป้าหมายในข้อนั้นเหลือ 50%',
    note: 'หากมีเกราะกุหลาบ การโจมตีจะถูกป้องกัน',
  },
  rose_shield: {
    activation: 'ไม่ต้องกดใช้',
    timing: 'เกราะจะคงอยู่จนกว่าจะป้องกันการโจมตีสำเร็จ แล้วหายไป 1 ชิ้น',
    effect: 'ระบบป้องกันมนตร์ผนึกคะแนนให้อัตโนมัติ 1 ครั้ง',
  },
  illusion: {
    activation: 'หัวหน้าทีมกดใช้',
    timing: 'มีผลในคำถามข้อต่อไปเพียง 1 ข้อ',
    effect: 'ระบบตัดตัวเลือกที่ผิดออก 1 ตัวให้สมาชิกทั้งทีม',
  },
}

// Item-copy consistency (grimoire follow-up): a single source of truth for "is this queued
// effect upcoming, or already the question in progress" — badges/popups across MagicPanel and
// TeacherPage both need this same queued-vs-active distinction so they can never disagree on
// wording. affectedQuestionIndex is only ever >= currentQuestionIndex while the effect is live
// (resolution clears queuedEffect to null the moment the target question closes), so `<=` is a
// safe/simple "active" test — never <, which would mean an already-resolved (and thus already
// cleared) effect.
export type MagicEffectPhase = 'queued' | 'active'

export const getMagicEffectPhase = (affectedQuestionIndex: number, currentQuestionIndex: number): MagicEffectPhase =>
  affectedQuestionIndex <= currentQuestionIndex ? 'active' : 'queued'

// True once a team has ever received ANY starting item (available or already consumed) — used
// to gate "choose exactly one starting item" (must be false beforehand) without caring about
// exactly which type or how many, since the boss mini-game can add more of the same type later
// without that counting as a fresh "starting item" choice.
export const hasAnyMagicItem = (inventory: MagicInventory): boolean =>
  MAGIC_ITEM_TYPES.some((itemType) => inventory[itemType].available > 0 || inventory[itemType].consumed > 0)

export const totalAvailableMagicItems = (inventory: MagicInventory): number =>
  MAGIC_ITEM_TYPES.reduce((sum, itemType) => sum + inventory[itemType].available, 0)

// Milestone 4.1: replaces the old random-holder pickHolders — the magic holder is now the
// team's ELECTED captain. Highest vote count wins; a tie among the top candidates is broken by
// a uniform random draw (never array/insertion order), matching lib/boss.ts's tie-pool draw for
// boss ranking. If no votes were cast at all, every member tallies 0 and is therefore tied for
// "highest" — the same draw then picks uniformly among the WHOLE roster, so a team can never get
// permanently stuck with no captain (this is what backs the teacher's early-finalize button).
// Votes for a target no longer on the roster (e.g. a stale vote from before a re-randomize) are
// silently ignored rather than crashing.
export const pickElectedCaptain = (
  memberIds: string[],
  votesByVoter: Record<string, string>,
  random: () => number = Math.random,
): string | null => {
  if (memberIds.length === 0) return null
  const tally = new Map<string, number>(memberIds.map((id) => [id, 0]))
  Object.values(votesByVoter).forEach((targetId) => {
    if (!tally.has(targetId)) return
    tally.set(targetId, (tally.get(targetId) ?? 0) + 1)
  })
  const highest = Math.max(...tally.values())
  const topCandidates = memberIds.filter((id) => tally.get(id) === highest)
  return shuffle(topCandidates, random)[0] ?? null
}

// Milestone 4.1: chosen exactly ONCE, at activation time, and stored on the QueuedMagicEffect
// (see hiddenChoiceId's doc comment in types/game.ts) — callers must never call this again for
// an already-queued illusion effect; that discipline is what makes "retry/refresh never rerolls
// the hidden choice" true by construction, since nothing ever recomputes it on read.
export const pickIllusionHiddenChoice = (
  question: Pick<Question, 'choices' | 'correctChoiceId'>,
  random: () => number = Math.random,
): string => {
  const incorrectChoices = question.choices.filter((choice) => choice.id !== question.correctChoiceId)
  return shuffle(incorrectChoices, random)[0].id
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

export const formatHostilePercent = (multiplier: number): string => {
  const percent = multiplier * 100
  return Number.isInteger(percent) ? `${percent}` : percent.toFixed(1)
}

// Item 7: dramatic-popup presentation copy, shared by the student toast (MagicPanel) and the
// teacher spell-event overlay (TeacherPage) so both audiences narrate the same event with the
// same tone/wording, just at a different scale. `tone` drives the CSS variant (magic-toast-seal
// etc. — kept as the existing short aliases, not full MagicItemType values, matching the CSS
// classes already in styles.css).
export interface MagicEventCopy {
  tone: 'surge' | 'seal' | 'shield' | 'illusion'
  headline: string
  body: string
}

// Item 4 (follow-up): every "next eligible question" body explicitly says คำถามข้อต่อไป — never
// "ข้อนี้"/"this question" — since activation always targets the NEXT eligible question, never
// the one currently being answered. The specific number is kept alongside for precision, but the
// wording itself must never suggest an immediate/current-question effect.
export const buildIncomingSealCopy = (count: number, questionNumber: number): MagicEventCopy => ({
  tone: 'seal',
  headline: 'ทีมของคุณถูกสาปผนึกคะแนน!',
  body: count >= 2
    ? `ถูกผนึกคะแนน ${count} ครั้ง — คำถามข้อต่อไป (ข้อ ${questionNumber}) คะแนนของทีมคุณจะเหลือ ${formatHostilePercent(computeHostileMultiplier(count))}%`
    : `คำถามข้อต่อไป (ข้อ ${questionNumber}) คะแนนของทีมคุณจะเหลือ ${formatHostilePercent(computeHostileMultiplier(count))}%`,
})

export const buildPowerSurgeCopy = (questionNumber: number): MagicEventCopy => ({
  tone: 'surge',
  headline: 'ทีมของคุณร่ายมนตร์ทวีพลัง!',
  body: `คำถามข้อต่อไป (ข้อ ${questionNumber}) ทีมของคุณจะได้รับคะแนน x2`,
})

export const buildIllusionCopy = (questionNumber: number): MagicEventCopy => ({
  tone: 'illusion',
  headline: 'ทีมของคุณใช้มายาลวงตา!',
  body: `คำถามข้อต่อไป (ข้อ ${questionNumber}) ตัวเลือกที่ผิด 1 ตัวจะถูกซ่อนให้ทุกคนในทีม — คำตอบยังต้องเลือกเองตามปกติ`,
})

export const buildShieldBlockCopy = (): MagicEventCopy => ({
  tone: 'shield',
  headline: 'เกราะกุหลาบป้องกันสำเร็จ!',
  body: 'การโจมตีถูกสะท้อน/ป้องกันแล้ว ทีมของคุณไม่ถูกลดคะแนน และเกราะถูกใช้ไปหนึ่งชิ้น',
})

// Teacher-side variant of the same events — headline names the acting/target TEAM (guardian name
// once item 6 sets one, "ทีม N" fallback otherwise), since the teacher screen shows every team
// at once rather than a single team's own first-person view.
export const buildTeacherSpellEventCopy = (
  event: { itemType: MagicItemType; status: MagicEvent['status'] },
  sourceTeamName: string,
  targetTeamName: string | null,
): MagicEventCopy => {
  if (event.status === 'blocked') {
    return {
      tone: 'shield',
      headline: `เกราะกุหลาบของทีม${targetTeamName ?? '-'}ป้องกันมนตร์โจมตี!`,
      body: 'การโจมตีถูกสะท้อน/ป้องกันแล้ว',
    }
  }
  if (event.itemType === 'power_surge') {
    return { tone: 'surge', headline: `ทีม${sourceTeamName}ร่ายมนตร์ทวีพลัง!`, body: `คำถามข้อต่อไป ทีม${sourceTeamName}จะได้รับคะแนน x2` }
  }
  if (event.itemType === 'score_seal') {
    return { tone: 'seal', headline: `ทีม${sourceTeamName}สาปผนึกคะแนนใส่ทีม${targetTeamName ?? '-'}!`, body: `คำถามข้อต่อไป คะแนนของทีม${targetTeamName ?? '-'}จะเหลือลดลง` }
  }
  if (event.itemType === 'illusion') {
    return { tone: 'illusion', headline: `ทีม${sourceTeamName}ใช้มายาลวงตา!`, body: `คำถามข้อต่อไป ตัวเลือกที่ผิด 1 ตัวจะถูกซ่อนให้ทีม${sourceTeamName}` }
  }
  return { tone: 'shield', headline: `ทีม${sourceTeamName}ใช้เกราะกุหลาบ!`, body: 'พร้อมป้องกันมนตร์โจมตีครั้งถัดไป' }
}

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
