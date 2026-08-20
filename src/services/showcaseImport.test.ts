import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { computeEvidenceSummaryFromHistory, formatAverage, formatCountWithPercent, formatPercent, formatSignedAverage } from '../lib/evidenceSummary'
import { parseRosterCsv } from '../lib/rosterCsv'
import { historyToDerivedPlayers, teamsFromHistory } from '../lib/roomHistory'
import { computeTeamCompetitionStats } from '../lib/magic'
import { computeClassRecallSummary } from '../lib/learning'
import { SHOWCASE_MODE_FIELD, SHOWCASE_ROOM_CODE, type RosterStudent } from '../lib/showcaseRound'
import { SYNTHETIC_ROSTER } from '../lib/demoFixtures/syntheticRoster'
import { DemoGameService } from './demoService'
import type { Player, RoundHistoryEntry } from '../types/game'

// The hosted showcase must be importable from the CURRENT authenticated teacher session — no
// admin credentials, no service account, and no forged player documents. These tests drive the
// real service implementation with a SYNTHETIC roster.

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

const readHistory = async (service: DemoGameService, roomCode: string): Promise<RoundHistoryEntry[]> =>
  new Promise((resolve) => {
    const stop = service.subscribeRoundHistory(roomCode, (entries) => {
      if (entries.length > 0) { stop(); resolve(entries) }
    })
  })

describe('teacher-session showcase import', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('takes ownership from the calling teacher session automatically', async () => {
    const service = new DemoGameService()
    const teacherUid = 'teacher-session-uid-1'
    await service.importShowcaseRound(SHOWCASE_ROOM_CODE, teacherUid, SYNTHETIC_ROSTER)

    const room = await new Promise<{ teacherSessionId: string; status: string } | null>((resolve) => {
      const stop = service.subscribeRoom(SHOWCASE_ROOM_CODE, (value) => {
        if (value) { stop(); resolve(value as unknown as { teacherSessionId: string; status: string }) }
      })
    })
    expect(room?.teacherSessionId).toBe(teacherUid)
    expect(room?.status).toBe('completed')
    expect((room as unknown as Record<string, unknown>)[SHOWCASE_MODE_FIELD]).toBe(true)
  })

  it('creates NO player documents — the round renders from roundHistory alone', async () => {
    const service = new DemoGameService()
    await service.importShowcaseRound(SHOWCASE_ROOM_CODE, 'teacher-uid', SYNTHETIC_ROSTER)

    const players = await new Promise<Player[]>((resolve) => {
      const stop = service.subscribePlayers(SHOWCASE_ROOM_CODE, (value) => { stop(); resolve(value) })
    })
    expect(players).toEqual([])

    const history = await readHistory(service, SHOWCASE_ROOM_CODE)
    expect(history).toHaveLength(30)
  })

  it('refuses to overwrite a room that is not marked as a showcase', async () => {
    const service = new DemoGameService()
    // A real classroom room created the normal way.
    const real = await service.createRoom('other-teacher')
    await expect(service.importShowcaseRound(real.roomCode, 'teacher-uid', SYNTHETIC_ROSTER))
      .rejects.toThrow('ไม่ใช่ห้องสาธิต')

    // ...and it is left exactly as it was.
    const untouched = await new Promise<{ status: string; teacherSessionId: string } | null>((resolve) => {
      const stop = service.subscribeRoom(real.roomCode, (value) => {
        if (value) { stop(); resolve(value as unknown as { status: string; teacherSessionId: string }) }
      })
    })
    expect(untouched?.status).toBe('waiting')
    expect(untouched?.teacherSessionId).toBe('other-teacher')
  })

  it('is idempotent: re-importing replaces only the showcase room', async () => {
    const service = new DemoGameService()
    await service.importShowcaseRound(SHOWCASE_ROOM_CODE, 'teacher-uid', SYNTHETIC_ROSTER)
    await service.importShowcaseRound(SHOWCASE_ROOM_CODE, 'teacher-uid', SYNTHETIC_ROSTER)
    const history = await readHistory(service, SHOWCASE_ROOM_CODE)
    expect(history).toHaveLength(30)
  })

  it('rejects a roster that is not exactly 30 students numbered 1–30', async () => {
    const service = new DemoGameService()
    await expect(service.importShowcaseRound(SHOWCASE_ROOM_CODE, 'teacher-uid', SYNTHETIC_ROSTER.slice(0, 29)))
      .rejects.toThrow('exactly 30')
  })
})

describe('roster CSV parsing (external file, never stored)', () => {
  const csv = [
    'studentId,firstName,lastName,className,studentNumber',
    ...Array.from({ length: 30 }, (_, index) =>
      `T${String(index + 1).padStart(3, '0')},ชื่อ${index + 1},สกุล${index + 1},ม.5/1,${index + 1}`),
    'T999,นอกห้อง,ทดสอบ,ม.5/2,1',
  ].join('\n')

  it('filters to the requested class and sorts by studentNumber', () => {
    const roster = parseRosterCsv(csv, 'ม.5/1')
    expect(roster).toHaveLength(30)
    expect(roster.map((student) => student.studentNumber)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    )
    expect(roster.every((student) => student.className === 'ม.5/1')).toBe(true)
  })

  it('tolerates a UTF-8 BOM and rejects a class with no rows', () => {
    // Built from its code point — a literal BOM in source is invisible and trips lint.
    const bom = String.fromCharCode(0xFEFF)
    expect(parseRosterCsv(`${bom}${csv}`, 'ม.5/1')).toHaveLength(30)
    expect(() => parseRosterCsv(csv, 'ม.6/9')).toThrow('ไม่พบนักเรียน')
  })

  it('rejects a file missing a required identity column', () => {
    expect(() => parseRosterCsv('firstName,lastName\nA,B', 'ม.5/1')).toThrow('studentId')
  })
})

describe('imported showcase renders the Result command centre from history alone', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const importedHistory = async (): Promise<RoundHistoryEntry[]> => {
    const service = new DemoGameService()
    await service.importShowcaseRound(SHOWCASE_ROOM_CODE, 'teacher-uid', SYNTHETIC_ROSTER)
    return readHistory(service, SHOWCASE_ROOM_CODE)
  }

  it('derives the agreed presentation aggregates through the shared aggregator', async () => {
    const evidence = computeEvidenceSummaryFromHistory(await importedHistory())
    expect(evidence.totalStudents).toBe(30)
    expect(evidence.prePost.comparedCount).toBe(30)
    expect(formatAverage(evidence.prePost.preAverage, 2)).toBe('5.43')
    expect(formatAverage(evidence.prePost.postAverage, 2)).toBe('8.33')
    expect(formatSignedAverage(evidence.prePost.averageDifference, 2)).toBe('+2.90')
    expect(evidence.prePost.improvedCount).toBe(26)
    expect(evidence.prePost.unchangedCount).toBe(3)
    expect(evidence.prePost.declinedCount).toBe(1)
    expect(formatPercent(evidence.prePost.improvedPercent)).toBe('86.7%')
    expect(formatPercent(evidence.prePost.unchangedPercent)).toBe('10%')
    expect(formatPercent(evidence.prePost.declinedPercent)).toBe('3.3%')
    expect(formatCountWithPercent(evidence.main.completedCount, evidence.totalStudents)).toBe('30/30 คน · 100%')
    expect(formatAverage(evidence.main.averageScore, 2)).toBe('8.17')
    expect(formatAverage(evidence.recall.averageCorrect, 2)).toBe('4.13')
    expect(formatAverage(evidence.survey.overallAverage, 2)).toBe('4.63')
  })

  it('reconstructs teams and recall for the command centre without any player document', async () => {
    const history = await importedHistory()
    const derived = historyToDerivedPlayers(history)
    const teams = teamsFromHistory(history)
    expect(derived).toHaveLength(30)
    expect(teams).toHaveLength(5)

    const competition = computeTeamCompetitionStats(derived as unknown as Player[], teams, [], [], 1)
    expect(competition).toHaveLength(5)
    expect(competition.every((team) => team.memberCount === 6)).toBe(true)

    const recall = computeClassRecallSummary(derived as unknown as Player[])
    expect(recall.totalCount).toBe(5)
    expect(recall.concepts.length).toBeGreaterThan(0)
  })

  it('individual rows reconcile with the aggregate counts', async () => {
    const evidence = computeEvidenceSummaryFromHistory(await importedHistory())
    const improved = evidence.students.filter((s) => s.difference !== null && (s.difference as number) > 0)
    const same = evidence.students.filter((s) => s.difference === 0)
    const declined = evidence.students.filter((s) => s.difference !== null && (s.difference as number) < 0)
    expect(improved).toHaveLength(evidence.prePost.improvedCount)
    expect(same).toHaveLength(evidence.prePost.unchangedCount)
    expect(declined).toHaveLength(evidence.prePost.declinedCount)
    expect(evidence.students).toHaveLength(30)
  })

  it('carries the roster identities it was given, and nothing else', async () => {
    const history = await importedHistory()
    const names = history.map((entry) => entry.displayName).sort()
    const expected: RosterStudent[] = SYNTHETIC_ROSTER
    expect(names).toEqual(expected.map((s) => `${s.firstName} ${s.lastName}`).sort())
  })
})

describe('historical Result view is read-only', () => {
  const componentSource = async (): Promise<string> =>
    import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../components/TeacherResultCommandCenter.tsx', import.meta.url), 'utf8'))

  it('renders no prepare-next-round or end-room control in historical mode', async () => {
    const source = await componentSource()
    // Both live controls sit inside the non-historical branch.
    const roombar = source.slice(source.indexOf('rcc-roombar'))
    const historicalBranch = roombar.slice(roombar.indexOf('{historical ? ('), roombar.indexOf(') : ('))
    expect(historicalBranch).toContain('กลับไปประวัติห้อง')
    expect(historicalBranch).not.toContain('เตรียมภารกิจรอบใหม่')
    expect(historicalBranch).not.toContain('ยุติห้อง')
  })

  it('keeps Print/PDF and Excel available, sourced from the same evidence', async () => {
    const source = await componentSource()
    expect(source).toContain('onClick={onPrint}')
    expect(source).toContain('onClick={onExportExcel}')
  })
})
