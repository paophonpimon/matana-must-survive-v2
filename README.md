# มัทนาต้องรอด

เว็บแอปเกมการศึกษาภาษาไทยสำหรับนักเรียนชั้นมัธยมศึกษาปีที่ 5 เล่นเป็นกลุ่ม กลุ่มละประมาณ 4–5 คน ทุกกลุ่มได้รับคำถาม 10 ข้อชุดเดียวกัน ลำดับเดียวกัน และใช้เวลาต่อข้อเท่ากันตามที่ครูกำหนด นักเรียนเปลี่ยนคำตอบได้จนหมดเวลา โดยระบบใช้คำตอบล่าสุดและล็อกทันทีเมื่อ deadline ถึง จากนั้นจะแสดงถูก/ผิดพร้อมคะแนนสะสม 4 วินาทีก่อนเปลี่ยนข้อ หน้าครูเปิดคะแนนและจัดอันดับใหม่แบบ realtime พร้อมกับช่วงเฉลยโดยไม่เปิดคะแนนก่อนเวลา ระหว่างเล่นจะเข้าสู่โหมดกระดานเต็มพื้นที่สำหรับสะท้อนจากแท็บเล็ตขึ้นจอใหญ่ พร้อมปุ่มหยุดเกมฉุกเฉินที่คืนทุกกลุ่มสู่ห้องรอโดยไม่ลบรายชื่อ เมื่อจบรอบจอครูแสดงอันดับ 1–3 พร้อมเวทีและพลุฉลอง ส่วนนักเรียนเห็นเฉพาะคะแนนของกลุ่มตนเอง ไม่มีการตัดสินจากความเร็ว

โปรเจกต์เปิดใน **Demo Mode** เป็นค่าเริ่มต้น จึงทดลองหน้าจอและลำดับการเล่นได้ทันทีโดยยังไม่ต้องมี Firebase

## เทคโนโลยี

- React + TypeScript + Vite
- Tailwind CSS
- React Router
- Firebase Authentication แบบ Anonymous
- Cloud Firestore, realtime listener และ transaction
- Vitest
- ESLint

## โครงสร้างโฟลเดอร์

```text
src/
├─ components/       ส่วนประกอบ UI ที่ใช้ร่วมกัน
├─ context/          การเตรียม session และแหล่งข้อมูล
├─ data/             คลังคำถามตัวอย่าง
├─ hooks/            realtime hooks สำหรับห้องและกลุ่ม
├─ lib/              สุ่มคำถาม คะแนน validation และ route resolver
├─ pages/            หน้าจอครบทุก route
├─ services/         Demo Mode, Firebase Mode และ localStorage session
└─ types/            data model ของเกม
public/images/       ภาพ PNG ของเกม
firestore.rules      กฎความปลอดภัย Firestore สำหรับ MVP
firebase.json        การตั้งค่า rules และ Firebase Hosting
vercel.json          SPA fallback สำหรับ Vercel
```

## ติดตั้งและรันในเครื่อง

ต้องมี Node.js รุ่น 20.19 ขึ้นไป (หรือ 22.12 ขึ้นไป) และ npm

```bash
npm install
copy .env.example .env.local
npm run dev
```

บน macOS/Linux ใช้ `cp .env.example .env.local` แทน `copy` แล้วเปิด URL ที่ Vite แสดง

คำสั่งที่มีให้:

```bash
npm run dev        # เปิด development server
npm run lint       # ตรวจรูปแบบและข้อผิดพลาดของโค้ด
npm run typecheck  # ตรวจ TypeScript
npm run test       # รัน unit tests
npm run build      # สร้าง production build ใน dist/
```

## วิธีรัน Demo Mode

ตั้งค่าใน `.env.local`:

```env
VITE_DEMO_MODE=true
```

Demo Mode มีห้องตัวอย่างรหัส `MATANA` พร้อมกลุ่มตัวอย่าง 3 กลุ่ม

1. เปิด `/teacher` แล้วกด “เปิดห้องสาธิต MATANA” หรือสร้างห้องใหม่
2. เปิด `/join` ในอีกหน้าต่าง กดแถบโหมดสาธิตเพื่อใส่รหัส `MATANA`
3. กรอกชื่อกลุ่มและชื่อผู้พิทักษ์
4. กลับหน้าครูแล้วเริ่มภารกิจ

หากต้องการทดสอบตั้งแต่ห้องว่าง ให้กด **“สร้างห้องทดสอบใหม่”** ในแผงควบคุมครู แล้วนำรหัส 6 ตัวที่ได้ไปกรอกใน `/join` จากอีกแท็บ หน้าต่าง หรือเบราว์เซอร์ที่เปิดผ่าน Vite server ตัวเดียวกัน ห้องนี้จะไม่มี 3 กลุ่มตัวอย่างของ `MATANA`

ระหว่าง `npm run dev` และ `npm run preview` ข้อมูล Demo Mode จะแชร์ผ่าน Vite server และสำรองใน localStorage ทำให้หน้าต่างหรือเบราว์เซอร์คนละ storage context เข้าห้องเดียวกันได้ หากเป็น static hosting ที่ไม่มี endpoint นี้ ระบบจะ fallback เป็น localStorage; การใช้งานหลายอุปกรณ์จริงควรใช้ Firebase Mode หากต้องการเริ่ม Demo ใหม่ให้รีสตาร์ต server และลบ key `matana_demo_state_v2` ใน DevTools > Application > Local Storage

## ตั้งค่า Firebase Project

1. ไปที่ Firebase Console แล้วสร้างโปรเจกต์
2. เปิดเมนู **Build > Firestore Database**
3. กดสร้างฐานข้อมูล เลือก Region ใกล้ผู้ใช้ เช่น `asia-southeast1` และเลือก Production mode
4. ไปที่ **Build > Authentication > Sign-in method**
5. เปิดผู้ให้บริการ **Anonymous**
6. ไปที่ **Project settings > Your apps** แล้วสร้าง **Web App**
7. คัดลอกค่า Firebase config มาใส่ `.env.local`

ตัวอย่าง `.env.local`:

```env
VITE_DEMO_MODE=false
VITE_FIREBASE_API_KEY=ค่าจาก_Firebase
VITE_FIREBASE_AUTH_DOMAIN=ชื่อโปรเจกต์.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=ชื่อโปรเจกต์
VITE_FIREBASE_STORAGE_BUCKET=ชื่อโปรเจกต์.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=ตัวเลขจาก_Firebase
VITE_FIREBASE_APP_ID=ค่าจาก_Firebase
```

ค่า Firebase Web config ไม่ใช่ server secret แต่ควรจำกัด API key ตามโดเมนที่ใช้ และห้ามใส่ service-account key ในเว็บหรือใน repository

## Deploy Firestore Rules

ติดตั้ง Firebase CLI และ login ก่อน:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
firebase deploy --only firestore:rules
```

ตรวจ `firestore.rules` และทดสอบด้วย Firebase Emulator ก่อนใช้กับคะแนนจริงทุกครั้ง

## Production build

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

ไฟล์พร้อม deploy จะอยู่ใน `dist/` และทุกแพลตฟอร์มต้อง rewrite route ที่ไม่พบกลับไป `index.html`

## Deploy Firebase Hosting

```bash
firebase init hosting
```

เลือกโปรเจกต์เดิม, public directory เป็น `dist`, ตอบ Yes สำหรับ single-page app และอย่าเขียนทับ `index.html` จากนั้น:

```bash
npm run build
firebase deploy --only hosting
```

ไฟล์ `firebase.json` ในโปรเจกต์ตั้งค่า SPA rewrite ไว้แล้ว

## Deploy Vercel

1. นำ repository เข้า Vercel
2. Framework Preset: Vite
3. Build Command: `npm run build`
4. Output Directory: `dist`
5. เพิ่ม environment variables ชุดเดียวกับ `.env.local`
6. Deploy แล้วทดสอบการ refresh ทุก route

ไฟล์ `vercel.json` มี SPA rewrite ให้แล้ว

## วิธีใส่ข้อสอบจริง

แก้ไฟล์ `src/data/questions.ts` โดยคงโครงสร้าง `Question` และ ID ไม่ซ้ำกัน แต่ละข้อมีตัวเลือก 4 ตัวและ `correctChoiceId` ตรงกับตัวเลือกหนึ่งตัว

คลังต้องมีคำถามเพียงพอต่อสัดส่วนหนึ่งรอบ:

- `basic` 2 ข้อ
- `characters` 2 ข้อ
- `plot` 3 ข้อ
- `poetry` 2 ข้อ
- `theme` 1 ข้อ

ควรมีมากกว่าขั้นต่ำในทุกหมวดเพื่อให้รอบใหม่เปลี่ยนชุดคำถาม ปัจจุบันมีข้อสอบตัวอย่าง 25 ข้อและมี TODO ชัดเจน ควรให้ครูภาษาไทยตรวจเนื้อหาและความถูกต้องก่อนใช้ประเมินผลจริง

ระบบสุ่มเพียงครั้งเดียวเมื่อเตรียมรอบ แล้วบันทึก `questionIds` ที่ห้อง ทุกกลุ่มจึงได้รับลำดับคำถามและลำดับตัวเลือกเดียวกัน

## ไฟล์ภาพ PNG

เว็บอ้างอิงไฟล์ต่อไปนี้โดยตรงและไม่ใช้ URL ภายนอก:

- `public/images/hero-curse.png`
- `public/images/ending-fail.png`
- `public/images/ending-almost.png`
- `public/images/ending-win.png`

เปลี่ยนภาพได้โดยใช้ชื่อและนามสกุล `.png` เดิม แนะนำอัตราส่วนกว้างประมาณ 16:9 และวางตัวละครหลักใกล้กึ่งกลางเพื่อไม่ถูกตัดบนมือถือ UI มี gradient fallback, overlay และ `object-fit: cover` อยู่แล้ว

ภาพปัจจุบันไฟล์ละประมาณ 2–3 MB หากต้องการลดขนาดโดยไม่เสียคุณภาพ ให้สำรองไฟล์ก่อนแล้วใช้ `oxipng -o 4 public/images/*.png` ซึ่งเป็น lossless optimization จากนั้นเปิดตรวจทั้ง 4 ภาพและเปรียบเทียบ checksum/ขนาดตามกระบวนการของโรงเรียน และคงรูปแบบไฟล์ PNG ไว้ทุกจุด

## Data model ย่อ

```text
rooms/{roomCode}
  status, currentRound, questionIds, previousQuestionIds,
  startedAt, completedAt, currentQuestionIndex,
  questionDurationSeconds, questionStartedAt, teacherSessionId

rooms/{roomCode}/teams/{teamId}
  teamName, guardianName, ownerUid, currentRound,
  currentQuestionIndex, score, answers, submitted,
  finishedAt, elapsedMs, status
```

คะแนน คำตอบ สถานะห้อง คำถามปัจจุบัน และเวลาเริ่มคำถามอ่านจาก Firestore เป็นหลัก localStorage เก็บเฉพาะตัวระบุ session และชื่อที่ใช้พากลับสู่ route ที่ถูกต้อง

## ความปลอดภัยและข้อจำกัดของ MVP

- ใช้ Anonymous Authentication จึงไม่มีบัญชีครูที่ยืนยันตัวตนถาวร `teacherSessionId` ผูกกับ anonymous uid ของเบราว์เซอร์นั้น ไม่ใช่ระบบ authorization ระดับ production
- คลังคำถามและการตรวจคำตอบอยู่ฝั่ง client ผู้ที่เปิด DevTools สามารถดูข้อมูลหรือแก้ client ได้ จึงเหมาะกับกิจกรรมในชั้นเรียนที่ครูดูแล ไม่เหมาะกับการสอบเดิมพันสูง
- transaction และ rules จำกัดให้นักเรียนแก้ได้เฉพาะคำตอบและคะแนนของทีมตนเอง โดยครูเป็นผู้เดินคำถามกลางเมื่อหมดเวลา แต่ยังไม่สามารถยืนยันความถูกต้องของคำตอบจาก trusted backend ได้เต็มรูปแบบ
- ผู้ใช้ anonymous ที่ทราบรหัสห้องอ่าน room document ได้ Rules อนุญาตเช่นนี้เพื่อให้เข้าร่วมด้วยรหัส 6 ตัวได้ ส่วนข้อมูลทีมอ่านได้เฉพาะเจ้าของทีมหรือครูของห้อง
- ชื่อกลุ่มถูกแปลงเป็น team ID แบบคงที่เพื่อกันชื่อซ้ำใน transaction แต่ไม่ใช่ระบบระบุตัวบุคคล
- หากใช้เพื่อการสอบจริง ควรย้ายคลังข้อสอบ การตรวจคำตอบ และการควบคุมเวลาไป Cloud Functions หรือ backend ที่เชื่อถือได้ และเพิ่มบัญชีครูพร้อม custom claims

## การกู้สถานะและข้อผิดพลาด

- Refresh ระหว่าง lobby/game/result: ระบบอ่าน room, คำถามปัจจุบัน, deadline และ team จาก Firestore แล้วพาไป route ตามสถานะ
- อินเทอร์เน็ตหลุด: หน้าแสดงข้อความภาษาไทย ไม่แสดง stack trace และ Firestore จะเชื่อมใหม่เมื่อเครือข่ายกลับมา
- ชื่อกลุ่มซ้ำ: เลือกชื่อใหม่ในห้องเดิม
- เข้าไม่ได้หลังเริ่มเกม: ครูต้องเตรียมรอบใหม่ หรือผู้เรียนรอรอบถัดไป
- Anonymous Auth ล้มเหลว: ตรวจว่าเปิด provider แล้ว ตรวจโดเมนที่อนุญาต และกดลองเชื่อมต่ออีกครั้ง
- Firebase permission denied: deploy `firestore.rules`, ตรวจ Project ID และตรวจว่า Anonymous Authentication เปิดอยู่
- Route 404 หลัง deploy: ตั้ง SPA rewrite ไป `/index.html` ตาม `firebase.json` หรือ `vercel.json`
- ภาพไม่ขึ้น: ตรวจตัวพิมพ์เล็ก-ใหญ่และนามสกุล `.png` ทั้ง 4 ไฟล์
- ห้องเรียน Wi‑Fi ช้า: เปิดทุกเครื่องและเข้าห้องล่วงหน้า ทดสอบกับเครือข่ายจริง และหลีกเลี่ยงการ refresh พร้อมกันจำนวนมาก

## Checklist ก่อนใช้จริงในห้องเรียน

- [ ] 1. เปิดหน้าครูบนคอม 1 เครื่อง
- [ ] 2. สร้างห้อง
- [ ] 3. เปิดหน้าผู้เรียนอย่างน้อย 3 เครื่องหรือ 3 หน้าต่าง
- [ ] 4. เข้าห้องเดียวกัน
- [ ] 5. ตรวจว่ารายชื่อกลุ่มปรากฏบนหน้าครู
- [ ] 6. กำหนดเวลาต่อข้อแล้วกดเริ่มเกม
- [ ] 7. ตรวจว่าทุกกลุ่มได้คำถามข้อแรกเหมือนกัน
- [ ] 8. ตรวจว่าทุกกลุ่มได้ลำดับคำถามเหมือนกัน
- [ ] 9. ตอบหนึ่งกลุ่มทันทีและอีกกลุ่มช่วงท้าย ยืนยันทั้งสองยังเปลี่ยนข้อพร้อมกัน
- [ ] 10. ปล่อยหนึ่งกลุ่มไม่ตอบบางข้อ ยืนยันระบบข้ามข้อเมื่อหมดเวลา
- [ ] 11. ตรวจว่าหลังหมดเวลาแต่ละข้อ จอนักเรียนแสดงถูก/ผิดและคะแนนสะสม 4 วินาทีก่อนเปลี่ยนข้อ
- [ ] 12. ระหว่างเล่น ตรวจว่าหน้าครูยังไม่เพิ่มคะแนนของข้อปัจจุบันก่อนหมดเวลา จากนั้นเปิดคะแนนและเรียงอันดับใหม่พร้อมช่วงเฉลยของนักเรียน
- [ ] 13. ตรวจว่าจอนักเรียนแต่ละเครื่องเห็นเฉพาะคะแนนกลุ่มตนเอง
- [ ] 14. ตรวจว่าไม่มีข้อมูลคะแนนกลุ่มอื่นบนจอนักเรียน
- [ ] 15. ตรวจเวลาต่อข้อทั้งหน่วยวินาทีและนาที
- [ ] 16. Refresh ระหว่างจับเวลาและยืนยันกลับมาที่ข้อ/เวลาปัจจุบัน
- [ ] 17. กดหยุดเกมฉุกเฉินระหว่างเล่นและยืนยันทุกจอกลับ lobby รายชื่อเดิมยังอยู่ คะแนน/คำตอบถูก reset
- [ ] 18. เปลี่ยนคำตอบจากผิดเป็นถูกและจากถูกเป็นผิดก่อนหมดเวลา ยืนยันมีคำตอบเดียวและคะแนนใช้ตัวเลือกล่าสุด จากนั้นยืนยันเปลี่ยนไม่ได้หลังหมดเวลา
- [ ] 17. กดเตรียมรอบใหม่
- [ ] 18. ตรวจว่ารายชื่อกลุ่มยังอยู่
- [ ] 19. กดเริ่มรอบใหม่
- [ ] 20. ตรวจว่าคำถามเปลี่ยนจากรอบก่อน
- [ ] 21. ทดสอบ refresh ระหว่าง lobby
- [ ] 22. ทดสอบ refresh ระหว่าง game
- [ ] 23. ทดสอบ refresh หน้า result
- [ ] 24. ทดสอบ refresh หลังจบรอบและดูคะแนน
- [ ] 25. ทดสอบอินเทอร์เน็ตหลุดชั่วคราว
- [ ] 26. ทดสอบบนมือถือจริง
- [ ] 27. ทดสอบบน Wi‑Fi ที่จะใช้จริง
- [ ] 28. ตรวจว่าไฟล์ PNG โหลดครบทั้ง 4 ภาพ
- [ ] 29. ตรวจ fallback โดยทดลองเปลี่ยนชื่อภาพชั่วคราว แล้วเปลี่ยนกลับก่อน build
- [ ] 30. ตรวจ production build ก่อน deploy

## ข้อแนะนำก่อนเปิดห้อง

ให้ครูสร้างและควบคุมห้องจากเบราว์เซอร์เดิมตลอดกิจกรรม เพราะ anonymous uid และ `teacherSessionId` อยู่กับ browser profile นั้น เตรียมอุปกรณ์สำรอง 1 เครื่อง ตรวจไฟและ Wi‑Fi และเก็บรหัสห้องไว้บนกระดานจนทุกกลุ่มเข้าร่วมครบ
