import { useEffect } from 'react'
import { useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { RecordingInfo, RecordingRender, RecordingRenderKind } from '@shared/types'
import { api, ApiError, imgUrl, recordingFileUrl } from '../lib/api'
import { errorText, toast } from '../lib/hooks'
import { artistsText, fmtBytes } from '../lib/format'
import { Icon, type IconName } from '../components/icons'
import { ProgressBar, Spinner } from '../components/ui'

/**
 * 录制: the page behind the QR code a 大屏 shows after a song. Opening it keeps the recording
 * (otherwise it is deleted when the countdown ends) and starts mixing the audio; the MV and the
 * lyrics video are made when asked for.
 */
export default function Rec() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  useEffect(() => {
    document.title = '我的录音 · Netease KTV'
  }, [])

  const q = useQuery({
    queryKey: ['recording', id],
    queryFn: () => api.recording(id, true),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 3,
    refetchInterval: (query) => {
      const r = query.state.data?.renders
      return r && Object.values(r).some((x) => x.status === 'queued' || x.status === 'running') ? 1200 : false
    },
  })
  const render = useMutation({
    mutationFn: (kind: RecordingRenderKind) => api.renderRecording(id, kind),
    onSuccess: (info) => qc.setQueryData(['recording', id], info),
    onError: (e) => toast(errorText(e), 'error'),
  })

  if (q.isPending) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center text-muted">
          <Spinner size={28} />
        </div>
      </Shell>
    )
  }
  if (q.isError || !q.data) {
    const gone = q.error instanceof ApiError && q.error.status === 404
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/6 text-muted">
            <Icon name={gone ? 'clock' : 'alert'} size={28} />
          </span>
          <h1 className="m-0 text-xl font-extrabold">{gone ? '录音已过期' : '打不开录音'}</h1>
          <p className="m-0 text-sm leading-relaxed text-muted">
            {gone ? '二维码倒计时结束前没有人扫码，或者已经过了保存时间，录音已被删除。' : errorText(q.error)}
          </p>
          {!gone && (
            <button type="button" onClick={() => void q.refetch()} className="mt-2 h-11 rounded-2xl bg-white/8 px-5 text-sm font-semibold">
              重试
            </button>
          )}
        </div>
      </Shell>
    )
  }

  const info = q.data
  const start = (kind: RecordingRenderKind) => render.mutate(kind)
  return (
    <Shell>
      <SongCard info={info} />
      <AudioSection r={info.renders.audio} onStart={() => start('audio')} />
      <h2 className="m-0 mt-2 text-[15px] font-bold">合成视频</h2>
      <VideoCard
        kind="mv"
        icon="film"
        title="合成 MV"
        text="原版 MV 配上你的演唱"
        unavailable={info.hasMv ? null : '这首歌没有 MV'}
        r={info.renders.mv}
        onStart={() => start('mv')}
      />
      <VideoCard
        kind="lyrics"
        icon="lyrics"
        title="合成歌词视频"
        text="逐字歌词 + 你的演唱"
        unavailable={info.hasLyrics ? null : '这首歌没有歌词'}
        r={info.renders.lyrics}
        onStart={() => start('lyrics')}
      />
      <p className="m-0 mt-1 text-center text-xs leading-relaxed text-subtle">
        {keepText(info.expiresIn)}后自动删除 · 视频合成需要一两分钟，可以先离开再回来
        <br />
        苹果手机：点“下载”后在预览里点分享，选“存储到文件”或“存储视频”
      </p>
    </Shell>
  )
}

function keepText(expiresIn: number) {
  const h = Math.max(0, expiresIn / 3_600_000)
  return h >= 1 ? `${Math.round(h)} 小时` : `${Math.max(1, Math.round(h * 60))} 分钟`
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-ink text-fg">
      <div className="mx-auto flex min-h-full max-w-[520px] flex-col gap-3.5 px-4 pt-[max(20px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
        <header className="flex items-center gap-2 pb-1">
          <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-accent to-violet text-white">
            <Icon name="mic" size={17} />
          </span>
          <span className="text-[15px] font-bold">Netease KTV</span>
          <span className="text-sm text-muted">· 我的录音</span>
        </header>
        {children}
      </div>
    </div>
  )
}

function SongCard({ info }: { info: RecordingInfo }) {
  const cover = imgUrl(info.song.album.picUrl, 300)
  return (
    <section className="flex items-center gap-4 rounded-[22px] bg-white/[0.05] p-3.5">
      {cover ? (
        <img src={cover} alt="" className="h-20 w-20 shrink-0 rounded-2xl object-cover" />
      ) : (
        <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-white/8 text-muted">
          <Icon name="note" size={28} />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-lg font-extrabold">{info.song.name}</span>
        <span className="truncate text-[13px] text-muted">{artistsText(info.song)}</span>
        {info.singer && <span className="truncate text-[13px] text-accent-soft">演唱：{info.singer}</span>}
      </div>
    </section>
  )
}

function Working({ r, label }: { r: RecordingRender; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center justify-between text-[13px] text-fg-2">
        <span className="flex items-center gap-2">
          <Spinner size={14} />
          {r.status === 'queued' ? '排队中…' : label}
        </span>
        {r.status === 'running' && <span className="num text-muted">{Math.round(r.progress * 100)}%</span>}
      </span>
      <ProgressBar value={r.status === 'running' ? r.progress : 0} color="#FF4D7E" />
    </div>
  )
}

function Failed({ r, onRetry }: { r: RecordingRender; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 text-[13px] leading-snug text-warn">合成失败{r.error ? `：${r.error}` : ''}</span>
      <button type="button" onClick={onRetry} className="h-9 shrink-0 rounded-xl bg-white/8 px-3.5 text-[13px] font-semibold">
        重试
      </button>
    </div>
  )
}

function DownloadButton({ r, label }: { r: RecordingRender; label: string }) {
  if (!r.url) return null
  return (
    <a
      href={recordingFileUrl(r.url, true)}
      download
      className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-accent text-[15px] font-bold text-accent-ink active:scale-[0.98]"
    >
      <Icon name="download" size={18} strokeWidth={2} />
      {label}
      {r.size ? <span className="num text-[13px] font-semibold opacity-70">{fmtBytes(r.size)}</span> : null}
    </a>
  )
}

function AudioSection({ r, onStart }: { r: RecordingRender; onStart: () => void }) {
  return (
    <section aria-label="合成音频" className="flex flex-col gap-3 rounded-[22px] bg-white/[0.05] p-4">
      <span className="flex items-center gap-2 text-[15px] font-bold">
        <Icon name="headphones" size={18} className="text-accent-soft" />
        合成音频
        <span className="text-xs font-normal text-muted">伴奏 + 你的演唱</span>
      </span>
      {r.status === 'ready' && r.url ? (
        <>
          <audio controls preload="metadata" src={recordingFileUrl(r.url, false)} className="w-full" />
          <DownloadButton r={r} label="下载音频" />
        </>
      ) : r.status === 'error' ? (
        <Failed r={r} onRetry={onStart} />
      ) : r.status === 'idle' ? (
        <button type="button" onClick={onStart} className="h-12 rounded-2xl bg-accent text-[15px] font-bold text-accent-ink">
          开始合成
        </button>
      ) : (
        <Working r={r} label="正在合成音频…" />
      )}
    </section>
  )
}

function VideoCard({
  kind,
  icon,
  title,
  text,
  unavailable,
  r,
  onStart,
}: {
  kind: RecordingRenderKind
  icon: IconName
  title: string
  text: string
  unavailable: string | null
  r: RecordingRender
  onStart: () => void
}) {
  return (
    <section aria-label={title} className={clsx('flex flex-col gap-3 rounded-[22px] bg-white/[0.05] p-4', unavailable && 'opacity-60')}>
      <div className="flex items-center gap-3">
        <span className={clsx('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', r.status === 'ready' ? 'bg-accent text-accent-ink' : 'bg-white/10 text-fg-2')}>
          <Icon name={icon} size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-bold">{title}</span>
          <span className="truncate text-xs text-muted">{unavailable ?? text}</span>
        </span>
        {!unavailable && r.status === 'idle' && (
          <button type="button" onClick={onStart} className="h-10 shrink-0 rounded-xl bg-white/10 px-4 text-sm font-semibold hover:bg-white/14">
            开始合成
          </button>
        )}
      </div>
      {!unavailable && (r.status === 'queued' || r.status === 'running') && (
        <Working r={r} label={kind === 'mv' ? '正在合成 MV…' : '正在合成歌词视频…'} />
      )}
      {!unavailable && r.status === 'error' && <Failed r={r} onRetry={onStart} />}
      {!unavailable && r.status === 'ready' && r.url && (
        <>
          <video controls playsInline preload="metadata" src={recordingFileUrl(r.url, false)} className="aspect-video w-full rounded-2xl bg-black" />
          <DownloadButton r={r} label={kind === 'mv' ? '下载 MV' : '下载歌词视频'} />
        </>
      )}
    </section>
  )
}
