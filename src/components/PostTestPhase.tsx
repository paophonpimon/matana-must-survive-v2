import { POST_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { postTestWindow } from '../lib/gameFlow'
import { AssessmentPhase } from './AssessmentPhase'
import type { PostTestAnswerInput } from '../services/gameService'
import type { Player, Room } from '../types/game'

interface PostTestPhaseProps {
  player: Player
  room: Pick<Room, 'postTestStartedAt' | 'assessmentSecondsPerQuestion'>
  onAnswer: (input: PostTestAnswerInput) => Promise<void>
}

// "แบบทดสอบหลังเรียน" (Post-test). Same instrument as the pre-test, taken after play — see
// AssessmentPhase for the shared gating, budget and answer flow.
//
// This runs after Main has finished, so player.submitted is already true and the Main score is
// final. Nothing here reads or writes either. Critically, `submitted` is NOT the gate: reaching
// the postTest stage does not open the test. postTestStartedAt does, and only the teacher's
// explicit "เริ่มแบบทดสอบหลังเรียน" writes it — which is what stops students walking straight from
// Main question 10 into the post-test on their own.
export const PostTestPhase = ({ player, room, onAnswer }: PostTestPhaseProps) => (
  <AssessmentPhase
    playerId={player.id}
    answers={player.postTestAnswers}
    bank={POST_TEST_QUESTIONS}
    startedAt={room.postTestStartedAt}
    questionWindow={postTestWindow(room, player.postTestAnswers)}
    eyebrow="แบบทดสอบหลังเรียน"
    waitingTitle="ภารกิจหลักจบแล้ว"
    waitingHint="รอครูเริ่มแบบทดสอบหลังเรียน"
    finishedTitle="ทำแบบทดสอบหลังเรียนครบแล้ว"
    finishedHint="รอครูเริ่มแบบประเมินกิจกรรม"
    onAnswer={onAnswer}
  />
)
