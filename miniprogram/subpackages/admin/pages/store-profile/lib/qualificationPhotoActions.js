'use strict';

// 纯逻辑：门店资质与实景公示（门头照/民政备案复印件/食品安全承诺）"点击一张
// 已上传照片"该走哪条路径的决策，不依赖任何小程序 API（wx.*），供
// store-profile.ts 的 onTapQualificationPhoto 调用。
//
// 🐛 背景（2026-09-10 UX 缺口修复）：三个照片位全部上传过至少一张后，此前
// 唯一的"暂未上传"占位入口（sp-upload-slot）不再渲染，标题栏的"✏️ 修改"
// 按钮又在上一轮"UI 入口精简"里被误当成重复入口移除，导致整张卡片彻底没有
// 入口可以重新编辑/替换/删除已上传的照片。本次除了恢复标题栏按钮，还让点击
// 单张已上传照片本身也能触达管理入口——这里只负责"该弹什么、弹出后每一项
// 对应什么动作"这个决策分支，不做任何 UI 渲染或数据库读写。
//
// 拆成独立文件+配套 *.test.js 单测，是本仓库 cloudfunctions/*/lib/*.js 已有
// 的既定写法（不新建测试框架，用 node --test 直接跑），这是第一次把同一套
// 写法用在 miniprogram/ 页面上——TS 页面通过 `require('./lib/xxx')` 引入，
// tsconfig.json 的 allowJs:true 已经支持这种混合引用。

const PHOTO_FIELD_LABELS = {
  storePhotos: '门店照片',
  storefrontPhotos: '门头照',
  civilAffairsPhotos: '民政备案复印件',
  foodSafetyPledgePhotos: '食品安全承诺'
};

// 决定点击一张已上传的资质照片时该走哪条路径：
// - 只读角色（canManage 为 false）：永远直接预览大图，不弹任何管理选项——
//   义工/财务/家属等角色本来就不该在这个入口看到"更换/删除"这类管理动作
// - 可管理角色：弹出 ActionSheet，itemList 顺序固定为
//   [0] 预览大图  [1] 更换/删除该照片（进入既有的批量管理弹窗，
//   复用 onOpenQualificationModal 已经过验证的新增/删除/保存全套逻辑，
//   不重新实现一遍"单张替换后立即持久化"的写库路径）
function decideQualificationPhotoTap(canManage, category) {
  if (!canManage) {
    return { mode: 'preview' };
  }
  const label = PHOTO_FIELD_LABELS[category] || '照片';
  return {
    mode: 'action-sheet',
    itemList: ['预览大图', `更换/删除「${label}」`]
  };
}

// ActionSheet 的 success 回调按 tapIndex 选出对应动作——tapIndex === 0 是
// 预览，其余一律归为"打开管理弹窗"（而不是严格判断 === 1），避免以后往
// itemList 里追加第三个选项时这里漏改成 >= 2 的判断
function resolveQualificationActionSheetChoice(tapIndex) {
  return tapIndex === 0 ? 'preview' : 'manage';
}

module.exports = {
  PHOTO_FIELD_LABELS,
  decideQualificationPhotoTap,
  resolveQualificationActionSheetChoice
};
