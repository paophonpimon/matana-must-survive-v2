import type { Question } from '../types/game'

// Rapid Boss / ศึกด่านชิงมนตรา
// Three fixed, very short challenges based on the actual Suthes–Matana–Mayawin episode. They
// intentionally keep the SAME Question/selectedChoiceId answer contract as the main game, so the
// existing boss accuracy + total-time ranking and exactly-once reward flow stay intact.
// `question` holds the source passage/quote (rendered as .boss-source-quote in GamePage); when a
// challenge asks something distinct from "what does this passage mean" (boss-rapid-02), that
// follow-up is BossInteraction.question, rendered as its own line below the quote.
export const bossQuestions: Question[] = [
  {
    id: 'boss-rapid-01',
    category: 'plot',
    question: '“ข้าขอแถลงวะจะนะตาม สุระเทวะโปรดปราน.”',
    choices: [
      { id: 'boss-rapid-01-heart', text: 'พูดจากความรู้สึกจริง' },
      { id: 'boss-rapid-01-spell', text: 'ตอบภายใต้อำนาจมนตร์' },
    ],
    correctChoiceId: 'boss-rapid-01-spell',
    explanation: 'มัทนากำลังตอบภายใต้อำนาจมนตร์ คำพูดจึงยังไม่ใช่หลักฐานของความรักจากใจจริง',
    difficulty: 'easy',
    bossInteraction: {
      kind: 'binary',
      title: 'คำพูดนี้มาจากใจหรือไม่?',
      instruction: 'แตะคำตอบให้ไว',
      choiceIcons: {
        'boss-rapid-01-heart': '❤',
        'boss-rapid-01-spell': '✦',
      },
    },
  },
  {
    id: 'boss-rapid-02',
    category: 'theme',
    question: '“โยคะอันขลัง บังคับได้จน ให้ตอบยุบล ได้ตามต้องการ แต่จะบังคับ...ให้ชอบให้ชัง...ย่อมจะเป็นการสุดพ้นวิสัย”',
    choices: [
      { id: 'boss-rapid-02-answer', text: 'บังคับให้ตอบ' },
      { id: 'boss-rapid-02-love', text: 'บังคับให้รักจริง' },
      { id: 'boss-rapid-02-repeat', text: 'บังคับให้พูดตาม' },
    ],
    correctChoiceId: 'boss-rapid-02-love',
    explanation: 'มายาวินอธิบายว่ามนตร์บังคับการตอบได้ แต่ไม่สามารถบังคับจิตใจให้เกิดความรักหรือความชังจริง ๆ',
    difficulty: 'easy',
    bossInteraction: {
      kind: 'rune',
      title: 'ขีดจำกัดของมนตร์',
      question: 'สิ่งใดเป็นสิ่งที่มนตร์ทำไม่ได้?',
      instruction: 'แตะพลังที่ถูกต้อง',
      choiceIcons: {
        'boss-rapid-02-answer': '🗣',
        'boss-rapid-02-love': '❤',
        'boss-rapid-02-repeat': '◌',
      },
    },
  },
  {
    id: 'boss-rapid-03',
    category: 'theme',
    question: '“ตูข้าสมัคร ฤ มิสมัคร ก็บมิขัดจะคล้อยตาม.”',
    choices: [
      { id: 'boss-rapid-03-not-love', text: 'ยังไม่ใช่ความรักจากใจ' },
      { id: 'boss-rapid-03-love', text: 'ยอมรับรักสุเทษณ์แล้ว' },
    ],
    correctChoiceId: 'boss-rapid-03-not-love',
    explanation: 'การคล้อยตามเพราะถูกบังคับไม่เท่ากับความสมัครใจ',
    difficulty: 'medium',
    bossInteraction: {
      kind: 'swipe',
      title: 'ตัดสินหัวใจมัทนา',
      instruction: 'ปัดซ้ายหรือขวา',
      swipeLeftChoiceId: 'boss-rapid-03-not-love',
      swipeRightChoiceId: 'boss-rapid-03-love',
    },
  },
]

export const bossQuestionsById = new Map(bossQuestions.map((question) => [question.id, question]))
