import type { BackgroundMusicControls as Controls } from '../hooks/useBackgroundMusic'

interface BackgroundMusicControlsProps {
  controls: Controls
}

// Compact, persistent BGM control for the teacher screen. Rendered as a small fixed pill so it
// survives every stage transition — the room-control header it would otherwise live in is hidden
// once Main starts, and the teacher still needs to reach mute/volume mid-lesson.
//
// Purely presentational: every button mutates the existing audio element through the hook, so
// nothing here can restart the track.
export const BackgroundMusicControls = ({ controls }: BackgroundMusicControlsProps) => {
  const { isPlaying, muted, volume, toggleMute, volumeUp, volumeDown } = controls
  if (!isPlaying) return null

  const volumePercent = Math.round(volume * 100)

  return (
    <div className="bgm-controls" role="group" aria-label="เสียงเพลงประกอบ">
      <button
        type="button"
        className="bgm-button"
        onClick={toggleMute}
        aria-pressed={muted}
        title={muted ? 'เปิดเสียงเพลง' : 'ปิดเสียงเพลง'}
      >
        {muted ? '🔇' : '🎵'}
      </button>
      <button
        type="button"
        className="bgm-button"
        onClick={volumeDown}
        disabled={volume <= 0}
        title="ลดเสียง"
        aria-label="ลดเสียง"
      >
        −
      </button>
      <span className="bgm-level" aria-live="off">{muted ? 'ปิด' : `${volumePercent}%`}</span>
      <button
        type="button"
        className="bgm-button"
        onClick={volumeUp}
        disabled={volume >= 1}
        title="เพิ่มเสียง"
        aria-label="เพิ่มเสียง"
      >
        +
      </button>
    </div>
  )
}
