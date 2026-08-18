import { describe, expect, it } from 'vitest'
import { shuffleChoicesForPlayer } from './choiceOrder'
import { buildScoreSealCopy, computeHostileMultiplier } from './magic'
import { PRE_TEST_QUESTIONS, POST_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { questions } from '../data/questions'
import { bossQuestions } from '../data/bossQuestions'

const ids = (choices: Array<{ id: string }>): string[] => choices.map((choice) => choice.id)

describe('per-student choice order', () => {
  const question = PRE_TEST_QUESTIONS[0]

  it('is stable for the same student and question across repeated calls', () => {
    const first = ids(shuffleChoicesForPlayer(question.choices, 'player-1', question.id))
    for (let attempt = 0; attempt < 25; attempt += 1) {
      // Re-render, refresh and reconnect all reduce to "call it again" — the order must not move.
      expect(ids(shuffleChoicesForPlayer(question.choices, 'player-1', question.id))).toEqual(first)
    }
  })

  it('gives different students different orders', () => {
    const orders = new Set<string>()
    for (let index = 0; index < 40; index += 1) {
      orders.add(ids(shuffleChoicesForPlayer(question.choices, `player-${index}`, question.id)).join('|'))
    }
    // Not a strict guarantee for any single pair, but across 40 students the order must vary.
    expect(orders.size).toBeGreaterThan(1)
  })

  it('gives the same student different orders on different questions', () => {
    const a = ids(shuffleChoicesForPlayer(PRE_TEST_QUESTIONS[0].choices, 'player-1', PRE_TEST_QUESTIONS[0].id))
    const b = ids(shuffleChoicesForPlayer(PRE_TEST_QUESTIONS[1].choices, 'player-1', PRE_TEST_QUESTIONS[1].id))
    expect(a.join('|')).not.toBe(b.join('|'))
  })

  it('never adds, drops or mutates choices', () => {
    const original = [...question.choices]
    const shuffled = shuffleChoicesForPlayer(question.choices, 'player-7', question.id)
    expect([...ids(shuffled)].sort()).toEqual([...ids(original)].sort())
    expect(shuffled).toHaveLength(original.length)
    // The bank's own array must stay in its authored order for everything else that reads it.
    expect(question.choices).toEqual(original)
  })

  it('keeps the authored order when the student id is not resolved yet', () => {
    // A render before the session resolves must not produce an order that then changes.
    expect(ids(shuffleChoicesForPlayer(question.choices, '', question.id))).toEqual(ids(question.choices))
  })

  it('preserves the correct choice id for every question in every bank', () => {
    const banks = [
      ...PRE_TEST_QUESTIONS.map((item) => ({ id: item.id, choices: item.choices, correct: item.correctChoiceId })),
      ...POST_TEST_QUESTIONS.map((item) => ({ id: item.id, choices: item.choices, correct: item.correctChoiceId })),
      ...RECALL_QUESTIONS.map((item) => ({ id: item.id, choices: item.choices, correct: item.correctChoiceId })),
      ...questions.map((item) => ({ id: item.id, choices: item.choices, correct: item.correctChoiceId })),
      ...bossQuestions.map((item) => ({ id: item.id, choices: item.choices, correct: item.correctChoiceId })),
    ]
    for (const item of banks) {
      const shuffled = shuffleChoicesForPlayer(item.choices, 'player-42', item.id)
      // Correctness rides on the id, never on position — the correct choice is always present,
      // exactly once, wherever it happens to land.
      expect(shuffled.filter((choice) => choice.id === item.correct)).toHaveLength(1)
    }
  })

  it('removing a choice by id yields the same remaining set regardless of student', () => {
    // Illusion filters by id BEFORE ordering, so every teammate loses the same choice even though
    // they each see a different arrangement.
    const hidden = question.choices.find((choice) => choice.id !== question.correctChoiceId)?.id ?? ''
    const remaining = question.choices.filter((choice) => choice.id !== hidden)
    const a = ids(shuffleChoicesForPlayer(remaining, 'player-1', question.id))
    const b = ids(shuffleChoicesForPlayer(remaining, 'player-2', question.id))
    expect([...a].sort()).toEqual([...b].sort())
    expect(a).not.toContain(hidden)
    expect(b).not.toContain(hidden)
  })
})

describe('score seal copy', () => {
  it('states the effect on this question, never a bare percentage', () => {
    const copy = buildScoreSealCopy(1)
    expect(copy.primary).toBe('🔒 คะแนนข้อนี้เหลือ 50%')
    // Exactly one supporting line, and it quotes real points.
    expect(copy.detail).toBe('ตอบถูกข้อนี้ ได้สูงสุด 5 คะแนน จากปกติ 10 คะแนน')
    expect(Object.keys(copy)).toEqual(['primary', 'detail'])
  })

  it('scales to stacked seals without claiming “half”', () => {
    const copy = buildScoreSealCopy(2)
    expect(copy.primary).toBe('🔒 คะแนนข้อนี้เหลือ 25%')
    expect(copy.detail).toBe('ตอบถูกข้อนี้ ได้สูงสุด 2.5 คะแนน จากปกติ 10 คะแนน')
    expect(copy.detail).not.toContain('ครึ่งหนึ่ง')
  })

  it('is copy only — the multiplier itself is unchanged', () => {
    expect(computeHostileMultiplier(1)).toBe(0.5)
    expect(computeHostileMultiplier(2)).toBe(0.25)
  })
})
