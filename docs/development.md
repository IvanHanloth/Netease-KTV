# 开发说明

## 架构

```
浏览器（主屏 / 点歌台 / 手机） ──HTTP + WebSocket──▶ app（Node 24 · Fastify）
                                                     ├─ 网易云：@neteasecloudmusicapienhanced/api（库模式）
                                                     ├─ 点歌队列、播放状态、SQLite
                                                     └─ HTTP 任务 ──▶ separator（Python · audio-separator）
                                                                        两者共享 /data 卷
```

- `apps/server`：后端，接口文档见 [api.md](api.md)。
- `apps/web`：前端，三个页面：`/` 点歌台、`/tv` 主屏、`/m` 手机遥控。
- `separator`：分离服务，输出三个文件：
  - `instrumental.flac`：伴奏 + 和声
  - `vocals.flac`：主唱，导唱音量用它
  - `pitch.json`：主唱参考音高，打分用它
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
| `SCORING_ENABLED` | `true` | 主屏显示麦克风打分 |
| `SCORE_TOLERANCE` | `1.0` | 打分容错，单位为半音（0.3–3） |
| `MV_PRELOAD` | `true` | 提前下载已点歌曲的 MV，并自动与歌曲对齐 |
| `MV_RESOLUTION` | `720` | MV 清晰度：480 / 720 / 1080 |
| `CACHE_LIMIT_GB` | `20` | 音频、伴奏和 MV 缓存的上限，超出时先清理最久没用的歌 |

## MV 对齐

- MV 下载后，用 ffmpeg 把 MV 音轨和歌曲原曲都转成 11kHz 单声道，交给分离服务的 `align` 任务处理。
- 先对两边的起音强度曲线做互相关，在 ±120 秒范围内找偏移；再比较这个偏移下的和声特征（chroma），和随便错开几个位置时的相似度相比，看高出多少。
- 置信度为两项的乘积：起音相关度高于 0.3 开始计分、0.8 以上记满；和声相似度提升 0.05 以上记满。重叠部分不足 30 秒的直接记 0。用真实 MV 校准过：同一录音约为 1，不同歌曲或残缺的 MV 为 0。
- 主屏在置信度 ≥ 0.5 时按偏移同步（视频时间 = 音频时间 + 偏移）；MV 和歌曲时长相差 3 秒以内时也同步（偏移为 0）。其余情况独立循环播放。
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

音质、模型、局域网地址、第三方音源和打分开关也能在应用设置里修改。

## 第三方音源（unblock）

默认关闭。打开后，**只有网易云完全没有音源的歌**才会去第三方平台匹配；会员歌、付费歌、只能试听的歌一律不走第三方音源。

- 没有会员的账号上，会员歌的 `privilege.st` 也是负数，看起来和“无版权”一样，所以判断时先看歌曲本身的 `fee`。
- 匹配到的音频时长和网易云标注相差超过 3 秒就丢弃。
- 打开后，歌曲 id 会发送给第三方站点。这些音源的授权状况不明，仅限个人本地使用。
