import type { OptimizedBuffer } from "@opentui/core"

// Spider-Verse "Into the Spider-Verse" post-processing effect
// Combines CMYK plate misregistration, halftone dots, scanlines, and intermittent glitch

export class SpiderVerseEffect {
  // --- Chromatic aberration (plate misregistration) ---
  chromaticStrength = 1
  chromaticPulse = true

  // --- Halftone / Ben-Day dots ---
  halftoneEnabled = true
  halftoneScale = 3 // dot grid size (cells)
  halftoneStrength = 0.12 // how much to modulate

  // --- Scanlines ---
  scanlinesEnabled = true
  scanlinesStrength = 0.06

  // --- Glitch ---
  glitchChance = 0.4 // chance per second
  maxGlitchLines = 2
  maxShift = 8

  // --- Internal state ---
  private time = 0
  private glitchLines: { y: number; shift: number; ttl: number }[] = []

  apply = (buffer: OptimizedBuffer, deltaTime: number): void => {
    const width = buffer.width
    const height = buffer.height
    const buf = buffer.buffers
    this.time += deltaTime

    // 1. Chromatic aberration — shift red channel left, blue channel right
    this.applyChromaticAberration(buf.fg, buf.bg, width, height)

    // 2. Halftone dots — Ben-Day pattern in mid-tones
    if (this.halftoneEnabled) {
      this.applyHalftone(buf.bg, width, height)
    }

    // 3. Scanlines — subtle horizontal darkening
    if (this.scanlinesEnabled) {
      this.applyScanlines(buf.fg, buf.bg, width, height)
    }

    // 4. Glitch — occasional horizontal line shifts
    this.applyGlitch(buf, width, height, deltaTime)
  }

  private applyChromaticAberration(fg: Float32Array, bg: Float32Array, width: number, height: number): void {
    let strength = this.chromaticStrength
    if (this.chromaticPulse) {
      // Subtle pulse: strength oscillates between 0.5x and 1.5x
      strength *= 1.0 + 0.5 * Math.sin(this.time * 2.5)
    }
    const offset = Math.max(1, Math.round(strength))

    // Copy originals for reading
    const srcFg = Float32Array.from(fg)
    const srcBg = Float32Array.from(bg)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rX = Math.max(0, Math.min(width - 1, x - offset))
        const bX = Math.max(0, Math.min(width - 1, x + offset))

        const dest = (y * width + x) * 4
        const rSrc = (y * width + rX) * 4
        const bSrc = (y * width + bX) * 4

        // Foreground: red from left, green stays, blue from right
        fg[dest] = srcFg[rSrc] // R
        // fg[dest + 1] stays (green from center)
        fg[dest + 2] = srcFg[bSrc + 2] // B

        // Background: same treatment gives the "print misregistration" look
        bg[dest] = srcBg[rSrc] // R
        bg[dest + 2] = srcBg[bSrc + 2] // B
      }
    }
  }

  private applyHalftone(bg: Float32Array, width: number, height: number): void {
    const scale = this.halftoneScale
    const strength = this.halftoneStrength

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ci = (y * width + x) * 4
        // Luminance of this cell's background
        const lum = 0.299 * bg[ci] + 0.587 * bg[ci + 1] + 0.114 * bg[ci + 2]

        // Halftone is most visible in mid-tones (0.2 - 0.8)
        // Fade out at extremes (pure black / pure white don't show dots)
        const midtoneFactor = 1.0 - Math.abs(lum - 0.5) * 2.0
        if (midtoneFactor <= 0) continue

        // Create a regular dot pattern: distance from nearest grid center
        const gx = (x % scale) - scale / 2
        const gy = (y % scale) - scale / 2
        const dist = Math.sqrt(gx * gx + gy * gy) / (scale / 2)

        // Cells near grid centers get darkened (the "dot"), others get brightened
        const dotFactor = dist < 0.8 ? -strength : strength * 0.5
        const mod = dotFactor * midtoneFactor

        bg[ci] = Math.max(0, Math.min(1, bg[ci] + mod))
        bg[ci + 1] = Math.max(0, Math.min(1, bg[ci + 1] + mod))
        bg[ci + 2] = Math.max(0, Math.min(1, bg[ci + 2] + mod))
      }
    }
  }

  private applyScanlines(fg: Float32Array, bg: Float32Array, width: number, height: number): void {
    const s = this.scanlinesStrength
    const factor = 1.0 - s
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

  private applyGlitch(
    buf: { char: Uint32Array; fg: Float32Array; bg: Float32Array; attributes: Uint32Array },
    width: number,
    height: number,
    deltaTime: number,
  ): void {
    // Decay existing glitches
    this.glitchLines = this.glitchLines.filter((g) => {
      g.ttl -= deltaTime
      return g.ttl > 0
    })

    // Maybe spawn new glitches
    if (this.glitchLines.length === 0 && Math.random() < this.glitchChance * deltaTime) {
      const count = 1 + Math.floor(Math.random() * this.maxGlitchLines)
      for (let i = 0; i < count; i++) {
        this.glitchLines.push({
          y: Math.floor(Math.random() * height),
          shift: Math.floor((Math.random() - 0.5) * 2 * this.maxShift),
          ttl: 0.03 + Math.random() * 0.12, // 30-150ms
        })
      }
    }

    // Apply active glitches by shifting row data
    if (this.glitchLines.length === 0) return

    const tempChar = new Uint32Array(width)
    const tempFg = new Float32Array(width * 4)
    const tempBg = new Float32Array(width * 4)
    const tempAttr = new Uint32Array(width)

    for (const g of this.glitchLines) {
      if (g.y < 0 || g.y >= height) continue
      const base = g.y * width

      tempChar.set(buf.char.subarray(base, base + width))
      tempFg.set(buf.fg.subarray(base * 4, (base + width) * 4))
      tempBg.set(buf.bg.subarray(base * 4, (base + width) * 4))
      tempAttr.set(buf.attributes.subarray(base, base + width))

      for (let x = 0; x < width; x++) {
        const srcX = (((x - g.shift) % width) + width) % width
        buf.char[base + x] = tempChar[srcX]
        buf.attributes[base + x] = tempAttr[srcX]

        const di = (base + x) * 4
        const si = srcX * 4
        buf.fg[di] = tempFg[si]
        buf.fg[di + 1] = tempFg[si + 1]
        buf.fg[di + 2] = tempFg[si + 2]
        buf.fg[di + 3] = tempFg[si + 3]
        buf.bg[di] = tempBg[si]
        buf.bg[di + 1] = tempBg[si + 1]
        buf.bg[di + 2] = tempBg[si + 2]
        buf.bg[di + 3] = tempBg[si + 3]
      }
    }
  }
}
