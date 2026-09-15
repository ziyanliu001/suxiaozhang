'use strict';

// 纯逻辑：「爱心物资跨店调拨」与「登记采购入库」两个弹窗共用的表单校验 +
// 物资类目数据源。与 store-profile/lib/qualificationPhotoActions.js、
// pages/index/lib/smartReceiptDraft.js 同一套既定写法——不依赖 wx.*/
// this.setData，便于 node:test 直接单测；index.ts 的 onSelectMaterialTransferItem
// 等一系列处理函数只负责触发 setData/UI 更新，"这份表单算不算填完整"、
// "有哪些物资类目可选"全部委托给这里唯一维护，不允许 index.ts 里再出现
// 第二份拷贝各自漂移。
//
// 🥬 素食边界（务必先读，这是本文件类目枚举存在的前提）：本仓库服务雨花斋
// 等纯素公益食堂（见 CLAUDE.md 项目定位与"善款支付红线"），物资类目枚举
// 必须严格限定在纯素范围内——大米/食用油/面粉/时蔬，不允许出现任何荤食/
// 动物性原料类目。跨店调拨只放开前三项（时蔬保质期短、跨店平调时效性差，
// 与 cloudfunctions/manageMaterialTransfer 的 TRANSFERABLE_ITEMS 常量保持
// 同源口径，那边服务端也是硬编码这三项，双端不是共享同一份拷贝但取值必须
// 一致，改动其中一处务必同步改另一处）；采购入库四类目全覆盖。

const MATERIAL_TRANSFER_ITEM_OPTIONS = [
  { value: 'rice', emoji: '🍚', label: '大米' },
  { value: 'oil', emoji: '🫗', label: '食用油' },
  { value: 'flour', emoji: '🌾', label: '面粉' }
];

const MATERIAL_PURCHASE_ITEM_OPTIONS = [
  { value: 'rice', emoji: '🍚', label: '大米' },
  { value: 'oil', emoji: '🫗', label: '食用油' },
  { value: 'flour', emoji: '🌾', label: '面粉' },
  { value: 'vegetable', emoji: '🥬', label: '时蔬' }
];

const TRANSFERABLE_ITEM_VALUES = MATERIAL_TRANSFER_ITEM_OPTIONS.map((o) => o.value);

/**
 * 「爱心物资跨店调拨」表单是否已填写完整——门店已选、物资属于可调配三项、
 * 重量是大于 0 的合法数字、经手人非空，四项全部满足才允许点亮提交按钮。
 * @param {{partnerStoreId?:string, item?:string, quantityJin?:string, handledBy?:string}} form
 * @returns {boolean}
 */
function computeMaterialTransferFormValid(form) {
  if (!form || !form.partnerStoreId) return false;
  if (!TRANSFERABLE_ITEM_VALUES.includes(form.item)) return false;
  const qty = parseFloat(form.quantityJin);
  if (!Number.isFinite(qty) || qty <= 0) return false;
  if (!form.handledBy || !String(form.handledBy).trim()) return false;
  return true;
}

/**
 * 「登记采购入库」表单是否已填写完整——品类始终有默认选中值（表单打开时
 * 就预置了 'rice'），真正会留空的必填项只有重量，单独校验即可。
 * @param {string} quantityJin
 * @returns {boolean}
 */
function computeMaterialPurchaseFormValid(quantityJin) {
  const qty = parseFloat(quantityJin);
  return Number.isFinite(qty) && qty > 0;
}

/**
 * 智能库存余量联动（2026-09-18）：只在"调出支援"方向才有意义——调出会真的
 * 消耗本店库存，调入接收不存在"超量"这个概念（收多少都不会让任何一方出现
 * 负库存风险）。直接读页面已有的 materialStockDisplay（fetchMaterialStock()
 * 现算的本店四类目预估结存），不发起任何新的云函数请求，也不去查"对方门店"
 * 的库存——本店店长本就没有权限查看别家门店的精确库存数字（见
 * cloudfunctions/manageMaterialTransfer 的 resolveWriteTarget 权限模型），
 * 这里的"防止超量调拨"天然只能是"提醒调用者别把自己家底掏空"，不是替对方
 * 把关。
 * @param {'out'|'in'} direction
 * @param {string} item
 * @param {Record<string,{jin:number,status:string}>|null} materialStockDisplay
 * @returns {number|null} null 表示当前场景不需要展示余量提示（调入方向，或数据尚未就绪）
 */
function computeSelectedStockJin(direction, item, materialStockDisplay) {
  if (direction !== 'out') return null;
  if (!materialStockDisplay || !item) return null;
  const entry = materialStockDisplay[item];
  if (!entry || typeof entry.jin !== 'number') return null;
  return entry.jin;
}

/**
 * 本次填写的调配重量是否超过（严格大于）上面算出的本店预估结存——超量本身
 * 不阻断提交（结存是估算值，天然可能有误差，见 computeMaterialStock.js 头部
 * 注释同一口径），只用于展示一条醒目但可忽略的提醒。
 * @param {string} quantityJin
 * @param {number|null} stockJin
 * @returns {boolean}
 */
function isOverStock(quantityJin, stockJin) {
  if (stockJin === null || stockJin === undefined) return false;
  const qty = parseFloat(quantityJin);
  if (!Number.isFinite(qty) || qty <= 0) return false;
  return qty > stockJin;
}

/**
 * 快捷步进：把 +1/+5/+10 这类按钮点击换算成新的重量输入值。当前输入框是
 * 空/非法值时按 0 起步（而不是拒绝操作——用户点"+5"这个动作本身已经足够
 *明确意图，不需要先手动填个 0 再点）。保留一位小数，避免浮点运算残留
 * 类似 19.999999999998 这种展示噪音。
 * @param {string} currentQuantityJin
 * @param {number} stepJin
 * @returns {string}
 */
function applyQuickStep(currentQuantityJin, stepJin) {
  const current = parseFloat(currentQuantityJin);
  const base = Number.isFinite(current) && current > 0 ? current : 0;
  const next = Math.round((base + stepJin) * 10) / 10;
  return String(next);
}

/**
 * 常用门店快捷标签：从"最近调拨记录"（该店参与的、无论调出调入方向）里提炼
 * 出交易对手方门店，按最近一次出现的时间倒序去重，供调拨弹窗"请选择门店"
 * 上方的快捷标签使用，减少多店频繁互通时反复打开 picker 选同一批店的操作
 * 成本。不发起新的云函数请求——复用弹窗打开时已经在查的 listTransfers 结果
 * （见 index.ts fetchMaterialTransferRecent），只是把这批记录多利用一次。
 * @param {Array<{fromStoreId:string,fromStoreName:string,toStoreId:string,toStoreName:string,createTime?:string}>} records 已按 createTime desc 排序的调拨记录
 * @param {string} currentStoreId 当前门店 ID，用于判断每条记录里"对方"是 from 还是 to
 * @param {number} [limit=4] 最多返回多少个快捷标签
 * @returns {Array<{storeId:string, storeName:string}>}
 */
function buildRecentPartnerChips(records, currentStoreId, limit) {
  const maxCount = limit || 4;
  if (!Array.isArray(records) || !currentStoreId) return [];

  const seen = new Set();
  const chips = [];
  for (const rec of records) {
    if (!rec) continue;
    let partnerId;
    let partnerName;
    if (rec.fromStoreId === currentStoreId) {
      partnerId = rec.toStoreId;
      partnerName = rec.toStoreName;
    } else if (rec.toStoreId === currentStoreId) {
      partnerId = rec.fromStoreId;
      partnerName = rec.fromStoreName;
    } else {
      // 理论上不该出现——本店既不是 from 也不是 to，跳过这条脏数据，不让
      // 一条异常记录污染整份快捷标签
      continue;
    }
    if (!partnerId || seen.has(partnerId)) continue;
    seen.add(partnerId);
    chips.push({ storeId: partnerId, storeName: partnerName || '未命名门店' });
    if (chips.length >= maxCount) break;
  }
  return chips;
}

module.exports = {
  MATERIAL_TRANSFER_ITEM_OPTIONS,
  MATERIAL_PURCHASE_ITEM_OPTIONS,
  computeMaterialTransferFormValid,
  computeMaterialPurchaseFormValid,
  computeSelectedStockJin,
  isOverStock,
  applyQuickStep,
  buildRecentPartnerChips
};
