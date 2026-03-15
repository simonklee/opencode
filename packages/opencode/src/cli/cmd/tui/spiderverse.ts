import type { OptimizedBuffer } from "@opentui/core"

// Spider-Verse post-processing effect
//
// Structured as composed "episodes" — bursts of correlated chaos
// with calm breathing room between them, like musical phrases.
//
// Always-on: halftone dots, scanlines (the comic book texture)
// Episodes: chromatic aberration + localized glitches layered together
// Rare big episodes: all of the above + major screen tear

// --- Types ---

interface GlitchRegion {
  x: number
  y: number
  w: number
  h: number
  shift: number
  colorBleed: boolean
}

interface MajorGlitchRow {
  y: number
  type: "shift" | "duplicate" | "invert" | "skip"
  shift: number
  srcRow: number
  invertStartX: number
  invertW: number
}

// A "beat" is a single moment within an episode
interface Beat {
  time: number // when this beat fires (offset from episode start)
  chromatic: boolean // enable chromatic aberration
  chromaticStrength: number
  glitches: GlitchRegion[] // localized glitches for this beat
  majorRows: MajorGlitchRow[] // major tear rows (empty for normal beats)
  duration: number // how long this beat's effects are visible
}

interface Episode {
  beats: Beat[]
  totalDuration: number
}

type Buffers = { char: Uint32Array; fg: Float32Array; bg: Float32Array; attributes: Uint32Array }

export class SpiderVerseEffect {
  // --- Always-on texture ---
  halftoneEnabled = true
  halftoneScale = 5
  halftoneStrength = 0.08
  scanlinesEnabled = true
  scanlinesStrength = 0.04
  chromaticStrength = 1

  // --- Episode orchestration ---
  private idleTimer = 3.0 + Math.random() * 2.0 // first episode in 3-5s
  private episode: Episode | null = null
  private episodeTime = 0
  private episodeCount = 0 // track how many episodes to know when to do a big one

  // --- Active beat state (what's currently being rendered) ---
  private activeBeat: Beat | null = null
  private beatEndTime = 0

  apply = (buffer: OptimizedBuffer, deltaTimeMs: number): void => {
    const width = buffer.width
    const height = buffer.height
    const buf = buffer.buffers
    const dt = deltaTimeMs / 1000

    // 1. Always-on texture
    if (this.halftoneEnabled) this.applyHalftone(buf.bg, width, height)
    if (this.scanlinesEnabled) this.applyScanlines(buf.fg, buf.bg, width, height)

    // 2. Episode orchestration
    this.tick(dt, width, height)

    // 3. Render active beat effects
    if (this.activeBeat) {
      if (this.activeBeat.chromatic) {
        this.applyChromaticAberration(buf.fg, buf.bg, width, height, this.activeBeat.chromaticStrength)
      }
      if (this.activeBeat.glitches.length > 0) {
        this.applyGlitches(buf, width, height, this.activeBeat.glitches)
      }
      if (this.activeBeat.majorRows.length > 0) {
        this.applyMajorGlitch(buf, width, height, this.activeBeat.majorRows)
      }
    }
  }

  private tick(dt: number, width: number, height: number): void {
    if (this.episode) {
      this.episodeTime += dt

      // Check if a new beat should activate
      for (const beat of this.episode.beats) {
        if (this.episodeTime >= beat.time && this.episodeTime < beat.time + beat.duration) {
          this.activeBeat = beat
          this.beatEndTime = beat.time + beat.duration
          break
        }
      }

      // Clear beat if its time has passed
      if (this.activeBeat && this.episodeTime >= this.beatEndTime) {
        this.activeBeat = null
      }

      // Episode over?
      if (this.episodeTime >= this.episode.totalDuration) {
        this.episode = null
        this.activeBeat = null
        // Calm after the storm: 5-10s for normal, 8-14s after a big episode
        this.idleTimer = this.episodeCount % 4 === 0 ? 8.0 + Math.random() * 6.0 : 5.0 + Math.random() * 5.0
      }
    } else {
      // Idle — count down to next episode
      this.idleTimer -= dt
      if (this.idleTimer <= 0) {
        this.episodeCount++
        const isBig = this.episodeCount % 4 === 0 // every 4th episode is a big one
        this.episode = isBig ? this.composeBigEpisode(width, height) : this.composeEpisode(width, height)
        this.episodeTime = 0
        this.activeBeat = null
      }
    }
  }

  // --- Episode composers ---

  // Normal episode: 2-4 beats over ~1-2 seconds
  // Chromatic flicker -> glitch cluster -> maybe another hit -> fade
  private composeEpisode(width: number, height: number): Episode {
    const beats: Beat[] = []
    let t = 0

    // Beat 1: chromatic aberration kicks in
    beats.push({
      time: t,
      chromatic: true,
      chromaticStrength: this.chromaticStrength,
      glitches: [],
      majorRows: [],
      duration: 0.3 + Math.random() * 0.3, // 300-600ms
    })

    // Beat 2: glitch cluster arrives (overlaps with chromatic)
    t += 0.1 + Math.random() * 0.15
    const glitchCount = 1 + Math.floor(Math.random() * 3)
    const focusX = Math.floor(Math.random() * width)
    const focusY = Math.floor(Math.random() * height)
    beats.push({
      time: t,
      chromatic: true,
      chromaticStrength: this.chromaticStrength,
      glitches: this.makeGlitchCluster(glitchCount, focusX, focusY, width, height),
      majorRows: [],
      duration: 0.2 + Math.random() * 0.3, // 200-500ms
    })

    // Beat 3 (50% chance): a second glitch hit nearby
    if (Math.random() < 0.5) {
      t += 0.15 + Math.random() * 0.2
      beats.push({
        time: t,
        chromatic: Math.random() < 0.5,
        chromaticStrength: this.chromaticStrength,
        glitches: this.makeGlitchCluster(
          1 + Math.floor(Math.random() * 2),
          focusX + Math.floor((Math.random() - 0.5) * 30),
          focusY + Math.floor((Math.random() - 0.5) * 5),
          width,
          height,
        ),
        majorRows: [],
        duration: 0.15 + Math.random() * 0.2,
      })
    }

    const lastBeat = beats[beats.length - 1]
    return { beats, totalDuration: lastBeat.time + lastBeat.duration + 0.1 }
  }

  // Big episode: normal beats + a major screen tear
  // Chromatic -> glitches -> escalates to major tear -> settles
  private composeBigEpisode(width: number, height: number): Episode {
    const beats: Beat[] = []
    let t = 0

    // Beat 1: strong chromatic hit
    beats.push({
      time: t,
      chromatic: true,
      chromaticStrength: 2,
      glitches: [],
      majorRows: [],
      duration: 0.3 + Math.random() * 0.2,
    })

    // Beat 2: glitches intensify
    t += 0.15 + Math.random() * 0.1
    const focusX = Math.floor(Math.random() * width)
    const focusY = Math.floor(Math.random() * height)
    beats.push({
      time: t,
      chromatic: true,
      chromaticStrength: 2,
      glitches: this.makeGlitchCluster(2 + Math.floor(Math.random() * 3), focusX, focusY, width, height),
      majorRows: [],
      duration: 0.25 + Math.random() * 0.2,
    })

    // Beat 3: the major tear
    t += 0.2 + Math.random() * 0.15
    beats.push({
      time: t,
      chromatic: true,
      chromaticStrength: 3,
      glitches: this.makeGlitchCluster(1, focusX, focusY, width, height),
      majorRows: this.makeMajorGlitchRows(width, height),
      duration: 0.4 + Math.random() * 0.3, // 400-700ms — holds for a beat
    })

    // Beat 4 (optional): aftershock — small glitch as it settles
    if (Math.random() < 0.6) {
      t += 0.35 + Math.random() * 0.2
      beats.push({
        time: t,
        chromatic: true,
        chromaticStrength: this.chromaticStrength,
        glitches: this.makeGlitchCluster(1, focusX, focusY, width, height),
        majorRows: [],
        duration: 0.15 + Math.random() * 0.15,
      })
    }

    const lastBeat = beats[beats.length - 1]
    return { beats, totalDuration: lastBeat.time + lastBeat.duration + 0.1 }
  }

  // --- Helpers to generate glitch data ---

  private makeGlitchCluster(
    count: number,
    focusX: number,
    focusY: number,
    width: number,
    height: number,
  ): GlitchRegion[] {
    const glitches: GlitchRegion[] = []
    for (let i = 0; i < count; i++) {
      const gw = 10 + Math.floor(Math.random() * 35)
      const gh = 1 + Math.floor(Math.random() * 3)
      glitches.push({
        x: Math.max(0, Math.min(width - gw, focusX + Math.floor((Math.random() - 0.5) * 40))),
        y: Math.max(0, Math.min(height - gh, focusY + Math.floor((Math.random() - 0.5) * 6))),
        w: gw,
        h: gh,
        shift: Math.floor((Math.random() - 0.5) * 14),
        colorBleed: Math.random() < 0.4,
      })
    }
    return glitches
  }

  private makeMajorGlitchRows(width: number, height: number): MajorGlitchRow[] {
    const bandH = Math.floor(height * (0.3 + Math.random() * 0.4))
    const bandY = Math.floor(Math.random() * (height - bandH))
    const rows: MajorGlitchRow[] = []

    for (let y = bandY; y < bandY + bandH && y < height; y++) {
      const roll = Math.random()
      if (roll < 0.45) {
        rows.push({
          y,
          type: "shift",
          shift: Math.floor((Math.random() - 0.5) * 20),
          srcRow: 0,
          invertStartX: 0,
          invertW: 0,
        })
      } else if (roll < 0.65) {
        rows.push({
          y,
          type: "duplicate",
          shift: 0,
          srcRow: Math.max(0, Math.min(height - 1, y + Math.floor((Math.random() - 0.5) * 8))),
          invertStartX: 0,
          invertW: 0,
        })
      } else if (roll < 0.8) {
        const startX = Math.floor(Math.random() * width * 0.5)
        rows.push({
          y,
          type: "invert",
          shift: 0,
          srcRow: 0,
          invertStartX: startX,
          invertW: Math.floor(width * (0.3 + Math.random() * 0.5)),
        })
      } else {
        rows.push({ y, type: "skip", shift: 0, srcRow: 0, invertStartX: 0, invertW: 0 })
      }
    }
    return rows
  }

  // --- Renderers (unchanged buffer manipulation) ---

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

  private applyGlitches(buf: Buffers, width: number, height: number, glitches: GlitchRegion[]): void {
    for (const g of glitches) {
      for (let row = g.y; row < g.y + g.h && row < height; row++) {
        const base = row * width
        for (let col = g.x; col < g.x + g.w && col < width; col++) {
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

          if (g.colorBleed) {
            const tint = g.shift > 0 ? 0 : 2
            buf.fg[dc + tint] = Math.min(1, buf.fg[dc + tint] + 0.15)
            buf.bg[dc + tint] = Math.min(1, buf.bg[dc + tint] + 0.08)
          }
        }
      }
    }
  }

  private applyMajorGlitch(buf: Buffers, width: number, height: number, rows: MajorGlitchRow[]): void {
    const tempChar = new Uint32Array(width)
    const tempFg = new Float32Array(width * 4)
    const tempBg = new Float32Array(width * 4)
    const tempAttr = new Uint32Array(width)

    for (const row of rows) {
      if (row.y < 0 || row.y >= height) continue
      const base = row.y * width

      if (row.type === "shift") {
        if (row.shift === 0) continue
        tempChar.set(buf.char.subarray(base, base + width))
        tempFg.set(buf.fg.subarray(base * 4, (base + width) * 4))
        tempBg.set(buf.bg.subarray(base * 4, (base + width) * 4))
        tempAttr.set(buf.attributes.subarray(base, base + width))

        for (let x = 0; x < width; x++) {
          const srcX = (((x - row.shift) % width) + width) % width
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
      } else if (row.type === "duplicate") {
        const srcBase = row.srcRow * width
        buf.char.copyWithin(base, srcBase, srcBase + width)
        buf.attributes.copyWithin(base, srcBase, srcBase + width)
        buf.fg.copyWithin(base * 4, srcBase * 4, (srcBase + width) * 4)
        buf.bg.copyWithin(base * 4, srcBase * 4, (srcBase + width) * 4)
      } else if (row.type === "invert") {
        for (let x = row.invertStartX; x < row.invertStartX + row.invertW && x < width; x++) {
          const ci = (base + x) * 4
          buf.fg[ci] = 1.0 - buf.fg[ci]
          buf.fg[ci + 1] = 1.0 - buf.fg[ci + 1]
          buf.fg[ci + 2] = 1.0 - buf.fg[ci + 2]
          buf.bg[ci] = 1.0 - buf.bg[ci]
          buf.bg[ci + 1] = 1.0 - buf.bg[ci + 1]
          buf.bg[ci + 2] = 1.0 - buf.bg[ci + 2]
        }
      }
    }
  }
}
