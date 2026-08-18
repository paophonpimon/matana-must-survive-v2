import { describe, expect, it } from 'vitest'
import { resolveStudentRoute } from './game'
import type { Player, Room } from '../types/game'

// Regression for the real-Firebase bug where a student who had already reached /result at Main
// completion stayed there through the whole post-test and survey. The room reaches phase
// 'postTest'/'survey' with status still 'playing' and every player flagged submitted, so any
// routing rule shaped like "playing && !submitted -> /game" strands them. These cases pin the
// realtime lifecycle a student actually goes through, from a Main-completed starting point.

const CODE = 'ROSE01'

const roomAt = (phase: Room['phase'], status: Room['status']): Room => ({
  roomCode: CODE,
  status,
  currentRound: 1,
  createdAt: 0,
  startedAt: 0,
  completedAt: null,
  currentQuestionIndex: 10,
  questionDurationSeconds: 30,
  questionStartedAt: null,
  questionClosedAt: null,
  questionIds: [],
  previousQuestionIds: [],
  winner: null,
  teacherSessionId: 'teacher-1',
  teamCount: 1,
  teamsLocked: true,
  teams: [{ id: 'team-1', name: 'ทีม 1' }],
  phase,
  recallQuestionDurationSeconds: 15,
  recallQuestionIndex: 5,
  recallQuestionStartedAt: null,
  bossQuestionIds: [],
  bossQuestionIndex: 3,
  bossQuestionStartedAt: null,
  bossQuestionDurationSeconds: 10,
  bossCompleted: true,
  bossWinner: null,
  bossAwaitingContinue: false,
})

// A student who has finished all 10 Main questions: submitted === true, score final. This is the
// exact state that used to pin them to /result.
const submittedPlayer: Player = {
  id: 'player-1',
  displayName: 'Alpha',
  studentNumber: '01',
  teamId: 'team-1',
  joinedAt: 0,
  currentRound: 1,
  currentQuestionIndex: 10,
  score: 3,
  answers: [],
  bossAnswers: [],
  recallAnswers: [],
  preTestAnswers: [],
  postTestAnswers: [],
  surveyResponses: [],
  submitted: true,
  finishedAt: 0,
  elapsedMs: 0,
  status: 'submitted',
  ownerUid: 'uid-1',
}

describe('student route lifecycle after Main completion', () => {
  it('sends a submitted student back to the game for the post-test', () => {
    expect(resolveStudentRoute(roomAt('postTest', 'playing'), submittedPlayer)).toBe(`/game/${CODE}`)
  })

  it('sends a submitted student back to the game for the survey', () => {
    expect(resolveStudentRoute(roomAt('survey', 'playing'), submittedPlayer)).toBe(`/game/${CODE}`)
  })

  it('only releases the student to the result screen once the round is completed', () => {
    expect(resolveStudentRoute(roomAt('survey', 'completed'), submittedPlayer)).toBe(`/result/${CODE}`)
  })

  it('walks the whole realtime sequence a Main-completed student experiences', () => {
    // What each successive realtime room snapshot must resolve to, in order. The student is
    // already submitted at every step — that never again means "you are done".
    const lifecycle: Array<[Room['phase'], Room['status'], string]> = [
      ['main', 'playing', `/result/${CODE}`],   // Main over, waiting for the teacher
      ['postTest', 'playing', `/game/${CODE}`], // pulled back in for the post-test
      ['survey', 'playing', `/game/${CODE}`],   // and again for the survey
      ['survey', 'completed', `/result/${CODE}`], // released only now
    ]
    expect(lifecycle.map(([phase, status]) => resolveStudentRoute(roomAt(phase, status), submittedPlayer)))
      .toEqual(lifecycle.map(([, , expected]) => expected))
  })

  it('terminal states still outrank the assessment phases', () => {
    expect(resolveStudentRoute(roomAt('postTest', 'closed'), submittedPlayer)).toBe(`/closed/${CODE}`)
    const won: Room = {
      ...roomAt('survey', 'playing'),
      winner: {
        teamId: 'team-1', teamName: 'ทีม 1', guardianName: 'ทีม 1',
        score: 10, finishedAt: 0, elapsedMs: 1, round: 1,
      },
    }
    expect(resolveStudentRoute(won, submittedPlayer)).toBe(`/congratulations/${CODE}`)
  })

  it('ResultPage defers to resolveStudentRoute instead of its own branch list', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../pages/ResultPage.tsx', import.meta.url), 'utf8'))
    expect(source).toContain('resolveStudentRoute(room, player)')
    // The old rule that stranded students: it must not come back.
    expect(source).not.toContain("room.status === 'playing' && !player.submitted")
  })
})
