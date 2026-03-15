import type { OptimizedBuffer } from "@opentui/core"

// Spider-Verse post-processing effect
//
// - Always-on: halftone dots + scanlines (comic book texture)
//   + sparse micro-artifacts (tiny color pops that add texture)
// - Episodes: mixed vertical column-strips AND horizontal row-strips
//   that jitter rapidly. Structure stays stable, displacement re-rolls
//   every ~80ms so the glitch feels alive.
// - Every Nth episode escalates with wider tear rows.

// Vertical strip: displaces a column range up/down
interface VStrip {
  x: number
  w: number
  direction: number
  maxShift: number
  colorBleed: number // 0=none, 1=red, 2=blue
  yShift: number // re-rolled on jitter
}

// Horizontal strip: displaces a row range left/right
interface HStrip {
  y: number
  h: number
  direction: number
  maxShift: number
  colorBleed: number
  xShift: number // re-rolled on jitter
}

interface TearRow {
  y: number
  maxShift: number
  shift: number
}

interface Episode {
  vStrips: VStrip[]
  hStrips: HStrip[]
  regionX: number
  regionY: number
  regionW: number
  regionH: number
  chromaticStrength: number
  tearRows: TearRow[]
  duration: number
  elapsed: number
  jitterInterval: number
  jitterAccum: number
}

type Buffers = { char: Uint32Array; fg: Float32Array; bg: Float32Array; attributes: Uint32Array }

export class SpiderVerseEffect {
  halftoneEnabled = true
  halftoneScale = 5
  halftoneStrength = 0.08
  scanlinesEnabled = true
  scanlinesStrength = 0.04

  // Micro-artifacts: tiny random pops for texture (always-on, sparse)
  private microTimer = 0
  private microInterval = 0.05 // re-roll every 50ms

  private idleTimer = 3.0 + Math.random() * 2.0
  private episode: Episode | null = null
  private episodeCount = 0

  apply = (buffer: OptimizedBuffer, deltaTimeMs: number): void => {
    const width = buffer.width
    const height = buffer.height
    const buf = buffer.buffers
    const dt = deltaTimeMs / 1000

    if (this.halftoneEnabled) this.applyHalftone(buf.bg, width, height)
    if (this.scanlinesEnabled) this.applyScanlines(buf.fg, buf.bg, width, height)

    this.tick(dt, width, height)

    if (this.episode) {
      this.renderEpisode(buf, width, height)
    }

    // Micro-artifacts: always running, very sparse
    this.microTimer += dt
    if (this.microTimer >= this.microInterval) {
      this.microTimer = 0
      this.applyMicroArtifacts(buf, width, height)
    }
  }

  private tick(dt: number, width: number, height: number): void {
    if (this.episode) {
      this.episode.elapsed += dt
      if (this.episode.elapsed >= this.episode.duration) {
        this.episode = null
        this.idleTimer = this.episodeCount % 5 === 0 ? 8.0 + Math.random() * 6.0 : 5.0 + Math.random() * 7.0
        return
      }

      this.episode.jitterAccum += dt
      if (this.episode.jitterAccum >= this.episode.jitterInterval) {
        this.episode.jitterAccum = 0
        this.jitter(this.episode)
      }
    } else {
      this.idleTimer -= dt
      if (this.idleTimer <= 0) {
        this.episodeCount++
        this.episode =
          this.episodeCount % 5 === 0 ? this.composeBigEpisode(width, height) : this.composeEpisode(width, height)
      }
    }
  }

  private jitter(ep: Episode): void {
    for (const s of ep.vStrips) {
      const mag = 1 + Math.floor(Math.random() * s.maxShift)
      s.yShift = (Math.random() < 0.2 ? -s.direction : s.direction) * mag
    }
    for (const s of ep.hStrips) {
      const mag = 1 + Math.floor(Math.random() * s.maxShift)
      s.xShift = (Math.random() < 0.2 ? -s.direction : s.direction) * mag
    }
    for (const t of ep.tearRows) {
      t.shift = Math.floor((Math.random() - 0.5) * 2 * t.maxShift)
    }
  }

  // --- Episode composers ---

  private composeEpisode(width: number, height: number): Episode {
    // Focal region for the whole cluster
    const regionW = Math.floor(width * (0.2 + Math.random() * 0.4))
    const regionH = Math.floor(height * (0.3 + Math.random() * 0.4))
    const regionX = Math.floor(Math.random() * (width - regionW))
    const regionY = Math.floor(Math.random() * (height - regionH))
    const focusX = regionX + Math.floor(regionW / 2)
    const focusY = regionY + Math.floor(regionH / 2)

    // Mix of vertical and horizontal strips
    const totalStrips = 5 + Math.floor(Math.random() * 6) // 5-10 strips
    const vCount = Math.floor(totalStrips * (0.4 + Math.random() * 0.3)) // 40-70% vertical
    const hCount = totalStrips - vCount

    const baseDir = Math.random() < 0.5 ? 1 : -1

    // Vertical strips — range of widths including very small (1 col)
    const vStrips: VStrip[] = []
    const vSpread = 15 + Math.floor(Math.random() * 25)
    let vx = focusX - Math.floor(vSpread / 2)
    for (let i = 0; i < vCount; i++) {
      const w = Math.random() < 0.4 ? 1 : 1 + Math.floor(Math.random() * 4) // 40% chance of 1-col, else 1-4
      const gap = Math.floor(Math.random() * 4)
      const maxShift = 1 + Math.floor(Math.random() * 3)
      const direction = Math.random() < 0.2 ? -baseDir : baseDir
      const colorBleed = Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : 2) : 0

      vStrips.push({
        x: Math.max(0, Math.min(width - w, vx)),
        w,
        direction,
        maxShift,
        colorBleed,
        yShift: direction * (1 + Math.floor(Math.random() * maxShift)),
      })
      vx += w + gap
    }

    // Horizontal strips — row ranges shifted left/right
    const hStrips: HStrip[] = []
    const hSpread = 5 + Math.floor(Math.random() * 10)
    let hy = focusY - Math.floor(hSpread / 2)
    for (let i = 0; i < hCount; i++) {
      const h = Math.random() < 0.4 ? 1 : 1 + Math.floor(Math.random() * 2) // 40% chance of 1-row, else 1-2
      const gap = Math.floor(Math.random() * 3)
      const maxShift = 2 + Math.floor(Math.random() * 6)
      const direction = Math.random() < 0.2 ? -baseDir : baseDir
      const colorBleed = Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : 2) : 0

      hStrips.push({
        y: Math.max(0, Math.min(height - h, hy)),
        h,
        direction,
        maxShift,
        colorBleed,
        xShift: direction * (2 + Math.floor(Math.random() * maxShift)),
      })
      hy += h + gap
    }

    return {
      vStrips,
      hStrips,
      regionX,
      regionY,
      regionW,
      regionH,
      chromaticStrength: 1,
      tearRows: [],
      duration: 1.0 + Math.random() * 1.5,
      elapsed: 0,
      jitterInterval: 0.06 + Math.random() * 0.04,
      jitterAccum: 0,
    }
  }

  private composeBigEpisode(width: number, height: number): Episode {
    const ep = this.composeEpisode(width, height)
    ep.chromaticStrength = 3
    ep.duration = 1.5 + Math.random() * 1.5

    for (const s of ep.vStrips) s.maxShift = Math.round(s.maxShift * 2)
    for (const s of ep.hStrips) s.maxShift = Math.round(s.maxShift * 1.5)

    const tearCount = 3 + Math.floor(Math.random() * 5)
    for (let i = 0; i < tearCount; i++) {
      ep.tearRows.push({
        y: Math.min(ep.regionY + Math.floor(Math.random() * ep.regionH), height - 1),
        maxShift: 4 + Math.floor(Math.random() * 8),
        shift: Math.floor((Math.random() - 0.5) * 16),
      })
    }
    return ep
  }

  // --- Render ---

  private renderEpisode(buf: Buffers, width: number, height: number): void {
    const ep = this.episode!

    if (ep.chromaticStrength > 0) {
      this.applyChromaticAberration(buf.fg, buf.bg, width, height, ep.chromaticStrength)
    }

    this.applyVStrips(buf, width, height, ep)
    this.applyHStrips(buf, width, height, ep)

    if (ep.tearRows.length > 0) {
      this.applyTearRows(buf, width, height, ep.tearRows)
    }
  }

  // Vertical strips: shift columns up/down within the region
  private applyVStrips(buf: Buffers, width: number, height: number, ep: Episode): void {
    for (const strip of ep.vStrips) {
      const x0 = strip.x
      const x1 = Math.min(strip.x + strip.w, width)
      const y0 = ep.regionY
      const y1 = Math.min(ep.regionY + ep.regionH, height)
      const shift = strip.yShift
      if (shift === 0) continue

      const startY = shift > 0 ? y1 - 1 : y0
      const endY = shift > 0 ? y0 - 1 : y1
      const step = shift > 0 ? -1 : 1

      for (let y = startY; y !== endY; y += step) {
        const srcY = y - shift
        if (srcY < y0 || srcY >= y1) continue
        this.copyColumns(buf, width, y, srcY, x0, x1, strip.colorBleed)
      }
    }
  }

  // Horizontal strips: shift rows left/right within the region
  private applyHStrips(buf: Buffers, width: number, height: number, ep: Episode): void {
    const tempChar = new Uint32Array(width)
    const tempFg = new Float32Array(width * 4)
    const tempBg = new Float32Array(width * 4)
    const tempAttr = new Uint32Array(width)

    for (const strip of ep.hStrips) {
      const shift = strip.xShift
      if (shift === 0) continue

      const x0 = ep.regionX
      const x1 = Math.min(ep.regionX + ep.regionW, width)

      for (let row = strip.y; row < strip.y + strip.h && row < height; row++) {
        const base = row * width

        // Copy the region of this row
        tempChar.set(buf.char.subarray(base + x0, base + x1))
        tempFg.set(buf.fg.subarray((base + x0) * 4, (base + x1) * 4))
        tempBg.set(buf.bg.subarray((base + x0) * 4, (base + x1) * 4))
        tempAttr.set(buf.attributes.subarray(base + x0, base + x1))

        const regionW = x1 - x0
        for (let x = x0; x < x1; x++) {
          const srcLocal = (((x - x0 - shift) % regionW) + regionW) % regionW
          buf.char[base + x] = tempChar[srcLocal]
          buf.attributes[base + x] = tempAttr[srcLocal]
          const dc = (base + x) * 4
          const sc = srcLocal * 4
          buf.fg[dc] = tempFg[sc]
          buf.fg[dc + 1] = tempFg[sc + 1]
          buf.fg[dc + 2] = tempFg[sc + 2]
          buf.fg[dc + 3] = tempFg[sc + 3]
          buf.bg[dc] = tempBg[sc]
          buf.bg[dc + 1] = tempBg[sc + 1]
          buf.bg[dc + 2] = tempBg[sc + 2]
          buf.bg[dc + 3] = tempBg[sc + 3]
        }

        // Color bleed on the shifted region
        if (strip.colorBleed) {
          const tint = strip.colorBleed === 1 ? 0 : 2
          for (let x = x0; x < x1; x++) {
            const dc = (base + x) * 4
            buf.fg[dc + tint] = Math.min(1, buf.fg[dc + tint] + 0.12)
            buf.bg[dc + tint] = Math.min(1, buf.bg[dc + tint] + 0.06)
          }
        }
      }
    }
  }

  // Helper: copy column data from srcY row to dstY row for columns [x0, x1)
  private copyColumns(
    buf: Buffers,
    width: number,
    dstY: number,
    srcY: number,
    x0: number,
    x1: number,
    colorBleed: number,
  ): void {
    const dstBase = dstY * width
    const srcBase = srcY * width
    for (let x = x0; x < x1; x++) {
      buf.char[dstBase + x] = buf.char[srcBase + x]
      buf.attributes[dstBase + x] = buf.attributes[srcBase + x]
      const dc = (dstBase + x) * 4
      const sc = (srcBase + x) * 4
      buf.fg[dc] = buf.fg[sc]
      buf.fg[dc + 1] = buf.fg[sc + 1]
      buf.fg[dc + 2] = buf.fg[sc + 2]
      buf.fg[dc + 3] = buf.fg[sc + 3]
      buf.bg[dc] = buf.bg[sc]
      buf.bg[dc + 1] = buf.bg[sc + 1]
      buf.bg[dc + 2] = buf.bg[sc + 2]
      buf.bg[dc + 3] = buf.bg[sc + 3]

      if (colorBleed === 1) {
        buf.fg[dc] = Math.min(1, buf.fg[dc] + 0.15)
        buf.bg[dc] = Math.min(1, buf.bg[dc] + 0.08)
      } else if (colorBleed === 2) {
        buf.fg[dc + 2] = Math.min(1, buf.fg[dc + 2] + 0.15)
        buf.bg[dc + 2] = Math.min(1, buf.bg[dc + 2] + 0.08)
      }
    }
  }

  // --- Micro-artifacts: tiny random pops for texture ---

  private applyMicroArtifacts(buf: Buffers, width: number, height: number): void {
    // Scatter 3-8 tiny artifacts across the screen
    const count = 3 + Math.floor(Math.random() * 6)
    for (let i = 0; i < count; i++) {
      const x = Math.floor(Math.random() * width)
      const y = Math.floor(Math.random() * height)
      const len = 1 + Math.floor(Math.random() * 3) // 1-3 cells wide
      const type = Math.random()

      for (let dx = 0; dx < len && x + dx < width; dx++) {
        const ci = (y * width + x + dx) * 4

        if (type < 0.4) {
          // Single-channel color pop: boost one channel
          const ch = Math.floor(Math.random() * 3)
          buf.fg[ci + ch] = Math.min(1, buf.fg[ci + ch] + 0.2 + Math.random() * 0.15)
        } else if (type < 0.7) {
          // Tiny horizontal shift: swap with neighbor
          const nx = Math.min(width - 1, x + dx + 1 + Math.floor(Math.random() * 2))
          const ni = (y * width + nx) * 4
          // Swap fg colors
          const tr = buf.fg[ci]
          const tg = buf.fg[ci + 1]
          const tb = buf.fg[ci + 2]
          buf.fg[ci] = buf.fg[ni]
          buf.fg[ci + 1] = buf.fg[ni + 1]
          buf.fg[ci + 2] = buf.fg[ni + 2]
          buf.fg[ni] = tr
          buf.fg[ni + 1] = tg
          buf.fg[ni + 2] = tb
        } else {
          // Brightness flicker
          const factor = 0.7 + Math.random() * 0.6 // 0.7-1.3
          buf.fg[ci] = Math.min(1, buf.fg[ci] * factor)
          buf.fg[ci + 1] = Math.min(1, buf.fg[ci + 1] * factor)
          buf.fg[ci + 2] = Math.min(1, buf.fg[ci + 2] * factor)
        }
      }
    }
  }

  // --- Tear rows (big episodes) ---

  private applyTearRows(buf: Buffers, width: number, height: number, tearRows: TearRow[]): void {
    const tempChar = new Uint32Array(width)
    const tempFg = new Float32Array(width * 4)
    const tempBg = new Float32Array(width * 4)
    const tempAttr = new Uint32Array(width)

    for (const tear of tearRows) {
      if (tear.y < 0 || tear.y >= height || tear.shift === 0) continue
      const base = tear.y * width

      tempChar.set(buf.char.subarray(base, base + width))
      tempFg.set(buf.fg.subarray(base * 4, (base + width) * 4))
      tempBg.set(buf.bg.subarray(base * 4, (base + width) * 4))
      tempAttr.set(buf.attributes.subarray(base, base + width))

      for (let x = 0; x < width; x++) {
        const srcX = (((x - tear.shift) % width) + width) % width
        buf.char[base + x] = tempChar[srcX]
        buf.attributes[base + x] = tempAttr[srcX]
        const dc = (base + x) * 4
        const sc = srcX * 4
        buf.fg[dc] = tempFg[sc]
        buf.fg[dc + 1] = tempFg[sc + 1]
        buf.fg[dc + 2] = tempFg[sc + 2]
        buf.fg[dc + 3] = tempFg[sc + 3]
        buf.bg[dc] = tempBg[sc]
        buf.bg[dc + 1] = tempBg[sc + 1]
        buf.bg[dc + 2] = tempBg[sc + 2]
        buf.bg[dc + 3] = tempBg[sc + 3]
      }
    }
  }

  // --- Always-on texture ---

  private applyChromaticAberration(
    fg: Float32Array,
    bg: Float32Array,
    width: number,
    height: number,
    strength: number,
  ): void {
    const offset = Math.max(1, Math.round(strength))
    const srcFg = Float32Array.from(fg)
    const srcBg = Float32Array.from(bg)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rX = Math.max(0, Math.min(width - 1, x - offset))
        const bX = Math.max(0, Math.min(width - 1, x + offset))
        const dest = (y * width + x) * 4
        const rSrc = (y * width + rX) * 4
        const bSrc = (y * width + bX) * 4
        fg[dest] = srcFg[rSrc]
        fg[dest + 2] = srcFg[bSrc + 2]
        bg[dest] = srcBg[rSrc]
        bg[dest + 2] = srcBg[bSrc + 2]
      }
    }
  }

  private applyHalftone(bg: Float32Array, width: number, height: number): void {
    const scale = this.halftoneScale
    const strength = this.halftoneStrength

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ci = (y * width + x) * 4
        const lum = 0.299 * bg[ci] + 0.587 * bg[ci + 1] + 0.114 * bg[ci + 2]
        const midtoneFactor = Math.max(0, 1.0 - Math.abs(lum - 0.4) * 3.0)
        if (midtoneFactor <= 0) continue

        const ox = y % 2 === 0 ? 0 : Math.floor(scale / 2)
        const gx = ((x + ox) % scale) - scale / 2
        const gy = (y % scale) - scale / 2
        const dist = Math.sqrt(gx * gx + gy * gy) / (scale / 2)
        if (dist > 0.7) continue

        const mod = -strength * midtoneFactor * (1.0 - dist / 0.7)
        bg[ci] = Math.max(0, bg[ci] + mod)
        bg[ci + 1] = Math.max(0, bg[ci + 1] + mod)
        bg[ci + 2] = Math.max(0, bg[ci + 2] + mod)
      }
    }
  }

  private applyScanlines(fg: Float32Array, bg: Float32Array, width: number, height: number): void {
    const factor = 1.0 - this.scanlinesStrength
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x++) {
        const ci = (y * width + x) * 4
        fg[ci] *= factor
        fg[ci + 1] *= factor
        fg[ci + 2] *= factor
        bg[ci] *= factor
        bg[ci + 1] *= factor
        bg[ci + 2] *= factor
      }
    }
  }
}
