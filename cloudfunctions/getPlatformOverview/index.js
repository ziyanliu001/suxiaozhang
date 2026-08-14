// 云函数：getPlatformOverview
// SaaS 平台管理员（开发者/运维方）专用：查看系统运行状态与云资源消耗概览。
//
// 🛡️ 合规防腐边界：本函数只做 count() 计数聚合，绝不 get() 读取 report_logs 的
// 任何具体记录内容（余额/收入/支出/捐赠人姓名等），从数据访问层面杜绝平台管理员
// 借运维之便窥探公益机构内部敏感财务明细。
//
// 🐛 根因修复：tenants / tenant_subscriptions 是"多租户改造"引入的新集合，全新
// 环境（或从未调用过 createTenant / backfillTenantId 的环境）里这两个集合可能
// 从未被写入过一条数据——云开发对"从未写过的集合"直接 count()/get() 会抛
// -502005 Db or Table not exist，而不是静默返回 0/空数组。此前本函数用
// Promise.all 一次性发起全部统计查询，其中任意一条撞上这个错误，整个 Promise.all
// 立即 reject，外层 catch 把裸的 `err.message`（形如
// "collection.count:fail -502005 Db or Table not exist: tenants..."）原样透传
// 给客户端，客户端又原样 wx.showToast 出来——SaaS 平台管理页因此在全新环境下
// 直接报错，且报的是完全不友好的底层数据库错误字符串。
// 现在每一条统计查询都各自独立 try/catch，命中"集合不存在"时静默按 0/空数组
// 处理（语义上等价于"这张集合确实还没有任何数据"），不再让一条查询的失败拖垮
// 整个概览接口；任何非该错误类型的异常才会真正冒泡到外层，且外层也只返回
// 统一的友好文案，不再把 err.message 原样吐给前端。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String((err && (err.errMsg || err.message)) || '')));
}

// 🛡️ 统计类查询统一走这个包装：集合不存在时按"0 条"处理，不让整个概览接口
// 因为某一张还没有任何数据的新集合而彻底失败
async function safeCount(buildQuery) {
  try {
    const res = await buildQuery().count();
    return res.total || 0;
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    return 0;
  }
}

// 🛡️ 明细类查询同一套自愈口径：集合不存在时按"空列表"处理
async function safeList(buildQuery) {
  try {
    const res = await buildQuery().get();
    return res.data || [];
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    return [];
  }
}

async function requirePlatformAdmin() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return false;

  const roleRes = await db.collection('user_roles')
    .where({ _openid: OPENID })
    .limit(1)
    .get();

  return !!(roleRes.data && roleRes.data.length > 0 && roleRes.data[0].role === 'platform_admin');
}

exports.main = async () => {
  const allowed = await requirePlatformAdmin();
  if (!allowed) {
    return { success: false, error: '无权限：仅平台管理员（开发者）可查看平台运行概览' };
  }

  try {
    const [
      tenantTotal,
      activeSubTotal,
      expiredSubTotal,
      storeTotal,
      reportLogTotal,
      volunteerTotal,
      unusedCodeTotal
    ] = await Promise.all([
      safeCount(() => db.collection('tenants')),
      safeCount(() => db.collection('tenant_subscriptions').where({ status: 'active' })),
      safeCount(() => db.collection('tenant_subscriptions').where({ status: _.in(['expired', 'suspended']) })),
      safeCount(() => db.collection('stores')),
      // 仅统计记录条数（云资源/DB 读写用量参考），不读取具体记录内容
      safeCount(() => db.collection('report_logs')),
      safeCount(() => db.collection('user_roles')),
      // 🌸 待核销授权码数量：授权码管理 Tab 顶部 KPI 卡片用，见 platform-admin.wxml
      safeCount(() => db.collection('tenant_activation_codes').where({ status: 'UNUSED' }))
    ]);

    // 服务即将到期（7 天内）的租户清单：仅暴露 tenantId + 到期日，不涉及门店业务数据
    const soonExpireDate = new Date();
    soonExpireDate.setDate(soonExpireDate.getDate() + 7);
    const soonExpireDateStr = soonExpireDate.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    const soonExpiringTenants = await safeList(() =>
      db.collection('tenant_subscriptions')
        .where({
          status: 'active',
          serviceExpireDate: _.and(_.gte(todayStr), _.lte(soonExpireDateStr))
        })
        .field({ tenantId: true, serviceExpireDate: true, planType: true })
    );

    return {
      success: true,
      totals: {
        tenantCount: tenantTotal,
        activeSubscriptionCount: activeSubTotal,
        expiredOrSuspendedSubscriptionCount: expiredSubTotal,
        storeCount: storeTotal,
        reportLogCount: reportLogTotal,
        userAccountCount: volunteerTotal,
        unusedActivationCodeCount: unusedCodeTotal
      },
      soonExpiringTenants
    };
  } catch (err) {
    console.error('[getPlatformOverview] 异常:', err);
    // 🛡️ 严禁把裸的数据库报错（含具体集合名/错误码）暴露给平台管理员控制台——
    // 上面每一条查询已经各自做了"集合不存在"的自愈，这里能走到说明是真正的
    // 未知异常，只回一句统一的友好文案，详细堆栈已经在上面 console.error 里
    return { success: false, error: '平台概览加载失败，请下拉重试' };
  }
};
