# Netease KTV

把家里的电脑或电视变成 KTV。登录你自己的网易云音乐账号点歌，系统自动用 AI 去掉原唱、保留和声，生成伴奏，配上逐字歌词和 MV 背景。手机扫码就能点歌、切歌、调音量。

> 默认只播放登录账号有权播放的完整歌曲，不含任何破解。项目依赖非官方的网易云接口，可能随时失效。生成的伴奏仅供个人本地使用，请勿分发或商用。

## 特点

- **网易云曲库**：搜索、每日推荐、排行榜、我的歌单。扫码登录，账号能听的歌都能点。
- **AI 伴奏**：只去主唱、保留和声，听起来不空。点歌后在后台提前生成，唱到时直接播放。
  - 有 NVIDIA 显卡时，一首歌约 1 分钟就能生成。
  - 没有显卡也能用，只是慢一些。
  - **可以接入多台分离服务器**：家里另一台有显卡的电脑也能帮忙，按速度自动分配，本机不一定要跑分离服务。
- **逐字歌词**：网易云逐字歌词逐字填色，支持翻译和罗马音；只有逐行歌词的歌自动按字估算时间。
- **移动耳返**：手机打开耳返页面，戴上耳机单独听主唱人声、原唱或伴奏，和主屏同步播放；早了晚了可以前后微调几百毫秒。同时是一个小提词器。
- **两种大屏模式**：
  - 舞台模式：沉浸式暗色界面，大字歌词，背景随专辑封面变色。
  - MV 模式：全屏播放 MV，底部只显示两行歌词，像传统 KTV 一样左右交替。MV 和歌曲版本一致时自动对齐画面。
  - 两种模式下，控制面板都会在空闲时自动隐藏。
  - 没人点歌时，扫码页面上小声播放待机音乐，背景缓缓流动。
- **调音**：音量、±6 半音升降调。伴唱 / 领唱 / 原唱无缝切换，不停顿、不重新加载。
- **领唱**：每段第一句（开头和每次停顿 4 秒以上之后）由原唱带着唱，唱完人声淡出、退回伴奏；拖动进度后接下来的一两句也会带原唱。切换点按主唱音轨里实际的人声位置校准，误差在毫秒级。
- **倒计时**：每段开唱前，在歌词上方显示 3–5 个点，逐秒消失，最后一个消失时正好开唱。
- **切歌与插播**：一键切歌、插播到下一首、随机打乱已点列表。下一首提前缓冲好，切过去马上就能唱；歌快唱完时，大屏侧边会显示接下来的歌，提醒下一位准备。
- **点歌记录**：记住最近点过的 50 首歌，从新到旧排列，一键再点一次。
- **专辑和歌手页**：点歌曲的专辑名或歌手名，直接看整张专辑或歌手的热门歌曲。
- **试听**：点歌前可以在手机或电脑上先试听一段，确认是不是要找的歌。
- **临时歌单**：粘贴网易云歌单链接就能临时导入，只保存在导入的那台设备上。
- **麦克风打分**：实时显示音高轨道，每句给出评级，唱完给出 0–100 的总分。音准容错可以在设置里调，有宽松、标准、严格三档。
- **K 歌排行榜**：记录每首歌每次的得分和演唱者，显示最高分、平均分和排名；可以重置单首歌或整个榜单。
- **手机遥控**：扫大屏上的二维码，手机就能点歌、插播、拖拽排序、切歌、调音。
- **多块大屏**：可以同时打开多个播放页面（大屏），其中一块是主屏，点歌台和手机控制的是它；其他大屏同步显示，可以各自切换 舞台 / MV，也可以一键设为主屏。在设置里可以让所有大屏统一模式（多大屏协同），或者让多块大屏同时发声（多大屏播放）。
- **开箱即用的 Docker 部署**：一条命令启动，自动判断用 GPU 还是 CPU，自动下载分离模型。
- **可选第三方音源**：默认关闭，只用于网易云完全没有音源的歌，会员歌不会走这条路。

## 启动方式

### 1. 准备

- 安装 Docker：
  - Windows / macOS：[Docker Desktop](https://www.docker.com/products/docker-desktop/)
  - Linux：Docker Engine + Docker Compose v2
- 想用 NVIDIA 显卡加速（可选）：
  - Windows：Docker Desktop 使用 WSL2 后端，并装好较新的 NVIDIA 驱动。
  - Linux：安装 [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)。
- 磁盘空间约 10 GB（镜像加模型）。

### 2. 一键启动

先下载代码：

```bash
git clone <本仓库地址> netease-ktv
```

```bash
cd netease-ktv
```

Windows：双击 `start.cmd`，或者在 PowerShell 里运行：

```powershell
.\start.ps1
```

Linux / macOS：

```bash
./start.sh
```

脚本会自动完成：

- 检测 Docker 能否使用 NVIDIA 显卡，选择 GPU 或 CPU 版的伴奏分离服务。
- 检测本机局域网 IP，用作手机扫码地址。
- 构建并启动容器。

第一次启动要下载基础镜像（约 4 GB），分离服务启动后还会自动下载 AI 模型（0.2–0.9 GB），视网速需要几分钟到十几分钟。之后再启动只要几秒。

查看模型下载进度：

```bash
docker compose logs -f separator
```

### 3. 开始唱歌

1. 打开点歌台 `http://<本机局域网 IP>:8686`（启动脚本会打印这个地址），点左下角“登录网易云”，用网易云音乐 App 扫码。
2. 在接电视或投影的那台电脑上打开大屏 `http://localhost:8686/tv`，点一下“开始”。
   - 浏览器要求先点一下才能出声。
   - 用 localhost 打开才能使用麦克风打分（配置了 HTTPS 后，用 HTTPS 地址打开也可以）。
3. 手机连同一个 Wi‑Fi，扫大屏上的二维码点歌。

手机打不开时，检查电脑防火墙是否放行了 8686 端口。

### 停止与更新

停止：

```bash
docker compose down
```

更新到最新版本：

```bash
git pull
```

然后重新运行启动脚本。

歌曲缓存、伴奏、登录状态和模型都保存在 Docker 卷里，停止或更新都不会丢失。

### 使用预构建镜像

每个版本发布时，镜像会推送到 GitHub Container Registry，不想在本机构建时可以直接拉取：

```bash
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d --no-build
```

有 NVIDIA 显卡时：

```bash
KTV_SEPARATOR_VARIANT=gpu docker compose -f docker-compose.yml -f docker-compose.gpu.yml -f docker-compose.ghcr.yml up -d --no-build
```

默认使用最新版本，用 `KTV_VERSION=0.1.2` 这样的变量固定版本。镜像列表：

- `ghcr.io/ivanhanloth/netease-ktv-app`（amd64 / arm64）
- `ghcr.io/ivanhanloth/netease-ktv-separator`，标签带 `-cpu` 或 `-gpu` 后缀
- `ghcr.io/ivanhanloth/netease-ktv-caddy`（amd64 / arm64），HTTPS 用；在 `.env` 里设置 `KTV_CADDY_IMAGE=ghcr.io/ivanhanloth/netease-ktv-caddy:latest`，启动前先运行一次 `docker compose ... pull`

### 发布新版本

把 `package.json`（根目录和 `apps/*`）里的版本号改好并提交，然后推送版本标签：

```bash
git tag -a v0.1.2 -m "Netease KTV 0.1.2"
```

```bash
git push origin v0.1.2
```

GitHub Actions（`.github/workflows/release.yml`）会检查标签和版本号一致、构建并推送镜像，然后创建 GitHub Release。

### 可选配置

第一次启动后，项目目录下会生成 `.env`，改完重新运行启动脚本即可生效。常用项：

| 配置 | 默认值 | 说明 |
|---|---|---|
| `KTV_PORT` | `8686` | 访问端口 |
| `PUBLIC_URL` | 自动检测 | 手机扫码地址，自动检测不准时手动填写，如 `http://192.168.1.8:8686` |
| `ACCESS_TOKEN` | 空 | 设置后需要令牌才能访问，二维码会自动带上令牌 |
| `AUDIO_LEVEL` | `exhigh` | 音质：`standard` / `higher` / `exhigh` / `lossless` / `hires` |
| `ENABLE_UNBLOCK` | `false` | 第三方音源，仅用于网易云无音源的歌 |
| `KTV_GPU` | `auto` | 设为 `on` / `off` 可强制使用或不使用 GPU |
| `KTV_DOMAIN` / `CF_API_TOKEN` | 空 | 开启 HTTPS，见下一节 |

分离服务器、音质、分离模型、待机音乐、局域网地址、MV 与缓存、第三方音源这些运维选项，也能在后台管理页面 `http://<本机局域网 IP>:8686/admin` 里直接修改；点歌台的“设置”只保留打分相关的选项。

### HTTPS（可选）

有一个托管在 Cloudflare 的域名时，可以让手机和大屏用 `https://ktv.example.com` 访问。好处：

- 任何设备打开大屏都能用麦克风打分，不必在主屏电脑上用 localhost；
- 手机可以把点歌台“添加到主屏幕”，像 App 一样打开。

证书由 Caddy 通过 Cloudflare DNS 验证自动申请和续期，KTV 不需要暴露到公网。步骤：

1. 在 Cloudflare 给域名添加一条 A 记录，例如 `ktv` → 本机局域网 IP（如 `192.168.1.8`），代理状态选 **仅 DNS**（灰色云朵）。
   - 在路由器里给这台电脑固定 IP（DHCP 静态分配），否则 IP 变了要回来改记录。
2. 创建 API 令牌：Cloudflare 控制台 → 我的个人资料 → API 令牌 → 创建令牌 → 使用“编辑区域 DNS”模板，区域资源只选这个域名。
3. 在 `.env` 里填写：

   ```bash
   KTV_DOMAIN=ktv.example.com
   CF_API_TOKEN=你的令牌
   ```

4. 重新运行启动脚本。
   - 二维码会自动改成 HTTPS 地址。如果之前在 后台管理 里填过局域网地址，把它清空或改成 HTTPS 地址。
   - 第一次申请证书需要一两分钟，进度可以用 `docker logs -f netease-ktv-caddy-1` 查看。

注意事项：

- **手机打不开、提示找不到域名**：很多路由器开启了“DNS 重绑定保护”，会拦截解析到内网 IP 的公网域名。在路由器里把这个域名加入白名单（OpenWrt：网络 → DHCP/DNS → 重绑定保护），或者让手机使用公共 DNS。
- **443 端口被占用**（例如 Windows 上的 IIS 或其他程序）：设置 `KTV_HTTPS_PORT=8443`，地址变成 `https://ktv.example.com:8443`。记得在防火墙里放行这个端口。
- `http://<局域网 IP>:8686` 仍然可以访问，不支持新证书的老电视盒子可以继续用它。
- 不要给这个域名开启带 `includeSubDomains` 的 HSTS，否则浏览器会拒绝用 http 打开它。
- 令牌只给这一个域名的 DNS 编辑权限，`.env` 不要分享给别人。
- 证书保存在 Docker 卷 `caddy-data` 里，重启不会重新申请。停止时要带上 HTTPS 配置，Caddy 才会一起停止：

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.https.yml down
  ```

### 多台分离服务器

在另一台电脑（最好有 NVIDIA 显卡）上装好 Docker、拷贝本项目，然后运行：

- Windows：双击 `start-separator.cmd`
- Linux / macOS：`./start-separator.sh`

脚本会打印这台分离服务器的地址和令牌，填到 后台管理 → 分离服务器 → 添加服务器 里即可。不想在本机运行分离服务时，在 `.env` 里设置 `KTV_SEPARATOR=off` 再运行启动脚本。
