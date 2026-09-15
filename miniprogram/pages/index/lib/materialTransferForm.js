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

module.exports = {
  MATERIAL_TRANSFER_ITEM_OPTIONS,
  MATERIAL_PURCHASE_ITEM_OPTIONS,
  computeMaterialTransferFormValid,
  computeMaterialPurchaseFormValid
};
