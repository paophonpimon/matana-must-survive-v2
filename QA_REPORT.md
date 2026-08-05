# รายงาน QA ก่อนใช้งานจริง — มัทนาต้องรอด

วันที่ตรวจ: 15 กรกฎาคม 2026  
ขอบเขต: Demo Mode, โครงสร้าง Firebase Mode, production build, assets, routes, classroom flow, refresh recovery, responsive CSS, accessibility และ Firestore rules

## สรุปผล

- `npm run lint`: ผ่าน ไม่มี error
- `npm run typecheck`: ผ่าน หลังแก้ type narrowing ใน test harness ใหม่
- `npm run test`: ผ่าน 3 ไฟล์ รวม 22/22 tests
- `npm run build`: ผ่าน, Vite build สำเร็จ 79 modules
- Production preview: ทุก route และภาพ PNG ทั้ง 4 เส้นทางตอบ HTTP 200
- พบปัญหาที่แก้ได้ในโปรเจกต์ 20 รายการ และแก้ครบแล้ว

หมายเหตุ: เครื่องนี้ไม่มี npm ติดตั้งแบบ global จึงเรียก npm 11.4.2 ผ่าน temporary package runner โดย script ที่ทำงานจริงยังเป็น `npm run lint`, `npm run typecheck`, `npm run test` และ `npm run build` ตามลำดับ

## ผลการตรวจ 45 รายการ

| # | สิ่งที่ทดสอบ | ผล | หลักฐาน/วิธีตรวจ |
| --- | --- | --- | --- |
| 1 | ไฟล์ภาพอ้างอิงเป็น PNG เท่านั้น | ผ่าน | ตรวจ `public/images`, source และ README; ไม่พบไฟล์รูปนามสกุลอื่น |
| 2 | เส้นทางภาพ 4 ไฟล์ | ผ่าน | production preview ตอบ 200 ครบ: hero, fail, almost, win |
| 3 | ค้นหานามสกุลภาพต้องห้ามทั้งโปรเจกต์ | ผ่านหลังแก้ | ลบข้อความที่เหลือใน README แล้วค้นซ้ำไม่พบ |
| 4 | lint | ผ่าน | ESLint exit code 0 |
| 5 | typecheck | ผ่าน | `tsc -b --pretty false` exit code 0 |
| 6 | tests | ผ่าน | Vitest 22/22 tests, 3/3 files |
| 7 | production build | ผ่าน | `tsc -b && vite build`, exit code 0 |
| 8 | error และ warning สำคัญ | ผ่านหลังแก้ | แก้ scoring trust, invalid choice, text overflow, dialog description และ test typing |
| 9 | ทุก route | ผ่าน | HTTP/SPA fallback ตอบ 200 สำหรับ `/`, `/teacher`, `/join`, lobby, game, result, congratulations, closed และ not-found |
| 10 | Demo Mode | ผ่าน | behavioral tests ครอบคลุม create/join/start/timed answer/shared advance/deadline/score summary/reset/closed/missing room และ join ข้าม browser storage context |
| 11 | Firebase Mode | ผ่านระดับโครงสร้าง | ตรวจ anonymous auth, snapshot listeners, transactions, batches และ error callbacks; ต้องยืนยันกับ Firebase project จริงตามข้อจำกัด |
| 12 | responsive 360/390/768/desktop | ผ่านระดับ CSS | มี breakpoint 639/640, min-width 320, fluid widths, clamp และ overflow protection; การตรวจบนเครื่องจริงอยู่ใน checklist ด้านล่าง |
| 13 | ข้อความไทยไม่ล้นปุ่ม | ผ่านหลังแก้ | เพิ่ม `min-width: 0` และ `overflow-wrap: anywhere` ให้ปุ่ม/ข้อความยาว |
| 14 | PNG ไม่ดัน layout | ผ่าน | ภาพใช้ `position: fixed`, เต็ม viewport และ `object-fit: cover`; ทุกภาพ 1672×941 |
| 15 | fallback เมื่อภาพโหลดไม่ได้ | ผ่านระดับโครงสร้าง | มี gradient fallback อยู่หลังภาพ และ `onError` ซ่อนภาพที่โหลดล้มเหลว |
| 16 | refresh ระหว่าง waiting | ผ่านระดับ state recovery | session คงอยู่และ resolver ส่งกลับ lobby จาก room status |
| 17 | refresh ระหว่าง playing | ผ่านระดับ state recovery | subscribe room/team ใหม่และ resolver ส่งไป game |
| 18 | refresh หลัง submitted | ผ่านระดับ state recovery | team `submitted` ส่งไป result |
| 19 | refresh หลังหมดเวลา | ผ่านระดับ state recovery | room completed ส่งนักเรียนกลับ result ของทีมตนเอง; waiting รอบใหม่ส่งกลับ lobby |
| 20 | ทุกกลุ่มได้ questionIds ชุดเดียวกัน | ผ่าน | ชุดคำถามเก็บครั้งเดียวที่ room; behavioral test เทียบ array ของหลายทีม |
| 21 | สุ่มครั้งเดียวต่อรอบ | ผ่าน | สุ่มตอน create room/prepare next round เท่านั้น ไม่สุ่มใน team หรือ GamePage |
| 22 | ทุกกลุ่มได้ลำดับเดียวกัน | ผ่าน | ทุกทีมอ่าน `room.questionIds[currentQuestionIndex]` ชุดเดียวกัน |
| 23 | ทุกกลุ่มใช้เวลาเท่ากัน | ผ่าน | เวลาเริ่มและระยะเวลาต่อข้อเก็บระดับ room; automated test ยืนยันตอบเร็วไม่เลื่อนข้อเอง |
| 24 | หมดเวลาแล้วตอบไม่ได้ | ผ่าน | UI ล็อกที่ศูนย์วินาทีและ Demo/Firebase service ตรวจ deadline ก่อนบันทึก; behavioral test ครอบคลุม |
| 25 | สองกลุ่มส่งพร้อมกัน | ผ่านระดับ Firebase transaction | แต่ละทีมเขียน document ของตนผ่าน transaction โดยไม่เปลี่ยนคำถามกลาง |
| 26 | ไม่มีการแข่งขันด้านความเร็ว | ผ่าน | ตัด winner claim ออกจาก service/rules; ครูเป็นผู้ advance คำถามกลางเมื่อ deadline ถึง |
| 27 | ครูเห็นคะแนนรวมทุกกลุ่ม | ผ่านระดับ realtime UI/state | TeacherPage ซ่อนคะแนนข้อปัจจุบันระหว่างเวลาตอบ แล้วเปิดคะแนนและจัดอันดับใหม่เมื่อเข้าช่วงเฉลยพร้อมนักเรียน พร้อมสถานะตอบ จำนวนข้อ และภาพรวมคะแนน |
| 28 | นักเรียนเห็นเฉพาะคะแนนตนเอง | ผ่านระดับ UI/rules | GamePage แสดงถูก/ผิดและคะแนนสะสมของทีมหลังหมดเวลา 4 วินาที; ResultPage และ rules จำกัดข้อมูลทีมอื่น |
| 29 | จบเวลาแล้วทุก student ไป result | ผ่านระดับ realtime logic | GamePage ฟัง room completed แล้ว replace route ไป result โดยไม่ใช้ winner |
| 30 | เริ่มรอบใหม่ | ผ่าน | teacher prepare แล้ว start; reset เพิ่มหมายเลขรอบและเลือกชุดใหม่ |
| 31 | รายชื่อกลุ่มไม่หาย | ผ่าน | reset update team documents/objects เดิม ไม่ลบทีม; behavioral test ยืนยัน team id เดิม |
| 32 | คะแนนและคำตอบ reset | ผ่าน | score/index เป็น 0, answers ว่าง, submitted false, status waiting; behavioral test ยืนยัน |
| 33 | ชื่อกลุ่มซ้ำ | ผ่าน | Demo เปรียบเทียบแบบ trim+lowercase; Firebase ใช้ stable normalized team id; behavioral test มี case ซ้ำ |
| 34 | ช่องว่างหัวท้าย | ผ่าน | form และ service trim room/team/guardian; behavioral test ยืนยันค่าที่เก็บ |
| 35 | input เกิน 40 ตัวอักษร | ผ่าน | HTML `maxLength=40` และ validation test ครอบคลุม 40/41 ตัวอักษร |
| 36 | ห้องไม่พบ | ผ่าน | service reject และหน้าแสดง error panel; behavioral test ครอบคลุม |
| 37 | ห้องปิด | ผ่าน | join ถูกปฏิเสธ, connected pages ไป closed; behavioral test ครอบคลุม |
| 38 | network error | ผ่านระดับโครงสร้าง | Firebase listeners มี onError, actions catch และแปลงเป็นข้อความไทย; ต้องทดสอบตัด Wi-Fi จริง |
| 39 | ป้องกัน submit ซ้ำ | ผ่าน | UI กันการกดระหว่างกำลังบันทึก; ก่อน deadline service แทนที่คำตอบเดิมแทนการเพิ่ม record ซ้ำและคำนวณคะแนนใหม่ หลัง deadline ปฏิเสธทุกการแก้ไข; behavioral test ครอบคลุม |
| 40 | prefers-reduced-motion | ผ่าน | ลด animation/transition เหลือ 0.01ms และซ่อน petal field |
| 41 | accessibility เบื้องต้น | ผ่านหลังแก้ | semantic headings/labels, focus-visible, aria-live/alert, alt text, modal label+description และ disabled states |
| 42 | firestore.rules | ผ่านระดับโครงสร้าง | signed-in gate, teacher/team ownership, นักเรียนแก้ได้เฉพาะ answers/score และ deny delete; ต้องรัน Emulator/Deploy จริง |
| 43 | README ใช้ชื่อ PNG ถูกต้อง | ผ่าน | รายชื่อครบทั้ง 4 ไฟล์และไม่เหลือข้อความอ้างรูปแบบอื่น |
| 44 | README ตั้งค่า Firebase ครบ | ผ่าน | ครบ Firestore, Anonymous Auth, Web App config, env 6 ค่า, deploy rules และ hosting |
| 45 | production build ใช้งานได้ | ผ่าน | build สำเร็จ; production preview routes และ images ตอบ 200 |

## ปัญหาที่พบและแก้แล้ว

1. README ยังมีข้อความอ้างนามสกุลภาพอื่น — แก้ให้ระบุใช้ PNG เท่านั้นและค้นซ้ำทั้งโปรเจกต์แล้วไม่พบ
2. Service เดิมรับ `isCorrect` จาก client — ลบ field นี้จาก API และคำนวณจาก question bank ภายใน Demo/Firebase service
3. Service เดิมไม่ปฏิเสธ choice id ที่ไม่มีจริง — เพิ่ม validation ก่อนบันทึกคะแนน
4. ข้อความไทยยาว/ชื่อกลุ่มยาวมีโอกาสล้น control — เพิ่ม wrapping และ min-width protection
5. Confirm dialog ไม่มี description relation — เพิ่ม `aria-describedby`
6. Test เดิมยังไม่ครอบคลุม classroom flow สำคัญ — เพิ่ม Demo behavioral suite, timed question-flow suite และ boundary tests ทำให้รวมเป็น 22 tests
7. ห้องสาธิต `MATANA` ค้างสถานะปิดจาก `localStorage` — เพิ่มการรีเซ็ตห้องสาธิตให้กลับเป็น waiting พร้อม 3 กลุ่มตัวอย่างจากทั้งหน้าสร้างห้องและหน้าห้องปิด
8. React StrictMode เรียก effect cleanup ระหว่าง development แล้ว `mounted` ค้างเป็น false ทำให้ feedback/saving ไม่ถูก reset หลังตอบข้อแรก — ตั้งค่า mounted ใหม่ทุก effect setup, จัดการ timeout ตอน unmount และใช้ผล `saveAnswer` เป็น optimistic progress จน realtime snapshot ตามทัน
9. หน้า Teacher ของ Demo Mode ไม่มีทางสร้างห้องว่างใหม่เมื่อเปิด `MATANA` อยู่ — เพิ่มปุ่ม “สร้างห้องทดสอบใหม่” ที่เรียก flow `createRoom()` เดิมและอัปเดต README วิธีทดสอบแบบครูหนึ่งแท็บ/นักเรียนหนึ่งแท็บ
10. ห้อง Demo ที่สร้างเองพบจากหน้าครู แต่หน้า Join ใน browser storage คนละชุดแจ้งว่าไม่พบรหัส — เพิ่ม shared Demo state endpoint ใน Vite dev/preview, polling สำหรับ realtime ข้าม context, localStorage fallback และ automated test จำลอง storage แยกกัน
11. กติกาเดิมตัดสินผู้ชนะจากทีมแรกที่ได้ 9+ ทำให้เวลาแต่ละทีมไม่เท่ากัน — เปลี่ยนเป็น timer ระดับห้อง ครูกำหนดเวลาต่อข้อ ทุกทีมเปลี่ยนข้อพร้อมกัน จอครูเห็นคะแนนทุกกลุ่มแบบ realtime และจอนักเรียนแสดงเฉพาะทีมตนเอง
12. Timed flow เดิมเปลี่ยนข้อทันทีเมื่อหมดเวลา ทำให้นักเรียนไม่เห็นผลคำตอบ — เพิ่มช่วง reveal 4 วินาที แสดงถูก/ผิดหรือไม่ได้ตอบ พร้อมคะแนนสะสมของทีมก่อนเปลี่ยนข้อพร้อมกัน
13. จอครูเดิมแสดงเพียงสถานะระหว่างเล่นและสรุปคะแนนเป็นรายการธรรมดาหลังจบรอบ — เปลี่ยนเป็นกระดานคะแนนสด เรียงอันดับตามคะแนน แสดงคะแนนตัวใหญ่ ความคืบหน้า สถานะคำตอบ คะแนนสูงสุด คะแนนเฉลี่ย และจำนวนกลุ่ม
14. จอครูระหว่างเล่นยังเสียพื้นที่ให้ส่วนควบคุมและข้อมูลรอง ทำให้กระดานอ่านยากเมื่อสะท้อนจากแท็บเล็ตขึ้นจอใหญ่ — เพิ่ม broadcast mode อัตโนมัติ ย่อส่วนหัว/ข้อมูลห้อง ซ่อนปุ่มระหว่างเกม ขยายกระดานเต็มพื้นที่ และขยายชื่อกับคะแนนของทุกกลุ่มที่ครองอันดับนำ จากนั้นคืนส่วนควบคุมเมื่อจบรอบ
15. คะแนนที่บันทึกทันทีเมื่อทีมตอบถูกทำให้จอครูเห็นคะแนนและอันดับก่อนจอนักเรียนเข้าสู่ช่วงเฉลย — เพิ่ม teacher-visible score ซึ่งซ่อนแต้มของข้อปัจจุบันระหว่างเวลาตอบ และเปิดแต้มพร้อมนักเรียนเมื่อ deadline ถึง รวมทั้งใช้คะแนนที่เปิดเผยแล้วเท่านั้นในการเรียงอันดับ
16. อันดับหน้าชื่อกลุ่มยังเป็นวงกลมธรรมดาและอ่านสถานะผู้นำจากจอใหญ่ได้ไม่ชัด — เปลี่ยนเป็นตราโล่ SVG สีทอง/เงิน/ทองแดง พร้อมดาวสำหรับทุกกลุ่มที่ครองอันดับนำ
17. Broadcast mode ซ่อนปุ่มควบคุมทั้งหมด ทำให้ครูไม่สามารถกู้รอบที่ค้างได้ — เพิ่มปุ่ม “หยุดเกม” แบบลอยตลอดช่วงเล่น พร้อม dialog ยืนยัน; คำสั่งใหม่หยุดรอบ สุ่มคำถามใหม่ reset คะแนน/คำตอบ และพาทุก client กลับ lobby โดยเก็บรายชื่อกลุ่มเดิม
18. ตัวล็อก auto-advance เดิมไม่ปล่อยเมื่อ service ตอบสำเร็จแต่ snapshot ไม่เปลี่ยน ทำให้ครูอาจค้างที่ข้อเดิมถาวร — เพิ่ม watchdog ให้ลอง advance ซ้ำหลัง 3 วินาที โดย service ยังคงตรวจ expected question index เพื่อป้องกันการข้ามข้อซ้ำ
19. หน้าสรุปครูเดิมให้ความสำคัญกับรายการคะแนนเท่ากันทั้งหมดและไม่มีบรรยากาศฉลอง — เพิ่มเวทีประกาศอันดับ 1 ขนาดใหญ่ พลุ แสงรัศมี เหรียญ คะแนน และการ์ดอันดับ 2–3 พร้อมรองรับอันดับหนึ่งร่วมและ `prefers-reduced-motion`
20. นักเรียนกดคำตอบผิดแล้วแก้ไม่ได้แม้เวลายังเหลือ — เปลี่ยน Demo/Firebase transaction ให้แทนที่คำตอบของข้อปัจจุบันและปรับคะแนนตามคำตอบล่าสุด UI เปิดตัวเลือกจนหมดเวลา และแก้ Firestore rules ให้ยอมรับการแทนที่หนึ่ง record โดยยังล็อก deadline/current question

## ไฟล์ที่แก้

- `README.md`
- `src/components/Layout.tsx`
- `src/styles.css`
- `src/pages/GamePage.tsx`
- `src/pages/TeacherPage.tsx`
- `src/pages/ResultPage.tsx`
- `src/types/game.ts`
- `src/lib/game.ts`
- `src/lib/game.test.ts`
- `src/lib/gameFlow.ts`
- `src/lib/gameFlow.test.ts`
- `src/services/gameService.ts`
- `src/services/demoService.ts`
- `src/services/firebaseService.ts`
- `firestore.rules`
- `src/services/demoService.test.ts` (เพิ่มใหม่)
- `vite.config.ts`
- `QA_REPORT.md`

## ข้อจำกัดที่ยังเหลือ

1. ไม่มี Firebase environment/project จริงใน workspace จึงยังไม่ได้ทดสอบ auth, permission, transaction retry และ realtime ข้ามหลายอุปกรณ์กับ backend จริง
2. ตามคำสั่งผู้ใช้ หยุด browser automation แล้ว การตรวจ responsive และ refresh ใช้ CSS/state/tests/HTTP แทน จึงยังต้องยืนยันภาพจริงบนอุปกรณ์
3. PNG มีขนาดประมาณ 2.2–2.8 MB ต่อไฟล์ แม้ไม่ทำให้ layout shift แต่อาจโหลดช้าบน Wi-Fi ห้องเรียน; README มีขั้นตอน lossless optimization
4. Firestore rules จำกัด ownership และการแก้ field แล้ว แต่คำตอบที่ถูกต้องและ deadline ยังเป็น logic ฝั่งเว็บ หากใช้เป็นข้อสอบที่มีผลคะแนนจริงควรย้าย scoring/timer ไป trusted backend/Cloud Function
5. Anonymous Authentication ไม่ใช่บัญชีครูถาวร ต้องสำรองแผนกรณี browser storage ถูกล้างหรือเปลี่ยนเครื่องครู

## ขั้นตอนที่ผู้ใช้ต้องทำด้วยมือ

1. สร้าง Firebase project, เปิด Firestore และ Anonymous Authentication
2. ใส่ค่า `.env.local` ครบทุกตัวและตั้ง `VITE_DEMO_MODE=false`
3. Deploy `firestore.rules` และทดสอบด้วย Firebase Emulator Suite ก่อน deploy ห้องเรียน
4. เปิดครู 1 เครื่องและนักเรียนอย่างน้อย 3 เครื่องบน Wi-Fi จริง
5. ให้สองกลุ่มตอบข้อเดียวกันคนละเวลา ยืนยันจอครูยังแสดงคะแนนเดิมระหว่างเวลาตอบ แล้วเปิดคะแนนและจัดอันดับใหม่พร้อมช่วงเฉลยบนจอนักเรียนเมื่อเวลาหมด
6. ตัด Wi-Fi ระหว่าง waiting/playing/result แล้วต่อใหม่ ตรวจข้อความ error และ realtime recovery
7. Refresh แต่ละเครื่องที่ waiting, playing, หลังตอบแล้วรอเวลา และ result หลังจบรอบ
8. ตรวจ Console/Firestore ว่าไม่มี permission-denied หรือ transaction error
9. ทดสอบปิดห้องและเริ่มรอบใหม่ ยืนยันรายชื่อทีมเดิมอยู่ คะแนน/คำตอบเป็นศูนย์
10. เตรียม Demo Mode เป็นแผนสำรองหากอินเทอร์เน็ตโรงเรียนล่ม

## Checklist ทดสอบบนมือถือจริงก่อนเข้าชั้นเรียน

ทดสอบอย่างน้อย 360px Android, 390px iPhone, 768px tablet และ desktop:

1. เปิด `/`, `/join`, `/lobby/{code}`, `/game/{code}`, `/result/{code}` และ `/congratulations/{code}`
2. ตรวจว่าไม่มี horizontal scroll และไม่มีข้อความไทยหลุดขอบปุ่ม/การ์ด
3. เปิด keyboard ในหน้า join ตรวจว่าช่องกรอกและปุ่ม submit ยังมองเห็นและกดได้
4. ใส่ชื่อไทยติดกัน 40 ตัวอักษร ตรวจว่าตัดบรรทัดโดยไม่ดัน layout
5. หมุน portrait/landscape ตรวจภาพยัง cover และข้อความสำคัญไม่ถูกบัง
6. เปิดโหมด Reduce Motion ของอุปกรณ์ ตรวจ spinner/petal/transition ไม่เคลื่อนไหวต่อเนื่อง
7. ทดสอบ Slow 3G หรือ Wi-Fi อ่อน ตรวจ gradient fallback แสดงระหว่างภาพยังไม่มา
8. ปิดการโหลดหนึ่งไฟล์ภาพชั่วคราวบน staging ตรวจว่าเนื้อหายังอ่านและกดได้
9. ทดสอบ VoiceOver/TalkBack: label ช่องกรอก, focus order, error message และ dialog ต้องอ่านเข้าใจได้
10. ทำ classroom rehearsal ครบหนึ่งรอบ: join → ตั้งเวลา → start → answer/timeout → score summary → next round → refresh
