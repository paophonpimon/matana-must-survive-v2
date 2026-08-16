import type { Difficulty, Question, QuestionCategory } from '../types/game'
import { bossQuestions } from './bossQuestions'

// TODO: คลังนี้เป็นข้อสอบตัวอย่างสำหรับตรวจระบบ ครูควรทบทวนและแทนที่ด้วยข้อสอบจริงก่อนใช้ประเมินผล
const makeQuestion = (
  id: string,
  category: QuestionCategory,
  question: string,
  choices: [string, string, string, string],
  correctIndex: number,
  explanation: string,
  difficulty: Difficulty,
): Question => ({
  id,
  category,
  question,
  choices: choices.map((text, index) => ({ id: `${id}-${String.fromCharCode(97 + index)}`, text })),
  correctChoiceId: `${id}-${String.fromCharCode(97 + correctIndex)}`,
  explanation,
  difficulty,
})

// Learning Layer iteration: this bank is now exactly the 10 fixed questions the approved
// content spec requires — main-01..main-10, five of which (main-04/06/07/08/09) are the
// "in-game evidence" half of the Learning Evidence pairing with a Story Recall concept (see
// data/recallQuestions.ts's mappedMainQuestionId). ROUND_CATEGORY_COUNTS in lib/game.ts is set
// to match this exact per-category distribution (basic:1, poetry:1, characters:2, theme:5,
// plot:1) so selectRoundQuestions's existing category-quota selection picks literally all 10 of
// them every round — never a random subset — which is what "do not randomly replace the five
// mapped evidence questions" requires structurally, not just by convention.
export const questions: Question[] = [
  makeQuestion(
    'main-01',
    'basic',
    'คำว่า “มัทนะพาธา” สอดคล้องกับเหตุการณ์ของเรื่องมากที่สุดอย่างไร?',
    ['ความรักทำให้ทุกคนสมหวัง', 'ความรักทำให้มนุษย์มีอำนาจ', 'ความรักและความลุ่มหลงนำไปสู่ความทุกข์', 'ความรักทำให้ผู้ถูกสาปกลับสวรรค์'],
    2,
    'ชื่อเรื่องสัมพันธ์กับความทุกข์ที่เกิดจากความรักและความลุ่มหลง',
    'easy',
  ),
  makeQuestion(
    'main-02',
    'poetry',
    'เหตุใดการใช้คำประพันธ์หลายชนิดจึงเหมาะกับมัทนะพาธา ซึ่งเป็นบทละครพูดคำฉันท์?',
    ['เพื่อเลือกจังหวะและเสียงให้เหมาะกับอารมณ์และเหตุการณ์', 'เพื่อให้เรื่องยาวขึ้น', 'เพื่อหลีกเลี่ยงการใช้บทสนทนา', 'เพื่อให้ทุกตัวละครพูดเหมือนกัน'],
    0,
    'การเลือกชนิดคำประพันธ์ช่วยสร้างจังหวะและอารมณ์ให้เหมาะกับแต่ละฉาก',
    'medium',
  ),
  makeQuestion(
    'main-03',
    'characters',
    'การที่มัทนาปฏิเสธสุเทษณ์ทั้งก่อนและหลังถูกมนตร์ แสดงลักษณะเด่นของนางข้อใดมากที่สุด?',
    ['ดื้อรั้นโดยไม่มีเหตุผล', 'ต้องการทดสอบอำนาจสุเทษณ์', 'ไม่เข้าใจความหมายของความรัก', 'ซื่อตรงต่อความรู้สึกของตนเอง'],
    3,
    'มัทนาไม่ยอมเรียกสิ่งที่ไม่ได้เกิดจากใจว่าเป็นความรัก',
    'medium',
  ),
  // Learning Evidence pair: recall-mayawin (data/recallQuestions.ts)
  makeQuestion(
    'main-04',
    'theme',
    'การที่สุเทษณ์เลือกใช้มนตร์เพื่อให้มัทนามาพบ สะท้อนปัญหาใดในความรักของสุเทษณ์ชัดที่สุด?',
    ['ไม่กล้าแสดงความรู้สึก', 'ไม่ยอมรับสิทธิของอีกฝ่ายในการปฏิเสธ', 'ไม่รู้ว่ามัทนาอยู่ที่ใด', 'เข้าใจผิดว่ามายาวินรักมัทนา'],
    1,
    'สุเทษณ์พยายามใช้อำนาจเพื่อให้ได้ความรัก แทนที่จะยอมรับการตัดสินใจของมัทนา',
    'medium',
  ),
  makeQuestion(
    'main-05',
    'theme',
    'มายาวินกล่าวว่า มนตร์สามารถบังคับให้ตอบได้ แต่ไม่สามารถบังคับให้ “ชอบหรือชัง” ได้ ข้อใดสรุปแนวคิดนี้ดีที่สุด?',
    ['คำพูดกับความรู้สึกภายในอาจไม่ตรงกัน', 'ผู้มีเวทมนตร์สามารถควบคุมทุกสิ่งได้', 'คนที่พูดว่ารักย่อมรักจริงเสมอ', 'ความรักเกิดขึ้นได้จากคำสั่ง'],
    0,
    'มนตร์ควบคุมการตอบได้ แต่ไม่สามารถสร้างความรักที่แท้จริงในจิตใจ',
    'medium',
  ),
  // Learning Evidence pair: recall-curse
  makeQuestion(
    'main-06',
    'characters',
    'เมื่อมัทนาไม่รับรักแล้วสุเทษณ์ตอบโต้ด้วยการสาป การกระทำนี้แสดงว่าสุเทษณ์มีปัญหาใดมากที่สุด?',
    ['ไม่เข้าใจเวทมนตร์', 'ต้องการช่วยมัทนา', 'ใช้อำนาจและอารมณ์เมื่อไม่ได้สิ่งที่ต้องการ', 'ต้องการให้มายาวินรับผิดแทน'],
    2,
    'คำสาปเกิดจากความโกรธและการใช้อำนาจเมื่อสุเทษณ์ไม่ได้รับความรักตามที่ต้องการ',
    'medium',
  ),
  // Learning Evidence pair: recall-human-love
  makeQuestion(
    'main-07',
    'theme',
    'ความรักระหว่างมัทนากับท้าวชัยเสนต่างจากความรักที่สุเทษณ์ต้องการจากมัทนาอย่างไร?',
    ['เกิดจากคำสาปเหมือนกัน', 'เกิดจากมายาวินใช้มนตร์', 'เกิดเพราะพระฤๅษีสั่งให้รักกัน', 'เกิดจากความสมัครใจของทั้งสองฝ่าย'],
    3,
    'มัทนากับท้าวชัยเสนเกิดรักกันโดยสมัครใจ ต่างจากสุเทษณ์ที่พยายามบังคับความรัก',
    'medium',
  ),
  // Learning Evidence pair: recall-jealousy
  makeQuestion(
    'main-08',
    'plot',
    'เหตุการณ์ที่จัณฑีทำให้ท้าวชัยเสนกับมัทนาเข้าใจผิดกัน แสดงผลของอารมณ์ใดเด่นที่สุด?',
    ['ความเมตตา', 'ความริษยาและความไม่ไว้วางใจ', 'ความกล้าหาญ', 'ความเสียสละ'],
    1,
    'ความริษยาของจัณฑีนำไปสู่ความเข้าใจผิดและความทุกข์ของตัวละคร',
    'medium',
  ),
  // Learning Evidence pair: recall-ending
  makeQuestion(
    'main-09',
    'theme',
    'ตอนจบที่มัทนายอมเป็นกุหลาบตลอดกาล แทนที่จะรับรักสุเทษณ์ สนับสนุนแนวคิดใดมากที่สุด?',
    ['ความรักแท้ต้องเกิดจากความสมัครใจ', 'ผู้มีอำนาจย่อมชนะเสมอ', 'การยอมตามทำให้พ้นทุกข์', 'ความรักต้องตอบแทนกันเสมอ'],
    0,
    'แม้ต้องเผชิญผลร้าย มัทนาก็ไม่ยอมกล่าวว่ารักผู้ที่ตนไม่ได้รัก',
    'hard',
  ),
  makeQuestion(
    'main-10',
    'theme',
    'หากต้องเลือกประโยคเดียวเป็นแก่นสำคัญของมัทนะพาธา ข้อใดเหมาะสมที่สุด?',
    ['ผู้มีเวทมนตร์ย่อมได้ทุกสิ่งที่ต้องการ', 'ความรักที่ขาดการเคารพความสมัครใจ อาจกลายเป็นความทุกข์และการทำร้ายกัน', 'ความรักที่ดีต้องมีการแข่งขัน', 'ผู้ที่ถูกสาปย่อมไม่มีทางเลือก'],
    1,
    'เรื่องแสดงให้เห็นว่าความรักที่กลายเป็นการบังคับ ครอบครอง หรือริษยา สามารถนำไปสู่ความทุกข์ได้',
    'hard',
  ),
]

export const questionsById = new Map([...questions, ...bossQuestions].map((question) => [question.id, question]))
