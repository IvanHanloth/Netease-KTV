import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import type { LyricLine, PlayerState, Song, TrackState } from '@shared/types'
import { api, imgUrl, mediaUrl, tokenized } from '../lib/api'
import { ambientColor, companionColor } from '../lib/color'
import { artistsText, deriveStatus, fmtTime } from '../lib/format'
import { useIsLocalhostOrigin, useRemoteUrl, useSettings } from '../lib/hooks'
import { currentLineIndex, hasLyrics, lineWords, wordFills } from '../lib/lyrics'
import { AudioEngine } from '../player/engine'
import { useScoring } from '../player/useScoring'
import type { MicError } from '../player/mic'
import { connect, onCommand, sendCommand, sendMessage, useApp } from '../store/app'
import { Icon } from '../components/icons'
import { Cover, ProgressBar, Range, Spinner, StatusPill } from '../components/ui'
import { QrCode } from '../components/QrCode'
import { PitchLane } from '../components/PitchLane'
import { LineRatingPop, ScoreOverlay, type ScoreResult } from '../components/ScoreOverlay'

// ---------------- Ambient background ----------------

function Ambient({ song }: { song: Song | null }) {
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
            className="ktv-drift absolute -top-[30vh] -left-[14vw] h-[100vh] w-[58vw] rounded-full opacity-[0.42] blur-[30px]"
            style={{ background: `radial-gradient(circle, ${color} 0%, rgba(0,0,0,0) 62%)` }}
          />
          <div
            className="ktv-drift-slow absolute top-[6vh] -right-[16vw] h-[92vh] w-[52vw] rounded-full opacity-[0.36] blur-[30px]"
            style={{ background: `radial-gradient(circle, ${second} 0%, rgba(0,0,0,0) 60%)` }}
          />
        </motion.div>
      </AnimatePresence>
      <div
        className="absolute -bottom-[52vh] left-[32vw] h-[84vh] w-[47vw] rounded-full opacity-[0.16] blur-[30px]"
        style={{ background: 'radial-gradient(circle, #FF9F43 0%, rgba(0,0,0,0) 60%)' }}
      />
    </div>
  )
}

function MvLayer({ song }: { song: Song }) {
  const { data } = useQuery({
    queryKey: ['mv', song.id],
    queryFn: () => api.mv(song.id),
    enabled: song.mvId > 0,
    retry: false,
    staleTime: 10 * 60_000,
  })
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [data?.url])
  if (!data?.url || failed) return null
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.2 }}
      aria-hidden="true"
      className="absolute inset-0"
    >
      <video
        key={data.url}
        src={tokenized(data.url)}
        muted
        loop
        autoPlay
        playsInline
        onError={() => setFailed(true)}
        className="h-full w-full object-cover opacity-55"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,7,11,0.75)_0%,rgba(7,7,11,0.35)_35%,rgba(7,7,11,0.45)_60%,rgba(7,7,11,0.92)_100%)]" />
    </motion.div>
  )
}

const Vignette = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0"
    style={{
      background:
        'radial-gradient(ellipse at 50% 46%, rgba(7,7,11,0) 0%, rgba(7,7,11,0.5) 68%, rgba(7,7,11,0.9) 100%)',
    }}
  />
)

// ---------------- Lyrics ----------------

function useClock(getMs: () => number, active: boolean) {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = -1
    const tick = () => {
      const v = getMs()
      if (Math.abs(v - last) >= 16) {
        last = v
        setMs(v)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getMs, active])
  return ms
}

function CurrentLine({ line, ms, showTranslation }: { line: LyricLine; ms: number; showTranslation: boolean }) {
  const words = lineWords(line)
  const fills = wordFills(line, ms)
  return (
    <div className="flex flex-col items-center gap-[2vh]">
      <p className="m-0 px-[4vw] text-[clamp(40px,4.8vw,104px)] leading-[1.15] font-black tracking-[0.04em]">
        {words.map((w, i) => {
          const p = fills[i] ?? 0
          return (
            <span
              key={i}
              style={{
                backgroundImage: `linear-gradient(90deg, #FFFFFF ${p}%, rgba(255,255,255,0.34) ${p}%)`,
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                filter: p >= 100 ? 'drop-shadow(0 0 22px rgba(255,77,126,0.75))' : 'none',
                whiteSpace: 'pre-wrap',
              }}
            >
              {w.text}
            </span>
          )
        })}
      </p>
      {showTranslation && (line.translation || line.roma) && (
        <p className="num m-0 px-[4vw] text-[clamp(18px,1.45vw,32px)] tracking-[0.02em] text-[#C8C8D0]">
          {line.translation || line.roma}
        </p>
      )}
    </div>
  )
}

function LyricsView({ songId, getMs, song }: { songId: number; getMs: () => number; song: Song }) {
  const { data } = useQuery({ queryKey: ['lyrics', songId], queryFn: () => api.lyrics(songId), staleTime: Infinity })
  const ms = useClock(getMs, hasLyrics(data))
  if (!data) return null
  if (!hasLyrics(data))
    return (
      <div className="flex flex-col items-center gap-6 text-center">
        <Cover song={song} px={600} className="h-[30vh] w-[30vh] rounded-[28px] shadow-[0_30px_80px_rgba(0,0,0,0.5)]" />
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[clamp(36px,3.6vw,72px)] font-black">{song.name}</p>
          <p className="m-0 text-[clamp(16px,1.3vw,26px)] text-muted">这首歌暂无歌词，尽情发挥吧</p>
        </div>
      </div>
    )
  const lines = data.lines
  const idx = currentLineIndex(lines, ms)
  const cur = Math.max(0, idx)
  const prev = idx > 0 ? lines[idx - 1] : null
  const next1 = lines[cur + 1]
  const next2 = lines[cur + 2]
  const showTranslation = lines.some((l) => l.translation || l.roma)
  return (
    <div className="flex w-full flex-col items-center gap-[2.8vh] text-center">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.p
          key={'p' + (idx - 1)}
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -30 }}
          transition={{ duration: 0.35 }}
          className="m-0 min-h-[1.2em] px-[4vw] text-[clamp(22px,2.1vw,44px)] font-medium text-white/40"
        >
          {prev?.text ?? ' '}
        </motion.p>
        <motion.div
          key={'c' + cur}
          layout
          initial={{ opacity: 0, y: 40, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -40, scale: 0.92 }}
          transition={{ duration: 0.4 }}
          className="my-[1.5vh]"
        >
          <CurrentLine line={lines[cur]} ms={idx < 0 ? -1 : ms} showTranslation={showTranslation} />
        </motion.div>
        <motion.p
          key={'n' + (cur + 1)}
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -30 }}
          transition={{ duration: 0.35 }}
          className="m-0 min-h-[1.2em] px-[4vw] text-[clamp(24px,2.4vw,50px)] font-semibold text-white/62"
        >
          {next1?.text ?? ' '}
        </motion.p>
        <motion.p
          key={'m' + (cur + 2)}
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="m-0 min-h-[1.2em] px-[4vw] text-[clamp(20px,1.9vw,40px)] font-medium text-white/38"
        >
          {next2?.text ?? ' '}
        </motion.p>
      </AnimatePresence>
    </div>
  )
}

// ---------------- Header / footer pieces ----------------

function Chip({ children, icon }: { children: ReactNode; icon?: 'wave' | 'lyrics' | 'globe' | 'note' }) {
  return (
    <span className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-white/10 bg-white/8 px-3 text-[15px] text-[#E4E4EA]">
      {icon && <Icon name={icon} size={16} />}
      {children}
    </span>
  )
}

function Header({ player, track }: { player: PlayerState; track?: TrackState }) {
  const cur = player.current!
  const queue = useApp((s) => s.state.queue)
  const tracks = useApp((s) => s.state.tracks)
  const { data: lyrics } = useQuery({
    queryKey: ['lyrics', cur.song.id],
    queryFn: () => api.lyrics(cur.song.id),
    staleTime: Infinity,
  })
  const next = queue[0]
  const nextStatus = next ? deriveStatus(next.song, tracks[next.song.id], true) : null
  const working = queue.find((q) => {
    const st = tracks[q.song.id]?.status
    return st === 'separating' || st === 'downloading'
  })
  const workingTrack = working ? tracks[working.song.id] : undefined
  const karaoke = player.trackMode === 'karaoke' && track?.hasStems
  return (
    <header className="absolute top-[5.2vh] right-[3.75vw] left-[3.75vw] flex items-start justify-between gap-8">
      <div className="flex min-w-0 items-center gap-6">
        <Cover song={cur.song} px={300} className="h-24 w-24 rounded-[18px] shadow-[0_18px_40px_rgba(0,0,0,0.45)]" />
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="m-0 truncate text-[34px] font-bold tracking-[0.01em]">{cur.song.name}</h1>
          <div className="truncate text-xl text-[#B4B4BE]">
            {artistsText(cur.song)}
            {cur.song.album.name && ` · ${cur.song.album.name}`}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2.5">
            {karaoke ? <Chip icon="wave">伴奏 · 保留和声</Chip> : <Chip icon="note">原唱</Chip>}
            {lyrics?.kind === 'yrc' && <Chip icon="lyrics">逐字歌词</Chip>}
            {track?.source === 'unblock' && <Chip icon="globe">第三方音源</Chip>}
            {player.key !== 0 && <Chip>{player.key > 0 ? `升 ${player.key} 调` : `降 ${-player.key} 调`}</Chip>}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-4">
        {next && nextStatus && (
          <div className="glass flex items-center gap-4 rounded-[20px] py-3.5 pr-5 pl-3.5">
            <Cover song={next.song} px={120} className="h-14 w-14 rounded-xl" />
            <div className="flex max-w-[22vw] min-w-0 flex-col gap-1">
              <div className="text-sm tracking-[0.12em] text-muted">下一首</div>
              <div className="truncate text-xl font-semibold">
                {next.song.name} <span className="font-normal text-[#B4B4BE]">· {artistsText(next.song)}</span>
              </div>
            </div>
            <span className="ml-2">
              <StatusPill status={nextStatus} large />
            </span>
          </div>
        )}
        <div className="flex items-center gap-3 text-base text-[#B4B4BE]">
          {working && workingTrack && (
            <>
              <Icon name="sparkles" size={18} className="text-accent" />
              <span className="max-w-[18vw] truncate">
                {workingTrack.status === 'downloading' ? '下载中' : 'AI 伴奏分离'} · {working.song.name}
              </span>
              <ProgressBar value={workingTrack.progress} color="#FF4D7E" className="w-[120px]" />
              <span className="num text-[#E4E4EA]">{Math.round(workingTrack.progress * 100)}%</span>
              <span className="text-faint">|</span>
            </>
          )}
          <span>已点 {queue.length + 1} 首</span>
        </div>
      </div>
    </header>
  )
}

function Progress({ getPos, duration }: { getPos: () => number; duration: number }) {
  const [pos, setPos] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setPos(getPos()), 250)
    return () => clearInterval(t)
  }, [getPos])
  const pct = duration ? Math.min(100, (pos / duration) * 100) : 0
  return (
    <div className="num flex items-center gap-5 text-lg text-[#C8C8D0]">
      <span>{fmtTime(pos)}</span>
      <div
        role="slider"
        tabIndex={-1}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(pos)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          sendCommand({ action: 'seek', position: ((e.clientX - r.left) / r.width) * duration })
        }}
        className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/14"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: pct + '%', background: 'linear-gradient(90deg, #FF4D7E 0%, #FFB3C6 100%)', boxShadow: '0 0 16px #FF4D7E' }}
        />
      </div>
      <span>{fmtTime(duration)}</span>
    </div>
  )
}

function ControlPill({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('glass flex h-16 items-center gap-3.5 rounded-[20px] px-5.5', className)}>{children}</div>
}

function Controls({ player, hasStems, extra }: { player: PlayerState; hasStems: boolean; extra?: ReactNode }) {
  const set = (patch: Omit<Extract<Parameters<typeof sendCommand>[0], { action: 'set' }>, 'action'>) =>
    sendCommand({ action: 'set', ...patch })
  return (
    <div className="flex flex-wrap items-center gap-4">
      {hasStems && player.trackMode === 'karaoke' && (
        <ControlPill>
          <Icon name="mic" size={22} />
          <span className="text-lg">导唱</span>
          <div className="w-[120px]">
            <Range label="导唱音量" value={Math.round(player.vocalVolume * 100)} onChange={(v) => set({ vocalVolume: v / 100 })} color="#FFFFFF" />
          </div>
          <span className="num w-11 text-lg text-[#C8C8D0]">{Math.round(player.vocalVolume * 100)}%</span>
        </ControlPill>
      )}
      <ControlPill>
        <Icon name="volume" size={22} />
        <span className="text-lg">{player.trackMode === 'karaoke' && hasStems ? '伴奏' : '音量'}</span>
        <div className="w-[120px]">
          <Range label="伴奏音量" value={Math.round(player.musicVolume * 100)} onChange={(v) => set({ musicVolume: v / 100 })} color="#FFFFFF" />
        </div>
        <span className="num w-11 text-lg text-[#C8C8D0]">{Math.round(player.musicVolume * 100)}%</span>
      </ControlPill>
      <ControlPill className="pr-3">
        <span className="text-lg">升降调</span>
        <button
          type="button"
          aria-label="降调"
          disabled={player.key <= -6}
          onClick={() => set({ key: player.key - 1 })}
          className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-white/8 hover:bg-white/14 disabled:opacity-40"
        >
          <Icon name="minus" size={20} strokeWidth={2} />
        </button>
        <span className="num w-10 text-center text-[22px] font-semibold text-accent">
          {player.key > 0 ? '+' + player.key : player.key}
        </span>
        <button
          type="button"
          aria-label="升调"
          disabled={player.key >= 6}
          onClick={() => set({ key: player.key + 1 })}
          className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-white/8 hover:bg-white/14 disabled:opacity-40"
        >
          <Icon name="plus" size={20} strokeWidth={2} />
        </button>
      </ControlPill>
      {hasStems && (
        <div role="group" aria-label="音轨" className="glass flex h-16 items-center gap-1 rounded-[20px] px-2.5">
          {(
            [
              ['karaoke', '伴奏'],
              ['original', '原唱'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={player.trackMode === mode}
              onClick={() => set({ trackMode: mode })}
              className={clsx(
                'h-11 rounded-[14px] px-4.5 text-[17px]',
                player.trackMode === mode ? 'bg-fg font-semibold text-ink' : 'text-[#C8C8D0] hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {extra}
    </div>
  )
}

const SCORE_PREF = 'ktv.scoring'

function readScorePref() {
  try {
    return localStorage.getItem(SCORE_PREF) === '1'
  } catch {
    return false
  }
}

function ScoreToggle({
  on,
  onToggle,
  hasPitch,
  status,
  micError,
  pitchError,
}: {
  on: boolean
  onToggle: () => void
  hasPitch: boolean
  status: 'off' | 'loading' | 'on' | 'error'
  micError: MicError | null
  pitchError: boolean
}) {
  let hint: string | null = null
  if (on) {
    if (!window.isSecureContext || micError === 'insecure') hint = '麦克风需要通过 localhost 或 HTTPS 打开主屏'
    else if (micError === 'denied') hint = '麦克风权限被拒绝，请在浏览器里允许'
    else if (micError === 'unavailable') hint = '没有找到可用的麦克风'
    else if (!hasPitch) hint = '这首歌暂无参考音高（需要伴奏分离）'
    else if (pitchError) hint = '参考音高加载失败'
    else if (status === 'loading') hint = '正在打开麦克风…'
  }
  return (
    <div className="glass flex h-16 items-center gap-3 rounded-[20px] pr-4 pl-2.5">
      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        className={clsx(
          'flex h-11 items-center gap-2 rounded-[14px] px-4 text-[17px] transition-colors',
          on ? 'bg-accent font-semibold text-accent-ink' : 'bg-white/8 text-fg hover:bg-white/14',
        )}
      >
        <Icon name="mic" size={20} />
        评分
      </button>
      {hint && <span className="max-w-[240px] text-[13px] leading-5 text-warn">{hint}</span>}
    </div>
  )
}

function QrCard({ big }: { big?: boolean }) {
  const url = useRemoteUrl()
  const localhost = useIsLocalhostOrigin()
  const display = url.replace(/^https?:\/\//, '').replace(/\?.*$/, '')
  return (
    <div className={clsx('glass flex items-center rounded-3xl', big ? 'gap-8 p-6 pr-10' : 'gap-5.5 p-4.5 pr-6.5')}>
      <QrCode value={url} size={big ? 220 : 132} label="扫码点歌二维码" />
      <div className="flex flex-col gap-1.5">
        <div className={clsx('font-bold', big ? 'text-[34px]' : 'text-2xl')}>扫码点歌</div>
        <div className={clsx('text-[#B4B4BE]', big ? 'text-lg' : 'text-base')}>同一 Wi‑Fi 下用手机扫描</div>
        <div className={clsx('num mt-1.5 font-medium text-accent', big ? 'text-xl' : 'text-[17px]')}>{display}</div>
        {localhost && (
          <div className="mt-1 max-w-[260px] text-[13px] leading-5 text-warn">
            当前通过 localhost 打开，手机无法访问。请在点歌台“设置”里填写局域网地址。
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------- States ----------------

function IdleScreen() {
  const connected = useApp((s) => s.connected)
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[6vh] px-[4vw] text-center">
      <div className="flex flex-col items-center gap-5">
        <div className="flex h-20 w-20 items-center justify-center rounded-[24px] bg-[linear-gradient(135deg,#FF4D7E_0%,#8B5CF6_100%)] text-white shadow-[0_20px_60px_rgba(255,77,126,0.45)]">
          <Icon name="mic" size={40} strokeWidth={2} />
        </div>
        <h1 className="m-0 text-[clamp(40px,4.4vw,88px)] font-black tracking-[0.02em]">今晚，谁先开嗓？</h1>
        <p className="m-0 text-[clamp(16px,1.4vw,26px)] text-[#B4B4BE]">
          {connected ? '用手机扫码点一首歌，伴奏会自动生成' : '正在连接 KTV 主机…'}
        </p>
      </div>
      <QrCard big />
    </div>
  )
}

function PreparingScreen({ song, track, loading, loadError }: { song: Song; track?: TrackState; loading: boolean; loadError: string }) {
  let title = '正在准备'
  let detail = ''
  let progress: number | null = null
  let tone: 'normal' | 'warn' = 'normal'
  switch (track?.status) {
    case 'downloading':
      title = '正在下载歌曲'
      progress = track.progress
      break
    case 'queued':
      title = '排队等待生成伴奏'
      detail = '前面还有歌曲在处理'
      break
    case 'separating':
      title = '正在生成伴奏'
      progress = track.progress
      detail = 'AI 正在去除主唱、保留和声'
      break
    case 'unavailable':
      title = '这首歌无法播放'
      detail = track.message || (song.playable === 'vip' ? '需要会员才能播放完整版' : '网易云暂无音源')
      tone = 'warn'
      break
    case 'error':
      title = '伴奏生成失败'
      detail = (track.message ? track.message + ' · ' : '') + '可在点歌台重试或切到下一首'
      tone = 'warn'
      break
    case 'ready':
      title = loadError ? '音频加载失败' : '正在加载音频'
      detail = loadError
      tone = loadError ? 'warn' : 'normal'
      break
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center px-[4vw]">
      <div className="flex flex-col items-center gap-8 text-center">
        <div className="relative">
          <Cover song={song} px={600} className="h-[34vh] w-[34vh] rounded-[32px] shadow-[0_30px_80px_rgba(0,0,0,0.55)]" />
          {(loading || progress !== null || track?.status === 'queued') && tone === 'normal' && (
            <div className="absolute -right-4 -bottom-4 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_10px_30px_rgba(255,77,126,0.5)]">
              <Spinner size={28} />
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="text-[clamp(28px,2.6vw,52px)] font-black">
            {title}
            {progress !== null && <span className="num ml-3 text-accent">{Math.round(progress * 100)}%</span>}
          </div>
          <div className="text-[clamp(18px,1.4vw,28px)] text-fg-2">
            {song.name} · {artistsText(song)}
          </div>
          {detail && <div className={clsx('text-base', tone === 'warn' ? 'text-warn' : 'text-muted')}>{detail}</div>}
          {progress !== null && <ProgressBar value={progress} color="#FF4D7E" className="mt-3 h-1.5 w-[32vw] max-w-[520px]" />}
        </div>
      </div>
    </div>
  )
}

// ---------------- Page ----------------

export default function Tv() {
  const engineRef = useRef<AudioEngine | null>(null)
  if (!engineRef.current) engineRef.current = new AudioEngine()
  const engine = engineRef.current
  const [unlocked, setUnlocked] = useState(false)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [loadError, setLoadError] = useState('')
  const player = useApp((s) => s.state.player)
  const tracks = useApp((s) => s.state.tracks)
  const connected = useApp((s) => s.connected)
  const { data: settings } = useSettings()
  const [scoreOn, setScoreOn] = useState(readScorePref)
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null)
  const finishRef = useRef<() => ScoreResult | null>(() => null)
  const toggleScore = useCallback(() => {
    setScoreOn((v) => {
      try {
        localStorage.setItem(SCORE_PREF, v ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !v
    })
  }, [])
  const clearScoreResult = useCallback(() => setScoreResult(null), [])

  useEffect(() => connect('tv'), [])
  useEffect(() => {
    document.title = '主屏 · Netease KTV'
  }, [])

  const report = useCallback(() => {
    if (!engine.hasTrack) return
    sendMessage({ type: 'report', position: engine.position(), playing: engine.playing })
  }, [engine])

  const cur = player.current
  const track = cur ? tracks[cur.song.id] : undefined
  const ready = track?.status === 'ready'
  const useStems = player.trackMode === 'karaoke' && !!track?.hasStems
  const songKey = cur ? `${cur.uid}|${player.epoch}|` : ''
  const loadKey = cur && ready ? `${songKey}${player.key}|${useStems ? 'k' : 'o'}` : ''

  // load audio when the song / epoch / key / mode changes
  useEffect(() => {
    if (!unlocked) return
    if (!loadKey || !cur) {
      if (engine.hasTrack) engine.unload()
      setLoadState('idle')
      return
    }
    if (engine.loadedKey === loadKey) return
    const sameSong = engine.loadedKey.startsWith(songKey)
    const id = cur.song.id
    const k = player.key
    const ac = new AbortController()
    setLoadState('loading')
    setLoadError('')
    engine
      .load(
        loadKey,
        useStems
          ? { main: mediaUrl(id, 'instrumental', k), vocals: mediaUrl(id, 'vocals', k) }
          : { main: mediaUrl(id, 'original', k) },
        ac.signal,
      )
      .then((ok) => {
        if (!ok) return
        setLoadState('ready')
        const resumeAt = sameSong ? engine.lastPosition : 0
        const resume = sameSong ? engine.lastPlaying : true
        if (resume) engine.play(resumeAt)
        else engine.seek(resumeAt)
        report()
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setLoadState('error')
        setLoadError(e instanceof Error ? e.message : '音频加载失败')
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, unlocked])

  // gains
  useEffect(() => {
    engine.setVolumes(player.musicVolume, useStems ? player.vocalVolume : 0)
  }, [engine, player.musicVolume, player.vocalVolume, useStems, loadState])

  // server-forwarded commands
  useEffect(
    () =>
      onCommand((c) => {
        if (!engine.hasTrack) return
        switch (c.action) {
          case 'play':
            if (!engine.playing) engine.play()
            break
          case 'pause':
            engine.pause()
            break
          case 'toggle':
            if (engine.playing) engine.pause()
            else engine.play()
            break
          case 'seek':
            engine.seek(c.position)
            break
          case 'restart':
            engine.seek(0)
            if (!engine.playing) engine.play(0)
            break
          default:
            return
        }
        report()
      }),
    [engine, report],
  )

  // periodic report + ended
  useEffect(() => {
    engine.onEnded = () => {
      const result = finishRef.current()
      if (result) setScoreResult(result)
      report()
      sendMessage({ type: 'ended' })
    }
    const t = setInterval(report, 1000)
    return () => {
      clearInterval(t)
      engine.onEnded = null
    }
  }, [engine, report])

  // keyboard shortcuts (TV remote / keyboard)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const p = useApp.getState().state.player
      switch (e.key) {
        case ' ':
          e.preventDefault()
          sendCommand({ action: 'toggle' })
          break
        case 'ArrowLeft':
          sendCommand({ action: 'seek', position: Math.max(0, engine.position() - 5) })
          break
        case 'ArrowRight':
          sendCommand({ action: 'seek', position: engine.position() + 5 })
          break
        case 'ArrowUp':
          e.preventDefault()
          sendCommand({ action: 'set', musicVolume: Math.min(1, Math.round((p.musicVolume + 0.05) * 100) / 100) })
          break
        case 'ArrowDown':
          e.preventDefault()
          sendCommand({ action: 'set', musicVolume: Math.max(0, Math.round((p.musicVolume - 0.05) * 100) / 100) })
          break
        case 'n':
        case 'N':
          sendCommand({ action: 'next' })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  const getMs = useCallback(() => engine.position() * 1000, [engine])
  const getPos = useCallback(() => engine.position(), [engine])
  const playingAudio = loadState === 'ready' && engine.hasTrack

  const scoringAllowed = settings?.scoringEnabled ?? true
  const { data: lyricsData } = useQuery({
    queryKey: ['lyrics', cur?.song.id],
    queryFn: () => api.lyrics(cur!.song.id),
    enabled: !!cur,
    staleTime: Infinity,
  })
  const scoring = useScoring({
    engine,
    active: unlocked && scoreOn && scoringAllowed && playingAudio,
    songId: cur?.song.id ?? null,
    songKey,
    hasPitch: !!track?.hasPitch,
    pitchKey: player.key,
    lines: lyricsData?.lines,
  })
  finishRef.current = () => {
    const s = scoring.finish()
    return s !== null && cur ? { id: Date.now(), score: s, song: cur.song } : null
  }
  const laneShown = scoring.status === 'on'

  const start = async () => {
    try {
      await engine.unlock()
      setUnlocked(true)
      document.documentElement.requestFullscreen?.().catch(() => {})
    } catch {
      setUnlocked(false)
    }
  }

  const duration = useMemo(() => (playingAudio ? engine.duration : (cur?.song.duration ?? 0) / 1000), [playingAudio, engine, cur])

  return (
    <div className="relative h-full min-h-[560px] w-full overflow-hidden bg-ink-2 text-fg select-none">
      <Ambient song={cur?.song ?? null} />
      {cur && playingAudio && cur.song.mvId > 0 && <MvLayer key={cur.song.id} song={cur.song} />}
      <Vignette />

      {!cur ? (
        <IdleScreen />
      ) : (
        <>
          <Header player={player} track={track} />
          {playingAudio ? (
            <main
              className={clsx(
                'absolute inset-x-0 top-[27vh] flex items-center justify-center transition-[bottom] duration-500',
                laneShown ? 'bottom-[38vh]' : 'bottom-[26vh]',
              )}
            >
              <LyricsView songId={cur.song.id} getMs={getMs} song={cur.song} />
            </main>
          ) : (
            <PreparingScreen song={cur.song} track={track} loading={loadState === 'loading'} loadError={loadError} />
          )}
          {laneShown && <LineRatingPop rating={scoring.lineRating} />}
          <footer className="absolute right-[3.75vw] bottom-[5.2vh] left-[3.75vw] flex flex-col gap-5">
            {laneShown && <PitchLane lane={scoring.lane} getTime={getPos} score={scoring.score} />}
            <div className="flex items-end gap-12">
              <div className="flex min-w-0 flex-1 flex-col gap-7">
                <Progress getPos={getPos} duration={duration} />
                <Controls
                  player={player}
                  hasStems={!!track?.hasStems}
                  extra={
                    scoringAllowed && (
                      <ScoreToggle
                        on={scoreOn}
                        onToggle={toggleScore}
                        hasPitch={!!track?.hasPitch}
                        status={scoring.status}
                        micError={scoring.micError}
                        pitchError={scoring.pitchError}
                      />
                    )
                  }
                />
              </div>
              <div className="hidden lg:block">
                <QrCard />
              </div>
            </div>
          </footer>
        </>
      )}

      <ScoreOverlay result={scoreResult} onDone={clearScoreResult} />

      {!connected && (
        <div className="glass absolute top-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm text-warn">
          <Spinner size={14} /> 与主机断开，正在重连…
        </div>
      )}

      <AnimatePresence>
        {!unlocked && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="absolute inset-0 z-40 flex items-center justify-center bg-ink-2/80 backdrop-blur-md"
          >
            <button
              type="button"
              onClick={start}
              autoFocus
              className="group flex flex-col items-center gap-6 rounded-[32px] p-10 text-center"
            >
              <span className="flex h-28 w-28 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_20px_60px_rgba(255,77,126,0.55)] transition-transform group-hover:scale-105">
                <Icon name="play" size={48} />
              </span>
              <span className="text-[clamp(28px,2.6vw,48px)] font-black">点击开始 KTV</span>
              <span className="text-base text-muted">浏览器需要一次点击才能播放声音 · 将自动进入全屏</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
