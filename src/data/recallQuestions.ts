// Learning Layer: "ทบทวนเรื่องราว" (Story Recall) — the mandatory individual phase every round
// begins with, before the competitive Main game. Exactly 5 items, each mapped 1:1 to a concept
// id and to the specific Main question (see data/questions.ts) that later serves as "in-game
// evidence" for the same concept — see lib/learning.ts for how the review result is reported.
// Learning Gain are computed from that mapping. Order here is fixed and is also the required
// answering order (no skipping): the next unanswered question for a player is always
// RECALL_QUESTIONS[player.recallAnswers.length].
export interface RecallQuestion {
  // Doubles as the Learning Evidence "Concept ID" — Recall is exactly one question per concept,
  // so no separate id/conceptId split is needed.
  id: string
  // Short label for compact display in summaries (student/teacher Learning Summary) — the full
  // prompt is often too long to list several of at once.
  label: string
  prompt: string
  choices: [{ id: string; text: string }, { id: string; text: string }]
  correctChoiceId: string
  feedback: string
}

export const RECALL_QUESTIONS: RecallQuestion[] = [
  {
    id: 'recall-mayawin',
    label: 'เหตุที่มายาวินใช้มนตร์',
    prompt: 'เพราะเหตุใดสุเทษณ์จึงให้มายาวินใช้มนตร์กับมัทนา?',
    choices: [
      { id: 'recall-mayawin-a', text: 'เพราะมัทนาหนีไปอยู่โลกมนุษย์' },
      { id: 'recall-mayawin-b', text: 'เพราะมัทนาไม่รับรัก จึงต้องการเรียกนางมาพบ' },
    ],
    correctChoiceId: 'recall-mayawin-b',
    feedback: 'สุเทษณ์ยังหลงรักมัทนา แต่นางไม่รับรัก จึงให้มายาวินใช้มนตร์เรียกนางมาหา',
  },
  {
    id: 'recall-curse',
    label: 'คำสาปของสุเทษณ์',
    prompt: 'เมื่อคลายมนตร์แล้วมัทนายังไม่รับรัก สุเทษณ์ทำอย่างไร?',
    choices: [
      { id: 'recall-curse-a', text: 'สาปให้นางเป็นดอกกุหลาบ' },
      { id: 'recall-curse-b', text: 'ยอมให้นางกลับไปโดยไม่มีเงื่อนไข' },
    ],
    correctChoiceId: 'recall-curse-a',
    feedback: 'สุเทษณ์โกรธและสาปมัทนาให้เป็นดอกกุหลาบ โดยนางจะคืนร่างมนุษย์ได้ในคืนวันเพ็ญ',
  },
  {
    id: 'recall-human-love',
    label: 'รักแท้บนโลกมนุษย์',
    prompt: 'หลังจากมัทนาไปอยู่โลกมนุษย์ เหตุการณ์สำคัญใดเกิดขึ้นต่อ?',
    choices: [
      { id: 'recall-human-love-a', text: 'มัทนากลับไปหาสุเทษณ์ทันที' },
      { id: 'recall-human-love-b', text: 'พระฤๅษีกาลทรรศินพบกุหลาบมัทนา และต่อมามัทนาได้พบรักกับท้าวชัยเสน' },
    ],
    correctChoiceId: 'recall-human-love-b',
    feedback: 'พระฤๅษีกาลทรรศินนำกุหลาบมัทนาไปปลูก และต่อมาท้าวชัยเสนมาประพาสป่า จนทั้งสองได้พบและรักกัน',
  },
  {
    id: 'recall-jealousy',
    label: 'ความริษยาของจัณฑี',
    prompt: 'อะไรเป็นเหตุให้ความรักของมัทนากับท้าวชัยเสนเกิดปัญหา?',
    choices: [
      { id: 'recall-jealousy-a', text: 'จัณฑีเกิดความริษยาและทำให้ทั้งสองเข้าใจผิดกัน' },
      { id: 'recall-jealousy-b', text: 'มายาวินกลับมาใช้มนตร์อีกครั้ง' },
    ],
    correctChoiceId: 'recall-jealousy-a',
    feedback: 'ท้าวชัยเสนมีพระมเหสีคือจัณฑีอยู่แล้ว ความริษยาของจัณฑีจึงนำไปสู่ความเข้าใจผิดและความทุกข์ของมัทนา',
  },
  {
    id: 'recall-ending',
    label: 'ตอนจบของมัทนา',
    prompt: 'ตอนจบของเรื่องมัทนามีชะตากรรมอย่างไร?',
    choices: [
      { id: 'recall-ending-a', text: 'ยอมรับรักสุเทษณ์และกลับขึ้นสวรรค์' },
      { id: 'recall-ending-b', text: 'ปฏิเสธสุเทษณ์อีกครั้ง และถูกสาปให้เป็นดอกกุหลาบตลอดกาล' },
    ],
    correctChoiceId: 'recall-ending-b',
    feedback: 'เมื่อมัทนาทุกข์เพราะความรัก นางขอให้สุเทษณ์ช่วย แต่ยังปฏิเสธที่จะรับรักเขา สุเทษณ์จึงสาปให้นางกลายเป็นดอกกุหลาบตลอดกาล',
  },
]

export const recallQuestionsById = new Map(RECALL_QUESTIONS.map((question) => [question.id, question]))
