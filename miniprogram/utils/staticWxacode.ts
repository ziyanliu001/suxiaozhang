/**
 * 官方生成的静态小程序码（菊花码）兜底方案：动态 getStoreQRCode 云函数失败/超时/
 * 无网络时的最终降级图。这是在微信公众平台"小程序码"生成工具里离线生成、随小程序
 * 一起打包的真实官方小程序码，扫码 100% 能拉起本小程序——彻底替换掉此前
 * utils/qrEncoder.ts 现算的本地 QR 码方案：那种码只能编码纯文本/通用链接，微信
 * 扫一扫客户端会直接拦下提示"暂不支持展示二维码中的文本内容"，对用户来说和没有
 * 码没区别，反而比诚实的占位提示更容易让人误以为自己手机有问题。
 *
 * 局限（刻意如此，不是 bug）：这张码是离线静态图，出厂时就没有 scene 场景值，
 * 没法像云函数版小程序码那样精确带上门店 ID/日期等参数——扫码统一进入小程序
 * 默认首页。这是"完全离线、不依赖任何网络请求"必然要付出的代价，与云函数版
 * 分工明确：云函数版永远优先尝试，只有它彻底不可用时才轮到这张图兜底。
 */
const STATIC_WXACODE_PATH = '/assets/images/gh_wxacode.png';

/**
 * 加载并绘制静态官方小程序码到 Canvas 指定区域。图片是随包打包的本地资源，
 * 不涉及网络请求，理论上不会失败——仍然用 Promise 包一层等 onload，
 * 与项目里其余"下载图片再画"的写法保持同一套异步范式。
 */
export function drawStaticWxacodeFallback(ctx: any, canvas: any, x: number, y: number, size: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage();
    img.onload = () => {
      ctx.drawImage(img, x, y, size, size);
      resolve();
    };
    img.onerror = () => reject(new Error('静态小程序码资源加载失败: ' + STATIC_WXACODE_PATH));
    img.src = STATIC_WXACODE_PATH;
  });
}
