# Netease KTV

基于网易云音乐的本地 KTV。用你自己登录的网易云账号点歌，取歌曲、逐字歌词和 MV；AI 去掉主唱、保留和声，生成伴奏。电视或电脑做主屏，手机扫码点歌。

- **点歌台**（`/`）：搜索、日推、排行榜、我的歌单，查看已点列表和伴奏生成进度。
- **主屏**（`/tv`）：逐字歌词、MV 或封面取色背景、导唱音量、升降调、原唱/伴奏切换、扫码点歌。整个系统只有主屏发声。
- **手机遥控**（`/m`）：点歌、切歌、调音量、升降调。

> 默认只播放登录账号有权播放的完整歌曲。会员歌在没有会员的账号上不可点，项目不含任何破解。见下文“第三方音源”。

## 架构

```
浏览器（主屏 / 点歌台 / 手机） ──HTTP + WebSocket──▶ app（Node 24 · Fastify）
                                                     ├─ 网易云：@neteasecloudmusicapienhanced/api（库模式）
                                                     ├─ 点歌队列、播放状态、SQLite
                                                     └─ HTTP 任务 ──▶ separator（Python · audio-separator）
                                                                        两者共享 /data 卷
```

- 伴奏：`instrumental.flac` = 伴奏 + 和声，`vocals.flac` = 主唱（导唱音量用它）。
- GPU 默认模型 `mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt`，CPU 默认模型 `UVR_MDXNET_KARA_2.onnx`。
- 分离服务不可用时自动改播原曲。
- 升降调由服务端 ffmpeg 渲染并缓存。

详细调研见 [docs/feasibility-study.md](docs/feasibility-study.md)，接口文档见 [docs/api.md](docs/api.md)。

## Docker 部署（推荐）

```bash
cp .env.example .env
```

只有 CPU：

```bash
docker compose up -d
```

有 NVIDIA 显卡（Windows 需要 Docker Desktop + WSL2，Linux 需要 nvidia-container-toolkit）：

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

启动后：

1. 打开 `http://<本机局域网 IP>:8686`，点左下角登录，用网易云 App 扫码。
2. 主屏设备打开 `http://<本机局域网 IP>:8686/tv`，点一下“开始”（浏览器要求先有一次点击才能出声）。
3. 手机扫主屏上的二维码点歌。

说明：

- 容器拿不到宿主机的局域网 IP。请在 `.env` 的 `PUBLIC_URL` 或应用设置里填写局域网地址，二维码才会正确。
- Windows 防火墙需要放行 8686 端口，手机才能访问。
- 模型在第一次分离时下载，存在 `ktv-models` 卷里；歌曲缓存、伴奏和数据库存在 `ktv-data` 卷里。
- 只在局域网内使用，不要映射到公网。需要时设置 `ACCESS_TOKEN`。

## 本地开发

需要 Node 22.13+ 和 ffmpeg（加入 PATH，或设置 `FFMPEG_PATH` / `FFPROBE_PATH`）。

```bash
npm install
```

```bash
npm run dev
```

后端监听 `http://localhost:8686`，前端开发服务器默认是 `http://localhost:5173`，`/api` 会代理到后端。

分离服务（可选，不启动时播放原曲）：

```bash
cd separator
python -m venv .venv
.venv\Scripts\activate
pip install "audio-separator[gpu]" -r requirements.txt
python app.py
```

没有 NVIDIA 显卡时，把 `[gpu]` 换成 `[cpu]`。

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
| `PORT` | `8686` | 后端端口 |
| `DATA_DIR` | `./data` | 数据目录（SQLite、音频、伴奏） |
| `SEPARATOR_URL` | `http://127.0.0.1:9000` | 分离服务地址 |
| `PUBLIC_URL` | 空 | 二维码使用的局域网地址 |
| `ACCESS_TOKEN` | 空 | 访问令牌，空表示不鉴权 |
| `AUDIO_LEVEL` | `exhigh` | 网易云音质 |
| `SEPARATOR_MODEL` | 自动 | 分离模型文件名 |
| `ENABLE_UNBLOCK` | `false` | 第三方音源开关 |
| `UNBLOCK_SOURCES` | `unm` | 第三方音源，逗号分隔 |

除 `PORT`、`DATA_DIR`、`SEPARATOR_URL`、`ACCESS_TOKEN` 外，其余都可以在应用设置里修改。

## 第三方音源（unblock）

默认关闭。打开后，**只有网易云完全没有音源的歌**才会去第三方平台匹配；会员歌、付费歌、只能试听的歌一律不走第三方音源。

- 匹配到的音频时长和网易云标注相差超过 3 秒就丢弃，避免拿到 live 版或翻唱版后歌词对不上。
- 打开后，点歌的歌曲 id 会发送给第三方站点。这些音源的授权状况不明，仅限个人本地使用。

## 免责声明

本项目依赖非官方的网易云接口，接口可能随时失效，账号也有被风控的可能。生成的伴奏仅供个人本地使用，请勿分发或用于商业用途。
