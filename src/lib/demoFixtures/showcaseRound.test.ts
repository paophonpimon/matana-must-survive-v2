import { describe, expect, it } from 'vitest'
import { buildRoundHistoryEntry } from '../roundHistory'
import {
  computeEvidenceSummary,
  computeEvidenceSummaryFromHistory,
  formatAverage,
  formatCountWithPercent,
  formatPercent,
  formatSignedAverage,
} from '../evidenceSummary'
import {
  SHOWCASE_COMPLETED_AT,
  SHOWCASE_MODE_FIELD,
  SHOWCASE_QUESTION_IDS,
  SHOWCASE_ROOM_CODE,
  SHOWCASE_ROUND,
  SHOWCASE_STUDENT_COUNT,
  SHOWCASE_TEAMS,
  assertShowcaseRoster,
  buildShowcasePlayers,
  showcaseTeamIdFor,
  showcaseTeamNameFor,
} from './showcaseRound'
import { SYNTHETIC_ROSTER, type RosterStudent } from './syntheticRoster'

// The showcase round is SIMULATED presentation data. These tests drive it with a SYNTHETIC roster
// — no real student identity exists anywhere in this repository — and pin that every headline
// figure is DERIVED by the production aggregator from the generated student rows.

const summary = () => computeEvidenceSummary(buildShowcasePlayers(SYNTHETIC_ROSTER))

describe('synthetic roster', () => {
  it('is exactly 30 rows, studentNumber 1–30, with unique ids', () => {
    expect(SYNTHETIC_ROSTER).toHaveLength(SHOWCASE_STUDENT_COUNT)
    expect(SYNTHETIC_ROSTER.map((student) => student.studentNumber)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    )
    expect(new Set(SYNTHETIC_ROSTER.map((student) => student.studentId)).size).toBe(30)
  })

  it('carries obviously synthetic identities', () => {
    for (const student of SYNTHETIC_ROSTER) {
      expect(student.studentId).toMatch(/^SYN-\d{3}$/)
      expect(student.firstName).toContain('ทดสอบ')
    }
  })
})

describe('roster validation', () => {
  it('rejects a roster of the wrong size', () => {
    expect(() => assertShowcaseRoster(SYNTHETIC_ROSTER.slice(0, 29))).toThrow('exactly 30')
  })

  it('rejects gaps or duplicates in studentNumber', () => {
    const broken: RosterStudent[] = SYNTHETIC_ROSTER.map((student, index) =>
      (index === 5 ? { ...student, studentNumber: 7 } : student))
    expect(() => assertShowcaseRoster(broken)).toThrow('1–30')
  })

  it('rejects duplicate studentId values', () => {
    const broken: RosterStudent[] = SYNTHETIC_ROSTER.map((student, index) =>
      (index === 5 ? { ...student, studentId: SYNTHETIC_ROSTER[0].studentId } : student))
    expect(() => assertShowcaseRoster(broken)).toThrow('duplicate studentId')
  })
})

describe('showcase round shape', () => {
  it('builds one player per roster row, in studentNumber order', () => {
    const players = buildShowcasePlayers(SYNTHETIC_ROSTER)
    expect(players).toHaveLength(30)
    expect(players.map((player) => player.studentNumber)).toEqual(
      Array.from({ length: 30 }, (_, index) => String(index + 1)),
    )
  })

  it('distributes all 30 students across the 5 showcase teams, 6 each', () => {
    const players = buildShowcasePlayers(SYNTHETIC_ROSTER)
    for (const team of SHOWCASE_TEAMS) {
      expect(players.filter((player) => player.teamId === team.id)).toHaveLength(6)
    }
    expect(showcaseTeamIdFor(1)).toBe('team-1')
    expect(showcaseTeamIdFor(30)).toBe('team-5')
    expect(showcaseTeamNameFor('team-1')).toBe('ทีมกุหลาบทอง')
  })

  it('is a finished round: every student answered all 10 main questions and submitted', () => {
    const players = buildShowcasePlayers(SYNTHETIC_ROSTER)
    expect(SHOWCASE_QUESTION_IDS).toHaveLength(10)
    expect(new Set(SHOWCASE_QUESTION_IDS).size).toBe(10)
    for (const player of players) {
      expect(player.answers).toHaveLength(10)
      expect(player.submitted).toBe(true)
      expect(player.currentRound).toBe(SHOWCASE_ROUND)
    }
  })
})

describe('derived presentation aggregates', () => {
  it('pre/post pairing, averages and difference derive to the agreed figures', () => {
    const evidence = summary()
    expect(evidence.totalStudents).toBe(30)
    expect(evidence.prePost.comparedCount).toBe(30)
    expect(formatAverage(evidence.prePost.preAverage, 2)).toBe('5.43')
    expect(formatAverage(evidence.prePost.postAverage, 2)).toBe('8.33')
    expect(formatSignedAverage(evidence.prePost.averageDifference, 2)).toBe('+2.90')
  })

  it('improved 26 / unchanged 3 / declined 1, over the paired-complete denominator', () => {
    const evidence = summary()
    expect(evidence.prePost.improvedCount).toBe(26)
    expect(evidence.prePost.unchangedCount).toBe(3)
    expect(evidence.prePost.declinedCount).toBe(1)
    expect(formatPercent(evidence.prePost.improvedPercent)).toBe('86.7%')
    // The shared formatter prints an exact whole without a decimal, the same rule that renders
    // 100% rather than 100.0%.
    expect(formatPercent(evidence.prePost.unchangedPercent)).toBe('10%')
    expect(formatPercent(evidence.prePost.declinedPercent)).toBe('3.3%')
    expect(evidence.prePost.improvedCount + evidence.prePost.unchangedCount + evidence.prePost.declinedCount)
      .toBe(evidence.prePost.comparedCount)
  })

  it('main, recall and survey derive to the agreed figures', () => {
    const evidence = summary()
    expect(formatCountWithPercent(evidence.main.completedCount, evidence.totalStudents)).toBe('30/30 คน · 100%')
    expect(formatAverage(evidence.main.averageScore, 2)).toBe('8.17')
    expect(formatAverage(evidence.recall.averageCorrect, 2)).toBe('4.13')
    expect(formatAverage(evidence.survey.overallAverage, 2)).toBe('4.63')
  })

  it('aggregate counts reconcile against the 30 individual rows', () => {
    const evidence = summary()
    const improved = evidence.students.filter((s) => s.difference !== null && (s.difference as number) > 0)
    const same = evidence.students.filter((s) => s.difference === 0)
    const declined = evidence.students.filter((s) => s.difference !== null && (s.difference as number) < 0)
    expect(improved).toHaveLength(26)
    expect(same).toHaveLength(3)
    expect(declined).toHaveLength(1)
    expect(evidence.students.filter((s) => s.mainCompleted)).toHaveLength(evidence.main.completedCount)
    expect(evidence.students.filter((s) => s.surveyCompleted)).toHaveLength(evidence.survey.completedCount)
  })

  it('no Boss, team competition or item score enters the Main /10 evidence', () => {
    const players = buildShowcasePlayers(SYNTHETIC_ROSTER)
    expect(players.every((player) => player.bossAnswers.length === 0)).toBe(true)
    const evidence = summary()
    expect(evidence.main.totalCount).toBe(10)
    const expected = players.reduce((total, player) => total + player.score, 0) / players.length
    expect(evidence.main.averageScore).toBeCloseTo(expected, 10)
    expect(players.every((player) => player.score <= 10)).toBe(true)
  })

  it('is roster-independent: the same figures come out for any valid 30-row roster', () => {
    const alternative: RosterStudent[] = SYNTHETIC_ROSTER.map((student) => ({
      ...student,
      studentId: `ALT-${String(student.studentNumber).padStart(3, '0')}`,
      firstName: `อื่นๆ${student.studentNumber}`,
    }))
    const other = computeEvidenceSummary(buildShowcasePlayers(alternative))
    const base = summary()
    expect(formatAverage(other.prePost.preAverage, 2)).toBe(formatAverage(base.prePost.preAverage, 2))
    expect(other.prePost.improvedCount).toBe(base.prePost.improvedCount)
    expect(formatAverage(other.main.averageScore, 2)).toBe(formatAverage(base.main.averageScore, 2))
  })
})

describe('the seeded round survives the durable history path identically', () => {
  it('roundHistory snapshots derive the same aggregates as the live players', () => {
    const players = buildShowcasePlayers(SYNTHETIC_ROSTER)
    const history = players.map((player) =>
      buildRoundHistoryEntry(
        player,
        SHOWCASE_ROUND,
        player.teamId ? showcaseTeamNameFor(player.teamId) : '',
        SHOWCASE_COMPLETED_AT,
      ))
    const stored = computeEvidenceSummaryFromHistory(history)
    const live = summary()
    expect(stored.totalStudents).toBe(live.totalStudents)
    expect(stored.prePost.comparedCount).toBe(live.prePost.comparedCount)
    expect(stored.prePost.improvedCount).toBe(live.prePost.improvedCount)
    expect(stored.prePost.unchangedCount).toBe(live.prePost.unchangedCount)
    expect(stored.prePost.declinedCount).toBe(live.prePost.declinedCount)
    expect(formatAverage(stored.prePost.preAverage, 2)).toBe('5.43')
    expect(formatAverage(stored.prePost.postAverage, 2)).toBe('8.33')
    expect(formatAverage(stored.main.averageScore, 2)).toBe('8.17')
    expect(formatAverage(stored.recall.averageCorrect, 2)).toBe('4.13')
    expect(formatAverage(stored.survey.overallAverage, 2)).toBe('4.63')
  })
})

describe('seed safety', () => {
  const seedSource = async (): Promise<string> =>
    import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../scripts/seed-showcase-m51.ts', import.meta.url), 'utf8'))

  it('reads the roster from an external CSV and never from a committed fixture', async () => {
    const source = await seedSource()
    expect(source).toContain("flag('roster')")
    expect(source).toContain('readRosterCsv')
    expect(source).toContain('Missing --roster=')
    // It must NOT import a roster constant from the repo.
    expect(source).not.toContain('M51_ROSTER')
    expect(source).not.toContain('SYNTHETIC_ROSTER')
  })

  it('refuses to overwrite a room that is not marked as the showcase', async () => {
    const source = await seedSource()
    expect(source).toContain('data[SHOWCASE_MODE_FIELD] !== true')
    expect(source).toContain('Refusing to overwrite what may be a real classroom room')
  })

  it('never enumerates, wipes or deletes any collection', async () => {
    const source = await seedSource()
    for (const forbidden of ['.delete(', 'listCollections(', 'recursiveDelete', 'bulkWriter']) {
      expect(source).not.toContain(forbidden)
    }
    expect(source).toContain("db.collection('rooms').doc(SHOWCASE_ROOM_CODE)")
  })

  it('requires an explicit teacher uid and never hard-codes one', async () => {
    const source = await seedSource()
    expect(source).toContain("flag('teacherUid')")
    expect(source).toContain('Missing --teacherUid=<UID>')
    expect(source).not.toMatch(/teacherUid\s*=\s*['"][A-Za-z0-9]{16,}['"]/)
  })

  it('marks the room as showcase data', () => {
    expect(SHOWCASE_MODE_FIELD).toBe('showcaseMode')
    expect(SHOWCASE_ROOM_CODE).toMatch(/^\d{4}$/)
  })
})

describe('fixtures stay out of the deployed bundle', () => {
  it('is imported by no production module', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const { join, relative } = await import('node:path')
    const srcRoot = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true })
      const nested = await Promise.all(entries.map(async (entry) => {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) return walk(full)
        return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
      }))
      return nested.flat()
    }

    const offenders: string[] = []
    for (const file of await walk(srcRoot)) {
      if (file.includes('.test.')) continue
      if (file.includes('demoFixtures')) continue
      const contents = await readFile(file, 'utf8')
      if (contents.includes('showcaseRound') || contents.includes('syntheticRoster') || contents.includes('demoFixtures')) {
        offenders.push(relative(srcRoot, file))
      }
    }
    expect(offenders).toEqual([])
  })
})
