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

function getImageInfo(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: (res) => resolve({ width: res.width, height: res.height }),
      fail: reject
    });
  });
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

// 带源图裁剪区域的绘制：用于头像等必须强制 1:1 的场景。
// 与 loadImageOntoCanvasScaled 的区别：那个函数是把整张源图等比缩放铺满目标画布（保留原始宽高比），
// 这个函数先在源图上截取正方形区域，再铺满目标画布——即"裁剪优先于缩放"，保证无论源图原始宽高比
// 是多少，画出来的都是一张真正的正方形图，而不是依赖 <image mode="aspectFill"> 在展示层做二次裁剪
// （那只能裁"显示效果"，存进云端的文件本身仍是非正方形原图）。
//
// 🐛 关键修复：裁剪区域改为基于【canvas 内 img 节点自己 onload 后报告的 img.width/img.height】计算，
// 不再依赖调用方提前通过 wx.getImageInfo 拿到的尺寸。两者本应一致，但曾怀疑存在方向/缓存导致的不一致，
// 这里让"用什么尺寸算裁剪框"和"实际画的是哪张图"始终来自同一个数据源，杜绝任何不一致的可能性。
function loadImageOntoCanvasCropped(canvas: any, src: string, destSize: number): Promise<{ naturalWidth: number; naturalHeight: number; cropX: number; cropY: number; cropSize: number }> {
  return new Promise((resolve, reject) => {
    canvas.width = destSize;
    canvas.height = destSize;
    const ctx = canvas.getContext('2d');
    const img = canvas.createImage();
    img.onload = () => {
      const naturalWidth = img.width || destSize;
      const naturalHeight = img.height || destSize;
      const cropSize = Math.min(naturalWidth, naturalHeight);
      const cropX = Math.max(0, Math.round((naturalWidth - cropSize) / 2));
      const cropY = Math.max(0, Math.round((naturalHeight - cropSize) / 2));

      ctx.clearRect(0, 0, destSize, destSize);
      ctx.drawImage(img, cropX, cropY, cropSize, cropSize, 0, 0, destSize, destSize);
      resolve({ naturalWidth, naturalHeight, cropX, cropY, cropSize });
    };
    img.onerror = (err: any) => {
      console.error('[imageCompress] 头像图片加载失败:', err);
      reject(new Error('图片加载失败'));
    };
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
 * 压缩单张图片：返回主图（≤1920px 长边，≤300KB）与缩略图（≤320px 长边）的本地临时路径
 */
export async function compressImageLocal(canvasId: string, src: string): Promise<{ mainPath: string; thumbPath: string }> {
  const canvas = await getCanvasNode(canvasId);

  // 1. 主图：按最长边缩放后绘制，迭代降低质量直到文件大小达标。目标尺寸从
  // canvas 自己解码这张图后报告的 img.width/img.height 算出（见函数注释），
  // 不再单独调用 wx.getImageInfo 取一份可能不一致的尺寸。
  const mainSize = await loadImageOntoCanvasScaled(canvas, src, MAX_LONG_EDGE);

  let quality = 0.8;
  let mainPath = await exportCanvas(canvas, mainSize.width, mainSize.height, quality);
  let size = await getFileSize(mainPath);

  let attempts = 0;
  while (size > MAX_FILE_SIZE && quality > MIN_QUALITY && attempts < 5) {
    quality = Math.max(MIN_QUALITY, quality - 0.15);
    mainPath = await exportCanvas(canvas, mainSize.width, mainSize.height, quality);
    size = await getFileSize(mainPath);
    attempts++;
  }

  // 🛡️ 硬性兜底：迭代降质后仍超过 1MB 视为异常图像，直接拒绝而非静默上传超大文件
  if (size > HARD_MAX_FILE_SIZE) {
    throw new Error(`图片压缩后仍超过 1MB（${(size / 1024 / 1024).toFixed(2)}MB），请更换一张图片重试`);
  }

  // 2. 缩略图：单独按更小尺寸重新绘制导出，用于列表懒加载（同样从这张图自己的
  // 解码结果重新算一遍目标尺寸，不复用上一步主图的 mainSize）
  const thumbSize = await loadImageOntoCanvasScaled(canvas, src, THUMB_LONG_EDGE);
  const thumbPath = await exportCanvas(canvas, thumbSize.width, thumbSize.height, 0.6);

  return { mainPath, thumbPath };
}

/**
 * 压缩单张图片并强制居中裁剪为正方形：返回主图（≤640px 边长，≤300KB）与缩略图（≤320px 边长）的本地临时路径。
 * 专供头像等"必须 1:1"的场景使用——不依赖 wx.chooseAvatar 原生裁剪 UI 是否在当前设备/基础库上正常触发
 * （不同手机微信客户端版本、开发者工具的 Linux 模拟环境等，原生裁剪 UI 的可靠性并不总是一致），
 * 从源头保证存进云端的文件本身就是正方形，而不是把"裁不裁得对"这件事完全交给展示层的
 * <image mode="aspectFill">（那只能裁剪显示效果，裁不掉底层文件本身的非正方形长宽比）。
 */
export async function compressSquareImageLocal(canvasId: string, src: string): Promise<{ mainPath: string; thumbPath: string }> {
  const AVATAR_MAX_SIZE = 640;

  // 仅用于粗定一个不离谱的目标导出边长（避免对着一张 4000×3000 的原图硬导出成 3000×3000）；
  // 真正决定裁剪框的尺寸来自 loadImageOntoCanvasCropped 内部 img.onload 报告的真实自然尺寸
  const info = await getImageInfo(src).catch(() => ({ width: AVATAR_MAX_SIZE, height: AVATAR_MAX_SIZE }));
  const roughDestSize = Math.min(Math.min(info.width, info.height), AVATAR_MAX_SIZE);

  const canvas = await getCanvasNode(canvasId);
  const cropInfo = await loadImageOntoCanvasCropped(canvas, src, roughDestSize);
  const destSize = roughDestSize;

  let quality = 0.85;
  let mainPath = await exportCanvas(canvas, destSize, destSize, quality);
  let size = await getFileSize(mainPath);

  let attempts = 0;
  while (size > MAX_FILE_SIZE && quality > MIN_QUALITY && attempts < 5) {
    quality = Math.max(MIN_QUALITY, quality - 0.15);
    mainPath = await exportCanvas(canvas, destSize, destSize, quality);
    size = await getFileSize(mainPath);
    attempts++;
  }

  if (size > HARD_MAX_FILE_SIZE) {
    throw new Error(`头像压缩后仍超过 1MB（${(size / 1024 / 1024).toFixed(2)}MB），请更换一张图片重试`);
  }

  const thumbDestSize = Math.min(destSize, THUMB_LONG_EDGE);
  await loadImageOntoCanvasCropped(canvas, src, thumbDestSize);
  const thumbPath = await exportCanvas(canvas, thumbDestSize, thumbDestSize, 0.6);

  return { mainPath, thumbPath };
}

/**
 * 压缩（强制正方形裁剪）并上传头像到云存储，返回主图与缩略图的 fileID
 */
export async function compressAndUploadSquareImage(canvasId: string, src: string, cloudPathPrefix: string): Promise<CompressUploadResult> {
  const { mainPath, thumbPath } = await compressSquareImageLocal(canvasId, src);

  const safePrefix = sanitizeCloudPathPrefix(cloudPathPrefix);
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);

  const [mainRes, thumbRes] = await Promise.all([
    wx.cloud.uploadFile({ cloudPath: `${safePrefix}/${ts}_${rand}.jpg`, filePath: mainPath }),
    wx.cloud.uploadFile({ cloudPath: `${safePrefix}/${ts}_${rand}_thumb.jpg`, filePath: thumbPath })
  ]);

  return { url: mainRes.fileID, thumbUrl: thumbRes.fileID };
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

  const canvas = await getCanvasNode(canvasId);
  const thumbSize = await loadImageOntoCanvasScaled(canvas, src, THUMB_LONG_EDGE);
  const thumbPath = await exportCanvas(canvas, thumbSize.width, thumbSize.height, 0.6);

  const [mainRes, thumbRes] = await Promise.all([
    wx.cloud.uploadFile({ cloudPath: `${safePrefix}/${ts}_${rand}.jpg`, filePath: src }),
    wx.cloud.uploadFile({ cloudPath: `${safePrefix}/${ts}_${rand}_thumb.jpg`, filePath: thumbPath })
  ]);

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
