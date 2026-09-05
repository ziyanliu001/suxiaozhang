// 🏛️ Open-Core 架构拆分 · 终局阶段：个人中心 SaaS 订阅与配额中台（Enterprise）
//
// 本文件是从 pages/profile/profile.ts 物理搬迁出来的方法/常量集合，运行时
// 通过 spread 合并回 profile.ts 的 Page({...}) 对象，与 Core 方法共享同一个
// 页面实例——原理同 pages/statistics/enterprise/nationalDashboardService.ts
// 头部注释，此处不再重复。
//
// 收录范围：套餐档位文案常量、"是否永久有效/到期文案"判定、套餐升级/续费
// 半屏卡片（showSubscriptionModal）的打开/关闭、配额信息拉取
// （fetchSubscriptionInfo，驱动门店配额进度条）、激活码/授权码自助兑换、
// 在线订购下单与支付（对接 wxPayCore）、平台客服微信一键复制。
//
// 🏛️（2026-08-31 Open-Core 第三阶段）本文件里的 onOpenSubscriptionModal 早已
// 有一道 `if (!ENTERPRISE_BUILD_ENABLED) return;` 运行时旗标早退（当时是原地
// 加在 profile.ts 里的），本次物理搬迁不去掉这道旗标——两种隔离机制同时保留：
// Core 包构建时物理删除本文件（用 core-overrides 的 saasSubscriptionHandler
// stub 整份替换 ./index.ts），旗标则继续服务于"同一份完整版代码，运营侧想
// 临时关闭购买入口但不想重新走一次构建发布"这个不同的场景，两者互不冲突。
import { checkTenantPermission, FEATURE_KEYS, clearTenantPermissionCache, resolveTier, PERMISSION_TIER } from '../../../utils/tenantPermission';
import { getSafeSystemInfo, isIOSDevice } from '../../../utils/util';
import { setTabBarHidden } from '../../../utils/tabBarVisibility';
import { callFunctionWithTimeout } from '../../../utils/withTimeout';
import { payForOrder, CreateOrderResponse } from '../../../utils/wxPayCore';
import { ENTERPRISE_BUILD_ENABLED } from '../../../utils/buildFlags';

// 🔐 套餐档位文案：与 subpackages/admin/pages/platform-admin/platform-admin.ts
// 的 PLAN_LABELS 保持同一套措辞，两处独立部署（云函数/页面各自没有共享模块
// 机制），文案硬编码一致即可，不需要额外抽取共享常量
export const PLAN_LABELS: Record<string, string> = {
  basic: '基础版',
  pro: '专业版',
  enterprise: '旗舰版'
};

// 🆕 底部主按钮文案联动：与 cloudfunctions/createSubscriptionOrder/lib/applyPayment.js
// 的 PLAN_RANK 同一份拷贝（只用于前端文案判断"该不该说续费/该不该说升级"，
// 不参与任何鉴权/计费，真正生效的档位排序仍以云函数为准）
export const PLAN_RANK: Record<string, number> = { basic: 0, pro: 1, enterprise: 2 };
export const PLAN_ACTION_META: Record<'pro' | 'enterprise', { icon: string; name: string; price: string }> = {
  pro: { icon: '💳', name: '专业版', price: '¥1,688/年' },
  enterprise: { icon: '👑', name: '旗舰版', price: '¥3,688/年' }
};

// 🐛 根因修复（专业版被误判为永久有效）：此前"是否永久有效"完全靠猜测服务端
// 存的到期日期是不是长得像哨兵值（年份 ≥2099）——但 pro/enterprise 是真实的
// 年费订阅，任何历史脏数据/异常写入（如激活码铸造时曾出现过的 2102-12-31，
// 见 activateTenantSubscription MAX_DURATION_DAYS 修复注释）都可能让它的真实
// 到期日恰好落进这个区间，届时会被误判成"永久有效"，连带底部按钮也错误地
// 隐藏了本该展示的"立即续费"。"是否永久"不能靠猜到期日期像不像哨兵值反推，
// 只能由两个明确信号决定：
//   ① 套餐本身就是免费的 basic 档（长期可用，天然没有"到期"概念）；
//   ② 该订阅记录被显式标记了终身特权（tenant_subscriptions.isLifetimeGrant
//      === true，只有 manageTenantSubscription 后台人工操作才会打上这个
//      标记，不会被一笔普通的支付/激活码续费意外产生）
// pro/enterprise 只要不满足②，哪怕存的到期日恰好落在哨兵区间，也一律如实
// 按日期展示——不再由前端帮着掩盖数据问题，脏数据交给平台管理员在
// platform-admin 后台核实修正
// 🐛（2026-08-31 修复）第一个参数此前直接传入 checkTenantPermission 返回的
// planType——但那是"到期已降级"后的值，pro/enterprise 到期会被降级成 'basic'，
// 导致这里误判为"本来就是免费档"从而永久显示"永久有效"，掩盖了真实的到期
// 状态。现在要求调用方改传 originalPlanType（降级前的真实套餐）
export function isPerpetualPlan(originalPlanType: string, isLifetimeGrant: boolean): boolean {
  return originalPlanType === 'basic' || !!isLifetimeGrant;
}

// 🌟 到期日展示：isPerpetual 由上面 isPerpetualPlan() 判定后传入，本函数不再
// 自行用日期形状去反推是否永久——同一份到期日字符串，"永久有效"还是"如实
// 显示日期"完全取决于调用方传入的 isPerpetual，职责单一、不重复判断
// 🆕（2026-08-31）新增 isExpired：非永久套餐已过期时改用"已于 X 到期"措辞，
// 与 getNationalDashboard 的 expireDateText 文案口径保持一致
export function formatTenantExpireText(expireDateStrOrTimestamp: any, isPerpetual: boolean, isExpired: boolean = false): string {
  if (isPerpetual) return '永久有效';
  const d = new Date(expireDateStrOrTimestamp);
  const year = d.getFullYear();
  if (!expireDateStrOrTimestamp || isNaN(year)) return '到期日异常，请联系客服核实';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return isExpired ? `已于 ${year}-${m}-${day} 到期` : `有效期至 ${year}-${m}-${day}`;
}

// 🍎 iOS 虚拟商品支付合规：付费 Tab 隐藏价格/支付按钮后，底部按钮改为引导
// 使用授权码/兑换卡号自助操作——文案按"续费/升级/开通"三种场景区分，与
// computePlanActionLabels 非 iOS 分支同一套判断，只是把"立即 X"换成"使用
// 兑换码 X"，让用户清楚这条路径要走的是下方的授权码输入框，而不是小程序内
// 支付
export function computeIOSPlanActionLabels(currentPlanType: string, isActive: boolean): Record<'pro' | 'enterprise', string> {
  const currentRank = PLAN_RANK[currentPlanType] ?? 0;
  const build = (tab: 'pro' | 'enterprise') => {
    const tabRank = PLAN_RANK[tab];
    if (isActive && currentRank >= tabRank) return '使用兑换码续费';
    if (isActive && currentRank < tabRank) return '使用兑换码升级';
    return '使用兑换码开通';
  };
  return { pro: build('pro'), enterprise: build('enterprise') };
}

// 🆕 见 data.isRedundantRenewTab 声明处注释：只对 pro/enterprise 两个"有真实
// 档位排序"的 Tab 生效——basic 本就走"当前为默认免费档位"的常驻禁用文案，
// add_on 是叠加购买、与是否永久无关，两者都不应被这个判断影响
export function computeRedundantRenewFlag(tab: string, currentPlanType: string, isActive: boolean, isPerpetual: boolean): boolean {
  if (tab !== 'pro' && tab !== 'enterprise') return false;
  if (!isActive || !isPerpetual) return false;
  const currentRank = PLAN_RANK[currentPlanType] ?? 0;
  return currentRank >= PLAN_RANK[tab];
}

export const saasSubscriptionHandlers = {
  // 🔐 套餐升级/续费半屏卡片：复用 checkTenantPermission（与首页/统计页同一套
  // 租户订阅鉴权入口），拿到的 planType/isExpired/serviceExpireDate 就是本机构
  // 当前生效的套餐状态——传哪个 featureKey 不影响这几个字段的取值，任选一个即可。
  // 抽成独立方法是因为激活码兑换成功后也要重新拉一遍最新状态刷新这张卡片，
  // 与"打开弹窗时首次加载"共用同一段逻辑，不重复维护两份
  async fetchSubscriptionInfo() {
    // 🌟 checkTenantPermission 内部按调用者自己的 _openid 反查 user_roles.tenantId
    // 再查 tenant_subscriptions（云端数据库，唯一真源）——不读取任何本地
    // Storage 缓存的授权标记。这意味着换一台手机用同一个微信账号登录，这里
    // 依然会查到同一个 tenantId 名下云端保存的真实套餐状态，专业版权益天然
    // 跨设备保持有效，不需要额外做"迁移本地授权状态"这类操作
    const result = await checkTenantPermission(FEATURE_KEYS.MULTI_STORE_DASHBOARD, { skipCache: true });
    const expireDateStr = result.serviceExpireDate || '';
    // 🌟 7 天内到期同样标红提醒——与 pages/platform-admin 大盘"7 天内到期机构"
    // 预警口径保持一致（见 getPlatformOverview 的 soonExpiringTenants）
    const EXPIRING_SOON_MS = 7 * 24 * 3600 * 1000;
    const expireTime = expireDateStr ? new Date(expireDateStr).getTime() : NaN;
    const isExpiringSoon = !result.isExpired && !Number.isNaN(expireTime) && (expireTime - Date.now()) <= EXPIRING_SOON_MS;
    // 🆕 isActive：与 tenantPermission.ts 的 BASIC/ADVANCED 两档概念对齐——
    // ADVANCED 且未到期才算"已开通"。到期的 pro/enterprise 服务端本就会把
    // planType 提前改写回 basic（见 checkTenantPermission 云函数），这里再
    // 显式判一次 isExpired 是双重保险，不是重复逻辑
    const isActive = resolveTier(result.planType) === PERMISSION_TIER.ADVANCED && !result.isExpired;
    // 🆕 是否永久有效：见 isPerpetualPlan() 头部注释——只由 originalPlanType
    // ===basic（降级前的真实套餐）或显式 isLifetimeGrant 标记决定，不再从
    // 到期日期的形状反推，也不能用已降级的 result.planType（否则过期的
    // pro/enterprise 会被误判成"永久有效"）
    const isPerpetual = isPerpetualPlan(result.originalPlanType, result.isLifetimeGrant);

    this.setData({
      // 🐛 根因修复（升级弹窗顶部机构名称错误/写死）：见 WXML
      // {{currentTenantName || currentStoreName || '我的机构'}} 绑定——此前
      // currentTenantName 只由 fetchCurrentTenantName() 写入，而该方法明确
      // 排除了 super_admin/platform_admin（见其头部注释"超管/平台管理员不
      // 调用本方法"），导致这两类账号打开本弹窗时 currentTenantName 永远是
      // 空字符串，退回展示 currentStoreName——一个跟"当前订阅所属机构"完全
      // 无关、且可能是切工作空间/切店前遗留的旧字段，表现为"通用工作空间下
      // 却显示雨花斋（全国总览机构）"这类张冠李戴。本方法本就在调用同一个
      // checkTenantPermission（已按调用者真实 tenantId 反查 tenants.name，
      // 见该云函数），这里顺带把 tenantName 一并写入，不新增云调用，且不受
      // fetchCurrentTenantName() 的角色限制影响——每次打开弹窗都会重新调用
      // 本方法，天然保证展示的是当前账号真实所属机构，不会残留旧工作空间的
      // 机构名
      currentTenantName: result.tenantName || this.data.currentTenantName,
      subscriptionInfo: {
        planType: result.planType,
        planLabel: PLAN_LABELS[result.planType] || result.planType,
        isExpired: result.isExpired,
        isExpiringSoon,
        // 🕊️ 宽限期字段：checkTenantPermission 云函数已算好，前端只透传展示，
        // 不重复实现一遍到期/宽限期判断逻辑
        isInGracePeriod: result.isInGracePeriod,
        graceExpireDate: result.graceExpireDate || '',
        coreReadOnly: result.coreReadOnly,
        isActive,
        expireDateStr,
        isPerpetual,
        expireDisplayText: formatTenantExpireText(expireDateStr, isPerpetual, result.isExpired),
        storeLimit: result.storeLimit || 2,
        usedStoreCount: result.usedStoreCount || 0
      },
      planActionLabels: this.computePlanActionLabels(result.planType, isActive, isPerpetual),
      iosPlanActionLabels: computeIOSPlanActionLabels(result.planType, isActive),
      isRedundantRenewTab: computeRedundantRenewFlag(this.data.comparePlanTab, result.planType, isActive, isPerpetual)
    });
  },

  // 🆕 见 data.planActionLabels 声明处注释：只依赖"当前持有档位 + 是否已生效"
  // 两个输入，与 comparePlanTab（用户正在浏览哪个 Tab）无关——两个 Tab
  // （pro/enterprise）各自的文案一次性算好存进 data，WXML 按当前 Tab 直接取用，
  // 不需要每次切 Tab 都重新算一遍
  // 🐛 根因修复：永久有效套餐（isPerpetual）没有真实到期日，currentRank >= tabRank
  // 分支此前无条件展示"立即续费 ¥xxx/年"，等于在邀请一个永远不会过期的机构
  // 花钱续费一个不存在的到期。永久档位下同/低档 Tab 改为"已享永久版权益"提示，
  // 不再拼价格、也不再是一个会触发下单的诱导性文案（见下方 WXML 改动，这类
  // Tab 的底部按钮已联动改为禁用态，此处文案只是兜底展示，不依赖调用方判断）
  computePlanActionLabels(currentPlanType: string, isActive: boolean, isPerpetual?: boolean): Record<'pro' | 'enterprise', string> {
    const currentRank = PLAN_RANK[currentPlanType] ?? 0;
    const build = (tab: 'pro' | 'enterprise') => {
      const meta = PLAN_ACTION_META[tab];
      const tabRank = PLAN_RANK[tab];
      if (isActive && isPerpetual && currentRank >= tabRank) return `✅ 已享永久版权益`;
      if (isActive && currentRank >= tabRank) return `${meta.icon} 立即续费 ${meta.price}`;
      if (isActive && currentRank < tabRank) return `${meta.icon} 立即升级${meta.name}`;
      return `${meta.icon} 立即开通${meta.name}`;
    };
    return { pro: build('pro'), enterprise: build('enterprise') };
  },

  // 🐛 防重锁：与 statistics.ts fetchStatistics 同一套 isLoading 式防抖，避免用户
  // 手快连点"会员开通/续费管理"打出重复的鉴权云调用
  // 🏛️（2026-08-31 Open-Core 第三阶段）本方法是页面内所有 SaaS 订阅弹窗入口
  // 的唯一汇合点（pro-service-card/top-advanced-secondary/sa-dev-tool-row
  // 三处 WXML 按钮 + onShow 里的自动唤起，均最终调用到这里）——Core 构建下
  // 直接早退，不发起任何鉴权云调用/不展示弹窗，见 utils/buildFlags.ts 头部注释
  async onOpenSubscriptionModal() {
    if (!ENTERPRISE_BUILD_ENABLED) return;
    if (this.data.subscriptionLoading) return;
    // 🍎 iOS 虚拟商品支付合规：微信小程序平台规则要求 iOS 客户端不得展示价格/
    // 拉起小程序内支付，每次打开弹窗都重新探测一次（成本极低，避免长驻页面
    // 缓存一份过期的平台判断），WXML 据此隐藏价格与支付按钮。isIOSDevice()
    // 而不是直接判 platform === 'ios'——开发者工具切换 iPhone 机型调试时
    // platform 恒为 'devtools'，见 utils/util.ts isIOSDevice 头部注释
    const sysInfo = getSafeSystemInfo();
    const isIOSPlatform = isIOSDevice(sysInfo);
    this.setData({
      showSubscriptionModal: true,
      subscriptionLoading: true,
      activationCodeInput: '',
      isIOSPlatform,
      // 🎫 每次重新打开半屏卡片都收起授权码折叠区，不带着上一次的展开态；
      // 🍎 iOS 端例外——应用内支付被隐藏后，授权码/兑换卡号是唯一的自助开通
      // 通道，直接展开主导展示，不需要用户先发现"原来还有个折叠入口"
      showRedeemSection: isIOSPlatform
    });
    // 🐛 根因修复：自定义 tabBar 是框架自动挂载的原生层组件，本卡片的
    // z-index 再高也盖不住它（见 utils/tabBarVisibility.ts 头部注释），
    // 显式隐藏，关闭时（下方 onCloseSubscriptionModal）再恢复
    setTabBarHidden(this, true);

    try {
      await this.fetchSubscriptionInfo();
    } catch (err) {
      console.warn('[onOpenSubscriptionModal] 加载套餐信息失败:', err);
    } finally {
      this.setData({ subscriptionLoading: false });
    }
  },

  // WXML 中 pro-service-card 按钮绑定此方法（与 onOpenSubscriptionModal 同义）
  onOpenProSubscriptionModal() {
    return this.onOpenSubscriptionModal();
  },

  onCloseSubscriptionModal() {
    this.setData({ showSubscriptionModal: false });
    setTabBarHidden(this, false);
  },

  // 🎫 授权码折叠区展开/收起：见 data.showRedeemSection 声明处注释
  onToggleRedeemSection() {
    this.setData({ showRedeemSection: !this.data.showRedeemSection });
  },

  onActivationCodeInput(e: any) {
    // 🆕 自动去除前后空格：授权码通常是从聊天记录/短信里复制来的，前后经常
    // 带着换行/空格，这里在每次输入变化时就地清理，兑换时不会因为多余空白
    // 字符导致校验失败
    this.setData({ activationCodeInput: (e.detail.value || '').trim() });
  },

  // 🆕 粘贴：直接读取剪贴板填入输入框（并去除前后空格），授权码通常是从
  // 客服/购买渠道的聊天记录里复制来的，比手动长按输入框选择粘贴更省事
  onPasteActivationCode() {
    wx.getClipboardData({
      success: (res) => {
        const text = (res.data || '').trim();
        if (!text) {
          wx.showToast({ title: '剪贴板为空', icon: 'none' });
          return;
        }
        this.setData({ activationCodeInput: text });
      },
      fail: () => {
        wx.showToast({ title: '读取剪贴板失败', icon: 'none' });
      }
    });
  },

  // 🌸 激活码/授权码自助兑换：完全自动化，校验通过立即生效，全程无需联系
  // 管理员或等待人工审批——对接 cloudfunctions/activateTenantSubscription 的
  // redeem action，那边会直接写入 tenant_subscriptions（与 platform_admin 后台
  // 手工续费同一张表），本页只是多了一个自助入口
  async onRedeemActivationCode() {
    if (this.data.activationSubmitting) return;
    const code = (this.data.activationCodeInput || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入激活码', icon: 'none' });
      return;
    }
    // 🆕 前端轻量格式校验：激活码固定 12 位字符（见 activateTenantSubscription
    // 云函数 generateRandomCode，展示态用短横线分隔成 4-4-4 段），去掉分隔符/
    // 空白后长度不对基本就是抄漏/抄错，不必真的发起一次网络请求才告知用户，
    // 真正的存在性/状态校验仍完全交给服务端，这里只拦明显不合法的输入
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length !== 12) {
      wx.showToast({ title: '激活码格式不正确，请核对后重新输入', icon: 'none' });
      return;
    }

    this.setData({ activationSubmitting: true });
    wx.showLoading({ title: '正在兑换...', mask: true });

    try {
      const res = await callFunctionWithTimeout({
        name: 'activateTenantSubscription',
        data: { action: 'redeem', activationCode: code }
      });
      const result = res.result as any;
      wx.hideLoading();

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '兑换失败，请重试', icon: 'none', duration: 2500 });
        return;
      }

      // 🆕 兑换成功：清空 tenantPermission.ts 的 60s 内存缓存，避免用户兑换完
      // 当场跳去统计页/导出功能，还要再等缓存自然过期才看到解锁生效；
      // fetchSubscriptionInfo() 顺带把本页 subscriptionInfo 刷新成最新套餐状态
      clearTenantPermissionCache();
      await this.fetchSubscriptionInfo();

      // 🐛 根因修复：此前兑换成功后弹窗不会关闭，用户还得自己再点一次关闭——
      // 兑换是"一次性口令、立即生效"的动作，成功后应该直接把半屏卡片收起来，
      // 而不是停留在原地等用户手动退出
      const planLabel = PLAN_LABELS[result.data.planType] || result.data.planType;
      this.setData({
        activationCodeInput: '',
        showPaymentPendingModal: false,
        showSubscriptionModal: false
      });
      setTabBarHidden(this, false);
      // 🐛 根因修复：微信原生 Toast 默认宽度只能容纳约 7 个汉字/行、最多两行，
      // 此前"已成功激活【XX版】，有效期至 YYYY-MM-DD"这类长文案在真机上会被
      // 截断成"已成功激活【专业...」看不全。到期日/套餐名 fetchSubscriptionInfo()
      // 已经刷新进 subscriptionInfo 卡片里完整展示，Toast 只需要给一个简短的
      // 动作反馈，不必在寸土寸金的弹层里塞完整信息
      wx.showToast({ title: '激活成功', icon: 'success', duration: 2000 });
    } catch (err) {
      wx.hideLoading();
      console.error('[onRedeemActivationCode] 兑换异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ activationSubmitting: false });
    }
  },

  // 🆕 套餐对比 Tab 切换：纯浏览态，见 data.comparePlanTab 声明处注释
  onSwitchComparePlanTab(e: any) {
    const tab = e.currentTarget.dataset.plan;
    const info = this.data.subscriptionInfo;
    this.setData({
      comparePlanTab: tab,
      isRedundantRenewTab: computeRedundantRenewFlag(tab, info.planType, info.isActive, info.isPerpetual)
    });
  },

  // 🏪 扩容门店包数量步进：¥200/店/年，1~20 家区间（与 createSubscriptionOrder
  // MAX_ADD_ON_QUANTITY 同一档上限），每次变化同步重算合计价格展示
  onIncreaseAddOnQuantity() {
    const next = Math.min(this.data.addOnQuantity + 1, 20);
    this.setData({ addOnQuantity: next, addOnTotalPrice: next * this.data.addOnUnitPrice });
  },
  onDecreaseAddOnQuantity() {
    const next = Math.max(this.data.addOnQuantity - 1, 1);
    this.setData({ addOnQuantity: next, addOnTotalPrice: next * this.data.addOnUnitPrice });
  },

  // 🆕 底部主操作按钮的统一入口：按当前正在浏览（comparePlanTab）的套餐分流
  // 成三种真实的在线支付下单动作——专业版/旗舰版/扩容门店包均已在
  // createSubscriptionOrder 云函数登记真实价格与 SKU（PRO_YEARLY/FLAGSHIP_YEARLY/
  // ADD_ON_STORE），不再有"联系客服定制开通"这条兜底路径。basic 是免费默认档，
  // 对应的按钮在 wxml 里就是一条不可点击的置灰提示条，不会触发本方法
  onPrimaryPlanAction() {
    // 🍎 iOS 虚拟商品支付合规：按钮本应已被 WXML 换成"联系客服咨询"（不会
    // 触发本方法），这里再做一道兜底拦截，防止任何遗漏分支下 iOS 客户端
    // 意外拉起小程序内支付
    if (this.data.isIOSPlatform) {
      wx.showToast({ title: '暂不支持应用内购买，请联系客服咨询开通', icon: 'none', duration: 2500 });
      return;
    }
    const tab = this.data.comparePlanTab;
    // 🐛 根因修复：永久有效套餐没有真实到期日，同/低档 Tab 下点击不应真的
    // 发起一笔"续费"订单——见 computeRedundantRenewFlag 注释
    if (this.data.isRedundantRenewTab) {
      wx.showToast({ title: '您的机构已享永久版权益，无需续费', icon: 'none', duration: 2500 });
      return;
    }
    if (tab === 'add_on') {
      this.onSubscribeAdvancedFeature('ADD_ON_STORE', this.data.addOnQuantity);
      return;
    }
    if (tab === 'enterprise') {
      this.onSubscribeAdvancedFeature('FLAGSHIP_YEARLY');
      return;
    }
    this.onSubscribeAdvancedFeature('PRO_YEARLY');
  },

  onClosePaymentPendingModal() {
    this.setData({ showPaymentPendingModal: false });
  },

  // 🆕 一键复制客服微信号：与"联系超级管理员"弹窗（onContactAdmin）背后是
  // 同一个真实联系方式，但语义场景不同——那个是"同级大家长权限调整需要超管
  // 协助"，这里是"支付/套餐咨询找平台客服"，文案对不上号，不能直接复用同一个
  // 弹窗标题，改成一次性 Toast 反馈的一键复制，更贴合"一键复制客服微信"这个
  // 具体交互诉求
  onCopyPlatformSupportWechat() {
    const wechat = this.data.superAdminContactWechat;
    if (!wechat) return;
    wx.setClipboardData({
      data: wechat,
      success: () => wx.showToast({ title: `已复制客服微信号：${wechat}，请在微信添加好友咨询`, icon: 'none', duration: 3000 })
    });
  },

  // 🍎 iOS 端付费 Tab 底部按钮：文案已改为"使用兑换码续费/升级"（见
  // computeIOSPlanActionLabels），点击不拉起任何支付，直接展开"授权码/兑换
  // 卡号"折叠区并把光标聚焦到输入框上——与文案承诺的动作保持一致，不能文案
  // 说"用兑换码"、点击却只是弹个提示需要用户自己再去找输入框。
  // 🐛 focus 重触发：input 的 focus 属性是"设为 true 时触发一次聚焦"，若上
  // 一次操作已经把它置为 true，本次再设 true 不会产生变化、无法重新聚焦
  // （小程序只在值真正变化时才触发副作用）。先显式置 false、下一个渲染周期
  // 再置 true，确保每次点击都能重新聚焦，即使折叠区本来就是展开状态
  onGuideToRedeemSection() {
    this.setData({ showRedeemSection: true, redeemInputFocus: false });
    wx.nextTick(() => {
      this.setData({ redeemInputFocus: true });
    });
  },

  // 🌟 在线订购：接入 wxPayCore 支付基础设施（APIv3 + Mock 开关，详见
  // cloudfunctions/wxPayCore 头部注释）。
  // 完整流程：createSubscriptionOrder 云函数算价/写业务台账 → 转发 wxPayCore
  // 统一下单 → payForOrder() 拉起支付（真实模式 wx.requestPayment / Mock 模式
  // 模拟支付确认弹窗，见 utils/wxPayCore.ts）→ wxPayCore 订单转 PAID 后自动
  // 回调 createSubscriptionOrder 更新 tenant_subscriptions 与 tenants 集合
  // （100% 自动无感，无需用户手动输入任何授权码）→ 前端清除权限缓存并刷新
  // 套餐展示状态。
  // 授权码/卡号输入框保留为备用/赠送激活入口（见上方 onRedeemActivationCode）。
  //
  // planKey：'PRO_YEARLY' / 'FLAGSHIP_YEARLY' / 'ADD_ON_STORE'，与
  // createSubscriptionOrder 云函数 PLAN_CONFIG / ADD_ON_STORE_CONFIG 一一对应；
  // quantity 仅 ADD_ON_STORE 生效（购买的扩容门店数量）
  async onSubscribeAdvancedFeature(planKey: 'PRO_YEARLY' | 'FLAGSHIP_YEARLY' | 'ADD_ON_STORE', quantity?: number) {
    if (this.data.subscriptionLoading) return;
    this.setData({ subscriptionLoading: true });
    wx.showLoading({ title: '正在生成订单...', mask: true });

    try {
      // Step 1: 调用云函数统一下单（内部已转发 wxPayCore，见 createSubscriptionOrder
      // 文件头注释），获取支付参数——mockMode 时是 Mock 拉起参数，真实模式时是
      // 已用商户私钥签好的真实 paySign，业务侧完全无感
      const orderRes = await callFunctionWithTimeout({
        name: 'createSubscriptionOrder',
        data: planKey === 'ADD_ON_STORE'
          ? { planType: planKey, quantity: quantity || 1 }
          : { planType: planKey }
      });
      const orderResult = orderRes.result as CreateOrderResponse;
      wx.hideLoading();

      if (!orderResult || !orderResult.success || !orderResult.payment) {
        // 🆕 微信支付未配置时改用弹窗承接（见 showPaymentPendingModal），不再是
        // 一晃而过的 Toast——弹窗里同时给了"授权码兑换"（就在这同一个半屏卡片
        // 下方，关掉弹窗即可看到）与"一键复制客服微信"两条出路，其余错误仍走
        // 原有的 Toast 原文展示。paymentNotConfigured 由 wxPayCore 显式打标
        // （见 wxPayCore/index.js handleCreateOrder），不再靠猜错误文案关键词
        if (orderResult?.paymentNotConfigured) {
          this.setData({ showPaymentPendingModal: true });
        } else {
          wx.showToast({ title: (orderResult && orderResult.error) || '生成订单失败，请重试', icon: 'none', duration: 3000 });
        }
        return;
      }

      // Step 2: 拉起支付——真实模式走 wx.requestPayment，Mock 模式走模拟支付
      // 确认弹窗，两条路径由 payForOrder 内部依据 orderResult.mockMode 分流
      // （见 utils/wxPayCore.ts），本页不需要关心当前处于哪种模式
      const outcome = await payForOrder(orderResult);
      if (!outcome.ok) {
        if (!outcome.cancelled) {
          console.error('[onSubscribeAdvancedFeature] 支付失败:', outcome.message);
          wx.showToast({ title: outcome.message || '支付失败，请重试', icon: 'none' });
        } else {
          wx.showToast({ title: outcome.message || '已取消支付', icon: 'none' });
        }
        return;
      }

      // Step 3: 支付成功 —— 清除权限缓存，刷新套餐展示
      // wxPayCore 在订单转为 PAID 后已通过 notifyFn 回调 createSubscriptionOrder
      // 自动更新 tenant_subscriptions，clearTenantPermissionCache() 清除 60s
      // 内存缓存，fetchSubscriptionInfo() 强制重新从云端读取最新状态，两步合用
      // 保证前端立即看到解锁结果
      clearTenantPermissionCache();
      wx.showLoading({ title: '正在激活...', mask: true });
      try {
        await this.fetchSubscriptionInfo();
      } finally {
        wx.hideLoading();
      }

      // 🐛 根因修复：此前按 SKU 拼出的完整权益说明长达二三十字，远超微信原生
      // Toast 单行约 7 字、最多两行的默认宽度，真机上会截断成"激活成功！已为
      // 您开通专..."看不全。精简为短促的动作反馈，完整权益本就在套餐对比卡片
      // 里列着，Toast 不需要重复一遍
      const successTitleMap: Record<string, string> = {
        PRO_YEARLY: '激活成功',
        FLAGSHIP_YEARLY: '激活成功',
        ADD_ON_STORE: `购买成功 +${quantity || 1}家`
      };
      wx.showToast({
        title: successTitleMap[planKey] || '激活成功',
        icon: 'success',
        duration: 2000
      });
    } catch (err: any) {
      wx.hideLoading();
      console.error('[onSubscribeAdvancedFeature] 异常:', err);
      wx.showToast({ title: err?.errMsg || '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ subscriptionLoading: false });
    }
  }
};
