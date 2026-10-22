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

音质、模型、局域网地址、第三方音源和打分开关也能在应用设置里修改。

## 第三方音源（unblock）

默认关闭。打开后，**只有网易云完全没有音源的歌**才会去第三方平台匹配；会员歌、付费歌、只能试听的歌一律不走第三方音源。

- 没有会员的账号上，会员歌的 `privilege.st` 也是负数，看起来和“无版权”一样，所以判断时先看歌曲本身的 `fee`。
- 匹配到的音频时长和网易云标注相差超过 3 秒就丢弃。
- 打开后，歌曲 id 会发送给第三方站点。这些音源的授权状况不明，仅限个人本地使用。
