// Per-student answer-choice ordering, to reduce copying between neighbouring screens.
//
// The order is DERIVED, never stored: it is a pure function of (playerId, questionId), so the same
// student sees the same order for the same question on every render, after a refresh, after a
// reconnect and on a different device — with nothing to persist, migrate or keep in sync. That
// also makes "never reshuffle once an answer is selected" true by construction rather than by
// guarding: there is no moment at which the order could change.
//
// Nothing about correctness rides on position. Every record already stores selectedChoiceId, and
// every evaluation compares ids, so two students with different orders produce identical, directly
// comparable data. The ก/ข/ค/ง letters are painted from the render index and are therefore a
// per-student label only — never persisted, never exported, never compared across students.

// FNV-1a. Small, dependency-free, and stable across runtimes — important, because the order has to
// match between a student's phone and the same student's tablet.
const hashString = (value: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// mulberry32 — a small deterministic PRNG. Seeded per (student, question) so orders differ between
// students but are fixed for each one.
const createRandom = (seed: number): (() => number) => {
  let state = seed || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export const choiceOrderSeed = (playerId: string, questionId: string): number =>
  hashString(`${playerId}::${questionId}`)

// Fisher-Yates over a copy. The input array is never mutated — callers pass the question bank's own
// choices array, which must stay in its authored order for everything else that reads it.
export const shuffleChoicesForPlayer = <T extends { id: string }>(
  choices: readonly T[],
  playerId: string,
  questionId: string,
): T[] => {
  const result = [...choices]
  // An empty player id (preview screens, or a render before the session resolves) must not produce
  // a random-looking order that then changes once the id arrives — keep the authored order.
  if (!playerId || !questionId) return result
  const random = createRandom(choiceOrderSeed(playerId, questionId))
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}
