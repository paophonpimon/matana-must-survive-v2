import { PRE_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { preTestWindow } from '../lib/gameFlow'
import { AssessmentPhase } from './AssessmentPhase'
import type { PreTestAnswerInput } from '../services/gameService'
import type { Player, Room } from '../types/game'

interface PreTestPhaseProps {
  player: Player
  room: Pick<Room, 'preTestStartedAt' | 'assessmentSecondsPerQuestion'>
  onAnswer: (input: PreTestAnswerInput) => Promise<void>
}

// "แบบทดสอบก่อนเรียน" (Pre-test). Everything about the gating, the shared budget and the answer
// flow lives in AssessmentPhase, so the pre-test and post-test are the same instrument taken twice
// — only the approved bank and the copy differ.
//
// preTestStartedAt is the gate: null means the teacher has not opened the test, and the student
// sees a waiting screen with no question to answer. It is persisted on the room, so a refresh or a
// reconnect resolves to the same state instead of slipping past the gate.
export const PreTestPhase = ({ player, room, onAnswer }: PreTestPhaseProps) => (
  <AssessmentPhase
    playerId={player.id}
    answers={player.preTestAnswers}
    bank={PRE_TEST_QUESTIONS}
    startedAt={room.preTestStartedAt}
    questionWindow={preTestWindow(room, player.preTestAnswers)}
    eyebrow="แบบทดสอบก่อนเรียน"
    waitingTitle="เตรียมทำแบบทดสอบก่อนเรียน"
    waitingHint="รอครูเริ่มแบบทดสอบก่อนเรียน"
    finishedTitle="ทำแบบทดสอบก่อนเรียนครบแล้ว"
    finishedHint="รอครูเริ่มกิจกรรมทบทวน"
    onAnswer={onAnswer}
  />
)
