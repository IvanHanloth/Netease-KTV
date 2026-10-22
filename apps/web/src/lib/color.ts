import { FastAverageColor } from 'fast-average-color'

const fac = new FastAverageColor()
const cache = new Map<string, string>()

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

/** Dominant cover color, normalised to a vivid mid-lightness tone that works on a dark background. */
export async function ambientColor(url: string | undefined, fallback = '#FF4D7E'): Promise<string> {
  if (!url) return fallback
  const hit = cache.get(url)
  if (hit) return hit
  try {
    const c = await fac.getColorAsync(url, { algorithm: 'dominant', crossOrigin: 'anonymous' })
    const [r, g, b] = c.value
    const [h, s] = rgbToHsl(r, g, b)
    // greys get the brand accent instead of a muddy grey glow
    const color = s < 0.12 ? fallback : `hsl(${Math.round(h)} ${Math.round(Math.max(0.6, s) * 100)}% 58%)`
    cache.set(url, color)
    return color
  } catch {
    return fallback
  }
}

/** Second ambient tone: hue-rotated version of the first. */
export function companionColor(color: string) {
  const m = /hsl\((\d+)/.exec(color)
  if (!m) return '#6D4BFF'
  return `hsl(${(Number(m[1]) + 70) % 360} 70% 52%)`
}
