# 开发说明

## 架构

```
浏览器（大屏 / 点歌台 / 手机） ──HTTP + WebSocket──▶ app（Node 24 · Fastify）
                                                     ├─ 网易云：@neteasecloudmusicapienhanced/api（库模式）
                                                     ├─ 点歌队列、播放状态、SQLite
                                                     └─ HTTP 任务 ──▶ separator（Python · audio-separator）
                                                                        文件通过 HTTP 上传 / 下载
```

- `apps/server`：后端，接口文档见 [api.md](api.md)。主要模块：
  - `core/`：`player.ts` 队列与播放状态，`pipeline.ts` 下载与分离调度，`mvPreload.ts` MV 预载与对齐，`storage.ts` 缓存策略（哪些保留、先清什么），`hub.ts` 状态与广播。
  - `media/`：`files.ts` 是媒体文件布局的唯一出处，`cache.ts` 扫描与删除，`busy.ts` 正在写入的文件，`ffmpeg.ts` 变调和分析音频。
  - `http/`：`routes.ts` 前台接口，`adminRoutes.ts` 后台接口（`/api/admin` 前缀），`ws.ts` WebSocket，`schemas.ts` 请求和消息校验，`errors.ts` 错误到状态码的映射。
  - `shared/`：`types.ts` 前后端共用的类型，`constants.ts` 共用的取值（升降调范围、设置上下限、匿名昵称、点歌规则）。
- 前端大页面按区域拆分：`pages/tv/*`（背景、MV、歌词、控制栏、各状态画面）、`pages/desk/*`（导航、搜索、内容页）、`components/admin/*`（后台各分区）。
- `apps/web`：前端，五个页面：`/` 点歌台、`/tv` 大屏（多块大屏中有一块是主屏）、`/m` 手机遥控、`/ear` 移动耳返、`/admin` 后台管理（运维面板，暂不鉴权）。
- `separator`：分离服务，可以部署多台。输出三个文件：
  - `instrumental.flac`：伴奏 + 和声
  - `vocals.flac`：主唱，原唱和领唱模式用它
  - `pitch.json`：主唱参考音高，打分用它

## 分离集群

- 分离服务器列表在 后台管理 → 分离服务器 里维护，存在 SQLite（`kv.separatorNodes`）。第一次启动时自动加入本机容器（`SEPARATOR_URL`）；`KTV_SEPARATOR=off` 时不加。
- 所有任务都走上传：先 `POST /files` 上传输入，再 `POST /jobs`（`input_file`），完成后从 `GET /jobs/{id}/files/{name}` 下载结果，最后 `DELETE /jobs/{id}` 清理。分离服务器不需要访问 KTV 的数据卷，本机容器也一样。
- 分离服务器设置了 `SEPARATOR_TOKEN` 时，任务接口要求 `Authorization: Bearer <token>`；`/health` 不需要。
- 调度（`apps/server/src/separator.ts`）：
  - 每首歌交给预计最早完成的服务器：预计时间 = 它手上任务的剩余时间 + 歌曲时长 × 它的速度系数。速度系数由分离服务器按实际耗时滚动更新，通过 `/health` 的 `speed_factor` 报告。
  - 如果最快完成的那台还在忙，这首歌就等它，而不是交给空闲但慢很多的服务器。
  - 多台服务器同时工作，已点列表按顺序分配。服务器中途掉线（连不上）时，这首歌重新排队，最多换 3 次服务器；其他错误直接播放原曲。
  - 音高提取和 MV 对齐交给当前任务最少的在线服务器。
- 单独部署一台分离服务器：`docker-compose.separator.yml`，或运行 `start-separator.cmd` / `start-separator.sh`（自动选 GPU / CPU，第一次运行时在 `.env.separator` 生成令牌，并打印地址和令牌）。

## 移动耳返的同步

- 时钟：主屏和耳返通过 WebSocket ping / pong 估算与服务端的时钟偏差（取最近 16 次里往返最快的 3 次的平均，`apps/web/src/lib/clock.ts`）。局域网里误差一般在几毫秒内。
- 主屏每秒上报一次：此刻扬声器正在播放的位置（`AudioContext.getOutputTimestamp()`，已含输出延迟），加上它的服务端时间。所以“主屏在服务端时间 t 播放到哪里”是一条直线。
- 耳返在自己的音频时钟上排好起点，让手机发出的声音落在这条直线上（再加上用户设置的延迟）。之后每 200ms 用手机自己的 `getOutputTimestamp()` 测一次偏差：
  - 偏差在 3ms 以内不动；
  - 80ms 以内把播放速度微调最多 ±0.4%（每秒追回 4ms，听不出音高变化）；
  - 超过 80ms（拖动进度、暂停后继续、上报中断）直接按直线重新起播。
- 主屏的上报会做平滑：同一段连续播放里相差 50ms 以内的上报，只取 30% 的修正，避免时钟估算的抖动带动耳返。
- 蓝牙耳机等额外延迟浏览器测不到，由用户的“提前 / 延后”滑块补偿（±600ms）。“测量蓝牙延迟”（`apps/web/src/components/LatencyCalibration.tsx`）帮用户找这个值：手机每秒按固定节拍发一声“嘀”，外圈每秒穿过内圈一次，重合时刻画在节拍之后“当前延迟”处；用户听到“嘀”就点一下，每次点击把延迟设为“点击时刻 − 这一拍发出的时刻”，重合时刻随之对齐到听到声音的时刻。延迟对了，重合和“嘀”就同时发生，用户确认后把它设为耳返的“提前”量。
- 主屏没了（页面关掉、刷新后等待点击、标签页被冻结）时，服务端把歌曲暂停在当时的位置（`core/player.ts` 里的 `freeze`：主屏断开、或在线却 6 秒没有上报、或没有主屏时服务端自己计时到了歌曲结尾）。否则“正在播放”的状态会一直留着，遥控上的进度越过歌曲时长也不会结束。
- 调研记录见 [feasibility-study.md](feasibility-study.md)。

## Docker 启动做了什么

`start.cmd` / `start.ps1` / `start.sh`：

1. 没有 `.env` 时从 `.env.example` 复制一份。
2. `.env` 没设 `PUBLIC_URL` 时，检测本机局域网 IP，作为手机二维码地址传给容器。
3. 用 `docker run --gpus all busybox true` 检测 Docker 能否访问 NVIDIA 显卡：
   - 能：叠加 `docker-compose.gpu.yml`，分离服务用 `beveradb/audio-separator:gpu` 镜像并分配显卡。
   - 不能：用多架构的 `cpu` 镜像（支持 amd64 / arm64）。
   - 用 `KTV_GPU=on|off` 可以强制指定。
4. `docker compose up -d --build`。

分离服务启动后先在后台下载并加载默认模型，下载到 `ktv-models` 卷，所以第一首歌不用再等模型。

- GPU 默认模型：`mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt`，约 900MB。
- CPU 默认模型：`UVR_MDXNET_KARA_2.onnx`。

`/health` 返回的 `stage` 字段会依次经过 `starting` → `preparing_model` → `ready`；准备期间前端显示“分离模型准备中”。

## 本地开发

需要 Node 22.13+ 和 ffmpeg。ffmpeg 要在 PATH 里，或者设置 `FFMPEG_PATH` / `FFPROBE_PATH`。

```bash
npm install
```

```bash
npm run dev
```

后端监听 `http://localhost:8686`，前端开发服务器是 `http://localhost:5173`，`/api` 自动代理到后端。

分离服务是可选的，不启动时播放原曲：

```bash
cd separator
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install "audio-separator[gpu]" -r requirements.txt
```

`audio-separator[gpu]` 在 Windows 上会装成 CPU 版 PyTorch，需要换成 CUDA 版。版本号与已装的 torch 一致；驱动支持 CUDA 13 时用 cu130 源：

```bash
pip install --force-reinstall --no-deps torch==2.14.1 --index-url https://download.pytorch.org/whl/cu130
```

```bash
set MODEL_DIR=models
python app.py
```

没有 NVIDIA 显卡时，把 `[gpu]` 换成 `[cpu]`，并跳过换 PyTorch 那一步。

在 RTX 4060 Laptop 上实测，一首 3 分钟左右的歌：分离约 45 秒，提取音高再约 10 秒。

生产构建：

```bash
npm run build
```

```bash
npm start
```

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `KTV_PORT` | `8686` | Docker 映射到宿主机的端口 |
| `PORT` | `8686` | 后端端口（容器内） |
| `DATA_DIR` | `./data` | 数据目录（SQLite、音频、伴奏） |
| `SEPARATOR_URL` | `http://127.0.0.1:9000` | 分离服务地址 |
| `PUBLIC_URL` | 自动检测 | 二维码使用的局域网地址 |
| `ACCESS_TOKEN` | 空 | 访问令牌，空表示不鉴权 |
| `AUDIO_LEVEL` | `exhigh` | 网易云音质 |
| `SEPARATOR_MODEL` | 自动 | 分离模型文件名 |
| `PRELOAD_MODEL` | `1` | 分离服务启动时预下载、预加载模型 |
| `ENABLE_UNBLOCK` | `false` | 第三方音源开关 |
| `UNBLOCK_SOURCES` | `unm` | 第三方音源，逗号分隔 |
| `SCORING_ENABLED` | `true` | 大屏显示麦克风打分（只在主屏上打分） |
| `SCORE_TOLERANCE` | `1.0` | 打分容错，单位为半音（0.3–3） |
| `MV_PRELOAD` | `true` | 提前下载已点歌曲的 MV，并自动与歌曲对齐 |
| `MV_RESOLUTION` | `720` | MV 清晰度：480 / 720 / 1080 |
| `CACHE_LIMIT_GB` | `20` | 音频、伴奏和 MV 缓存的上限，超出时先清理最久没用的歌 |
| `KTV_SEPARATOR` | `on` | `off` 表示本机不运行分离服务，只用其他电脑上的分离服务器 |
| `IDLE_MUSIC` | `true` | 待机音乐默认是否开启 |
| `SEPARATOR_TOKEN` | 空 | （分离服务器）任务接口的令牌 |
| `JOBS_DIR` | 系统临时目录 | （分离服务器）上传文件和结果的存放目录 |

## 领唱

- **哪些句子领唱**：每段的第一句，即第一句，以及和上一句间隔 ≥ 4 秒的那一句（`SECTION_GAP_MS`，`apps/web/src/lib/lyrics.ts`）。这些句子前面也会显示倒计时点，两者用同一个判断。
- **倒计时点数**：按间隔给 3–5 个点，每秒消失一个，并在上一句结束后留出 1 秒：间隔 4 秒 3 个点，5 秒 4 个，6 秒以上 5 个。
- **拖动进度之后**：落在一句歌词中间时，这一句剩下的部分和下一句都带原唱；落在两句之间时，下一句带原唱。重唱时清除。
- **淡出**：领唱结束时人声不是直接切掉，而是从结束前一点开始指数淡出，时长 0.2–0.8 秒，取决于离下一句还有多久，保证下一句开始时原唱已经基本听不到。
- **校准起止**（`apps/web/src/lib/leadVocal.ts`）：
  - 把主唱音轨按 10ms 一帧算音量，门限取“95 分位 × 0.1”和“30 分位 × 2”中较大的值。
  - 起点：在歌词时间前 0.6 秒到后 0.5 秒内，找第一个连续 60ms 超过门限的位置，再提前 0.12 秒。
  - 终点：从最后一个字往后找，最多找 1.5 秒，遇到 0.25 秒的静音就停，再加 0.12 秒尾音；不超过下一句开始前 0.08 秒。
  - 检测不到人声时退回歌词时间。
- **排程**（`scheduleVocalGain`）：主唱音量在音频时钟上排好，开启时间常数 20ms、收回 120ms。伴奏和主唱两轨同时开始播放，所以切换点是逐采样精确的。暂停、跳转、升降调、调音量时都会重新排程。

## MV 对齐

- MV 下载后，用 ffmpeg 把 MV 音轨和歌曲原曲都转成 11kHz 单声道，交给分离服务的 `align` 任务处理。
- 先对两边的起音强度曲线做互相关，在 ±120 秒范围内找偏移；再比较这个偏移下的和声特征（chroma），和随便错开几个位置时的相似度相比，看高出多少。
- 置信度为两项的乘积：起音相关度高于 0.3 开始计分、0.8 以上记满；和声相似度提升 0.05 以上记满。重叠部分不足 30 秒的直接记 0。用真实 MV 校准过：同一录音约为 1，不同歌曲或残缺的 MV 为 0。
- 大屏在置信度 ≥ 0.5 时按偏移同步（视频时间 = 音频时间 + 偏移）；MV 和歌曲时长相差 3 秒以内时也同步（偏移为 0）。其余情况独立循环播放。
- 同步时的追帧策略：
  - 误差在 0.15 秒以内，正常速度播放。
  - 误差在 0.15–1.5 秒之间，把播放速度调到 0.9–1.1 倍慢慢追上。
  - 误差超过 1.5 秒，并且目标位置已经缓冲好，才直接跳转。

## 打分规则

- 每帧取演唱音高和参考音高的误差（不区分八度，参考音高会随升降调一起移动），时间上允许 ±250ms 的偏差（唱早或唱晚都算），取窗口内最小的误差。
- 误差不超过容错 T 时得满分，在 T 到 3T 之间线性递减到 0，超过 3T 记 0 分。
- 只统计长度不少于 120ms 的音，并跳过每个音开头和结尾各 60ms 的过渡段。该出声的时候没出声，记 0 分。
- 整首得分：`100 × min(1, 原始得分率 / 0.9) ^ 0.75`，范围 0–100。每句评级用同样的换算。
- 唱完后，主屏把成绩提交到 `/api/scores`，演唱者取自点歌时填写的昵称。

运维选项（分离服务器、音质、模型、待机音乐、局域网地址、MV 与缓存、第三方音源）在后台管理 `/admin` 里修改；打分开关和容错在点歌台的“设置”里修改。

## 升降调

- 由服务端用 ffmpeg 的 rubberband 渲染变调后的文件（`media/<id>/pitch/`），一个 4 分钟的音轨约 7 秒。
- 主屏在按键停止 0.5 秒后才去加载，连按几下只渲染最终的调；渲染期间旧的调继续播放，升降调按钮上显示“变调中”。
- 第一次变调后，服务端在后台预先渲染相邻的两个调，之后再按一次基本马上生效。

## 待机音乐

- 已点列表为空时，主屏在扫码页面上小声循环播放后台设置的歌单（默认 Tony Anderson《1993》）。
- 音量是独立的“待机音乐音量”（`player.idleVolume`，默认 40%），在手机遥控、点歌台、后台管理里实时调，大屏待机时按 ↑↓ 也能调。
- 多块大屏时，其他大屏显示主屏正在放的待机音乐；开了“多大屏播放”并取消静音后和主屏同步发声（再乘上这块大屏自己的音量）。
- 歌曲由 `POST /api/idle/:id/prepare` 按需下载原曲，不进入点歌队列，也不做分离。
- 有人点歌时淡出并暂停，下次待机从原来的位置继续。

## 第三方音源（unblock）

默认关闭。打开后，**只有网易云完全没有音源的歌**才会去第三方平台匹配；会员歌、付费歌、只能试听的歌一律不走第三方音源。

- 没有会员的账号上，会员歌的 `privilege.st` 也是负数，看起来和“无版权”一样，所以判断时先看歌曲本身的 `fee`。
- 匹配到的音频时长和网易云标注相差超过 3 秒就丢弃。
- 打开后，歌曲 id 会发送给第三方站点。这些音源的授权状况不明，仅限个人本地使用。
