// 🔊 后厨语音与音效无感反馈中台
//
// 🏛️ 定位：义工在后厨做饭/端菜/搬运时经常双手占用、无法低头细看屏幕文字，
// 这套服务在"触觉（震动，见 index.ts showCareModeSuccess）+ 视觉（大字 Toast/
// 弹窗）"之外补上"听觉"这一维，核心动作完成时给一声短促、温润的音效 + 一次
// 震动，人不用看屏幕也能确认"这一步成功了"。
//
// 🛡️ 诚实边界——本文件不做真正的语音合成（TTS）：微信小程序基础库没有内置
// 任意文本转语音的能力，`wx.createInnerAudioContext` 只能播放真实存在的
// 音频文件，播不出动态拼出来的一句话（比如"已识别大米50斤"里的"50"每次
// 都不一样，没法用一份固定录音覆盖所有数值）。要做到真正"念出"这句话，
// 需要接入一个真实的云端 TTS 服务（微信同声传译插件、腾讯云 TTS API 等），
// 这涉及额外的接口凭据/资费，是一个产品侧需要拍板的决定，不属于本次可以
// 直接落地的范围。因此 playOcrSuccess() 目前只播放一段固定的"确认音"，
// summaryText 参数先保留在签名里（未来真正接入 TTS 时不需要改调用点），
// 当前实现只是把它记录到日志，不会真的被"念"出来——调用方仍然要靠自己的
// wx.showToast 展示这段文字（如 material-usage-modal 已有的"已自动填入
// XX重量，请核对"提示）。
//
// 🎵 三段音效文件用 Python 标准库 wave/struct 现场合成的正弦波短音（不是
// 网上下载/AI 生成的素材），存放在 assets/audio/：
//   checkin_success.wav（打卡成功·温润上扬双音）
//   ocr_success.wav（识票确认·清脆单音）
//   report_sealed.wav（封账存证·厚重下行三音）
// 均为 22050Hz 单声道 16bit，时长 0.13~0.53 秒，单文件几 KB～二十几 KB，
// 不会对包体积造成明显负担。

const VOICE_FEEDBACK_STORAGE_KEY = 'voice_feedback_enabled';

// 🛡️ 同一个事件短时间内不重复播报——例如财务连续点击"确认封账"按钮但云
// 调用还没返回时按钮被禁用，理论上不会重入，这里的节流是给"网络抖动导致
// 用户手快多点几下"这类边界情况兜底，不是主要的防重入手段（主要手段仍是
// 各调用点自己的 xxxInFlight 标志位）
const THROTTLE_MS = 600;
const _lastPlayedAt: Record<string, number> = {};

function isThrottled(key: string): boolean {
  const now = Date.now();
  const last = _lastPlayedAt[key] || 0;
  if (now - last < THROTTLE_MS) return true;
  _lastPlayedAt[key] = now;
  return false;
}

// 🔊「语音提示」开关：默认开启，与「关怀模式」是两个独立维度（有人想要大字
// 但不想要声音，反之亦然），各自独立持久化，不绑定同一个 storage key
export function isVoiceFeedbackEnabled(): boolean {
  try {
    const stored = wx.getStorageSync(VOICE_FEEDBACK_STORAGE_KEY);
    return stored === undefined || stored === null || stored === '' ? true : !!stored;
  } catch (err) {
    return true;
  }
}

export function setVoiceFeedbackEnabled(enabled: boolean): void {
  try {
    wx.setStorageSync(VOICE_FEEDBACK_STORAGE_KEY, enabled);
  } catch (err) {
    console.warn('[audioService] 语音提示开关持久化失败:', err);
  }
}

// 🛡️ 每次播放都新建一个 InnerAudioContext 并在播完/出错后立即 destroy，
// 不维护一个长期复用的单例——微信小程序对同时存在的 InnerAudioContext
// 实例数有上限，用完即焚避免几个音效连续触发时互相抢占同一个 context
// 导致播放被截断
function playAudioFile(src: string): void {
  try {
    const ctx = wx.createInnerAudioContext();
    ctx.src = src;
    ctx.obeyMuteSwitch = false; // 静音键开着时也能听到——这是操作反馈音，不是媒体播放
    const cleanup = () => {
      try {
        ctx.destroy();
      } catch (err) {
        // 忽略重复 destroy 报错
      }
    };
    ctx.onEnded(cleanup);
    ctx.onError((err) => {
      console.warn('[audioService] 音效播放失败:', src, err);
      cleanup();
    });
    ctx.play();
  } catch (err) {
    console.warn('[audioService] 创建音频上下文失败:', err);
  }
}

function vibrate(type: 'light' | 'medium' | 'heavy'): void {
  if (wx.vibrateShort) {
    wx.vibrateShort({ type } as any);
  }
}

// 🙏 到岗打卡成功：温润上扬双音 + 中等震动
export function playCheckInSuccess(): void {
  if (!isVoiceFeedbackEnabled() || isThrottled('checkInSuccess')) return;
  vibrate('medium');
  playAudioFile('/assets/audio/checkin_success.wav');
}

// 📸 智能识票完成：清脆确认音 + 轻震动
// summaryText：识别结果摘要（如"已识别大米50斤"），当前仅记录日志，见文件
// 头部"诚实边界"说明——真正接入 TTS 前不会被念出来，实际文字反馈仍由
// 调用方自己的 wx.showToast 负责
export function playOcrSuccess(summaryText?: string): void {
  if (!isVoiceFeedbackEnabled() || isThrottled('ocrSuccess')) return;
  if (summaryText) {
    console.log('[audioService] OCR 识别摘要（预留 TTS 接入点，当前不播报文本）:', summaryText);
  }
  vibrate('light');
  playAudioFile('/assets/audio/ocr_success.wav');
}

// 🔒 日结封账/签名存证完成：厚重下行三音 + 重震动，与打卡/识票区分开，
// 强调这是一个更"郑重"的完成动作
export function playReportSealed(): void {
  if (!isVoiceFeedbackEnabled() || isThrottled('reportSealed')) return;
  vibrate('heavy');
  playAudioFile('/assets/audio/report_sealed.wav');
}
