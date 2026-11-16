import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import type { RecordingOffer } from '@shared/types'
import { Icon } from '../../components/icons'
import { QrCode } from '../../components/QrCode'
import { serverNow } from '../../lib/clock'
import { useIsLocalhostOrigin, useRecordingUrl } from '../../lib/hooks'

/** Seconds left on the QR countdown, ticking. */
function useSecondsLeft(expiresAt: number | null) {
  const [now, setNow] = useState(() => serverNow() ?? Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const t = window.setInterval(() => setNow(serverNow() ?? Date.now()), 250)
    return () => window.clearInterval(t)
  }, [expiresAt])
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0
}

/**
 * 录制: after a song, a QR code to take the recording home. Big while the score card is up,
 * then small in the bottom-left corner until the countdown ends (it never blocks the next song).
 * Once someone has scanned it, it says so.
 */
export function RecordingCard({ offer, big, raised }: { offer: RecordingOffer | null; big: boolean; raised: boolean }) {
  const url = useRecordingUrl(offer?.id ?? null)
  const localhost = useIsLocalhostOrigin()
  const left = useSecondsLeft(offer?.expiresAt ?? null)
  const shown = !!offer && left > 0
  const qr = big ? 220 : 132

  return (
    <AnimatePresence>
      {shown && offer && (
        <motion.aside
          key={offer.id}
          aria-label="扫码带走这首歌的录音"
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 260, damping: 28 }}
          className={clsx(
            'glass absolute left-[3.75vw] z-50 flex items-center rounded-3xl transition-[bottom] duration-500',
            big ? 'gap-7 p-6 pr-9' : 'gap-5 p-4 pr-6',
            raised ? 'bottom-[calc(5.2vh+190px)]' : 'bottom-[5.2vh]',
          )}
        >
          <div className="relative shrink-0">
            {localhost ? (
              <div aria-hidden="true" className="flex items-center justify-center rounded-2xl bg-white/6 text-warn" style={{ width: qr, height: qr }}>
                <Icon name="alert" size={big ? 56 : 36} />
              </div>
            ) : (
              <QrCode value={url} size={qr} label="录音二维码" className={clsx(offer.claimed && 'opacity-35')} />
            )}
            {offer.claimed && (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-ok text-ink shadow-lg">
                  <Icon name="check" size={34} strokeWidth={3} />
                </span>
              </span>
            )}
          </div>
          <div className="flex max-w-[22vw] min-w-[220px] flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
              <span className={clsx('font-bold whitespace-nowrap', big ? 'text-[32px]' : 'text-[22px]')}>
                {offer.claimed ? '已扫码' : '扫码带走录音'}
              </span>
            </div>
            <div className={clsx('truncate text-fg-2', big ? 'text-lg' : 'text-base')}>
              《{offer.songName}》{offer.singer ? ` · ${offer.singer}` : ''}
            </div>
            <div className={clsx('leading-snug text-muted', big ? 'text-base' : 'text-sm')}>
              {offer.claimed ? '在手机上下载音频，或合成 MV、歌词视频' : '可下载合成音频，或合成 MV、歌词视频'}
            </div>
            {localhost ? (
              <div className="mt-1 text-sm leading-6 text-warn">通过 localhost 打开，手机无法访问。请在后台管理的“网络”里填写局域网地址。</div>
            ) : (
              <div className={clsx('num mt-1 font-semibold', offer.claimed ? 'text-ok' : 'text-accent-soft', big ? 'text-lg' : 'text-[15px]')}>
                {offer.claimed ? `${left} 秒后收起` : `${left} 秒内没人扫码就删除`}
              </div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

/** The room should know it is being recorded. */
export function RecBadge({ shown }: { shown: boolean }) {
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="glass pointer-events-none absolute top-[calc(1.2vh+var(--tb-h))] left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-3.5 py-1.5 text-[clamp(13px,0.8vw,16px)] font-semibold text-fg-2"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          录制中
        </motion.div>
      )}
    </AnimatePresence>
  )
}
