import type { JoinInput, Player, Question, QuestionCategory, Room, TeacherSession } from '../types/game'

export const ROUND_CATEGORY_COUNTS: Record<QuestionCategory, number> = {
  basic: 2,
  characters: 2,
  plot: 3,
  poetry: 2,
  theme: 1,
}

// Legacy 6-character room codes (letters/digits, excluding easily-confused O/I/L/0/1) — no
// longer generated for new rooms (see generateRoomCode below), but existing rooms created under
// the old format must remain joinable, so validateJoinInput still accepts this shape too.
const LEGACY_ROOM_CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{6}$/
// New room codes: exactly 4 numeric digits, "0000"-"9999".
const ROOM_CODE_PATTERN = /^\d{4}$/

export const shuffle = <T>(items: T[], random: () => number): T[] => {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

export const selectRoundQuestions = (
  bank: Question[],
  previousQuestionIds: string[] = [],
  random: () => number = Math.random,
): string[] => {
  const selected: Question[] = []
  const selectedByCategory = new Map<QuestionCategory, Question[]>()

  for (const [category, count] of Object.entries(ROUND_CATEGORY_COUNTS) as [QuestionCategory, number][]) {
    const pool = bank.filter((question) => question.category === category)
    if (pool.length < count) {
      throw new Error(`คำถามหมวด ${category} มีไม่พอสำหรับสร้างรอบ`)
    }
    const picked = shuffle(pool, random).slice(0, count)
    selectedByCategory.set(category, picked)
    selected.push(...picked)
  }

  const previousSet = new Set(previousQuestionIds)
  const duplicatesWholeSet = selected.length === previousSet.size && selected.every((item) => previousSet.has(item.id))
  if (duplicatesWholeSet) {
    for (const category of Object.keys(ROUND_CATEGORY_COUNTS) as QuestionCategory[]) {
      const picked = selectedByCategory.get(category) ?? []
      const replacement = bank.find(
        (question) => question.category === category && !picked.some((item) => item.id === question.id),
      )
      if (replacement && picked[0]) {
        const index = selected.findIndex((item) => item.id === picked[0].id)
        selected[index] = replacement
        break
      }
    }
  }

  return shuffle(selected, random).map((question) => question.id)
}

// New rooms get a 4-digit numeric code, 0000-9999 — always zero-padded to exactly 4 digits (a
// bare `String(n)` would produce "42" for the number 42, not "0042"). Uniqueness against
// existing rooms is the caller's responsibility (see firebaseService.ts/demoService.ts's
// createRoom, which check-then-retry on collision) — this function only ever returns a
// uniformly random 4-digit string, never checks for a clash itself.
export const generateRoomCode = (random: () => number = Math.random): string =>
  String(Math.floor(random() * 10_000)).padStart(4, '0')

export const calculateScore = (answers: Array<{ isCorrect: boolean }>): number =>
  answers.reduce((score, answer) => score + (answer.isCorrect ? 1 : 0), 0)

export const evaluateChoice = (
  question: Question | undefined,
  selectedChoiceId: string,
): { valid: boolean; isCorrect: boolean } => ({
  valid: Boolean(question?.choices.some((choice) => choice.id === selectedChoiceId)),
  isCorrect: Boolean(question && question.correctChoiceId === selectedChoiceId),
})

export const validateJoinInput = (input: JoinInput): Partial<Record<keyof JoinInput, string>> => {
  const errors: Partial<Record<keyof JoinInput, string>> = {}
  const roomCode = input.roomCode.trim().toUpperCase()
  const displayName = input.displayName.trim()
  const studentNumber = input.studentNumber.trim()

  // New rooms only ever get a 4-digit numeric code (see generateRoomCode above), but rooms
  // created before this change used the legacy 6-character format and must remain joinable —
  // so both shapes are accepted here.
  if (!roomCode) errors.roomCode = 'กรุณากรอกรหัสห้อง'
  else if (!ROOM_CODE_PATTERN.test(roomCode) && !LEGACY_ROOM_CODE_PATTERN.test(roomCode)) {
    errors.roomCode = 'รหัสห้องต้องเป็นตัวเลข 4 หลัก (หรือรหัสรุ่นเก่า 6 ตัวอักษรแบบไม่มี O, I, L, 0, 1)'
  }
  if (!displayName) errors.displayName = 'กรุณากรอกชื่อผู้เล่น'
  else if (displayName.length > 40) errors.displayName = 'ชื่อผู้เล่นต้องไม่เกิน 40 ตัวอักษร'
  if (!studentNumber) errors.studentNumber = 'กรุณากรอกเลขที่นักเรียน'
  else if (studentNumber.length > 20) errors.studentNumber = 'เลขที่นักเรียนต้องไม่เกิน 20 ตัวอักษร'
  return errors
}

export const resolveStudentRoute = (room: Room, player: Player): string => {
  const base = room.roomCode
  if (room.status === 'closed') return `/closed/${base}`
  if (room.winner) return `/congratulations/${base}`
  if (room.status === 'completed') return `/result/${base}`
  if (room.status === 'waiting') return `/lobby/${base}`
  if (player.submitted) return `/result/${base}`
  return `/game/${base}`
}

// A locally stored teacher session can outlive the Firebase identity it was captured under
// (a fresh anonymous sign-in on a new profile, cleared browser storage, etc.). currentUid is
// always the authoritative, stable Firebase uid (from GameContext, backed by
// ensureAnonymousUser) — it must win. If the stored session's teacherSessionId doesn't match
// it, the room it points at is no longer provably owned by this browser, so it's discarded
// entirely (both the stale uid AND its remembered roomCode) rather than silently reused,
// which would just produce a confusing permission-denied later.
export const resolveTeacherRoomSession = (
  stored: TeacherSession | null,
  currentUid: string,
): { teacherSessionId: string; roomCode: string } => {
  if (stored && stored.teacherSessionId === currentUid) {
    return { teacherSessionId: currentUid, roomCode: stored.roomCode ?? '' }
  }
  return { teacherSessionId: currentUid, roomCode: '' }
}

export const formatElapsedTime = (elapsedMs: number | null | undefined): string => {
  const safeMs = Math.max(0, elapsedMs ?? 0)
  const minutes = Math.floor(safeMs / 60_000)
  const seconds = Math.floor((safeMs % 60_000) / 1_000)
  return `${minutes}:${seconds.toString().padStart(2, '0')} นาที`
}
