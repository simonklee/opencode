import type { OptimizedBuffer } from "@opentui/core"

// Super-Collider: Spider-Verse collider beam duel → logo reveal
//
// Two opposing WHITE energy beams fire from screen edges, collide at
// center where the logo sits, lock in a crackling duel with tear-row
// displacement + chromatic aberration building to crescendo, then
// explode — a glitchy shockwave that slams the entire screen white.
// When the white dissolves (noisy, not uniform), the logo is there.
//
// Timeline (~7.7s):
//   0.0–1.8   FIRE     beams shoot from edges toward center
//   1.8–5.3   DUEL     beams locked, node crackles, tears + aberration build
//   5.3–6.3   EXPLODE  glitchy white shockwave fills entire screen
//   6.3–6.5   WHITE    brief full-screen whiteout
//   6.5–7.7   FADE     white dissolves unevenly, logo revealed

const FIRE_DUR = 1.5
const DUEL_DUR = 4.3
const EXPLODE_DUR = 1.0
const WHITE_DUR = 0.2
const FADE_DUR = 1.2

const DUEL_START = FIRE_DUR
const DUEL_END = DUEL_START + DUEL_DUR
const EXPLODE_END = DUEL_END + EXPLODE_DUR
const WHITE_END = EXPLODE_END + WHITE_DUR
const TOTAL = WHITE_END + FADE_DUR

const BEAM_HALF = 1 // Thinner beams
const MASK_W = 46
const MASK_H = 8

// Block characters for energy corruption
const BLOCKS = [0x2588, 0x2593, 0x2592, 0x2591, 0x2580, 0x2584]

type Buffers = OptimizedBuffer["buffers"]

export class SuperColliderEffect {
  onComplete?: () => void
  private elapsed = 0
  private running = false
  private logoCy: number | null = null

  // Pre-allocated temp buffers for row displacement (like spiderverse)
  private rowChar: Uint32Array | null = null
  private rowFg: Float32Array | null = null
  private rowBg: Float32Array | null = null
  private rowAttr: Uint32Array | null = null
  private tmpWidth = 0

  private ensureTemp(w: number): void {
    if (this.tmpWidth >= w) return
    this.rowChar = new Uint32Array(w)
    this.rowFg = new Float32Array(w * 4)
    this.rowBg = new Float32Array(w * 4)
    this.rowAttr = new Uint32Array(w)
    this.tmpWidth = w
  }

  start(): void {
    this.elapsed = 0
    this.running = true
    this.logoCy = null
  }

  get active(): boolean {
    return this.running
  }

  apply = (buffer: OptimizedBuffer, deltaTimeMs: number): void => {
    if (!this.running) return

    const w = buffer.width
    const h = buffer.height
    const buf = buffer.buffers
    const cx = w / 2

    this.ensureTemp(w)

    // Detect logo — update every frame if found so we track it
    // if it moves (e.g. text input appears and shifts layout)
    const detected = detectLogo(buf.char, w, h)
    this.logoCy = detected

    const cy = this.logoCy

    this.elapsed += deltaTimeMs / 1000
    if (this.elapsed >= TOTAL) {
      this.running = false
      this.onComplete?.()
      return
    }

    const t = this.elapsed

    // === Logo masking: removed ===

    // === Phase dispatch ===
    if (t < DUEL_END) {
      this.renderBeams(buf, w, h, t, cx, cy)
    } else if (t < EXPLODE_END) {
      this.renderBeams(buf, w, h, t, cx, cy) // Keep beams firing as explosion grows
      this.renderExplosion(buf, w, h, t, cx, cy)
    } else if (t < WHITE_END) {
      // Full white — slam every cell
      const size = w * h * 4
      for (let ci = 0; ci < size; ci += 4) {
        buf.fg[ci] = 1
        buf.fg[ci + 1] = 1
        buf.fg[ci + 2] = 1
        buf.bg[ci] = 1
        buf.bg[ci + 1] = 1
        buf.bg[ci + 2] = 1
      }
    } else {
      this.renderFade(buf, w, h, t)
    }
  }

  // --- Beams + duel (fire and duel phases) ---
  private renderBeams(buf: Buffers, w: number, h: number, t: number, cx: number, cy: number): void {
    const fire = Math.min(1, t / FIRE_DUR)
    const duel = t >= DUEL_START
    const rawDuelProg = duel ? (t - DUEL_START) / DUEL_DUR : 0
    const duelProg = Math.min(1, rawDuelProg)

    // Node oscillation with snap-to-center before explosion
    const snap = duelProg < 0.85 ? 1 : Math.max(0, 1 - (duelProg - 0.85) / 0.15)
    const nodeX = duel
      ? cx +
        snap * (Math.sin(t * Math.PI * 2.1) * 4.5 + Math.sin(t * Math.PI * 3.7) * 2.5 + Math.sin(t * Math.PI * 7.3) * 1)
      : cx

    const intensity = duel ? 0.5 + 0.5 * duelProg : 1

    // Beam endpoints (Charge up slowly, then shoot fast using easeInQuint-like curve, adding a slight elastic pullback)
    let lEnd: number
    let rEnd: number
    if (duel) {
      lEnd = Math.round(nodeX)
      rEnd = Math.round(nodeX)
    } else {
      // Tractor beam "swing" charge: pulls back slightly (negative space off-screen),
      // holds tension, then snaps in incredibly fast
      const c4 = (2 * Math.PI) / 3
      const fireExt =
        fire === 0 ? 0 : fire === 1 ? 1 : -Math.pow(2, 10 * fire - 10) * Math.sin((fire * 10 - 10.75) * c4)

      lEnd = Math.round(fireExt * cx)
      rEnd = Math.round(w - fireExt * (w - cx))
    }

    const beamY0 = Math.max(0, cy - BEAM_HALF - 1)
    const beamY1 = Math.min(h - 1, cy + BEAM_HALF + 1)

    // === Beam core energy ===
    if (fire > 0 && (lEnd > 0 || rEnd < w - 1)) {
      for (let y = beamY0; y <= beamY1; y++) {
        const yDist = Math.abs(y - cy)
        const prof = Math.max(0, 1 - (yDist * yDist) / ((BEAM_HALF + 0.5) * (BEAM_HALF + 0.5)))
        if (prof < 0.01) continue

        const above = y < cy

        for (let x = 0; x < w; x++) {
          const inLeft = x <= lEnd
          const inRight = x >= rEnd
          if (!inLeft && !inRight) continue

          // Multi-frequency traveling wave with noise (flows toward center)
          const dir = inLeft ? -1 : 1
          const wave =
            0.5 +
            0.3 * Math.sin(x * 0.35 + dir * t * 14) +
            0.15 * Math.sin(x * 0.8 + dir * t * 23) +
            0.05 * (Math.random() * 2 - 1)

          // Intensity along beam length
          let edge = 1
          if (!duel) {
            const dist = inLeft ? lEnd - x : x - rEnd
            edge = dist < 3 ? 1 : Math.exp(-(dist - 3) * 0.08)
          } else {
            const dist = Math.abs(x - nodeX)
            edge = (0.1 + 0.9 * Math.max(0, 1 - dist / (cx * 0.6))) * intensity
          }

          const glow = prof * wave * edge * (0.85 + Math.random() * 0.15)
          if (glow < 0.02) continue

          const ci = (y * w + x) * 4

          // WHITE core — aggressive, brighter
          const core = glow * 1.5
          tint(buf.bg, ci, core, core, core)
          if (glow > 0.05) {
            const fg = glow * 0.8
            tint(buf.fg, ci, fg, fg, fg)
          }

          // Character corruption in beam core
          if (glow > 0.25 && yDist <= 1 && Math.random() < 0.6) {
            buf.char[y * w + x] = BLOCKS[Math.floor(Math.random() * BLOCKS.length)]
          }

          // Chromatic fringe — aggressive, on outer rows AND adjacent
          if (yDist >= BEAM_HALF - 1 && glow > 0.04) {
            const f = glow * 0.45
            if (above) {
              tint(buf.bg, ci, f, 0, f * 0.7) // magenta above
              tint(buf.fg, ci, f * 0.3, 0, f * 0.2)
            } else {
              tint(buf.bg, ci, 0, f * 0.7, f) // cyan below
              tint(buf.fg, ci, 0, f * 0.2, f * 0.3)
            }
          }
        }
      }
    }

    // === Spark streaks — vertical trails, not single dots ===
    if (fire > 0.2 || duel) {
      const count = duel ? 6 + Math.floor(Math.random() * 12) : 3 + Math.floor(Math.random() * 5)
      for (let i = 0; i < count; i++) {
        const sx = duel
          ? Math.round(nodeX + (Math.random() - 0.5) * 6)
          : Math.round((Math.random() < 0.5 ? lEnd : rEnd) + (Math.random() - 0.5) * 5)
        const dir = Math.random() < 0.5 ? 1 : -1
        const len = 2 + Math.floor(Math.random() * 5)
        for (let dy = 0; dy < len; dy++) {
          const sy = cy + dir * (1 + dy)
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue
          const sci = (sy * w + sx) * 4
          const b = (0.35 + Math.random() * 0.5) * (1 - dy / len)
          tint(buf.fg, sci, b, b * 0.95, b * 0.88)
          if (dy === 0 && Math.random() < 0.25) {
            buf.char[sy * w + sx] = 0x2588
          }
        }
      }
    }

    // === Connection node — crackling, not a smooth sine ===
    if (duel) {
      // Crackle: random bright flashes, not gentle pulse
      const crackle =
        Math.random() < 0.3
          ? 0.75 + Math.random() * 0.25 // bright flash (30% of frames)
          : 0.15 + Math.random() * 0.35 // dim crackle
      const brightness = crackle * intensity

      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nx = Math.round(nodeX) + dx
          const ny = cy + dy
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const d = Math.sqrt(dx * dx + dy * dy * 2.5)
          if (d > 3.5) continue
          const ci = (ny * w + nx) * 4
          const ng = (1 - d / 3.5) * brightness
          tint(buf.bg, ci, ng, ng, ng)
          tint(buf.fg, ci, ng * 0.5, ng * 0.5, ng * 0.5)
          // Character corruption at node center
          if (d < 2 && Math.random() < 0.4) {
            buf.char[ny * w + nx] = BLOCKS[Math.floor(Math.random() * 4)]
          }
        }
      }

      // === Tear rows near collision — like spiderverse episodes ===
      if (duelProg > 0.25) {
        const tearCount = 1 + Math.floor(duelProg * 3)
        this.applyTears(buf, w, h, cy, nodeX, tearCount, 2 + Math.floor(duelProg * 5))
      }

      // === Crescendo: last 10% of duel, white pulse grows at collision ===
      if (rawDuelProg > 0.9 && rawDuelProg <= 1.0) {
        const crescendo = (rawDuelProg - 0.9) / 0.1
        const pulseR = crescendo * 15
        for (let dy = -Math.ceil(pulseR); dy <= Math.ceil(pulseR); dy++) {
          for (let dx = -Math.ceil(pulseR * 2); dx <= Math.ceil(pulseR * 2); dx++) {
            const px = Math.round(nodeX) + dx
            const py = cy + dy
            if (px < 0 || px >= w || py < 0 || py >= h) continue
            const d = Math.sqrt(dx * dx * 0.25 + dy * dy)
            if (d > pulseR) continue
            const ci = (py * w + px) * 4
            const g = (1 - d / pulseR) * crescendo * 0.6
            tint(buf.bg, ci, g, g, g)
            tint(buf.fg, ci, g * 0.3, g * 0.3, g * 0.3)
          }
        }
      }
    }
  }

  // --- Row displacement (tear-row effect from spiderverse) ---
  private applyTears(
    buf: Buffers,
    w: number,
    h: number,
    cy: number,
    focusX: number,
    count: number,
    maxShift: number,
  ): void {
    const tc = this.rowChar!
    const tf = this.rowFg!
    const tb = this.rowBg!
    const ta = this.rowAttr!

    for (let i = 0; i < count; i++) {
      const ty = cy + Math.floor((Math.random() - 0.5) * 8)
      if (ty < 0 || ty >= h) continue
      const shift = Math.floor((Math.random() - 0.5) * maxShift * 2)
      if (shift === 0) continue

      const x0 = Math.max(0, Math.round(focusX) - 20)
      const x1 = Math.min(w, Math.round(focusX) + 20)
      const base = ty * w
      const regionW = x1 - x0

      // Snapshot the row region
      tc.set(buf.char.subarray(base + x0, base + x1))
      tf.set(buf.fg.subarray((base + x0) * 4, (base + x1) * 4))
      tb.set(buf.bg.subarray((base + x0) * 4, (base + x1) * 4))
      ta.set(buf.attributes.subarray(base + x0, base + x1))

      // Write back shifted
      for (let x = x0; x < x1; x++) {
        const src = (((x - x0 - shift) % regionW) + regionW) % regionW
        buf.char[base + x] = tc[src]
        buf.attributes[base + x] = ta[src]
        const dc = (base + x) * 4
        const sc = src * 4
        buf.fg[dc] = tf[sc]
        buf.fg[dc + 1] = tf[sc + 1]
        buf.fg[dc + 2] = tf[sc + 2]
        buf.fg[dc + 3] = tf[sc + 3]
        buf.bg[dc] = tb[sc]
        buf.bg[dc + 1] = tb[sc + 1]
        buf.bg[dc + 2] = tb[sc + 2]
        buf.bg[dc + 3] = tb[sc + 3]
      }

      // Color bleed on shifted region (red or blue, like spiderverse)
      if (Math.random() < 0.4) {
        const ch = Math.random() < 0.5 ? 0 : 2
        for (let x = x0; x < x1; x++) {
          const dc = (base + x) * 4
          buf.fg[dc + ch] = Math.min(1, buf.fg[dc + ch] + 0.15)
          buf.bg[dc + ch] = Math.min(1, buf.bg[dc + ch] + 0.08)
        }
      }
    }
  }

  // --- Explosion: glitchy white shockwave fills entire screen ---
  private renderExplosion(buf: Buffers, w: number, h: number, t: number, cx: number, cy: number): void {
    const prog = (t - DUEL_END) / EXPLODE_DUR
    const maxDx = Math.max(cx, w - cx)
    const maxDy = Math.max(cy, h - cy) * 2
    const maxR = Math.sqrt(maxDx * maxDx + maxDy * maxDy) + 5
    const radius = prog * maxR

    // Initial flash — screen-wide pulse at explosion origin
    if (prog < 0.15) {
      const flash = (1 - prog / 0.15) * 0.4
      const size = w * h * 4
      for (let ci = 0; ci < size; ci += 4) {
        tint(buf.bg, ci, flash, flash, flash)
      }
    }

    for (let y = 0; y < h; y++) {
      // Per-row noise on radius — glitchy wavefront, not a clean circle
      const rowNoise = (Math.random() - 0.5) * 10
      const rowR = radius + rowNoise

      for (let x = 0; x < w; x++) {
        const dx = x - cx
        const dy = (y - cy) * 2
        const d2 = dx * dx + dy * dy
        if (d2 > (rowR + 5) * (rowR + 5)) continue

        const ci = (y * w + x) * 4
        const dist = Math.sqrt(d2)

        if (dist < rowR - 6) {
          // Well behind wavefront: solid white
          buf.fg[ci] = 1
          buf.fg[ci + 1] = 1
          buf.fg[ci + 2] = 1
          buf.bg[ci] = 1
          buf.bg[ci + 1] = 1
          buf.bg[ci + 2] = 1
        } else if (dist < rowR) {
          // Wavefront: aggressive white + noise + character corruption
          const behind = rowR - dist
          const strength = (behind / 6) * (0.7 + Math.random() * 0.3)
          whiten(buf.fg, ci, strength)
          whiten(buf.bg, ci, strength)
          if (Math.random() < 0.5) {
            buf.char[y * w + x] = BLOCKS[Math.floor(Math.random() * BLOCKS.length)]
          }
        } else if (dist < rowR + 5) {
          // Just ahead of wavefront: chromatic fringe + brightness push
          const f = (1 - (dist - rowR) / 5) * 0.35
          if (y < cy) tint(buf.bg, ci, f, 0, f * 0.7)
          else tint(buf.bg, ci, 0, f * 0.7, f)
          tint(buf.fg, ci, f * 0.15, f * 0.15, f * 0.15)
        }
      }
    }
  }

  // --- Fade: white dissolves unevenly, logo appears ---
  private renderFade(buf: Buffers, w: number, h: number, t: number): void {
    const raw = Math.max(0, 1 - (t - WHITE_END) / FADE_DUR)
    if (raw < 0.001) return

    const size = w * h
    for (let i = 0; i < size; i++) {
      const ci = i * 4
      // Per-cell noise: white dissolves unevenly, not clinical
      const noise = 0.8 + Math.random() * 0.4
      const strength = Math.min(1, raw * noise)
      whiten(buf.fg, ci, strength)
      whiten(buf.bg, ci, strength)
    }

    // Residual sparks as white clears
    if (raw > 0.2 && raw < 0.8) {
      const count = Math.floor(raw * 8)
      for (let i = 0; i < count; i++) {
        const x = Math.floor(Math.random() * w)
        const y = Math.floor(Math.random() * h)
        const ci = (y * w + x) * 4
        const b = raw * 0.3 * Math.random()
        tint(buf.fg, ci, b, b * 0.95, b * 0.9)
      }
    }
  }
}

// Detect the logo's vertical center by scanning for the first cluster
// of consecutive rows with many block characters (█ ▀ ▄).
// The logo has 3 consecutive rows with 15-33 blocks each — stop at
// the first gap after the cluster to avoid being pulled down by
// stray block chars in prompt/tips/status bar.
function detectLogo(chars: Uint32Array, w: number, h: number): number {
  const rowCounts = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let count = 0
    for (let x = 0; x < w; x++) {
      const c = chars[y * w + x]
      // Count █ (0x2588), ▀ (0x2580), ▄ (0x2584), _ (0x5F), ^ (0x5E), ~ (0x7E)
      // wait, in the buffer they are replaced! so only the rendered ones:
      if (c === 0x2588 || c === 0x2580 || c === 0x2584) count++
    }
    rowCounts[y] = count
  }

  // Look for the specific logo block signature:
  // Row 1: 32 blocks (16 if wrapped)
  // Row 2: 19 blocks (10/9 if wrapped)
  // Row 3: 32 blocks (16 if wrapped)
  for (let y = 0; y < h - 2; y++) {
    if (rowCounts[y] > 14 && rowCounts[y + 1] > 8 && rowCounts[y + 2] > 14) {
      // y is Row 1. y + 1 is Row 2 (the center gap).
      return y + 1
    }
  }

  // Fallback: Hard-code position to 3/8ths of screen height
  return Math.floor(h * 0.425)
}

function tint(arr: Float32Array, ci: number, r: number, g: number, b: number): void {
  arr[ci] = Math.min(1, arr[ci] + r)
  arr[ci + 1] = Math.min(1, arr[ci + 1] + g)
  arr[ci + 2] = Math.min(1, arr[ci + 2] + b)
}

function whiten(arr: Float32Array, ci: number, strength: number): void {
  arr[ci] = arr[ci] + (1 - arr[ci]) * strength
  arr[ci + 1] = arr[ci + 1] + (1 - arr[ci + 1]) * strength
  arr[ci + 2] = arr[ci + 2] + (1 - arr[ci + 2]) * strength
}
