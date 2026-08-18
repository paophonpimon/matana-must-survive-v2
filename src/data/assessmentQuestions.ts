// Assessment Layer question banks: Pre-test A and Post-test B.
//
// Two SEPARATE banks, never merged and never shuffled together. Each has 10 items, and item i of
// bank A covers the same topic as item i of bank B — that pairing is the whole point: it is what
// lets later reporting compare A1 <-> B1, A2 <-> B2 and so on by topic. ASSESSMENT_TOPIC_ORDER
// below is the single declaration of that order, and both banks are checked against it at module
// load, so a future edit that reorders one bank without the other fails loudly instead of quietly
// producing a mismatched comparison.
//
// These banks are the ONLY authority on correctness. Services evaluate a submitted choice against
// them; correctness is never accepted from a client. Nothing here carries score weighting, timing,
// team, magic or ranking data — pre/post are individual, non-competitive measurements.

export type AssessmentTopic =
  | 'author_origin'
  | 'name_background'
  | 'recognition'
  | 'poetic_form'
  | 'story_structure'
  | 'magic_interpretation'
  | 'curse'
  | 'human_realm_plot'
  | 'character_analysis'
  | 'theme'

// Topic sequence shared by both banks, in item order. Index i of either bank must have topic
// ASSESSMENT_TOPIC_ORDER[i].
export const ASSESSMENT_TOPIC_ORDER: AssessmentTopic[] = [
  'author_origin',
  'name_background',
  'recognition',
  'poetic_form',
  'story_structure',
  'magic_interpretation',
  'curse',
  'human_realm_plot',
  'character_analysis',
  'theme',
]

export const ASSESSMENT_QUESTION_COUNT = ASSESSMENT_TOPIC_ORDER.length

export interface AssessmentChoice {
  id: string
  text: string
}

export interface AssessmentQuestion {
  id: string
  topic: AssessmentTopic
  question: string
  choices: AssessmentChoice[]
  correctChoiceId: string
}

export const PRE_TEST_QUESTIONS: AssessmentQuestion[] = [
  {
    id: 'pre-a-01',
    topic: 'author_origin',
    question: 'เรื่อง “มัทนะพาธา” เป็นพระราชนิพนธ์ของผู้ใด',
    choices: [
      { id: 'pre-a-01-a', text: 'พระบาทสมเด็จพระพุทธเลิศหล้านภาลัย' },
      { id: 'pre-a-01-b', text: 'พระบาทสมเด็จพระจุลจอมเกล้าเจ้าอยู่หัว' },
      { id: 'pre-a-01-c', text: 'พระบาทสมเด็จพระมงกุฎเกล้าเจ้าอยู่หัว' },
      { id: 'pre-a-01-d', text: 'พระบาทสมเด็จพระปกเกล้าเจ้าอยู่หัว' },
    ],
    correctChoiceId: 'pre-a-01-c',
  },
  {
    id: 'pre-a-02',
    topic: 'name_background',
    question: 'เหตุใดจึงเลือกใช้ชื่อ “มัทนา” แทนคำสันสกฤต “กุพชก” ที่หมายถึงดอกกุหลาบ',
    choices: [
      { id: 'pre-a-02-a', text: 'เพราะคำว่า “มัทนา” เป็นชื่อดอกไม้ในภาษาไทย' },
      { id: 'pre-a-02-b', text: 'เพราะ “กุพชก” มีอีกความหมายหนึ่งว่า “นางค่อม” ขณะที่ “มัทนา” สัมพันธ์กับความรักหรือความลุ่มหลง' },
      { id: 'pre-a-02-c', text: 'เพราะ “กุพชก” เป็นชื่อของตัวละครอื่นอยู่แล้ว' },
      { id: 'pre-a-02-d', text: 'เพราะต้องการให้ชื่อตัวละครออกเสียงง่ายที่สุด' },
    ],
    correctChoiceId: 'pre-a-02-b',
  },
  {
    id: 'pre-a-03',
    topic: 'recognition',
    question: 'เหตุใดวรรณคดีสโมสรจึงยกย่อง “มัทนะพาธา” เป็นยอดของบทละครพูดคำฉันท์',
    choices: [
      { id: 'pre-a-03-a', text: 'เพราะเป็นวรรณคดีไทยเรื่องแรกที่มีดนตรีประกอบ' },
      { id: 'pre-a-03-b', text: 'เพราะเป็นเรื่องที่มีตัวละครมากที่สุดในสมัยนั้น' },
      { id: 'pre-a-03-c', text: 'เพราะเป็นเรื่องที่ได้รับความนิยมจากต่างประเทศ' },
      { id: 'pre-a-03-d', text: 'เพราะแต่งได้ยาก และตัวละครกับภูมิประเทศสอดคล้องกับยุคภารตวรรษ' },
    ],
    correctChoiceId: 'pre-a-03-d',
  },
  {
    id: 'pre-a-04',
    topic: 'poetic_form',
    question: 'ข้อใดกล่าวถึงลักษณะคำประพันธ์ของ “มัทนะพาธา” ได้ถูกต้อง',
    choices: [
      { id: 'pre-a-04-a', text: 'เป็นบทละครพูดคำฉันท์ ใช้ฉันท์ 21 ชนิด และกาพย์ 3 ชนิด' },
      { id: 'pre-a-04-b', text: 'เป็นบทละครร้อยแก้วทั้งหมด' },
      { id: 'pre-a-04-c', text: 'เป็นกาพย์ห่อโคลงตลอดเรื่อง' },
      { id: 'pre-a-04-d', text: 'เป็นกลอนบทละครสลับโคลงสี่สุภาพ' },
    ],
    correctChoiceId: 'pre-a-04-a',
  },
  {
    id: 'pre-a-05',
    topic: 'story_structure',
    question: 'ข้อใดกล่าวถึงโครงสร้างเนื้อเรื่องได้ถูกต้อง',
    choices: [
      { id: 'pre-a-05-a', text: 'แบ่งเป็นภาคอดีตและภาคปัจจุบัน' },
      { id: 'pre-a-05-b', text: 'แบ่งเป็นภาคสวรรค์และภาคมนุษย์' },
      { id: 'pre-a-05-c', text: 'แบ่งเป็นภาคอินเดียและภาคไทย' },
      { id: 'pre-a-05-d', text: 'แบ่งเป็นภาคสุเทษณ์และภาคชัยเสน' },
    ],
    correctChoiceId: 'pre-a-05-b',
  },
  {
    id: 'pre-a-06',
    topic: 'magic_interpretation',
    question: 'เหตุการณ์ที่มายาวินใช้มนตร์สะกดมัทนา แสดงให้เห็นข้อใดชัดที่สุด',
    choices: [
      { id: 'pre-a-06-a', text: 'มนตร์สามารถทำให้คนรักกันได้อย่างแท้จริง' },
      { id: 'pre-a-06-b', text: 'มัทนามีใจให้สุเทษณ์อยู่แล้ว' },
      { id: 'pre-a-06-c', text: 'สุเทษณ์ไม่เคยต้องการความรักจากมัทนา' },
      { id: 'pre-a-06-d', text: 'การบังคับคำพูดของคนหนึ่งได้ ไม่ได้หมายความว่าจะบังคับความรู้สึกภายในได้' },
    ],
    correctChoiceId: 'pre-a-06-d',
  },
  {
    id: 'pre-a-07',
    topic: 'curse',
    question: 'หลังจากมัทนาปฏิเสธความรักของสุเทษณ์ นางถูกสาปให้เป็นสิ่งใด',
    choices: [
      { id: 'pre-a-07-a', text: 'ดอกบัว' },
      { id: 'pre-a-07-b', text: 'ดอกมะลิ' },
      { id: 'pre-a-07-c', text: 'ดอกกุหลาบ' },
      { id: 'pre-a-07-d', text: 'ดอกจำปา' },
    ],
    correctChoiceId: 'pre-a-07-c',
  },
  {
    id: 'pre-a-08',
    topic: 'human_realm_plot',
    question: 'ข้อใดเรียงเหตุการณ์ในภาคมนุษย์ได้เหมาะสมที่สุด',
    choices: [
      { id: 'pre-a-08-a', text: 'พระกาละทรรศินพบกุหลาบ → มัทนาพบชัยเสน → เกิดความรัก → จัณฑีเกิดความริษยา' },
      { id: 'pre-a-08-b', text: 'จัณฑีพบมัทนา → สุเทษณ์ลงมายังโลก → ชัยเสนถูกสาป → มัทนากลับสวรรค์' },
      { id: 'pre-a-08-c', text: 'ชัยเสนพบสุเทษณ์ → มัทนาถูกสาป → พระกาละทรรศินพบจัณฑี' },
      { id: 'pre-a-08-d', text: 'มัทนาพบจัณฑี → พระกาละทรรศินสาปมัทนา → ชัยเสนกลับสวรรค์' },
    ],
    correctChoiceId: 'pre-a-08-a',
  },
  {
    id: 'pre-a-09',
    topic: 'character_analysis',
    question: 'การที่มัทนายังคงปฏิเสธสุเทษณ์หลังจากมนตร์ถูกคลาย แสดงลักษณะเด่นของมัทนาในข้อใด',
    choices: [
      { id: 'pre-a-09-a', text: 'เปลี่ยนใจง่ายตามสถานการณ์' },
      { id: 'pre-a-09-b', text: 'ต้องการเอาชนะสุเทษณ์' },
      { id: 'pre-a-09-c', text: 'ซื่อตรงต่อความรู้สึกของตนเอง' },
      { id: 'pre-a-09-d', text: 'ไม่เข้าใจความหมายของความรัก' },
    ],
    correctChoiceId: 'pre-a-09-c',
  },
  {
    id: 'pre-a-10',
    topic: 'theme',
    question: 'แนวคิดใดสอดคล้องกับเรื่อง “มัทนะพาธา” มากที่สุด',
    choices: [
      { id: 'pre-a-10-a', text: 'ความรักที่มากพอย่อมทำให้คนอื่นยอมรับเรา' },
      { id: 'pre-a-10-b', text: 'ความรักที่ไม่เคารพความสมัครใจของอีกฝ่ายอาจนำไปสู่ความทุกข์' },
      { id: 'pre-a-10-c', text: 'ผู้มีอำนาจย่อมมีสิทธิ์ตัดสินใจแทนผู้อื่น' },
      { id: 'pre-a-10-d', text: 'ความหึงหวงเป็นสิ่งจำเป็นในการรักษาความรัก' },
    ],
    correctChoiceId: 'pre-a-10-b',
  },
]

export const POST_TEST_QUESTIONS: AssessmentQuestion[] = [
  {
    id: 'post-b-01',
    topic: 'author_origin',
    question: 'ข้อใดกล่าวถึงที่มาของ “มัทนะพาธา” ได้ถูกต้อง',
    choices: [
      { id: 'post-b-01-a', text: 'ดัดแปลงจากนิทานพื้นบ้านไทย' },
      { id: 'post-b-01-b', text: 'แปลโดยตรงจากบทละครภาษาสันสกฤต' },
      { id: 'post-b-01-c', text: 'ดัดแปลงจากพงศาวดารอินเดีย' },
      { id: 'post-b-01-d', text: 'พระบาทสมเด็จพระมงกุฎเกล้าเจ้าอยู่หัวทรงพระราชนิพนธ์ขึ้นจากจินตนาการของพระองค์เอง' },
    ],
    correctChoiceId: 'post-b-01-d',
  },
  {
    id: 'post-b-02',
    topic: 'name_background',
    question: 'เหตุใดการตั้งชื่อตัวละครเอกจึงเกี่ยวข้องกับภาษาสันสกฤต',
    choices: [
      { id: 'post-b-02-a', text: 'เพราะทรงกำหนดให้เรื่องเกิดในภารตวรรษหรืออินเดีย' },
      { id: 'post-b-02-b', text: 'เพราะภาษาไทยยังไม่มีคำเรียกดอกกุหลาบ' },
      { id: 'post-b-02-c', text: 'เพราะตัวละครทุกตัวในเรื่องเป็นเทพ' },
      { id: 'post-b-02-d', text: 'เพราะวรรณคดีสโมสรเป็นผู้กำหนดชื่อให้' },
    ],
    correctChoiceId: 'post-b-02-a',
  },
  {
    id: 'post-b-03',
    topic: 'recognition',
    question: 'ข้อใดเป็นข้อมูลสำคัญเกี่ยวกับการยกย่อง “มัทนะพาธา”',
    choices: [
      { id: 'post-b-03-a', text: 'ได้รับยกย่องเป็นยอดแห่งนิราศ' },
      { id: 'post-b-03-b', text: 'ได้รับยกย่องเป็นยอดแห่งกลอนบทละคร' },
      { id: 'post-b-03-c', text: 'ได้รับยกย่องเป็นยอดของบทละครพูดคำฉันท์ใน พ.ศ. 2467' },
      { id: 'post-b-03-d', text: 'ได้รับยกย่องเป็นยอดแห่งกาพย์ห่อโคลง' },
    ],
    correctChoiceId: 'post-b-03-c',
  },
  {
    id: 'post-b-04',
    topic: 'poetic_form',
    question: 'ข้อใดเป็นลักษณะเด่นของการประพันธ์เรื่องนี้',
    choices: [
      { id: 'post-b-04-a', text: 'ใช้โคลงชนิดเดียวตลอดทั้งเรื่อง' },
      { id: 'post-b-04-b', text: 'ใช้ฉันท์หลายชนิดร่วมกับกาพย์' },
      { id: 'post-b-04-c', text: 'ใช้ร้อยแก้วสลับกลอนสุภาพเท่านั้น' },
      { id: 'post-b-04-d', text: 'ใช้กาพย์ยานี 11 เพียงชนิดเดียว' },
    ],
    correctChoiceId: 'post-b-04-b',
  },
  {
    id: 'post-b-05',
    topic: 'story_structure',
    question: 'เหตุการณ์ใดอยู่ใน “ภาคมนุษย์” ของเรื่อง',
    choices: [
      { id: 'post-b-05-a', text: 'มายาวินใช้มนตร์เรียกมัทนา' },
      { id: 'post-b-05-b', text: 'สุเทษณ์ขอความรักจากมัทนา' },
      { id: 'post-b-05-c', text: 'สุเทษณ์สั่งให้มายาวินคลายมนตร์' },
      { id: 'post-b-05-d', text: 'พระกาละทรรศินพบกุหลาบมัทนาในป่าหิมพานต์' },
    ],
    correctChoiceId: 'post-b-05-d',
  },
  {
    id: 'post-b-06',
    topic: 'magic_interpretation',
    question: 'มัทนาตอบรับสุเทษณ์ขณะถูกมนตร์ แต่เมื่อมนตร์คลายกลับปฏิเสธเช่นเดิม เหตุการณ์นี้ชี้ให้เห็นข้อใด',
    choices: [
      { id: 'post-b-06-a', text: 'คำพูดที่ถูกบังคับไม่อาจใช้แทนความรู้สึกที่แท้จริงได้' },
      { id: 'post-b-06-b', text: 'มัทนาไม่สามารถตัดสินใจเรื่องความรักได้' },
      { id: 'post-b-06-c', text: 'มายาวินทำมนตร์ผิดพลาด' },
      { id: 'post-b-06-d', text: 'สุเทษณ์เข้าใจความรู้สึกของมัทนาตั้งแต่แรก' },
    ],
    correctChoiceId: 'post-b-06-a',
  },
  {
    id: 'post-b-07',
    topic: 'curse',
    question: 'สาเหตุสำคัญที่ทำให้มัทนาถูกสาปเป็นดอกกุหลาบคือข้อใด',
    choices: [
      { id: 'post-b-07-a', text: 'นางต้องการหนีออกจากสวรรค์' },
      { id: 'post-b-07-b', text: 'นางทำลายมนตร์ของมายาวิน' },
      { id: 'post-b-07-c', text: 'นางยังคงปฏิเสธความรักของสุเทษณ์หลังได้สติ' },
      { id: 'post-b-07-d', text: 'นางรักชัยเสนตั้งแต่อยู่บนสวรรค์' },
    ],
    correctChoiceId: 'post-b-07-c',
  },
  {
    id: 'post-b-08',
    topic: 'human_realm_plot',
    question: 'เหตุการณ์ใดนำไปสู่ความทุกข์ของมัทนาในช่วงท้ายของภาคมนุษย์',
    choices: [
      { id: 'post-b-08-a', text: 'พระกาละทรรศินขับมัทนาออกจากอาศรม' },
      { id: 'post-b-08-b', text: 'ความริษยาของจัณฑีนำไปสู่ความเข้าใจผิดระหว่างชัยเสนกับมัทนา' },
      { id: 'post-b-08-c', text: 'มายาวินกลับมาใช้มนตร์กับมัทนา' },
      { id: 'post-b-08-d', text: 'ชัยเสนต้องการให้มัทนากลับเป็นดอกกุหลาบ' },
    ],
    correctChoiceId: 'post-b-08-b',
  },
  {
    id: 'post-b-09',
    topic: 'character_analysis',
    question: 'การที่สุเทษณ์ใช้มนตร์และคำสาปเมื่อมัทนาไม่รับรัก สะท้อนข้อบกพร่องสำคัญของสุเทษณ์อย่างไร',
    choices: [
      { id: 'post-b-09-a', text: 'ไม่ยอมรับสิทธิของอีกฝ่ายในการปฏิเสธความรัก' },
      { id: 'post-b-09-b', text: 'ไม่กล้าบอกความรู้สึกของตนเอง' },
      { id: 'post-b-09-c', text: 'เชื่อใจมายาวินมากเกินไป' },
      { id: 'post-b-09-d', text: 'สนใจเฉพาะการปกครองสวรรค์' },
    ],
    correctChoiceId: 'post-b-09-a',
  },
  {
    id: 'post-b-10',
    topic: 'theme',
    question: 'ชื่อเรื่อง “มัทนะพาธา” สัมพันธ์กับเนื้อหาของเรื่องมากที่สุดในข้อใด',
    choices: [
      { id: 'post-b-10-a', text: 'ความรักนำชัยชนะมาให้ผู้ที่พยายามมากที่สุด' },
      { id: 'post-b-10-b', text: 'ความงามของดอกกุหลาบทำให้ทุกคนหลงรัก' },
      { id: 'post-b-10-c', text: 'ผู้ที่มีความรักย่อมต้องสมหวังในที่สุด' },
      { id: 'post-b-10-d', text: 'ความรักหรือความลุ่มหลงที่ขาดความพอดีอาจนำมาซึ่งความเจ็บปวด' },
    ],
    correctChoiceId: 'post-b-10-d',
  },
]

export const preTestQuestionsById = new Map(PRE_TEST_QUESTIONS.map((question) => [question.id, question]))
export const postTestQuestionsById = new Map(POST_TEST_QUESTIONS.map((question) => [question.id, question]))

// Structural guarantees, asserted at module load rather than left to a test: a mismatch here would
// silently corrupt the topic-paired reporting these banks exist for.
const assertBankShape = (bank: AssessmentQuestion[], label: string): void => {
  if (bank.length !== ASSESSMENT_QUESTION_COUNT) {
    throw new Error(`${label} must have exactly ${ASSESSMENT_QUESTION_COUNT} questions`)
  }
  bank.forEach((question, index) => {
    if (question.topic !== ASSESSMENT_TOPIC_ORDER[index]) {
      throw new Error(`${label} item ${index + 1} must cover topic ${ASSESSMENT_TOPIC_ORDER[index]}`)
    }
    if (!question.choices.some((choice) => choice.id === question.correctChoiceId)) {
      throw new Error(`${label} item ${index + 1} has a correctChoiceId that is not one of its choices`)
    }
  })
}

assertBankShape(PRE_TEST_QUESTIONS, 'PRE_TEST_QUESTIONS')
assertBankShape(POST_TEST_QUESTIONS, 'POST_TEST_QUESTIONS')
