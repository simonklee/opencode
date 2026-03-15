import type { OptimizedBuffer } from "@opentui/core"

// Spider-Verse "Into the Spider-Verse" post-processing effect
// Combines CMYK plate misregistration, sparse halftone dots, scanlines, and localized glitches

interface Glitch {
  // Region bounds
  x: number
  y: number
  w: number
  h: number
  // Effect
  shift: number
  colorBleed: boolean
  ttl: number
}

export class SpiderVerseEffect {
  // --- Chromatic aberration (plate misregistration) ---
  // Not always on — flickers in and out like a bad print job
  chromaticStrength = 1
  private chromaticActive = false
  private chromaticTtl = 0
  private chromaticCooldown = 0

  // --- Halftone / Ben-Day dots ---
  halftoneEnabled = true
  halftoneScale = 5 // larger grid = fewer, sparser dots
  halftoneStrength = 0.08 // subtle

  // --- Scanlines ---
  scanlinesEnabled = true
  scanlinesStrength = 0.04

  // --- Glitch ---
  // Rare, localized, brief
  private glitchCooldown = 0
  private glitches: Glitch[] = []

  // --- Internal state ---
  private time = 0

  apply = (buffer: OptimizedBuffer, deltaTime: number): void => {
    const width = buffer.width
    const height = buffer.height
    const buf = buffer.buffers
    this.time += deltaTime

    // 1. Chromatic aberration — intermittent, not constant
    this.updateChromatic(deltaTime)
    if (this.chromaticActive) {
      this.applyChromaticAberration(buf.fg, buf.bg, width, height)
    }

    // 2. Halftone dots — sparse Ben-Day pattern, only in mid-tones
    if (this.halftoneEnabled) {
      this.applyHalftone(buf.bg, width, height)
    }

    // 3. Scanlines
    if (this.scanlinesEnabled) {
      this.applyScanlines(buf.fg, buf.bg, width, height)
    }

    // 4. Localized glitches — affect rectangular regions, not full rows
    this.updateGlitches(buf, width, height, deltaTime)
  }

  // Chromatic aberration flickers on for brief moments, then goes away
  private updateChromatic(dt: number): void {
    if (this.chromaticActive) {
      this.chromaticTtl -= dt
      if (this.chromaticTtl <= 0) {
        this.chromaticActive = false
        // Long cooldown before next chromatic burst: 2-6 seconds
        this.chromaticCooldown = 2.0 + Math.random() * 4.0
      }
    } else {
      this.chromaticCooldown -= dt
      if (this.chromaticCooldown <= 0) {
        this.chromaticActive = true
        // Brief active window: 0.1 - 0.5 seconds
        this.chromaticTtl = 0.1 + Math.random() * 0.4
      }
    }
  }

  private applyChromaticAberration(fg: Float32Array, bg: Float32Array, width: number, height: number): void {
    const offset = Math.max(1, Math.round(this.chromaticStrength))
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

        // Only mid-tones — narrow band so most of the screen is unaffected
        const midtoneFactor = Math.max(0, 1.0 - Math.abs(lum - 0.4) * 3.0)
        if (midtoneFactor <= 0) continue

        // Offset every other row for a more organic hex-grid feel
        const ox = y % 2 === 0 ? 0 : Math.floor(scale / 2)
        const gx = ((x + ox) % scale) - scale / 2
        const gy = (y % scale) - scale / 2
        const dist = Math.sqrt(gx * gx + gy * gy) / (scale / 2)

        // Only darken at dot centers, leave everything else alone
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

  private updateGlitches(
    buf: { char: Uint32Array; fg: Float32Array; bg: Float32Array; attributes: Uint32Array },
    width: number,
    height: number,
    dt: number,
  ): void {
    // Decay existing glitches
    this.glitches = this.glitches.filter((g) => {
      g.ttl -= dt
      return g.ttl > 0
    })

    // Cooldown between glitch bursts
    this.glitchCooldown -= dt
    if (this.glitchCooldown > 0 || this.glitches.length > 0) {
      this.applyGlitches(buf, width, height)
      return
    }

    // Low chance to spawn a new glitch burst: ~0.12/sec = one every ~8 seconds
    if (Math.random() > 0.12 * dt) {
      this.applyGlitches(buf, width, height)
      return
    }

    // Spawn 1-3 localized glitches in a cluster
    const count = 1 + Math.floor(Math.random() * 3)
    // Pick a focal point — glitches cluster near each other
    const focusX = Math.floor(Math.random() * width)
    const focusY = Math.floor(Math.random() * height)

    for (let i = 0; i < count; i++) {
      // Region near the focal point, with some spread
      const gw = 8 + Math.floor(Math.random() * 30) // 8-37 cells wide
      const gh = 1 + Math.floor(Math.random() * 3) // 1-3 rows tall
      const gx = Math.max(0, Math.min(width - gw, focusX + Math.floor((Math.random() - 0.5) * 40)))
      const gy = Math.max(0, Math.min(height - gh, focusY + Math.floor((Math.random() - 0.5) * 6)))

      this.glitches.push({
        x: gx,
        y: gy,
        w: gw,
        h: gh,
        shift: Math.floor((Math.random() - 0.5) * 12),
        colorBleed: Math.random() < 0.3,
        ttl: 0.04 + Math.random() * 0.1, // 40-140ms — brief flash
      })
    }

    // Cooldown: 3-8 seconds before next burst
    this.glitchCooldown = 3.0 + Math.random() * 5.0

    this.applyGlitches(buf, width, height)
  }

  private applyGlitches(
    buf: { char: Uint32Array; fg: Float32Array; bg: Float32Array; attributes: Uint32Array },
    width: number,
    height: number,
  ): void {
    if (this.glitches.length === 0) return

    for (const g of this.glitches) {
      for (let row = g.y; row < g.y + g.h && row < height; row++) {
        const base = row * width

        for (let col = g.x; col < g.x + g.w && col < width; col++) {
          // Read from shifted source position
          const srcCol = Math.max(0, Math.min(width - 1, col + g.shift))
          const di = base + col
          const si = base + srcCol

          buf.char[di] = buf.char[si]
          buf.attributes[di] = buf.attributes[si]

          const dc = di * 4
          const sc = si * 4
          buf.fg[dc] = buf.fg[sc]
          buf.fg[dc + 1] = buf.fg[sc + 1]
          buf.fg[dc + 2] = buf.fg[sc + 2]
          buf.fg[dc + 3] = buf.fg[sc + 3]
          buf.bg[dc] = buf.bg[sc]
          buf.bg[dc + 1] = buf.bg[sc + 1]
          buf.bg[dc + 2] = buf.bg[sc + 2]
          buf.bg[dc + 3] = buf.bg[sc + 3]

          // Optional: color bleed — tint the region cyan/magenta
          if (g.colorBleed) {
            const tint = g.shift > 0 ? 0 : 2 // red or blue channel boost
            buf.fg[dc + tint] = Math.min(1, buf.fg[dc + tint] + 0.15)
            buf.bg[dc + tint] = Math.min(1, buf.bg[dc + tint] + 0.08)
          }
        }
      }
    }
  }
}
