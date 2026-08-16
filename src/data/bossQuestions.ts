import type { Question } from '../types/game'

// Rapid Boss / ศึกชิงมนตรา
// Three fixed, very short challenges based on the actual Suthes–Matana–Mayawin episode.
// They intentionally keep the SAME Question/selectedChoiceId answer contract as the main game,
// so the existing boss accuracy + total-time ranking and exactly-once reward flow stay intact.
export const bossQuestions: Question[] = [
  {
    id: 'boss-rapid-01',
    category: 'plot',
    question: '“ข้าขอแถลงวะจะนะตาม สุระเทวะโปรดปราน.”',
    choices: [
      { id: 'boss-rapid-01-heart', text: 'พูดจากใจจริง' },
      { id: 'boss-rapid-01-spell', text: 'อยู่ใต้อำนาจมนตร์' },
    ],
    correctChoiceId: 'boss-rapid-01-spell',
    explanation: 'มัทนากำลังตอบตามอำนาจมนตร์ของมายาวิน มิใช่แสดงความรักจากใจจริง',
    difficulty: 'easy',
    bossInteraction: {
      kind: 'binary',
      title: 'ใจจริง หรือ มนต์สะกด?',
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
    question: '“บังคับ...ให้ตอบ...ได้ตามต้องการ แต่จะบังคับ...ให้ชอบให้ชัง...ย่อมจะเป็นการสุดพ้นวิสัย”',
    choices: [
      { id: 'boss-rapid-02-speech', text: 'บังคับให้ตอบตามต้องการ' },
      { id: 'boss-rapid-02-love', text: 'บังคับให้เกิดความรักจริง' },
      { id: 'boss-rapid-02-memory', text: 'ลบความทรงจำ' },
    ],
    correctChoiceId: 'boss-rapid-02-speech',
    explanation: 'มายาวินอธิบายว่ามนตร์บังคับการตอบได้ แต่บังคับใจให้รักหรือชังอย่างแท้จริงไม่ได้',
    difficulty: 'easy',
    bossInteraction: {
      kind: 'rune',
      title: 'มนตร์ทำอะไรได้?',
      instruction: 'แตะพลังที่ถูกต้อง',
      choiceIcons: {
        'boss-rapid-02-speech': '🗣',
        'boss-rapid-02-love': '❤',
        'boss-rapid-02-memory': '◌',
      },
    },
  },
  {
    id: 'boss-rapid-03',
    category: 'theme',
    question: '“ตูข้าสมัคร ฤ มิสมัคร ก็บมิขัดจะคล้อยตาม.”',
    choices: [
      { id: 'boss-rapid-03-not-love', text: 'ยังไม่ใช่ความรักจากใจ' },
      { id: 'boss-rapid-03-love', text: 'ยอมรับรักด้วยใจจริง' },
    ],
    correctChoiceId: 'boss-rapid-03-not-love',
    explanation: 'มัทนากล่าวว่าตนจะสมัครหรือไม่สมัครก็ขัดไม่ได้และต้องคล้อยตาม จึงยังไม่ใช่ความรักที่เกิดจากความสมัครใจ',
    difficulty: 'medium',
    bossInteraction: {
      kind: 'swipe',
      title: 'ตัดสินความจริง',
      instruction: 'ปัดซ้ายหรือขวา',
      swipeLeftChoiceId: 'boss-rapid-03-not-love',
      swipeRightChoiceId: 'boss-rapid-03-love',
    },
  },
]

export const bossQuestionsById = new Map(bossQuestions.map((question) => [question.id, question]))
