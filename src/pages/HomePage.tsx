import { Link } from 'react-router-dom'

// Home deliberately does NOT use ScenePage: that wrapper layers a fallback gradient, a scene
// overlay and a vignette tuned for the old hero art, which would fight the approved background.
// Home owns its own stacking instead — background, scrim, characters and logo are each an
// independent layer so they can be scaled and repositioned separately per breakpoint.
//
// Routes and actions are unchanged from the previous Home: /join for learners, /teacher for the
// teacher. No game logic is touched here.
export const HomePage = () => (
  <main className="home-page">
    <img className="home-bg" src="/assets/home/home-bg.png" alt="" aria-hidden="true" />
    <div className="home-scrim" aria-hidden="true" />

    {/* Character artwork is its own positioned layer, not a background of the content column,
        so breakpoints can move/scale it without shrinking the copy or the actions. */}
    <img
      className="home-characters"
      src="/assets/home/home-characters.png"
      alt="ตัวละครจากเรื่องมัทนะพาธา"
    />

    {/* The course label is a banner across the top of the composition rather than part of the
        left column, so it reads as a header for the whole screen. */}
    <p className="home-eyebrow">วรรณคดีไทย · มัธยมศึกษาปีที่ ๕</p>

    <div className="home-layout">
      <section className="home-copy">
        {/* The approved logo carries the title artwork; the heading stays in the DOM for
            screen readers and document outline without visually duplicating it. */}
        <h1 className="home-logo-heading">
          <span className="sr-only">มัทนาต้องรอด — ภารกิจคลายคำสาป</span>
          <img className="home-logo" src="/assets/home/home-logo.png" alt="" aria-hidden="true" />
        </h1>

        <p className="home-lede">
          ภารกิจคลายคำสาปจากวรรณคดีเรื่อง <strong>มัทนะพาธา</strong>
        </p>

        <div className="home-actions">
          <Link className="home-cta-primary" to="/join">เริ่มเล่น</Link>
          <Link className="home-cta-text" to="/teacher">สำหรับครู →</Link>
        </div>
      </section>
    </div>
  </main>
)
