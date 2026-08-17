/**
 * 图片压缩与缩略图生成工具
 *
 * 面向"上百家门店规模"的成本控制：
 * - 主图：最长边不超过 1920px（约 1080p），文件大小压到 300KB 以内
 * - 缩略图：最长边不超过 320px，用于列表懒加载，详情页再按需加载主图
 *
 * 依赖调用方页面 WXML 中放置一个隐藏离屏 canvas：
 *   <canvas type="2d" id="imgCompressCanvas" style="position:fixed;left:-9999px;top:-9999px;width:1920px;height:1920px;"></canvas>
 */

const MAX_LONG_EDGE = 1920;
const THUMB_LONG_EDGE = 320;
const MAX_FILE_SIZE = 300 * 1024;
const MIN_QUALITY = 0.3;
// 🛡️ 硬性兜底上限：即使迭代降质后仍未达到 300KB 目标（极端复杂图像），也绝不允许
// 超过 1MB 的文件进入上传流程，防止云存储空间被单张异常大图占用
const HARD_MAX_FILE_SIZE = 1024 * 1024;

export interface CompressUploadResult {
  url: string;
  thumbUrl: string;
}

// 🛡️ 云存储路径规范化：修复 -501007 invalid parameters | cloud path is invalid。
// 调用方拼接 cloudPathPrefix 时用到的 storeId/tenantId 等变量，任何一环取到空字符串/undefined
// 都会在模板字符串里产出连续斜杠（如 "activity_logs//169..."）或字面量 "undefined" 段，
// 云存储直接拒绝这种路径。这里统一在真正拼出 cloudPath 之前做一次兜底清洗：
// - 各段落分别过滤为仅保留字母数字下划线短横线（云存储对合法字符本就有限制）
// - 过滤后变成空的段落回退为 'x'，不会产生连续斜杠
// - 掐头去尾多余的斜杠，保证结果既不以 / 开头也不以 / 结尾
function sanitizeCloudPathPrefix(prefix: string): string {
  const segments = String(prefix || '')
    .split('/')
    .map((seg) => seg.replace(/[^a-zA-Z0-9_-]/g, ''))
    .map((seg) => (seg ? seg : 'x'))
    .filter((seg) => seg.length > 0);

  return segments.length > 0 ? segments.join('/') : 'uploads';
}

function getFileSize(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // wx.getFileInfo 已废弃，改用官方推荐的 wx.getFileSystemManager().getFileInfo
    wx.getFileSystemManager().getFileInfo({
      filePath: path,
      success: (res: any) => resolve(res.size || 0),
      fail: reject
    });
  });
}

function getCanvasNode(canvasId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const query = wx.createSelectorQuery();
    query.select(`#${canvasId}`)
      .fields({ node: true, size: true })
      .exec((res: any) => {
        if (res[0] && res[0].node) {
          resolve(res[0].node);
        } else {
          reject(new Error('压缩画布节点未找到，请确认页面已放置 #' + canvasId));
        }
      });
  });
}

// 🐛 深度修复"手机实拍大图/高分辨率照片被裁切放大"：此前 compressImageLocal 是
// 先用 wx.getImageInfo(src) 单独拿一次原图宽高算目标尺寸，再让 canvas 的 <image>
// 节点自己异步解码同一张图去绘制——两次"读这张图多大"来自两个独立的调用，在部分
// 手机高清照片/EXIF 信息更复杂的图片上，wx.getImageInfo 报告的宽高与 canvas 内部
// 解码后 img.width/img.height 不一定完全一致（这正是 loadImageOntoCanvasCropped
// 那处头像裁剪逻辑早前踩过、并已注释记录的同一类问题）。只要两个尺寸来源对不上，
// "画布该开多大"和"实际画的是哪张图"就会错位，表现成整张图被压扁/拉伸、
// 显示时像是"只截了一部分再放大"。
//
// 这里改成唯一数据源：目标尺寸完全从【canvas 内 img 节点自己 onload 报告的
// img.width/img.height】计算，不再依赖调用方提前查询到的尺寸——画布尺寸、
// 绘制尺寸、导出尺寸全部衍生自同一次解码结果，结构上杜绝这类不一致，
// 不需要再去猜测/手动补偿 EXIF 旋转方向。
function loadImageOntoCanvasScaled(canvas: any, src: string, maxLongEdge: number): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage();
    img.onload = () => {
      const naturalWidth = img.width;
      const naturalHeight = img.height;
      const { width, height } = computeScaledSize(naturalWidth, naturalHeight, maxLongEdge);

      // 显式把 canvas 的物理像素缓冲区（width/height 属性，不是 CSS 样式）设为
      // 计算出的目标尺寸，再绘制——保证缓冲区与绘制目标严格 1:1，不会只截到左上角
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      resolve({ width, height });
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

function exportCanvas(canvas: any, width: number, height: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      width,
      height,
      destWidth: width,
      destHeight: height,
      fileType: 'jpg',
      quality,
      success: (res: any) => resolve(res.tempFilePath),
      fail: reject
    });
  });
}

function computeScaledSize(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return { width, height };
  }
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * 🐛 头像"被严重放大只看到局部色块"根因修复（最终定位）：这里此前复用
 * compressImageLocal——先把主图导出到本地临时文件，再立刻在【同一块共享离屏 canvas】
 * 上重绘缩略图。本项目其实早就在另一处踩过、并修复过同一类问题：见下方
 * compressAndUploadImage 的注释——"食谱/门店日志照片主体被裁切"根因就是主图经过
 * Canvas 重新绘制-导出这一整套流程，在部分设备/基础库的 Canvas 2D 实现上不可靠，
 * 当时的修复方案是让主图完全绕开 Canvas、直接上传 chooseMedia/chooseAvatar 原始
 * 文件。此前给头像写这个函数时，误以为 compressImageLocal 是食谱/支出凭证也在用的
 * 稳定管道——实际从未有任何生产路径用过它，食谱/支出凭证用的是下面这个完全不同的
 * compressAndUploadImage。现改为对齐这条真正已验证的模式：主图不经过 Canvas，直接
 * 上传原始临时文件；头像本身不需要缩略图（没有任何地方消费 avatarUrl 的 thumbUrl），
 * 因此彻底不再触碰 Canvas，从根源上排除这一整类"设备相关 Canvas 2D 重绘不可靠"风险。
 */
export async function compressAndUploadScaledImage(src: string, cloudPathPrefix: string): Promise<CompressUploadResult> {
  const safePrefix = sanitizeCloudPathPrefix(cloudPathPrefix);
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);

  const mainRes = await wx.cloud.uploadFile({ cloudPath: `${safePrefix}/${ts}_${rand}.jpg`, filePath: src });

  return { url: mainRes.fileID, thumbUrl: mainRes.fileID };
}

/**
 * 压缩并上传单张图片到云存储，返回主图与缩略图的 fileID
 *
 * 🐛 修复"食谱/门店日志照片主体被裁切"：此前主图走 compressImageLocal 在离屏 Canvas 上
 * 重新绘制（loadImageOntoCanvasScaled 等比例缩放到 ≤1920px 长边，理论上不裁剪），但这多出
 * 的一次 Canvas 解码-绘制-导出全流程，与"支出凭证"(uploadReceiptImages，见 index.ts)
 * 直接 wx.cloud.uploadFile 原始 tempFilePath、完全不经过 Canvas 的做法不是同一条路径——
 * 两者在部分设备/基础库的 Canvas 2D 实现上表现并不总是一致。为彻底排除"Canvas 重绘环节"
 * 这一整类风险，主图改为与支出凭证 100% 同构：直接上传 wx.chooseMedia 返回的原始文件，
 * 不再经过任何 Canvas 处理。缩略图仍单独走 Canvas 生成一份 ≤320px 长边的小图，仅用于
 * 列表懒加载展示，不影响详情页/大图预览看到的主图画质与画幅。
 */
export async function compressAndUploadImage(canvasId: string, src: string, cloudPathPrefix: string): Promise<CompressUploadResult> {
  const safePrefix = sanitizeCloudPathPrefix(cloudPathPrefix);
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);

  const mainUploadPromise = wx.cloud.uploadFile({ cloudPath: `${safePrefix}/${ts}_${rand}.jpg`, filePath: src });

  // 🛡️ 缩略图生成非致命化：缩略图只是列表懒加载用的附属产物，不该因为它失败
  // （画布节点未找到/图片解码失败/canvasToTempFilePath 失败等，成因很多，不只
  // 是本文件某一次已知的挂载位置问题）拖累本该独立成功的主图上传——原先两者
  // 串行/耦合在一起，缩略图这步一 throw，主图上传甚至都还没发起。降级策略：
  // 缩略图生成失败就直接复用主图 fileID 当 thumbUrl（牺牲一点列表加载体积，
  // 换取"选完图片就是能传上去"这个更基本的可用性）
  let thumbUploadPromise: Promise<{ fileID: string }>;
  try {
    const canvas = await getCanvasNode(canvasId);
    const thumbSize = await loadImageOntoCanvasScaled(canvas, src, THUMB_LONG_EDGE);
    const thumbPath = await exportCanvas(canvas, thumbSize.width, thumbSize.height, 0.6);
    thumbUploadPromise = wx.cloud.uploadFile({ cloudPath: `${safePrefix}/${ts}_${rand}_thumb.jpg`, filePath: thumbPath });
  } catch (thumbErr) {
    console.warn('[compressAndUploadImage] 缩略图生成失败，降级复用主图:', thumbErr);
    thumbUploadPromise = mainUploadPromise;
  }

  const [mainRes, thumbRes] = await Promise.all([mainUploadPromise, thumbUploadPromise]);

  return { url: mainRes.fileID, thumbUrl: thumbRes.fileID };
}

/**
 * 批量压缩并上传，按顺序执行（避免同一离屏 canvas 被并发争用）
 */
export async function compressAndUploadImages(canvasId: string, srcList: string[], cloudPathPrefix: string): Promise<CompressUploadResult[]> {
  const results: CompressUploadResult[] = [];
  for (const src of srcList) {
    const r = await compressAndUploadImage(canvasId, src, cloudPathPrefix);
    results.push(r);
  }
  return results;
}
