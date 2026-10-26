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

- **大屏与主屏。** 每个播放页面（role = tv）都是一块“大屏”，其中只有一块是“主屏”。主屏根据 `player` 状态加载音频，每秒上报一次 `report`，播完发 `ended`。
  - `report` 带 `at`：这一位置的声音从主屏扬声器播出时的服务端时间（毫秒，已含输出延迟），以及 `uid` / `epoch`（属于哪首歌，切歌过程中的旧上报会被丢弃）。
- **时钟同步：** 主屏和移动耳返发 `{type:'ping', id}`，服务端立即回 `{type:'pong', id, t}`（`t` 为服务端高精度时间）。客户端取往返最快的几次估算时钟偏差。
- **移动耳返（role = ear）：** 服务端把主屏的每次上报转成 `{type:'sync', sync: PlaybackSync}` 推给耳返；耳返连上时先收到最近一次。
- **同一时间只有一块主屏。** 服务端给每块大屏发 `{type:'tvRole', active}`（`active` 表示是不是主屏）。
  - 大屏点“开始”或“设为主屏”时发 `{type:'claim', displayMode}`，成为主屏。它当时的 舞台 / MV 模式成为同步的模式，点歌台和手机遥控显示、控制的都是主屏。
  - 其他大屏继续显示：歌词、进度和 MV 按主屏的 `sync` 上报同步（和移动耳返用同一套时钟）。右下角有“设为主屏”按钮。
  - `multiScreenSync`（多大屏协同）开启时，所有大屏都用同步的 舞台 / MV 模式；关闭时，主屏以外的大屏各自切换，只影响自己。
  - `multiScreenAudio`（多大屏播放）开启时，主屏以外的大屏可以取消静音，按主屏的上报对齐起播，偏差超过 35ms 时重新对齐；开启时不会自动取消静音，关闭时主屏以外的大屏全部静音。取消静音后，这块大屏还有自己的音量（只存在这台设备上，歌曲和待机音乐都按它缩放）。
  - 只有主屏会收到 play/pause/seek/restart 指令，它的 `report` / `ended` 才会被采纳；打分只在主屏上。
  - 待机音乐由主屏选歌播放，并像歌曲一样每秒上报 `{type:'idleReport', songId, position, playing, at}`；服务端转成 `{type:'idle', idle: IdleSync}` 推给其他大屏（大屏连上时先收到最近一次）。其他大屏显示同一首待机音乐，取消静音后按同样的规则对齐播放。换主屏时待机音乐停在原处，新主屏从那里继续。
  - 主屏断开时，主屏交给最近打开的另一块大屏。
  - 主屏加载歌曲时，从服务端记录的位置继续，并保持原来的播放/暂停状态；只有新切到的歌从 0 开始。
- 其他端（desk、remote、ear）发 `command`。服务端处理音量（`musicVolume` 伴奏、`idleVolume` 待机音乐，都是 0–1）、升降调、原唱/伴奏、切歌，然后广播 `player`。play / pause / seek / restart 会转发给主屏执行，主屏执行后的上报再更新状态。
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
| GET | `/albums/:id` | `AlbumDetail`：专辑信息和全部歌曲 |
| GET | `/artists/:id` | `ArtistDetail`：歌手信息（单曲数、专辑数） |
| GET | `/artists/:id/songs?offset=&limit=` | `{ songs: Song[], hasMore }`，按热度排序 |
| GET | `/playlists` | `{ playlists: PlaylistSummary[] }`，当前账号的歌单 |
| GET | `/toplists` | `{ playlists: PlaylistSummary[] }`，官方榜单 |
| GET | `/playlists/:id/tracks?offset=&limit=` | `{ songs: Song[], hasMore }`（任意公开歌单都可以） |
| GET | `/playlists/resolve?q=` | 把粘贴的歌单链接、分享文本（含 163cn.tv 短链）或歌单 ID 解析成 `PlaylistSummary`。用于“临时导入歌单”：导入记录只存在导入设备的浏览器里，服务端不保存 |
| GET | `/songs/:id` | `Song` |
| GET | `/songs/:id/lyrics` | `Lyrics` |
| GET | `/songs/:id/mv` | `MvInfo`：`url` 指向 `/api/mv/:mvId/stream`；`cached` 表示已缓存到本地；`offset` / `confidence` 是 MV 与歌曲的自动对齐结果（视频时间 = 音频时间 + offset）。没有 MV 返回 404 |
| GET | `/mv/:mvId/stream` | MV 视频（支持 Range）。已缓存时读本地文件，否则代理网易云 |
| GET | `/songs/:id/preview` | 试听：低音质（standard）音频流，在点歌的设备本地播放，不进队列。拿不到返回 404。不走第三方音源 |
| GET | `/img?u=<网易云图片地址>&s=<尺寸>` | 封面代理（同源，方便取色），只允许 `*.music.126.net` |

曲库类 GET 接口都可以加 `fresh=1`：跳过服务端的网易云数据缓存，重新获取（点歌台每页右上角的刷新按钮）。

## 点歌队列

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/queue` | `{ songId, position?: 'end' \| 'next', addedBy? }` → `QueueItem`。`next` 为插播。`addedBy` 为空时记为“匿名”（点歌台固定为匿名，只有手机端可设昵称）。没有正在播放的歌时直接开始播放。会员歌返回 409 |
| GET | `/history` | 点歌记录：`{ songs: Song[] }`，最近点过的 50 首（同一首只记一次，再点会回到最前），从新到旧。变化时 WebSocket 推送 `{ type: 'history' }` |
| POST | `/queue/shuffle` | 随机打乱整个队列（当前歌不受影响） |
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
| PUT | `/settings` | 点歌台能改的设置（`DeskSettings`）：`scoringEnabled`、`scoreTolerance`、`multiScreenSync`（多大屏协同）、`multiScreenAudio`（多大屏播放）。其他字段会被忽略 |
| GET | `/idle` | `IdleMusic`：待机音乐是否开启和歌曲列表（音量是 `player.idleVolume`，用 `set` 指令实时调） |
| POST | `/idle/:id/prepare` | 确保待机音乐里的这首歌已下载到本地（不在列表里返回 404）。之后用 `/media/:id/original` 播放 |

设置变化时（点歌台或后台管理），WebSocket 推送 `{ type: 'settings' }`。

## 后台管理

`/admin` 页面使用的接口，全部在 `/api/admin/` 下。目前不单独鉴权（只受 `ACCESS_TOKEN` 限制）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/status` | `AdminStatus`：版本、运行时长、分离集群概况（在线 / 工作中的服务器数、待处理歌曲数）、各页面在线数、是否启用令牌 |
| PUT | `/admin/settings` | 部分更新运维设置（`AdminSettings`）：`audioLevel`、`separatorModel`、`publicUrl`、`mvPreload`、`mvResolution` 480/720/1080、`cacheLimitGB` 1–500、`unblockEnabled`、`unblockSources`、`idleEnabled`、`idleSongs` |
| GET | `/admin/separators` | `{ nodes: SeparatorNodeView[] }`：每台分离服务器的状态、设备、速度、正在做的任务、完成 / 失败数 |
| POST | `/admin/separators` | 添加：`{ name, url, token?, enabled?, model? }` |
| PUT | `/admin/separators/:id` | 修改，字段同上。`token` 省略表示不变，空字符串表示移除 |
| DELETE | `/admin/separators/:id` | 移除 |
| POST | `/admin/separators/test` | `{ url, token?, id? }` → `{ ok, message, health? }`：测试连接和令牌（传 `id` 时用已保存的令牌） |
| GET | `/admin/cache` | `CacheInfo`：音频、MV 缓存占用，以及网易云数据缓存条数 |
| DELETE | `/admin/cache` | 清空音频和 MV 缓存（正在唱和已点的歌除外） |
| DELETE | `/admin/cache/data` | 清除网易云数据缓存（歌单、榜单、日推、搜索、歌词）。这些数据平时按各自的有效期缓存；网易云接口出错时先返回过期的旧数据 |
