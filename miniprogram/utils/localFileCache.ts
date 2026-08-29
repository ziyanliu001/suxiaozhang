// 本地临时/导出文件安全写入封装 —— 收口 wx.env.USER_DATA_PATH 目录下几处
// 会反复写入新文件的场景（门店二维码临时图片、CSV 报表导出）。
//
// 🐛 根因修复（本地日志/文件写满报错）：USER_DATA_PATH 本地存储有容量上限，
// 而这几处写入此前要么用 Date.now() 拼文件名（如门店二维码临时图
// store_qr_*.png），每次生成都是一个全新文件、从未清理；要么导出文件名随
// 门店/周期变化，长期使用同样会累积出大量再也用不上的历史文件——最终写满
// 配额后，后续写入直接报错 "writeFile:fail the maximum size of the file
// storage limit is exceeded"（这不是本项目自己维护了一个 .log 日志模块，
// 项目里没有这类模块，是这几处业务性本地文件写入长期不清理导致的）。
// 这里统一在写入失败时按前缀清理同类历史文件后重试一次，两次都失败才放弃、
// 静默返回 false，调用方按 false 走已有的失败降级分支（Toast 提示 + 保留
// 原有重试/占位逻辑），不会因为一次本地磁盘写入失败就抛出未捕获异常。
function cleanupLocalFilesByPrefix(prefix: string, keepPath?: string) {
  try {
    const fs = wx.getFileSystemManager();
    const dir = wx.env.USER_DATA_PATH;
    const names = fs.readdirSync(dir);
    names.forEach((name) => {
      if (!name.startsWith(prefix)) return;
      const fullPath = `${dir}/${name}`;
      if (keepPath && fullPath === keepPath) return;
      try {
        fs.unlinkSync(fullPath);
      } catch (e) {
        // 单个文件删除失败（可能已被系统回收）不影响其余文件的清理
      }
    });
  } catch (e) {
    // USER_DATA_PATH 目录本身读取失败是极端情况，不影响调用方主流程
  }
}

/**
 * 安全写入本地临时/导出文件：写入失败时自动清理同前缀的历史文件后重试一次，
 * 仍失败则静默返回 false（不抛出异常），由调用方决定如何降级。
 *
 * @param filePath      完整目标路径（`${wx.env.USER_DATA_PATH}/xxx`）
 * @param data          文件内容
 * @param encoding      'utf8'（CSV 等文本）| 'base64'（图片等二进制）
 * @param cleanupPrefix 写入失败时用于匹配、清理同类历史文件的文件名前缀
 */
export function writeLocalFileSafe(
  filePath: string,
  data: string,
  encoding: 'utf8' | 'base64',
  cleanupPrefix: string
): boolean {
  const fs = wx.getFileSystemManager();
  try {
    fs.writeFileSync(filePath, data, encoding);
    return true;
  } catch (err) {
    console.warn(`[localFileCache] 写入失败（${filePath}），清理历史缓存文件后重试:`, err);
    cleanupLocalFilesByPrefix(cleanupPrefix, filePath);
    try {
      fs.writeFileSync(filePath, data, encoding);
      return true;
    } catch (retryErr) {
      console.warn(`[localFileCache] 清理后重试仍写入失败（${filePath}），静默降级:`, retryErr);
      return false;
    }
  }
}
