import { describe, expect, it } from 'vitest'
import {
  bossQuestionTiming,
  getAssessmentDeadline,
  getAssessmentRemainingMilliseconds,
  getQuestionDeadline,
  getRemainingMilliseconds,
  isAssessmentExpired,
  mainQuestionTiming,
  postTestWindow,
  preTestWindow,
  recallQuestionTiming,
} from './gameFlow'
import { PHASE_INTRO_MILLISECONDS } from '../types/game'

// The phase-intro cutscene must cost a timed activity nothing, WITHOUT the persisted timestamp
// ever being a client-authored value. The server writes the real phase-entry instant; the intro
// offset is applied on read, here.

const START = 1_000_000

describe('phase intro is an offset applied on read, not a stored value', () => {
  it('is a short, non-zero transition', () => {
    expect(PHASE_INTRO_MILLISECONDS).toBeGreaterThanOrEqual(1_500)
    expect(PHASE_INTRO_MILLISECONDS).toBeLessThanOrEqual(2_000)
  })

  // ---- 2. deadline = persisted timestamp + intro offset + duration -------------------------
  it('derives the main deadline from the persisted timestamp plus intro plus duration', () => {
    const room = {
      questionStartedAt: START,
      questionDurationSeconds: 30,
      questionClosedAt: null,
      currentQuestionIndex: 0,
    }
    expect(getQuestionDeadline(mainQuestionTiming(room))).toBe(START + PHASE_INTRO_MILLISECONDS + 30_000)
  })

  it('derives the assessment deadline the same way, from the persisted open instant', () => {
    const room = { preTestStartedAt: START, postTestStartedAt: START, assessmentSecondsPerQuestion: 240 }
    expect(getAssessmentDeadline(preTestWindow(room))).toBe(START + PHASE_INTRO_MILLISECONDS + 240_000)
    expect(getAssessmentDeadline(postTestWindow(room))).toBe(START + PHASE_INTRO_MILLISECONDS + 240_000)
  })

  it('applies the offset on phase ENTRY only, never between ordinary questions', () => {
    const base = { questionStartedAt: START, questionDurationSeconds: 30, questionClosedAt: null }
    // Question 1 is the main-phase entry: intro plays.
    expect(mainQuestionTiming({ ...base, currentQuestionIndex: 0 }).introOffsetMs).toBe(PHASE_INTRO_MILLISECONDS)
    // Every later question advances with no intro, so no offset.
    for (const index of [1, 2, 5, 9]) {
      expect(mainQuestionTiming({ ...base, currentQuestionIndex: index }).introOffsetMs).toBe(0)
      expect(getQuestionDeadline(mainQuestionTiming({ ...base, currentQuestionIndex: index })))
        .toBe(START + 30_000)
    }
    // Same rule for boss and recall.
    expect(bossQuestionTiming({ bossQuestionStartedAt: START, bossQuestionDurationSeconds: 10, bossQuestionIndex: 0 }).introOffsetMs)
      .toBe(PHASE_INTRO_MILLISECONDS)
    expect(bossQuestionTiming({ bossQuestionStartedAt: START, bossQuestionDurationSeconds: 10, bossQuestionIndex: 2 }).introOffsetMs)
      .toBe(0)
    expect(recallQuestionTiming({ recallQuestionStartedAt: START, recallQuestionDurationSeconds: 15, recallQuestionIndex: 0 }).introOffsetMs)
      .toBe(PHASE_INTRO_MILLISECONDS)
    expect(recallQuestionTiming({ recallQuestionStartedAt: START, recallQuestionDurationSeconds: 15, recallQuestionIndex: 3 }).introOffsetMs)
      .toBe(0)
  })

  // ---- 1. the intro does not consume gameplay time -----------------------------------------
  it('shows the full configured time during the intro and never more', () => {
    const timing = mainQuestionTiming({
      questionStartedAt: START,
      questionDurationSeconds: 30,
      questionClosedAt: null,
      currentQuestionIndex: 0,
    })
    // Throughout the intro the readout holds at the full duration — it does not decrement, and it
    // never exceeds what the teacher configured.
    expect(getRemainingMilliseconds(timing, START)).toBe(30_000)
    expect(getRemainingMilliseconds(timing, START + 900)).toBe(30_000)
    expect(getRemainingMilliseconds(timing, START + PHASE_INTRO_MILLISECONDS)).toBe(30_000)
    // Then it counts down normally from the full duration.
    expect(getRemainingMilliseconds(timing, START + PHASE_INTRO_MILLISECONDS + 10_000)).toBe(20_000)
    expect(getRemainingMilliseconds(timing, START + PHASE_INTRO_MILLISECONDS + 30_000)).toBe(0)
  })

  it('does the same for an assessment budget', () => {
    const window = preTestWindow({ preTestStartedAt: START, assessmentSecondsPerQuestion: 240 })
    expect(getAssessmentRemainingMilliseconds(window, START)).toBe(240_000)
    expect(getAssessmentRemainingMilliseconds(window, START + PHASE_INTRO_MILLISECONDS)).toBe(240_000)
    expect(getAssessmentRemainingMilliseconds(window, START + PHASE_INTRO_MILLISECONDS + 60_000)).toBe(180_000)
    expect(isAssessmentExpired(window, START + PHASE_INTRO_MILLISECONDS + 239_999)).toBe(false)
    expect(isAssessmentExpired(window, START + PHASE_INTRO_MILLISECONDS + 240_000)).toBe(true)
  })

  // ---- 3. refresh / reconnect cannot restart the intro or the timer -------------------------
  it('is a pure function of the persisted timestamp, so reloading changes nothing', () => {
    const room = {
      questionStartedAt: START,
      questionDurationSeconds: 30,
      questionClosedAt: null,
      currentQuestionIndex: 0,
    }
    const at = START + PHASE_INTRO_MILLISECONDS + 12_000
    const first = getRemainingMilliseconds(mainQuestionTiming(room), at)
    // A refresh re-derives from the same stored room document — recomputing yields the same value
    // rather than restarting the countdown.
    for (let reload = 0; reload < 5; reload += 1) {
      expect(getRemainingMilliseconds(mainQuestionTiming({ ...room }), at)).toBe(first)
    }
    expect(first).toBe(18_000)
  })
})

// ---- 4. no timer relies on the teacher's local clock as the persisted authority --------------
describe('persisted start instants come from the server, not a client clock', () => {
  const readSource = async (file: string): Promise<string> =>
    import('node:fs/promises').then((fs) => fs.readFile(new URL(file, import.meta.url), 'utf8'))

  it('firebaseService writes every phase-entry timestamp with serverTimestamp()', async () => {
    const source = await readSource('../services/firebaseService.ts')
    for (const field of [
      'questionStartedAt',
      'recallQuestionStartedAt',
      'bossQuestionStartedAt',
      'preTestStartedAt',
      'postTestStartedAt',
    ]) {
      // Every write of a start instant must be serverTimestamp(), never Date.now().
      const clientWrites = source.match(new RegExp(`${field}:\\s*Date\\.now\\(\\)`, 'g')) ?? []
      expect(clientWrites, `${field} must not be written from the client clock`).toEqual([])
    }
    // And the offset constant must not be added into any persisted write.
    expect(source).not.toMatch(/StartedAt:\s*Date\.now\(\)\s*\+\s*PHASE_INTRO_MILLISECONDS/)
    expect(source).not.toContain('PHASE_INTRO_MILLISECONDS')
  })

  it('the offset lives in the read-side derivation instead', async () => {
    const source = await readSource('./gameFlow.ts')
    expect(source).toContain('introOffsetMs')
    expect(source).toContain('room.questionStartedAt + (room.introOffsetMs ?? 0)')
  })
})
