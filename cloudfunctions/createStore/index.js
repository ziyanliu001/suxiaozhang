// 云函数：createStore
// 机构超级管理员在本机构（tenant）下新建门店，写入 stores 集合并强制打上 tenantId。
//
// 🏢 多租户配额约束：新建门店前会读取该机构最新的 tenant_subscriptions 记录，
// 按 cloudQuota.storeLimit 校验门店数量上限，超出配额直接拒绝 —— 这是
// tenant_subscriptions 这张"服务订阅表"在业务链路中真正被读取并生效的地方，
// 而不仅仅是平台管理后台里的一份静态记录。
//
// 🛡️ 修复"账号尚未关联任何机构"误拦截：早期通过 setupSuperAdmin 引导创建的
// super_admin 账号可能没有传入 tenantId，导致 caller.tenantId 为空，所有依赖
// tenantId 的操作（建店、审批新门店申请）都会被误判为"未关联机构"而拦死。
// 现在 super_admin 缺失 tenantId 时统一回退到默认机构 DEFAULT_TENANT_ID
// （雨花斋总部/全国总览机构），并把该 tenantId 自愈写回其 user_roles 记录，
// 下次调用就不会再走这条兜底分支。
//
// 🌟 新增 bindAsManager：super_admin 新建门店时可选直接把自己的 storeId/storeName
// 绑定为该新店（角色仍保留 super_admin，不做降级 —— super_admin 的权限本就
// 超集覆盖 store_manager，这里只是把"当前所在门店"指向新店，便于日常报表等
// 界面默认落在这家新店上），免去二次审批流程。
//
// 🔒 事务化写入：建店文档 + bindAsManager 回写 + 默认账目模板预装，三者用
// db.startTransaction() 包在一起（与 manageReportApproval 的既有用法一致），
// 任何一步失败都整体回滚，不会留下"店建好了但模板没装成、或角色回写漏了"的
// 半成品脏数据。
//
// 🌱 账目模板预装：给新店在 expense_item_templates 里预装一组去宗教化的默认
// 常用支出项目（daily=每日食材杂购，fixed=房租/设备专项），避免"高频账目模板"
// 功能在新店第一天是空的；不编造默认金额（defaultAmount:null，与手动添加模板
// 时的既有规则一致——具体金额因店而异，不该替用户瞎填）。
//
// 🛡️ 未加"每个 OpenID 限建 1 店"的硬上限：本机构的多店配额已经由
// tenant_subscriptions.cloudQuota.storeLimit 控管（见下方配额校验），这才是
// 本产品"一个机构可以有多家门店、由同一个 super_admin 陆续建店管理"这个模型下
// 正确的防滥用边界；按 OpenID 限 1 店会直接堵死机构建第二/第三家店的正常需求。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const TRIAL_DEFAULT_STORE_LIMIT = 3;
const DEFAULT_TENANT_ID = 'yuhuazhai_national';
const DEFAULT_TENANT_STORE_LIMIT = 999;

const DEFAULT_EXPENSE_TEMPLATES = [
  { category: 'daily', itemName: '青菜' },
  { category: 'daily', itemName: '豆腐' },
  { category: 'daily', itemName: '大米' },
  { category: 'daily', itemName: '食用油' },
  { category: 'daily', itemName: '燃气费' },
  { category: 'fixed', itemName: '店铺租金' },
  { category: 'fixed', itemName: '水电费' },
  { category: 'fixed', itemName: '设备维护' }
];

// 确保默认机构（及其订阅配额）存在，供缺失 tenantId 的 super_admin 账号兜底使用
async function ensureNationalTenant() {
  const tenantRes = await db.collection('tenants').doc(DEFAULT_TENANT_ID).get().catch(() => null);
  if (!tenantRes || !tenantRes.data) {
    await db.collection('tenants').doc(DEFAULT_TENANT_ID).set({
      data: {
        name: '雨花斋（全国总览机构）',
        status: 'active',
        createdAt: db.serverDate(),
        createdBy: 'system_auto_init'
      }
    });
  }

  // 🛡️ tenant_subscriptions 集合可能在这套环境里还没被建过（-502005 database
  // collection not exists）——查询失败一律当"没有订阅记录"处理，走下面的 add()
  // 兜底创建，而不是让整个建店流程被一张还没初始化的订阅表卡死
  let subRes = null;
  try {
    subRes = await db.collection('tenant_subscriptions')
      .where({ tenantId: DEFAULT_TENANT_ID })
      .limit(1)
      .get();
  } catch (err) {
    console.warn('[createStore] tenant_subscriptions 查询失败（集合可能不存在），按无订阅记录处理:', err);
  }
  if (!subRes || !subRes.data || subRes.data.length === 0) {
    await db.collection('tenant_subscriptions').add({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        planType: 'enterprise',
        serviceStartDate: new Date().toISOString().slice(0, 10),
        serviceExpireDate: '2099-12-31',
        cloudQuota: { storeLimit: DEFAULT_TENANT_STORE_LIMIT },
        status: 'active',
        lastRenewedAt: db.serverDate(),
        renewalHistory: [{
          operatorId: 'system_auto_init',
          operateTime: db.serverDate(),
          fromExpireDate: null,
          toExpireDate: '2099-12-31',
          reason: '默认机构自动初始化'
        }]
      }
    });
  }
}

// super_admin 缺失 tenantId 时的兜底 + 自愈回写
async function resolveCallerTenantId(caller) {
  if (caller.tenantId) return caller.tenantId;

  await ensureNationalTenant();
  await db.collection('user_roles').doc(caller._id).update({
    data: { tenantId: DEFAULT_TENANT_ID }
  }).catch(err => console.warn('[createStore] tenantId 自愈回写失败:', err));

  return DEFAULT_TENANT_ID;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { storeName, city, address, initialAnnouncement, bindAsManager } = event;

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }
  if (!storeName || !String(storeName).trim()) {
    return { success: false, error: '请填写门店名称' };
  }

  try {
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const caller = roleRes.data && roleRes.data[0];

    if (!caller || caller.role !== 'super_admin') {
      return { success: false, error: '无权限：仅本机构超级管理员可新建门店' };
    }

    const tenantId = await resolveCallerTenantId(caller);

    // 1. 校验机构状态
    const tenantRes = await db.collection('tenants').doc(tenantId).get().catch(() => null);
    const tenant = tenantRes && tenantRes.data;
    if (tenant && (tenant.status === 'suspended' || tenant.status === 'expired')) {
      return { success: false, error: `机构服务当前处于「${tenant.status}」状态，无法新建门店，请联系平台管理员续费` };
    }

    // 2. 读取最新订阅，确定门店配额
    // 🛡️ tenant_subscriptions 集合可能尚未初始化（-502005 database collection
    // not exists）或查询异常——一律降级为"无订阅记录"，回退到试用默认配额继续
    // 建店，不能因为一张订阅表还没建好就把用户的建店请求整个挡下来
    let subRes = null;
    try {
      subRes = await db.collection('tenant_subscriptions')
        .where({ tenantId })
        .orderBy('lastRenewedAt', 'desc')
        .limit(1)
        .get();
    } catch (err) {
      console.warn('[createStore] tenant_subscriptions 查询失败（集合可能不存在），降级为试用默认配额继续建店:', err);
    }
    const subscription = subRes && subRes.data && subRes.data[0];

    let storeLimit = TRIAL_DEFAULT_STORE_LIMIT;
    if (subscription) {
      if (subscription.status === 'suspended' || subscription.status === 'expired') {
        return { success: false, error: '订阅服务已暂停/过期，无法新建门店，请联系平台管理员续费' };
      }
      const todayStr = new Date().toISOString().slice(0, 10);
      if (subscription.serviceExpireDate && subscription.serviceExpireDate < todayStr) {
        return { success: false, error: '服务已过期，无法新建门店，请联系平台管理员续费' };
      }
      storeLimit = (subscription.cloudQuota && subscription.cloudQuota.storeLimit) || TRIAL_DEFAULT_STORE_LIMIT;
    }

    // 3. 校验当前门店数量是否已达配额上限
    const currentCountRes = await db.collection('stores').where({ tenantId }).count();
    if (currentCountRes.total >= storeLimit) {
      return {
        success: false,
        error: `已达当前套餐门店数量上限（${storeLimit} 家），如需新增门店请联系平台管理员升级套餐`
      };
    }

    // 4-6. 建店 + bindAsManager 回写 + 默认账目模板预装，三步一个事务，失败整体回滚
    const trimmedName = String(storeName).trim();
    const transaction = await db.startTransaction();
    let newStoreId;
    try {
      const createRes = await transaction.collection('stores').add({
        data: {
          storeName: trimmedName,
          city: city || '',
          // 🌟 address 独立于 city 存储：city 已被 getNationalDashboard 当作城市聚合维度使用，
          // 塞入完整地址会污染那个看板；initialAnnouncement 仅落库存证，公告系统本身
          // 目前是纯本机 wx.setStorageSync（见 index.ts onSaveNotice），前端建店成功后
          // 会自行套用到本机跑马灯，这里只负责持久化，不做任何下发/同步
          address: address || '',
          initialAnnouncement: initialAnnouncement || '',
          tenantId,
          status: 'active',
          createdBy: OPENID,
          createdAt: db.serverDate()
        }
      });
      newStoreId = createRes._id;

      // 可选：super_admin 直接把自己的当前门店指向新建的门店，免去"提交申请 -> 等待审批"
      // 的二次流程（角色仍保留 super_admin，不降级——见文件顶部注释）
      if (bindAsManager) {
        await transaction.collection('user_roles').doc(caller._id).update({
          data: {
            storeId: newStoreId,
            storeName: trimmedName
          }
        });
      }

      const now = db.serverDate();
      for (const tpl of DEFAULT_EXPENSE_TEMPLATES) {
        await transaction.collection('expense_item_templates').add({
          data: {
            tenantId,
            storeId: newStoreId,
            storeName: trimmedName,
            category: tpl.category,
            itemName: tpl.itemName,
            defaultAmount: null,
            createdBy: OPENID,
            createdAt: now,
            updateTime: now
          }
        });
      }

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    return {
      success: true,
      storeId: newStoreId,
      storeName: trimmedName,
      tenantId,
      remainingQuota: storeLimit - currentCountRes.total - 1
    };
  } catch (err) {
    console.error('[createStore] 异常:', err);
    return { success: false, error: err.message || '新建门店失败' };
  }
};
