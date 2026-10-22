# Netease-KTV 后端接口

类型定义见 [apps/server/src/shared/types.ts](../apps/server/src/shared/types.ts)。所有接口前缀 `/api`，返回 JSON。

## 鉴权

可选。设置了环境变量 `ACCESS_TOKEN` 时，请求需带 `Authorization: Bearer <token>` 或查询参数 `?token=<token>`（WebSocket、媒体、图片地址都用查询参数）。不设置则局域网内免鉴权。

## 状态与实时同步

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ ok: true, version }` |
| GET | `/state` | `AppState`：队列、播放状态、各歌曲伴奏状态、分离服务状态 |
| WS | `/ws` | 连上后先发 `{type:'hello', role}`；服务端立即推送一次完整 `state`，之后增量推送 `ServerMessage` |

播放模型：

- **主屏（role = tv）是唯一的发声端。** 它根据 `player` 状态加载音频，每秒上报一次 `report`，播完发 `ended`。
- **同一时间只有一个主屏发声。** 服务端给每个主屏连接发 `{type:'tvRole', active}`。
  - 主屏点“开始”或“在这里播放”时发 `{type:'claim'}`，成为发声主屏，其余主屏收到 `active:false` 后必须静音。
  - 只有发声主屏会收到 play/pause/seek/restart 指令，它的 `report` / `ended` 才会被采纳。
  - 发声主屏断开时，发声权交给最近打开的另一个主屏。
  - 主屏加载歌曲时，从服务端记录的位置继续，并保持原来的播放/暂停状态；只有新切到的歌从 0 开始。
- 其他端（desk、remote）发 `command`。服务端处理音量、升降调、原唱/伴奏、切歌，然后广播 `player`。play / pause / seek / restart 会转发给主屏执行，主屏执行后的上报再更新状态。
- `player.epoch` 变化表示需要从头重新加载当前歌曲。

## 账号

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/account` | `Account` |
| POST | `/auth/qr` | `{ key, qrUrl }`，`qrUrl` 由前端渲染成二维码 |
| GET | `/auth/qr/:key` | `{ status: QrStatus, account?: Account }`，前端每 2 秒轮询 |
| POST | `/auth/cookie` | `{ cookie }`，手动粘贴 `MUSIC_U` 登录 |
| POST | `/auth/logout` | 退出登录 |

## 曲库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/search?q=&offset=&limit=` | `{ songs: Song[], hasMore }` |
| GET | `/search/suggest?q=` | `{ keywords: string[] }` |
| GET | `/recommend` | `{ songs: Song[], daily: boolean }`。已登录返回日推，未登录返回热歌榜 |
| GET | `/playlists` | `{ playlists: PlaylistSummary[] }`，当前账号的歌单 |
| GET | `/toplists` | `{ playlists: PlaylistSummary[] }`，官方榜单 |
| GET | `/playlists/:id/tracks?offset=&limit=` | `{ songs: Song[], hasMore }` |
| GET | `/songs/:id` | `Song` |
| GET | `/songs/:id/lyrics` | `Lyrics` |
| GET | `/songs/:id/mv` | `{ mvId, url }`，`url` 指向 `/api/mv/:mvId/stream`；没有 MV 返回 404 |
| GET | `/mv/:mvId/stream` | MV 视频代理（支持 Range） |
| GET | `/img?u=<网易云图片地址>&s=<尺寸>` | 封面代理（同源，方便取色），只允许 `*.music.126.net` |

## 点歌队列

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/queue` | `{ songId, position?: 'end' \| 'next' \| 'now' }` → `QueueItem`。`now` 表示立即切到这首（当前歌不再回到队列）。没有正在播放的歌时直接开始播放。会员歌返回 409 |
| POST | `/queue/:uid/play` | 立即播放队列中的这首（切歌） |
| POST | `/queue/:uid/top` | 置顶（移到下一首） |
| POST | `/queue/reorder` | `{ uids: string[] }`，按给定顺序重排（拖拽排序用） |
| DELETE | `/queue/:uid` | 删除 |
| DELETE | `/queue` | 清空 |

## 播放控制

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/player/command` | body 为 `PlayerCommand`，效果同 WebSocket 的 `command` |

## 媒体

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/media/:songId/:stem?key=` | `stem` 取 `instrumental` / `vocals` / `original`；`key` 为升降调半音数，非 0 时服务端用 ffmpeg 渲染并缓存。支持 Range |
| GET | `/media/:songId/pitch` | `PitchTrack`：主唱参考音高，用于打分。`track.hasPitch` 为 true 时可用，否则 404 |
| POST | `/tracks/:songId/retry` | 重新下载并分离 |

## 打分排行榜

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/scores` | `ScoreSubmit`（`{ songId, score, tolerance, singer? }`，分数已归一化到 0–100）→ `ScoreSubmitResult`（含本次在该歌中的名次） |
| GET | `/scores` | `{ songs: SongRanking[] }`：所有打过分的歌，按最高分排序，每首带前 10 名 |
| GET | `/scores/:songId` | `SongRanking`，带前 50 名；没有成绩返回 404 |
| DELETE | `/scores` | 重置整个排行榜 |
| DELETE | `/scores/:songId` | 重置一首歌的成绩 |

成绩变化时，WebSocket 会推送 `{ type: 'scores' }`。

## 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings` | `Settings` 加 `unblockSourceOptions: string[]` |
| PUT | `/settings` | 部分更新 `Settings` |
