import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ASSESSMENT_QUESTION_COUNT, PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import type { Player, Room } from '../types/game'
import { DemoGameService } from './demoService'

// The teacher's pre-test stage must always be able to move the class on. Two halves:
//  - the service really does allow preTest -> recall with students unfinished (no gate to remove)
//  - the teacher screen really does render its CTA during preTest (the layout guard that hid it)

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

const readTeacherPage = async (): Promise<string> =>
  import('node:fs/promises').then((fs) => fs.readFile(new URL('../pages/TeacherPage.tsx', import.meta.url), 'utf8'))

describe('Teacher pre-test stage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('one unfinished student never blocks the class from moving to Recall', async () => {
    const service = new DemoGameService()
    const created = await service.createRoom('teacher-1')
    const code = created.roomCode
    const done = (await service.joinRoom({ roomCode: code, displayName: 'Alpha', studentNumber: '01' }, 'uid-1')).player
    const partial = (await service.joinRoom({ roomCode: code, displayName: 'Beta', studentNumber: '02' }, 'uid-2')).player
    const notStarted = (await service.joinRoom({ roomCode: code, displayName: 'Gamma', studentNumber: '03' }, 'uid-3')).player

    const liveRoom: { value: Room | null } = { value: null }
    const players: { value: Player[] } = { value: [] }
    const stopRoom = service.subscribeRoom(code, (value) => { liveRoom.value = value })
    const stopPlayers = service.subscribePlayers(code, (value) => { players.value = value })

    // Team setup now runs BEFORE the pre-test — startPreTest is gated on phase === 'teamSetup'
    // plus full team readiness, so it must be complete here first.
    await service.startTeamSetup(code, 'teacher-1')
    await service.randomizeTeams(code, 'teacher-1', 1)
    await service.lockTeams(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.teamsLocked).toBe(true))
    const teamId = (liveRoom.value as Room).teams[0].id
    await service.finalizeCaptainElection(code, 'teacher-1', teamId)
    const magic: { value: Array<{ teamId: string; magicHolderPlayerId: string | null }> } = { value: [] }
    const stopMagic = service.subscribeAllTeamMagic(code, (value) => { magic.value = value })
    await vi.waitFor(() => expect(magic.value[0]?.magicHolderPlayerId).toBeTruthy())
    const captainId = magic.value[0].magicHolderPlayerId as string
    await service.setTeamGuardianName(code, teamId, captainId, 'ทีมกุหลาบ')
    await service.chooseStartingItem(code, teamId, captainId, 'power_surge')
    stopMagic()

    await service.startPreTest(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('preTest'))

    for (let index = 0; index < ASSESSMENT_QUESTION_COUNT; index += 1) {
      await service.savePreTestAnswer(code, done.id, {
        questionId: PRE_TEST_QUESTIONS[index].id,
        selectedChoiceId: PRE_TEST_QUESTIONS[index].correctChoiceId,
        expectedIndex: index,
      })
    }
    for (let index = 0; index < 3; index += 1) {
      await service.savePreTestAnswer(code, partial.id, {
        questionId: PRE_TEST_QUESTIONS[index].id,
        selectedChoiceId: PRE_TEST_QUESTIONS[index].correctChoiceId,
        expectedIndex: index,
      })
    }
    // Gamma never answers anything -> "ยังไม่เริ่ม".

    await vi.waitFor(() => {
      expect(players.value).toHaveLength(3)
      const byId = new Map(players.value.map((player) => [player.id, player]))
      expect(byId.get(done.id)?.preTestAnswers).toHaveLength(ASSESSMENT_QUESTION_COUNT)
      expect(byId.get(partial.id)?.preTestAnswers).toHaveLength(3)
      expect(byId.get(notStarted.id)?.preTestAnswers).toHaveLength(0)
    })
    // 2 of 3 incomplete — exactly the count the confirmation reports.
    const incomplete = players.value.filter((player) => player.preTestAnswers.length < ASSESSMENT_QUESTION_COUNT)
    expect(incomplete).toHaveLength(2)

    // The teacher proceeds anyway. This must succeed, not throw.
    await service.startRecall(code, 'teacher-1')
    await vi.waitFor(() => expect(liveRoom.value?.phase).toBe('recall'))

    // And nothing was discarded on the way through.
    await vi.waitFor(() => {
      const after = new Map(players.value.map((player) => [player.id, player]))
      expect(after.get(done.id)?.preTestAnswers).toHaveLength(ASSESSMENT_QUESTION_COUNT)
      expect(after.get(partial.id)?.preTestAnswers).toHaveLength(3)
    })

    stopPlayers()
    stopRoom()
  })

  it('no dedicated stage screen is rendered alongside the full dashboard', async () => {
    const source = await readTeacherPage()
    // The guard that hides the dashboard body during the dedicated single-viewport stages must
    // list every such stage; omitting one is what pushed that stage's CTA below the fold.
    expect(source).toContain(
      '!isLobbyPhase && !isPreTestPhase && !isRecallPhase && !isPostTestPhase && !isSurveyPhase ?',
    )
  })

  it('both timing controls are per-question seconds, driven by the shared 1-second stepper', async () => {
    const page = await readTeacherPage()
    // Both settings are PER QUESTION and in seconds — no total-duration wording, no unit mixing.
    expect(page).toContain('เวลาต่อข้อ (ก่อนเรียน/หลังเรียน)')
    expect(page).toContain('เวลาต่อข้อ (ทบทวนเรื่องราว)')
    expect(page).toContain('ใช้ค่าเดียวกันทั้งแบบทดสอบก่อนเรียนและหลังเรียน')
    // No total-duration wording survives for the assessment setting.
    expect(page).not.toContain('เวลาแบบทดสอบ')
    expect(page).not.toContain('รวมทั้งชุด')
    // Both per-question helpers state seconds-per-question. A "not นาที" check is impossible in
    // Thai — วินาที contains นาที as a substring — so this asserts the positive unit instead, and
    // that no helper offers minutes as a standalone word.
    const helpers = page.match(/helper=\{`[^`]*`\}/g) ?? []
    expect(helpers).toHaveLength(2)
    for (const helper of helpers) {
      expect(helper).toContain('วินาทีต่อข้อ')
      expect(helper).not.toMatch(/[\s(]นาที/)
    }
    // Both go through the one reusable stepper rather than bespoke number fields.
    const steppers = page.match(/<SettingStepper/g) ?? []
    expect(steppers).toHaveLength(2)
  })

  it('the one shared stepper moves by exactly one step and clamps to its range', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../components/NumberStepper.tsx', import.meta.url), 'utf8'))
    // Default step is 1, and the timing settings never override it.
    expect(source).toContain('step = 1')
    expect(source).toContain('onClick={() => adjust(-step)}')
    expect(source).toContain('onClick={() => adjust(step)}')
    expect(source).toContain('Math.max(min, Math.min(max, next))')
    const page = await readTeacherPage()
    // No +/-5 stepping survives on any numeric setting.
    expect(page).not.toContain('delta * 5')
    expect(page).not.toContain('step={5}')
    // Every numeric setting renders through the one component — no bare .setup-stepper markup.
    expect(page).not.toContain('className="setup-stepper"')
  })
  it('the pre-test CTA is always rendered and routed through the incomplete-students confirmation', async () => {
    const page = await readTeacherPage()
    // The pre-test stage now renders through the shared TeacherAssessmentStage, so the wiring
    // lives on the usage site and the button behaviour lives in the component.
    expect(page).toContain('onContinue={requestStartRecall}')
    expect(page).toContain('continueLabel="เริ่มทบทวนเรื่องราว"')
    // Confirmation copy still states the real consequence.
    expect(page).toContain('จะไม่ถูกนำไปเปรียบเทียบคะแนนก่อน–หลัง')
    // The Recall per-item control must NOT appear on an assessment screen.
    const stage = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../components/TeacherAssessmentStage.tsx', import.meta.url), 'utf8'))
    expect(stage).not.toContain('recall-duration')
    // The continue button is never gated on everyone having finished — only on the busy flag.
    expect(stage).toContain('onClick={onContinue} disabled={busy}')
    // All four per-student statuses exist, in the shared pure helper.
    const clock = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../lib/assessmentClock.ts', import.meta.url), 'utf8'))
    for (const label of ['ยังไม่เริ่ม', 'กำลังทำ', 'เสร็จแล้ว', 'หมดเวลา']) expect(clock).toContain(label)
  })
})
