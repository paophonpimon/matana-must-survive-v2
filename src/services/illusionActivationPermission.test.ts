import { describe, expect, it } from 'vitest'

// Regression guard for the real-Firebase bug where a captain could never activate Illusion.
//
// The PASS 1 fairness check ("no teammate may have answered the current question") was implemented
// as getDocs(collection(rooms/{code}/players)) — a LIST. But players/{playerId} is deliberately
// `allow list: if isTeacher(roomCode)`: a student may read their OWN player doc and may never
// enumerate the roster. So the check itself was permission-denied for the very captain it gated,
// and the failure surfaced as the generic connection/session error. Power Surge and Score Seal
// were unaffected — only the Illusion branch performed that read.
//
// The fix reads answerProgress instead: broadly readable by design (`allow read: if signedIn()`),
// carrying only playerId/teamId/questionId/currentRound/answeredAt — never a choice, never
// correctness — and already the source of the "teammates answered X/Y" display.

const readFile = async (relative: string): Promise<string> =>
  import('node:fs/promises').then((fs) => fs.readFile(new URL(relative, import.meta.url), 'utf8'))

// The body of one `async name(` method, up to the next method at the same indent.
const methodBody = (source: string, name: string): string => {
  const start = source.indexOf(`  async ${name}(`)
  if (start < 0) throw new Error(`method not found: ${name}`)
  const rest = source.slice(start + 1)
  const next = rest.search(/\n {2}async [a-zA-Z]+\(/)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('Illusion activation must not require roster LIST permission', () => {
  it('activateItem never lists the players collection', async () => {
    const source = await readFile('./firebaseService.ts')
    const body = methodBody(source, 'activateItem')
    // The exact read that was permission-denied for a student captain.
    expect(body).not.toMatch(/getDocs\(\s*collection\(db,\s*'rooms',\s*roomCode,\s*'players'\s*\)/)
    // ...and no other shape of players-collection enumeration either.
    expect(body).not.toMatch(/collection\(db,\s*'rooms',\s*roomCode,\s*'players'\s*\)/)
  })

  it('activateItem derives Illusion fairness from answerProgress, scoped to the caller’s own team', async () => {
    const source = await readFile('./firebaseService.ts')
    const body = methodBody(source, 'activateItem')
    expect(body).toContain("collection(db, 'rooms', roomCode, 'answerProgress')")
    // Narrowed to this team — never a whole-room read.
    expect(body).toContain("where('teamId', '==', teamId)")
    // answerProgress survives round transitions, so questionId alone is not enough.
    expect(body).toContain('entry.currentRound === room.currentRound')
    expect(body).toContain('entry.questionId === currentQuestionId')
  })

  it('the rules still keep the roster un-enumerable by students, and answerProgress readable', async () => {
    const rules = await readFile('../../firestore.rules')
    // The constraint that made the old implementation impossible — unchanged by this fix.
    expect(rules).toContain('allow list: if isTeacher(roomCode);')
    // The collection the fix relies on stays broadly readable.
    expect(rules).toMatch(/match \/answerProgress\/\{playerId\} \{\s*\n\s*allow read: if signedIn\(\);/)
  })

  it('Power Surge and Score Seal never depended on the roster read', async () => {
    const source = await readFile('./firebaseService.ts')
    const body = methodBody(source, 'activateItem')
    // The fairness pre-check is Illusion-only, so the other two activatable items were never
    // affected by the permission failure — this pins that scoping.
    const guard = body.indexOf("if (itemType === 'illusion')")
    expect(guard).toBeGreaterThan(-1)
    const preCheck = body.slice(guard, body.indexOf('await runTransaction'))
    expect(preCheck).toContain('answerProgress')
    expect(preCheck).not.toContain('power_surge')
    expect(preCheck).not.toContain('score_seal')
  })
})
