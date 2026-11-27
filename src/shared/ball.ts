/** Orb preferences, stored in `ball.json` rather than the settings file. */

export interface BallSettings {
  visible: boolean
  /** Diameter in CSS pixels. */
  size: number
  /** Hide the orb while a fullscreen application owns the foreground. */
  hideInFullscreen: boolean
  /**
   * Ask action the orb opens. `null` means "the first enabled Ask action",
   * which is what builds before this setting did.
   */
  askActionId: string | null
}

export interface BallSettingsUpdate {
  visible?: boolean
  size?: number
  hideInFullscreen?: boolean
  /** Empty string clears the selection. */
  askActionId?: string
}

/** The three sizes offered in the orb section and the tray submenu. */
export const BALL_SIZE_OPTIONS = [
  { value: 44, label: '小' },
  { value: 56, label: '中' },
  { value: 72, label: '大' }
] as const

export const BALL_SIZE_MIN = 44
export const BALL_SIZE_MAX = 108

/** Snaps a stored or requested diameter to the nearest offered size. */
export function nearestBallSize(value: number): number {
  if (!Number.isFinite(value)) return 56
  const clamped = Math.min(Math.max(value, BALL_SIZE_MIN), BALL_SIZE_MAX)
  return BALL_SIZE_OPTIONS.reduce<number>(
    (best, option) =>
      Math.abs(option.value - clamped) < Math.abs(best - clamped) ? option.value : best,
    BALL_SIZE_OPTIONS[1].value
  )
}
