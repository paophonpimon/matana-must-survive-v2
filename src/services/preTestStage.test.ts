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

  it('the pre-test CTA is always rendered and routed through the incomplete-students confirmation', async () => {
    const source = await readTeacherPage()
    expect(source).toContain('เริ่มทบทวนเรื่องราว')
    // CTA is wired to the confirming entry point, not straight to the transition.
    expect(source).toContain('onClick={requestStartRecall}')
    // It is never gated on everyone having finished — only on the busy flag and a valid duration.
    expect(source).toContain('disabled={advancingStageBusy || !recallDurationValid}')
    expect(source).not.toMatch(/disabled=\{[^}]*preTestCompletedCount[^}]*\}/)
    // Confirmation copy states the real consequence.
    expect(source).toContain('จะไม่ถูกนำไปเปรียบเทียบคะแนนก่อน–หลัง')
    // All three per-student statuses exist.
    for (const label of ['ยังไม่เริ่ม', 'กำลังทำ', 'เสร็จแล้ว']) expect(source).toContain(label)
  })
})
