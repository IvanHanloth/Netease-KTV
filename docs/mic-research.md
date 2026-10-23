# 麦克风功能调研（v0.2 方向）

目标：KTV 里唱歌的声音能从主机音箱放出来，可以加混响、回声，并处理回声、啸叫和噪声。考察两种收音方式：

- 主机接麦克风：有线麦、USB 麦，或者 KTV 无线麦的接收器。
- 手机当麦克风：手机收音后，通过局域网传到主机播放。

## 结论速览

| 方案 | 能否实现 | 唱歌的人听到自己声音的延迟 | 主要问题 | 建议 |
|---|---|---|---|---|
| A. 主机接麦克风，浏览器里处理后从主机音箱放出 | 能 | 约 20–50ms，因系统和声卡而异 | 比专业设备（<10ms）略慢；需要防啸叫 | **第一步就做** |
| B. 手机当无线麦，传到主机播放 | 技术上能 | 约 60–200ms | 延迟明显；需要 HTTPS；手机会收进音箱里的伴奏和自己的声音，形成回授 | 只做实验功能（合唱、观众麦） |
| C. 手机收音，在手机耳机里听自己（配合移动耳返） | 能 | 取决于手机：iPhone 较好，安卓差异很大 | 浏览器里很难做到 10ms 以内；蓝牙耳机不可用 | 可选，按设备实测后再定 |
| D. 手机麦克风只用来打分 | 能，而且简单 | 不影响（按时间戳对齐） | 需要 HTTPS | **推荐**，顺便支持多人对唱打分 |

一句话：**“手机收音再从主机放出来”可以做，但延迟决定了它当不了主唱话筒**。主唱的声音应该走主机麦克风这条路（方案 A）；手机更适合用来打分，以及做合唱、观众麦这类对延迟不敏感的用途。

## 1. 延迟是第一约束

- Shure 的说法：舞台返听一般能接受 5–10ms，超过 10ms 演唱者就开始察觉。耳返对歌手要求更严，因为同时听到骨传导的声音，建议 5ms 以内。
- 主机音箱放的声音给全场听，唱歌的人对它的延迟没那么敏感。但到 50ms 以上，会明显听到“跟着一个回声”。KTV 本来就爱开“回声”效果，30–50ms 尚可接受；100ms 以上就会干扰唱歌的节奏。
- 浏览器里的实测参考：一篇实测文章在 Mac 上用 Chrome 测得，默认设置约 67ms；请求低延迟、并关掉回声消除、降噪和自动增益后约 19ms。Windows 上 Chrome 走 WASAPI 共享模式，一般会更高一些，需要在目标机器上实测。

所以每个方案落地前，都要先做一个**延迟自测工具**：主机放一个“哔”声，同时录音，计算从放出到录到的时间。放在后台管理里，每台主机、每支话筒都可以测。

## 2. 方案 A：主机接麦克风

### 信号链

```
麦克风 → getUserMedia（关闭浏览器自带的回声消除 / 降噪 / 自动增益）
       → 低切（80Hz，去掉喷麦和低频嗡声）
       → 噪声门（不唱时关掉，去掉底噪和串音）
       → 均衡（人声 EQ 预设）
       → 压缩（音量更稳）
       → 防啸叫（移频 / 自适应陷波）
       → 混响 + 回声（发送效果）
       → 话筒音量 → 和伴奏一起输出到主屏音箱
```

全部可以用 Web Audio 的现成节点完成，CPU 开销很小：BiquadFilter 做低切和均衡，DynamicsCompressor 做压缩，Delay、Gain 和滤波器做回声和算法混响。需要自定义处理的部分（噪声门、防啸叫、更好的混响）用 AudioWorklet 实现。

### 关于回声、降噪

- **不要对演唱用浏览器自带的回声消除（AEC）和降噪（NS）。** 它们是为通话里的说话设计的：伴奏声大的时候会把人声压下去，长音、颤音会被当成噪声削掉，听起来一抽一抽的。
- 真实 KTV 也不做回声消除，靠的是物理条件：
  - 心形指向的动圈话筒，贴近嘴唱；
  - 音箱放在话筒前方，不正对话筒；
  - 噪声门；
  - 防啸叫器。
- 伴奏从音箱串进话筒的问题，话筒贴嘴、开噪声门后音量很低，可以接受。
- **啸叫**（话筒 → 音箱 → 话筒的正反馈）是主机方案真正要处理的。两种常见做法都能在 AudioWorklet 里实现：
  - 移频：把信号整体移 4–8Hz，破坏正反馈。专业防啸叫器常用这种办法，对人声几乎听不出来。
  - 自适应陷波：检测到某个频率持续增长时，在那里挖一个窄凹口。
- 打分仍然用一路开了回声消除的收音（现在的 `player/mic.ts` 就是这样），和演唱用的那一路分开，互不影响。

### 设备建议

- 最好的体验是 **KTV 无线话筒 + USB 接收器（或带 USB 的调音台）**，几十到几百元。
- 如果用户本来就有带混响的调音台，也可以让声音不经过电脑，App 只负责打分。

### 延迟更低的后路

浏览器里大约 20–50ms。如果实测不能接受，可以做一个跑在主屏电脑上的原生小程序，用 WASAPI 独占模式、ASIO 或 CoreAudio，可以做到 5–10ms，效果参数由网页控制。这个程序不能放在 Docker 里，因为容器拿不到声卡。先不做，看实测结果再说。

### 混响 / 回声效果

| 效果 | 实现 | 说明 |
|---|---|---|
| KTV 回声 | Delay（120–250ms）+ 反馈（30–45%）+ 低通 | 最有 KTV 味道，也能掩盖一些延迟 |
| 混响（房间 / 大厅 / 录音棚） | 算法混响（Freeverb：并联梳状滤波 + 串联全通） | 用延迟线做，参数可以实时调；ConvolverNode 需要换脉冲响应才能改参数，实时调整不方便 |
| 人声 EQ 预设 | 3–5 段 Biquad | 男声 / 女声 / 明亮 / 温暖 |
| 压缩 | DynamicsCompressor | 防止忽大忽小 |

在手机遥控上加“话筒”面板：话筒音量、回声量、混响量、预设。参数通过现在的 `player` 状态同步到主屏，和伴奏音量的做法一样。

## 3. 方案 B：手机当无线麦

### 能不能拿到手机麦克风

- 浏览器只在安全上下文（HTTPS 或 localhost）里提供 `getUserMedia`。手机通过 `http://192.168.x.x` 打开时，`navigator.mediaDevices` 根本不存在。**这是第一个门槛。**
- 可选做法：
  1. 服务端额外开一个 HTTPS 端口，用自动生成的自签证书，手机第一次打开时手动“继续访问”。安卓 Chrome、iOS Safari 接受后通常可以用麦克风，但需要真机验证。
  2. 用 mkcert 一类工具生成本地 CA，安装到手机上。最可靠，但对普通用户太麻烦。
  3. 用户自己有域名时，用 DNS 验证申请正式证书，域名解析到局域网 IP。

### 怎么传

| 方式 | 优点 | 缺点 |
|---|---|---|
| WebRTC（手机 → 主屏，点对点，用现有 WebSocket 交换信令） | Opus 编码，自带抖动缓冲和丢包补偿；局域网不需要服务器转发 | 抖动缓冲由浏览器控制；Chrome 124+ 可以用 `jitterBufferTarget` 提示调低，Safari 不支持 |
| WebSocket 传 PCM，主屏用 AudioWorklet 自己做抖动缓冲 | 缓冲完全可控，实现简单 | TCP 在 Wi‑Fi 丢包时会卡顿，带宽较大（单声道 48kHz 约 768kbps） |

### 延迟估算（需要实测）

| 环节 | 估计 |
|---|---|
| 手机录音缓冲 | iPhone 约 10–30ms，安卓 20–100ms 以上 |
| 编码、打包 | 10–20ms |
| Wi‑Fi 传输 | 2–20ms，省电模式会偶尔跳到 100ms 以上 |
| 抖动缓冲 | 20–60ms |
| 主机输出 | 10–40ms |
| **合计** | **约 60–200ms** |

这远超 10ms 的门槛：唱歌的人会清楚听到自己的声音慢半拍从音箱出来。挑选设备、关闭 Wi‑Fi 省电能好一些，但做不到专业话筒的水平。

### 回声问题

- 手机话筒离音箱不远，会同时收进伴奏和音箱放出的自己的声音，再延迟 100ms 左右放出来：伴奏发糊，自己的声音形成一串回声，音量大了会啸叫。
- 手机上的回声消除没用：手机只知道自己播放的声音，不知道主机音箱在放什么。
- 能用的办法是**在主机端做回声消除**：主机知道自己放了什么（伴奏 + 话筒声），用它作参考信号，把手机传来的声音里的这部分减掉。
  - 需要把 SpeexDSP 或 WebRTC AEC3 编译成 WebAssembly，在 AudioWorklet 里跑，并先估计约 100–200ms 的可变延迟。
  - 已有 AEC3 的 Rust 移植（`aec3` crate），理论上可以编译成 WASM，但没找到现成的浏览器版本。
  - 这是研究性质的工作，而且这些算法都是为说话设计的，对歌声效果没有把握。
- 降噪方面，RNNoise 有现成的 WASM 版本，但同样是为说话训练的，对歌声可能有损伤，只适合作为可选项。

**结论**：可以做成“实验功能”，用于合唱、伴唱、观众互动，不建议当主唱话筒。

## 4. 方案 C：手机本地耳返（听自己的声音）

- 手机录音后直接从同一部手机的耳机放出来，可以加混响，类似唱吧的耳返。可以和现在的移动耳返页面合并：耳机里同时听到伴奏或领唱，以及自己的声音。
- 延迟取决于手机的音频栈：iPhone 的浏览器一般在几十毫秒；安卓差异很大，很多机型 50–150ms。原生 App 用 AAudio / Oboe 可以更低，网页做不到。
- 蓝牙耳机本身就有 150–300ms 延迟，这个场景完全不可用，只能用有线耳机。
- 建议：做成可选开关，页面上显示实测延迟，让用户自己判断能不能接受。

## 5. 方案 D：手机麦克风只用来打分

- 在手机上做音高检测（现在用的 pitchy 可以直接复用），每一帧打上服务端时间戳（移动耳返已经有时钟同步），通过 WebSocket 发给主屏，主屏按时间和参考音高对齐后打分。
- **延迟完全不影响结果**，因为是按时间戳对齐的，不是实时播放。
- 可以每人一部手机，实现**对唱、多人分别打分**。
- 唯一门槛还是 HTTPS（见第 3 节）。

## 6. 建议路线

1. **v0.2：主机话筒**
   - 话筒输入选择、效果链（低切、噪声门、EQ、压缩、防啸叫、回声、混响）和预设；
   - 手机遥控上的话筒面板；
   - 后台的延迟自测工具；
   - 打分和演唱共用同一个话筒设备（两路处理）；
   - 可选：录下“伴奏 + 人声”，生成演唱录音。
2. **v0.3：HTTPS 和手机打分**
   - 自签证书和首次访问引导；
   - 手机端音高检测加时间戳上报；
   - 多人对唱打分。
3. **实验功能**
   - 手机无线麦：WebRTC 传输，加主机端回声消除的研究；
   - 手机本地耳返听自己。
4. **视实测决定**：原生低延迟音频小程序。

## 待真机验证

- Windows / macOS 上 Chrome 的话筒到音箱往返延迟（用延迟自测工具测）。
- 安卓 Chrome、iOS Safari 接受自签证书后能否使用麦克风。
- 局域网 WebRTC 音频在几台手机上的实际端到端延迟（用 `getStats()` 看抖动缓冲）。
- 防啸叫移频 / 陷波对歌声的听感。

## 资料来源

- [Shure：Digital Wireless Latency Explained](https://www.shure.com/en-us/insights/shure-whiteboard-digital-wireless-latency-explained/)（返听延迟门槛）
- [MDN：getUserMedia（仅限安全上下文）](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [discuss-webrtc：Chrome M74 起媒体设备接口仅限安全源](https://groups.google.com/g/discuss-webrtc/c/QUdwwa-83K8)
- [webrtcHacks：Surviving Mandatory HTTPS in Chrome](https://webrtchacks.com/chrome-secure-origin-https/)
- [MDN：RTCRtpReceiver.jitterBufferTarget](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget)
- [Chrome 开发者博客：More native echo cancellation](https://developer.chrome.com/blog/more-native-echo-cancellation/)
- [Chrome 开发者博客：Disabling hardware noise suppression](https://developer.chrome.com/blog/disabling-hardware-noise-suppression/)
- [Zoom 开发者论坛：Chrome-wide AEC 与 AudioContext 输出](https://devforum.zoom.us/t/issupportchromewideaec-sniffs-browser-name-version-breaking-echo-cancellation-on-microsoft-edge/145288)
- [Chromium：Audio Latency Tracing](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/media/latency_tracing.md)
- [W3C public-audio：Round Trip Latency test](https://lists.w3.org/Archives/Public/public-audio/2014JulSep/0179.html)
- [aec3 crate（WebRTC AEC3 的 Rust 移植）](https://docs.rs/crate/aec3/0.4.0)
- [PJSIP：Acoustic Echo Cancellation](https://docs.pjsip.org/en/2.17/specific-guides/audio/aec.html)
- [Algorithmic Reverb and Web Audio API](https://itnext.io/algorithmic-reverb-and-web-audio-api-e1ccec94621a)、[Convolution Reverb and Web Audio API](https://itnext.io/convolution-reverb-and-web-audio-api-8ee65108f4ae)
- [Fora Soft：实时降噪（RNNoise / DeepFilterNet）集成](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/real-time-noise-suppression-krisp-rnnoise-deepfilternet-integration)
- [AudioRelay](https://audiorelay.net)（手机当电脑麦克风的同类产品）
