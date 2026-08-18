import { describe, expect, it } from 'vitest'
import { GAME_PHASES } from '../types/game'

// Regression guard for the real-Firebase bug where `startPreTest` wrote phase 'preTest'
// successfully, but firebaseService's read-side allow-list had never been extended past the
// pre-assessment phases — so every client mapped 'preTest' back to 'lobby' and the whole class
// appeared frozen in the lobby. The allow-list is now derived from GAME_PHASES; this pins that it
// really does cover every phase the app can write.
describe('room phase mapping', () => {
  it('GAME_PHASES covers every phase the flow can write, in order', () => {
    expect([...GAME_PHASES]).toEqual([
      'lobby', 'preTest', 'recall', 'teamSetup', 'main', 'boss', 'postTest', 'survey',
    ])
  })

  it('firebaseService validates phases against GAME_PHASES, not a hand-maintained literal', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./firebaseService.ts', import.meta.url), 'utf8'))
    // A literal array of phase strings here is exactly what went stale before.
    expect(source).toContain('(GAME_PHASES as readonly string[]).includes(phase)')
    expect(source).not.toMatch(/\['lobby',\s*'recall'/)
  })
})
