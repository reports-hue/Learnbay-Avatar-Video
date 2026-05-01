/**
 * Intro Sting Service (T104) — animated logo reveal in the first ~1.6s.
 *
 * Visual choreography (when active):
 *   t=0.0–1.3s : Black blackout covers everything; large logo fades in centered
 *                at 1.6× scale (fade-in 0–0.4s, hold 0.4–1.0s, fade-out 1.0–1.4s).
 *   t=1.3–1.6s : Black blackout fades out; brand-accent vertical strip
 *                "swooshes" left→right across the frame; corner logo (existing
 *                top-right pill chip) fades in at 1.3–1.6s.
 *   t≥1.6s    : Normal video, corner logo holds, intro is over.
 *
 * Intro is gated to: `hasLogo === true` AND `durationSec >= 4`. Below 4s the
 * sting eats too much of the message so we skip it entirely (graph behavior is
 * unchanged — corner logo overlays from t=0 with no fade-in, no blackout,
 * no large logo, no swoosh).
 *
 * Implementation notes:
 *   - All position arithmetic is precomputed and emitted as plain numbers so
 *     the filter graph never relies on per-frame x/y eval (which is slow).
 *   - The large logo and corner logo come from the SAME `logoIdx` input via
 *     `split` — Azure jobs only supply ONE logo file, never two.
 *   - The blackout and swoosh are plain `color` inputs added at the input
 *     stage, hence the helpers need to know the input indices.
 *   - `format=yuva420p` + `fade=…:alpha=1` is used everywhere instead of the
 *     deprecated `geq` per-pixel approach — same correctness, ~10× faster.
 *   - Spec compliance: never per-pixel `geq`; preset stays ≤ fast.
 */

export interface IntroState {
  active: boolean;
  /** When the centered large logo finishes fading in. */
  largeLogoFadeInEnd: number;
  /** When the centered large logo starts fading out. */
  largeLogoFadeOutStart: number;
  /** When the centered large logo is fully gone. */
  largeLogoFadeOutEnd: number;
  /** Scale multiplier applied to the corner logo height to size the centered logo. */
  largeLogoScale: number;
  /** When the black blackout starts fading out. */
  blackoutFadeStart: number;
  /** When the blackout is fully gone. */
  blackoutFadeEnd: number;
  /** When the corner logo (existing pill chip) starts fading in from alpha=0. */
  cornerLogoFadeInStart: number;
  /** When the corner logo reaches full alpha. */
  cornerLogoFadeInEnd: number;
  /** When the brand-accent swoosh strip enters from off-screen left. */
  swooshStart: number;
  /** When the swoosh exits off-screen right. */
  swooshEnd: number;
  /** Width of the swoosh strip as a fraction of frame width. */
  swooshWidthFrac: number;
}

const INACTIVE: IntroState = {
  active: false,
  largeLogoFadeInEnd: 0,
  largeLogoFadeOutStart: 0,
  largeLogoFadeOutEnd: 0,
  largeLogoScale: 1,
  blackoutFadeStart: 0,
  blackoutFadeEnd: 0,
  cornerLogoFadeInStart: 0,
  cornerLogoFadeInEnd: 0,
  swooshStart: 0,
  swooshEnd: 0,
  swooshWidthFrac: 0,
};

/**
 * Compute the intro sting state. Active only when a logo is present AND the
 * total video is long enough that the 1.6s sting won't dominate.
 */
export function computeIntroState(durationSec: number, hasLogo: boolean): IntroState {
  if (!hasLogo || !Number.isFinite(durationSec) || durationSec < 4) {
    return INACTIVE;
  }
  return {
    active: true,
    largeLogoFadeInEnd: 0.4,
    largeLogoFadeOutStart: 1.0,
    largeLogoFadeOutEnd: 1.4,
    largeLogoScale: 1.6,
    blackoutFadeStart: 1.3,
    blackoutFadeEnd: 1.6,
    cornerLogoFadeInStart: 1.3,
    cornerLogoFadeInEnd: 1.6,
    swooshStart: 1.3,
    swooshEnd: 1.6,
    swooshWidthFrac: 0.30,
  };
}

/**
 * Convert a `#RRGGBB` hex (or `RRGGBB`) to FFmpeg `0xRRGGBB` form. Strips
 * leading `#`, uppercases, pads short forms.
 */
function toFfmpegHex(hex: string): string {
  const s = (hex ?? "").replace("#", "").toUpperCase().padEnd(6, "0").slice(0, 6);
  return `0x${s}`;
}

/**
 * Build the filter chain for the centered large logo overlay.
 *
 * Inputs:
 *   - `logoSrcLabel`: the looped, multi-frame logo stream label (e.g. "logo_v_b").
 *     MUST already have proper monotonically increasing PTS — the upstream loop
 *     preprocessor handles this. If you pass `[N:v]` directly (a still PNG with
 *     PTS=0 only), the fade filter sees the source AT THE START OF FADE-IN
 *     (alpha=0) and produces a fully-transparent output forever. This is why
 *     ffmpegService preprocesses the logo with `loop=-1,setpts=N/30/TB,fps=30`.
 *   - `cornerMaxH`: the max-H the existing corner logo would render at
 *   - `inputLabel`: the label of the video stream BEFORE this overlay (e.g. "with_blackout")
 *
 * Output label: `with_large_logo` (or whatever caller uses).
 *
 * Returns an array of filter strings ready to push into the complex filter graph.
 */
export function buildLargeLogoFilters(
  state: IntroState,
  logoSrcLabel: string,
  outW: number,
  outH: number,
  cornerMaxH: number,
  inputLabel: string,
  outputLabel: string,
): string[] {
  if (!state.active) return [];
  const largeH = Math.round(cornerMaxH * state.largeLogoScale);
  // Width cap: never let a wide wordmark overflow the frame. Without this,
  // `scale=w=-1:h=H` ignores `force_original_aspect_ratio` (the directive
  // only takes effect when BOTH w and h are positive integers) and a wide
  // logo (e.g. Libraryminds at ~5:1) renders at width = 5 × largeH which
  // can easily exceed `outW` on vertical 1080×1920 — the right edge gets
  // clipped at the frame boundary. We constrain to 80% of frame width with
  // 10% margin per side, then let `force_original_aspect_ratio=decrease`
  // pick whichever bound is binding (height for square logos, width for
  // wide wordmarks). Aspect ratio is preserved either way.
  const largeMaxW = Math.round(outW * 0.80);
  const fadeInDur = state.largeLogoFadeInEnd; // starts at t=0
  const fadeOutDur = state.largeLogoFadeOutEnd - state.largeLogoFadeOutStart;
  // Fly-in offset: logo rises from N px below centre to centre over 0.35s.
  // Using overlay's per-frame `y` expression (ffmpeg evaluates W/H/w/h/t
  // per frame for overlay). The y offset starts at +flyPx, eases to 0 by
  // t=0.35s and holds. `max(0,...)` clamps the overshoot at rest.
  const flyPx = Math.round(outH * 0.10); // 10 % of frame height
  const flyDur = 0.35;
  const yExpr = `'(H-h)/2+${flyPx}*max(0\\,1-t/${flyDur.toFixed(3)})'`;
  return [
    // Scale logo to the large size, fitting within (largeMaxW × largeH).
    // `force_original_aspect_ratio=decrease` shrinks to fit BOTH bounds
    // while preserving aspect ratio. format=yuva420p preserves alpha.
    `[${logoSrcLabel}]scale=w=${largeMaxW}:h=${largeH}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd,format=yuva420p[large_logo_scaled]`,
    // Fade in 0→largeLogoFadeInEnd, then fade out largeLogoFadeOutStart→largeLogoFadeOutEnd.
    `[large_logo_scaled]fade=t=in:st=0:d=${fadeInDur.toFixed(3)}:alpha=1,fade=t=out:st=${state.largeLogoFadeOutStart.toFixed(3)}:d=${fadeOutDur.toFixed(3)}:alpha=1[large_logo_anim]`,
    // Centre horizontally; fly-in from below (y eases from +flyPx → 0 over flyDur).
    `[${inputLabel}][large_logo_anim]overlay=x='(W-w)/2':y=${yExpr}:format=auto[${outputLabel}]`,
  ];
}

/**
 * Build the filter chain for the black blackout overlay covering the entire
 * frame for the first `blackoutFadeStart` seconds, then fading out.
 *
 * Inputs:
 *   - `blackoutIdx`: ffmpeg input index of a `color=c=black:s=outWxoutH` source
 *   - `inputLabel` / `outputLabel`: video stream labels
 */
export function buildBlackoutFilter(
  state: IntroState,
  blackoutIdx: number,
  inputLabel: string,
  outputLabel: string,
): string[] {
  if (!state.active) return [];
  const fadeOutDur = state.blackoutFadeEnd - state.blackoutFadeStart;
  return [
    // The color input is fully opaque; we add an alpha plane and ramp it down
    // from 1→0 over the fade window. Before the fade, alpha stays at 1.
    `[${blackoutIdx}:v]format=yuva420p,fade=t=out:st=${state.blackoutFadeStart.toFixed(3)}:d=${fadeOutDur.toFixed(3)}:alpha=1[blackout_anim]`,
    `[${inputLabel}][blackout_anim]overlay=0:0:format=auto[${outputLabel}]`,
  ];
}

/**
 * Build the filter chain for the brand-accent vertical strip that "swooshes"
 * left→right across the frame between `swooshStart` and `swooshEnd`.
 *
 * The strip is `swooshWidthFrac × outW` wide and full-height. Its X position
 * is animated via overlay's per-frame `x` expression so it travels from
 * `-stripW` (off-screen left) at swooshStart to `outW` (off-screen right) at
 * swooshEnd. Outside that window it is hidden via `enable=`.
 *
 * Inputs:
 *   - `swooshIdx`: ffmpeg input index of `color=c=accent:s=stripWxoutH`
 */
export function buildSwooshFilter(
  state: IntroState,
  swooshIdx: number,
  outW: number,
  inputLabel: string,
  outputLabel: string,
): string[] {
  if (!state.active) return [];
  const stripW = Math.round(outW * state.swooshWidthFrac);
  const sweepDur = state.swooshEnd - state.swooshStart;
  // x(t) = -stripW + (outW + stripW) * (t - swooshStart) / sweepDur
  // At t=swooshStart: x = -stripW (off-screen left)
  // At t=swooshEnd:   x = outW    (off-screen right)
  // Commas inside the overlay expression must be escaped at the filter-graph
  // level (FFmpeg parses commas as filter separators inside complex filters).
  const xExpr = `'-${stripW}+(${outW}+${stripW})*(t-${state.swooshStart.toFixed(3)})/${sweepDur.toFixed(3)}'`;
  const enableExpr = `'between(t\\,${state.swooshStart.toFixed(3)}\\,${state.swooshEnd.toFixed(3)})'`;
  return [
    // The accent color input is fully opaque; format=yuva420p so overlay's
    // alpha-honoring path is consistent. (No fade — the strip just slides.)
    `[${swooshIdx}:v]format=yuva420p[swoosh_src]`,
    `[${inputLabel}][swoosh_src]overlay=x=${xExpr}:y=0:format=auto:enable=${enableExpr}[${outputLabel}]`,
  ];
}

/**
 * Build the alpha-fade-in filter to prepend to the existing corner logo
 * overlay's input chain. When intro is active, the corner logo fades in at
 * 1.3-1.6s instead of being visible from t=0.
 *
 * If intro is INACTIVE, returns an empty array — caller should NOT modify the
 * existing corner logo chain.
 *
 * Inputs:
 *   - `inputLabel`: the existing logo pill label (e.g. "logo_pill")
 *   - `outputLabel`: the new label after fade-in (e.g. "logo_pill_in")
 */
export function buildCornerLogoFadeIn(
  state: IntroState,
  inputLabel: string,
  outputLabel: string,
): string[] {
  if (!state.active) return [];
  const fadeDur = state.cornerLogoFadeInEnd - state.cornerLogoFadeInStart;
  return [
    // Force yuva420p so fade=alpha=1 has an alpha plane to multiply against.
    // Before the fade window, alpha multiplier is 0; during 1.3-1.6 it ramps
    // 0→1; after, alpha stays at the source's natural value.
    `[${inputLabel}]format=yuva420p,fade=t=in:st=${state.cornerLogoFadeInStart.toFixed(3)}:d=${fadeDur.toFixed(3)}:alpha=1[${outputLabel}]`,
  ];
}

/**
 * Helper to convert the brand color hex into the FFmpeg `0xRRGGBB` form used
 * for `color=c=...` inputs (NOT the BGR/ASS form).
 */
export function brandColorToFfmpeg(hex: string): string {
  return toFfmpegHex(hex);
}
