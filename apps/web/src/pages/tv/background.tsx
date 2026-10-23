import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Song } from '@shared/types'
import { imgUrl } from '../../lib/api'
import { ambientColor, companionColor } from '../../lib/color'

/** 大屏 backgrounds: the song-coloured glows, the idle page glows, the vignette. */

export function Ambient({ song }: { song: Song | null }) {
  const [color, setColor] = useState('#FF4D7E')
  const picUrl = song?.album.picUrl
  useEffect(() => {
    let alive = true
    ambientColor(imgUrl(picUrl, 120)).then((c) => alive && setColor(c))
    return () => {
      alive = false
    }
  }, [picUrl])
  const second = companionColor(color)
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <AnimatePresence>
        <motion.div
          key={color}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.6 }}
          className="absolute inset-0"
        >
          <div
            className="ktv-drift absolute -top-[30vh] -left-[14vw] h-[100vh] w-[58vw] rounded-full opacity-[0.42]"
            style={{ background: `radial-gradient(circle, ${color} 0%, rgba(0,0,0,0) 62%)` }}
          />
          <div
            className="ktv-drift-slow absolute top-[6vh] -right-[16vw] h-[92vh] w-[52vw] rounded-full opacity-[0.36]"
            style={{ background: `radial-gradient(circle, ${second} 0%, rgba(0,0,0,0) 60%)` }}
          />
        </motion.div>
      </AnimatePresence>
      <div
        className="absolute -bottom-[52vh] left-[32vw] h-[84vh] w-[47vw] rounded-full opacity-[0.16]"
        style={{ background: 'radial-gradient(circle, #FF9F43 0%, rgba(0,0,0,0) 60%)' }}
      />
    </div>
  )
}

/** A blob that wanders slowly to a new random spot every 9–16 s (idle page background). */
export function WanderBlob({ className, style, range }: { className: string; style: React.CSSProperties; range: number }) {
  const pick = () => ({
    x: `${(Math.random() * 2 - 1) * range}vw`,
    y: `${(Math.random() * 2 - 1) * range * 0.8}vh`,
    scale: 0.85 + Math.random() * 0.35,
    duration: 9 + Math.random() * 7,
  })
  const [to, setTo] = useState(pick)
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ x: 0, y: 0, scale: 1 }}
      animate={{ x: to.x, y: to.y, scale: to.scale }}
      transition={{ duration: to.duration, ease: 'easeInOut' }}
      onAnimationComplete={() => setTo(pick())}
    />
  )
}

/** Idle page background: the two glows drift around irregularly so the screen feels alive. */
export function IdleAmbient() {
  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.6 }}
    >
      <WanderBlob
        range={14}
        className="absolute -top-[30vh] -left-[14vw] h-[100vh] w-[58vw] rounded-full opacity-[0.42]"
        style={{ background: 'radial-gradient(circle, #FF4D7E 0%, rgba(0,0,0,0) 62%)' }}
      />
      <WanderBlob
        range={12}
        className="absolute top-[6vh] -right-[16vw] h-[92vh] w-[52vw] rounded-full opacity-[0.36]"
        style={{ background: `radial-gradient(circle, ${companionColor('#FF4D7E')} 0%, rgba(0,0,0,0) 60%)` }}
      />
      <div
        className="absolute -bottom-[52vh] left-[32vw] h-[84vh] w-[47vw] rounded-full opacity-[0.16]"
        style={{ background: 'radial-gradient(circle, #FF9F43 0%, rgba(0,0,0,0) 60%)' }}
      />
    </motion.div>
  )
}

export const Vignette = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0"
    style={{
      background:
        'radial-gradient(ellipse at 50% 46%, rgba(7,7,11,0) 0%, rgba(7,7,11,0.5) 68%, rgba(7,7,11,0.9) 100%)',
    }}
  />
)
