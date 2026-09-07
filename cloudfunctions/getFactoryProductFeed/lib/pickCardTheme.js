// 纯逻辑：发现页占位卡片的确定性配色/图标选取——products 集合目前没有任何
// 图片字段（product-management 页表单从未暴露、CLAUDE.md 已记录这个已知
// 缺口），本轮不做真实图片上传，用"按 productId 哈希固定取一个色相+emoji"
// 的占位卡片回避这个缺口：同一个商品每次刷新都拿到同一张"脸"，不会像
// Math.random() 那样每次刷新颜色乱跳，也不需要为占位视觉引入任何图床/审核
// 成本。不做 db I/O，便于单测。
'use strict';

const EMOJI_POOL = ['🥗', '🍱', '🍚', '🍜', '🥟', '🍙', '🫘', '🍲'];
const COLOR_POOL = ['#F4A259', '#8CB369', '#5B8C5A', '#E07A5F', '#3D8B8B', '#B5838D', '#6D6875', '#9C6644'];

function hashString(str) {
  let hash = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pickCardTheme(productId) {
  const h = hashString(productId);
  return {
    emoji: EMOJI_POOL[h % EMOJI_POOL.length],
    color: COLOR_POOL[Math.floor(h / EMOJI_POOL.length) % COLOR_POOL.length]
  };
}

module.exports = { pickCardTheme, hashString, EMOJI_POOL, COLOR_POOL };
