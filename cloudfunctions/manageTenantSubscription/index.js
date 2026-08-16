// 云函数：manageTenantSubscription
// SaaS 平台管理员（开发者/运维方）专用：管理租户（机构）生命周期与服务订阅/云资源配额。
//
// 🛡️ 合规防腐边界：本函数只读写 tenants / tenant_subscriptions 两个集合，
// 全程不触碰 report_logs / donationItems 等任何门店业务与财务数据，
// 确保"商业运营方（platform_admin）"与"公益机构内部数据"彻底隔离。
// 例外：getTenantDetail（只读）、removeStoreFromTenant / setStoreStatus /
// unbindStorePatriarch（只写 tenantId / status / patriarch 相关字段 +
// 对应 user_roles 记录的角色归属）会碰 stores（及 unbindStorePatriarch
// 额外碰 user_roles）集合——门店名/状态/归属机构/家长绑定都是基础档案与
// 角色归属，不属于上述"业务财务数据"范畴，且这几个 action 都只服务于
// 【机构管理】页面本身，不对外暴露任何账目/收支读写能力

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const TENANT_SUB_COLLECTION = 'tenant_subscriptions';

// 🌐 默认全国机构：早期账号（setupSuperAdmin 引导创建的 super_admin、或
// tenantId 缺失的历史门店）统一挂靠的兜底机构，与 createStore/updateStoreName/
// updateStoreStatus/processRoleAudit 四个云函数里各自的 ensureNationalTenant()
// 完全同一份 ID/字段约定（各云函数独立部署，没有跨函数共享模块机制，只能保持
// 常量/逻辑一致，见这几个文件里的同名函数）。
//
// 🐛 根因修复："机构列表看不到测试1"的真正原因：门店「测试1」的 tenantId
// 从一开始就正确指向 'yuhuazhai_national'，不是脏数据/未关联——但这个默认
// 机构的 tenants 文档本身从未被创建过。上述四个云函数各自的 ensureNationalTenant()
// 只在"有人新建门店/改门店名/改门店状态/走角色审核流程"时才会被触发去自愈
// 建这条记录，本机构自始至终没人调用过这几个操作，tenants 集合里自然就没有
// 这一条，listTenants 查出来的自然只有手动创建过的"厦门海沧三泓愿"。
// 这里补上同一份自愈逻辑：listTenants 每次查询前先确保这条兜底机构记录存在，
// 不再依赖"凑巧有人触发过其他云函数"这个偶然条件
const DEFAULT_TENANT_ID = 'yuhuazhai_national';
const DEFAULT_TENANT_STORE_LIMIT = 999;

// 🏛️ 「方案一：按机构维度统一授权与门店配额管理」——与 checkTenantPermission/
// createStore/activateTenantSubscription 三处完全同一份拷贝（本仓库一贯做法：
// 各云函数独立部署，没有跨函数共享模块机制）。basic 固定为该值；pro/enterprise
// 是"缺省建议值"——平台管理员在 createOrRenewSubscription 弹窗里仍可为单个
// 机构手动调高（如购买扩容包），未显式传入时才回落到这里的默认值
const PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 };

// 🏛️ 与 cloudfunctions/processRoleAudit/index.js 的 RELEASE_ROLE_TO_PRIMARY /
// RELEASE_ROLE_RANK 同一份口径（各云函数独立部署，没有跨函数共享模块机制，
// 只能保持常量一致）——unbindStorePatriarch 需要按同样的"多角色兼任感知"
// 逻辑剥离 STORE_PATRIARCH：只摘掉这一档身份，若调用者还持有其他身份（如
// 邀请码核销同时授予的 finance），平滑降级到剩余身份里权限最高的一档，
// 而不是像 superAdminForceUnbind 那样无条件把整条记录清空成 volunteer
const RELEASE_ROLE_TO_PRIMARY = {
  STORE_PATRIARCH: 'store_patriarch',
  STORE_MANAGER: 'store_manager',
  FINANCE: 'finance',
  VOLUNTEER: 'volunteer',
  FAMILY: 'volunteer'
};
const RELEASE_ROLE_RANK = {
  FAMILY: 0,
  VOLUNTEER: 1,
  FINANCE: 2,
  STORE_MANAGER: 3,
  STORE_PATRIARCH: 3
};

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
    }).catch(() => {});
  }

  let subRes = null;
  try {
    subRes = await db.collection(TENANT_SUB_COLLECTION)
      .where({ tenantId: DEFAULT_TENANT_ID })
      .limit(1)
      .get();
  } catch (err) {
    console.warn('[manageTenantSubscription] tenant_subscriptions 查询失败（集合可能不存在），按无订阅记录处理:', err);
  }
  if (!subRes || !subRes.data || subRes.data.length === 0) {
    await db.collection(TENANT_SUB_COLLECTION).add({
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
    }).catch(() => {});
  }
}

// 🛡️ -502005 DATABASE_COLLECTION_NOT_EXIST：tenant_subscriptions 可能在这套
// 环境里还没被写入过（全新机构，从未开通过订阅），与 submitFeedback/
// manageStoreInviteCode/manageNotice 同一套自愈口径——只读查询命中时直接降级
// 为"暂无订阅记录"，写路径（createOrRenewSubscription 的新建分支）命中时
// 显式建表再重试一次，任何一路都不能把裸的数据库报错抛给平台管理员控制台
function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

// 只读查询自愈：命中集合不存在时返回 null（语义等价于"这家机构还没有任何订阅
// 记录"），其余错误原样抛出给调用方处理
async function safeGetLatestSubscription(tenantId) {
  try {
    const subRes = await db.collection(TENANT_SUB_COLLECTION)
      .where({ tenantId })
      .orderBy('lastRenewedAt', 'desc')
      .limit(1)
      .get();
    return (subRes.data && subRes.data[0]) || null;
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    return null;
  }
}

async function requirePlatformAdmin() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { allowed: false, openid: '' };

  const roleRes = await db.collection('user_roles')
    .where({ _openid: OPENID })
    .limit(1)
    .get();

  const isPlatformAdmin = !!(roleRes.data && roleRes.data.length > 0 && roleRes.data[0].role === 'platform_admin');
  return { allowed: isPlatformAdmin, openid: OPENID };
}

exports.main = async (event) => {
  const { allowed, openid } = await requirePlatformAdmin();
  if (!allowed) {
    return { success: false, error: '无权限：仅平台管理员（开发者）可执行租户管理操作' };
  }

  const { action } = event;

  try {
    switch (action) {
      case 'createTenant': {
        const { name, contactName, contactPhone } = event;
        if (!name || !String(name).trim()) {
          return { success: false, error: '机构名称不能为空' };
        }

        const tenantData = {
          name: String(name).trim(),
          contactName: contactName || '',
          contactPhone: contactPhone || '',
          status: 'trial',
          createdAt: db.serverDate(),
          createdBy: openid
        };

        let tenantRes;
        try {
          tenantRes = await db.collection('tenants').add({ data: tenantData });
        } catch (err) {
          // 🐛 根因修复：全新环境下 tenants 集合可能从未被写入过任何一条数据，
          // .add() 通常会在集合不存在时自动建表，这里兜底：万一这次环境没有
          // 自动建表，显式建一次再重试一次写入——不能让平台管理员创建的
          // 第一家机构直接失败
          if (!isCollectionNotExistError(err)) throw err;
          await db.createCollection('tenants').catch(() => {});
          tenantRes = await db.collection('tenants').add({ data: tenantData });
        }

        return { success: true, tenantId: tenantRes._id };
      }

      case 'listTenants': {
        // 📄 分页：机构数量会随平台增长持续变多，不能一次性拉全量——skip 由
        // 客户端"触底加载更多"累加传入，多查一条判断 hasMore，不额外发 count()
        const PAGE_SIZE = 20;
        const skip = Math.max(parseInt(event.skip, 10) || 0, 0);

        // 🐛 根因修复：见文件头 ensureNationalTenant 处注释——默认全国机构
        // 只有在有人碰过 createStore/updateStoreName/updateStoreStatus/
        // processRoleAudit 里的同款自愈逻辑时才会被动创建，凑不巧就会一直
        // 缺失，导致挂在它下面的门店在这份机构列表里怎么也找不到对应的机构行。
        // 只在首页（skip===0，即"刷新/首次进页"）触发一次自愈检查，翻页加载
        // 更多时不重复做这次幂等但仍有一次读开销的检查
        if (skip === 0) {
          await ensureNationalTenant();
        }

        // 🐛 根因修复：全新环境（从未创建过任何机构）里 tenants 集合可能从未
        // 存在过，直接 .get() 会抛 -502005。"一家机构都还没有"是完全正常、
        // 该展示空状态的场景，不是错误——这里单独 try/catch 命中时直接返回
        // 空列表 + success:true，不让它冒泡到外层被判定成一次失败请求（那样
        // 客户端会弹一条不必要的错误提示，而不是安安静静展示空状态）
        let rows = [];
        try {
          const tenantsRes = await db.collection('tenants')
            .orderBy('createdAt', 'desc')
            .skip(skip)
            .limit(PAGE_SIZE + 1)
            .get();
          rows = tenantsRes.data || [];
        } catch (err) {
          if (!isCollectionNotExistError(err)) throw err;
          rows = [];
        }
        const hasMore = rows.length > PAGE_SIZE;
        const tenants = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

        // 逐一附带最新的订阅状态 + 门店数量，供平台管理员在同一览表中查看服务
        // 到期时间与规模。
        // 🐛 根因修复："机构列表看不到测试1"：本页"机构管理"列表展示的是
        // tenants（机构/租户）文档，门店（stores）是挂在某个 tenantId 下的
        // 子资源，从来不会、也不该在这个列表里单独占一行——这是设计如此，不是
        // 查询遗漏了什么过滤条件（listTenants 本身没有任何 status/isDeleted
        // 过滤，会返回全部机构）。但此前每张机构卡片完全不显示门店数量，管理员
        // 无从得知"测试1"其实已经挂在某个已显示的机构下面，容易误以为数据
        // 丢失/查询有 bug。这里补上 storeCount，与 getTenantDetail 保持同一
        // 统计口径，让列表本身就能提示"这家机构底下有几家门店"
        const withSubs = await Promise.all(tenants.map(async t => {
          const [sub, storeCountRes] = await Promise.all([
            safeGetLatestSubscription(t._id),
            db.collection('stores').where({ tenantId: t._id }).count().catch(() => ({ total: 0 }))
          ]);
          return { ...t, subscription: sub, storeCount: storeCountRes.total };
        }));

        return { success: true, tenants: withSubs, hasMore, nextSkip: skip + tenants.length };
      }

      case 'getTenantDetail': {
        const { tenantId } = event;
        if (!tenantId) return { success: false, error: '缺少 tenantId' };

        const tenantRes = await db.collection('tenants').doc(tenantId).get();
        const subscription = await safeGetLatestSubscription(tenantId);
        // 🐛 根因修复：此前只统计门店数量（storeCount），不返回具体门店本身——
        // 平台管理员想确认"某个门店到底挂在哪个机构下"时无从查起，只能凭一个
        // 数字自己猜。这里补上 storeList（门店名称/状态/城市/创建时间），不读取
        // 任何门店财务字段，与本云函数文件头"合规防腐边界：只读写 tenants /
        // tenant_subscriptions，全程不触碰 report_logs 等业务财务数据"的既有
        // 约束保持一致——stores 本身是门店的基础档案，不是财务数据
        // storeList 只取前 100 条供列表展示（这个体量的机构规模在本产品里
        // 极端罕见），storeCount 仍走独立的 count() 精确统计，两者互不影响
        const [storeCountRes, storesRes] = await Promise.all([
          db.collection('stores').where({ tenantId }).count().catch(() => ({ total: 0 })),
          db.collection('stores')
            .where({ tenantId })
            .orderBy('createdAt', 'desc')
            .limit(100)
            // 🛡️ 只投影 patriarch（家长真实姓名，供展示"是否已绑定家长"），不
            // 投影 patriarchOpenId——平台管理员不属于机构内部人员，没必要把
            // 用户 openid 这类可用于精确定位账号的标识符透传到前端，unbind
            // 动作本身只需要 storeId，openid 由服务端自己从 store 文档反查
            .field({ storeName: true, status: true, city: true, province: true, createdAt: true, patriarch: true })
            .get()
            .catch(() => ({ data: [] }))
        ]);

        return {
          success: true,
          tenant: tenantRes.data,
          subscription,
          storeCount: storeCountRes.total,
          storeList: storesRes.data
        };
      }

      // 🚪 移出机构：清空门店的 tenantId，供【机构管理 -> 查看门店】抽屉的
      // "移出机构"按钮使用。与 updateStoreStatus/updateStoreName 那套"调用者
      // 必须是本机构 super_admin"的鉴权模型不同——这是纯平台管理员操作，
      // 目的就是跨机构改动任意门店的归属，所以只鉴权 platform_admin，不做
      // "门店当前 tenantId 是否等于调用者所属机构"这层校验（这里调用者压根
      // 不属于任何机构）
      case 'removeStoreFromTenant': {
        const { storeId } = event;
        if (!storeId) return { success: false, error: '缺少 storeId 参数' };

        const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (!store) return { success: false, error: '门店不存在' };

        await db.collection('stores').doc(storeId).update({
          data: {
            tenantId: '',
            // 留痕：与 updateStoreStatus/updateStoreName 的 operationLog 同一套
            // 追加式数组约定
            operationLog: _.push({
              action: 'remove_from_tenant',
              operatorId: openid,
              operateTime: db.serverDate(),
              before: store.tenantId || '',
              after: ''
            })
          }
        });

        // 🔢 与 createStore.reserveStoreQuota 的原子自增对称：门店移出机构后
        // 归还它此前占用的配额名额，否则 currentStoreCount 会一直虚高，导致
        // 机构明明还有空余配额却被误判为"配额已满"。where 条件限定
        // currentStoreCount > 0 才自减，防止历史脏数据（如计数器从未被正确
        // 初始化过）被减成负数——0 匹配时静默跳过即可，下次 createStore 的
        // 惰性迁移路径会用 stores 集合的真实计数重新校准
        if (store.tenantId) {
          await db.collection('tenants').where({
            _id: store.tenantId,
            currentStoreCount: _.gt(0)
          }).update({
            data: { currentStoreCount: _.inc(-1) }
          }).catch((err) => console.warn('[manageTenantSubscription] currentStoreCount 归还失败:', err));
        }

        return { success: true, storeId };
      }

      // 🚪 加入机构：把一家门店（孤儿门店，或从别的机构移出后重新归属）绑定到
      // 指定机构，与 removeStoreFromTenant 对称，共同构成【机构管理 -> 查看门店】
      // 抽屉"移出/加入"两个方向的操作闭环。同样只鉴权 platform_admin，可跨机构
      // 对任意门店生效。
      //
      // 🔒 并发安全的配额占用：与 createStore.reserveStoreQuota 同一套 CAS
      // （条件自增）逻辑——目标机构 currentStoreCount 未满配额时才允许原子占用
      // 一个名额，避免平台管理员并发点击"加入机构"把目标机构的门店数挤爆配额。
      // 占用成功后再真正改写 stores.tenantId；若改写失败则归还刚占用的名额。
      case 'assignStoreToTenant': {
        const { storeId, targetTenantId } = event;
        if (!storeId || !targetTenantId) {
          return { success: false, error: '缺少 storeId / targetTenantId 参数' };
        }

        const [storeRes, targetTenantRes] = await Promise.all([
          db.collection('stores').doc(storeId).get().catch(() => null),
          db.collection('tenants').doc(targetTenantId).get().catch(() => null)
        ]);
        const store = storeRes && storeRes.data;
        const targetTenant = targetTenantRes && targetTenantRes.data;
        if (!store) return { success: false, error: '门店不存在' };
        if (!targetTenant) return { success: false, error: '目标机构不存在' };
        if (store.tenantId === targetTenantId) {
          return { success: false, error: '该门店已经归属于这家机构，无需重复操作' };
        }

        const targetSub = await safeGetLatestSubscription(targetTenantId);
        let storeLimit = PLAN_STORE_LIMITS.basic;
        if (targetSub) {
          storeLimit = (targetSub.cloudQuota && targetSub.cloudQuota.storeLimit)
            || PLAN_STORE_LIMITS[targetSub.planType]
            || PLAN_STORE_LIMITS.basic;
          if (targetSub.planType === 'basic') storeLimit = PLAN_STORE_LIMITS.basic;
        }

        // CAS 条件自增：currentStoreCount 未写入过（老机构/刚创建）时按 0 处理，
        // 与 createStore.reserveStoreQuota 步骤 2 的惰性迁移是同一个问题，这里
        // 直接内联处理（可调用方一次性场景，不额外抽 helper）
        let reserved = false;
        const casRes = await db.collection('tenants').where({
          _id: targetTenantId,
          currentStoreCount: _.lt(storeLimit)
        }).update({ data: { currentStoreCount: _.inc(1) } });
        if (casRes.stats.updated === 1) {
          reserved = true;
        } else {
          const actualCountRes = await db.collection('stores').where({ tenantId: targetTenantId }).count();
          await db.collection('tenants').where({
            _id: targetTenantId,
            currentStoreCount: _.exists(false)
          }).update({ data: { currentStoreCount: actualCountRes.total } }).catch(() => {});
          const retryRes = await db.collection('tenants').where({
            _id: targetTenantId,
            currentStoreCount: _.lt(storeLimit)
          }).update({ data: { currentStoreCount: _.inc(1) } });
          reserved = retryRes.stats.updated === 1;
        }

        if (!reserved) {
          const currentCountRes = await db.collection('tenants').doc(targetTenantId).field({ currentStoreCount: true }).get().catch(() => null);
          const currentCount = (currentCountRes && currentCountRes.data && currentCountRes.data.currentStoreCount) || storeLimit;
          return {
            success: false,
            error: `当前机构套餐门店额度已满(${currentCount}/${storeLimit})，请扩容或升级`,
            errorCode: 'STORE_LIMIT_REACHED'
          };
        }

        try {
          await db.collection('stores').doc(storeId).update({
            data: {
              tenantId: targetTenantId,
              operationLog: _.push({
                action: 'assign_to_tenant',
                operatorId: openid,
                operateTime: db.serverDate(),
                before: store.tenantId || '',
                after: targetTenantId
              })
            }
          });
        } catch (err) {
          // 🛡️ 门店没能真正改写归属，归还刚占用的配额名额
          await db.collection('tenants').doc(targetTenantId).update({
            data: { currentStoreCount: _.inc(-1) }
          }).catch(() => {});
          throw err;
        }

        // 归还门店在原机构占用的名额（若此前确实挂在某个机构下）
        if (store.tenantId) {
          await db.collection('tenants').where({
            _id: store.tenantId,
            currentStoreCount: _.gt(0)
          }).update({
            data: { currentStoreCount: _.inc(-1) }
          }).catch((err) => console.warn('[manageTenantSubscription] 原机构 currentStoreCount 归还失败:', err));
        }

        return { success: true, storeId, tenantId: targetTenantId };
      }

      // 🛑 平台管理员停用/启用门店：与 updateStoreStatus 云函数是同一份业务
      // 语义（stores.status: active/inactive，停用后 saveReport 会拒绝新记账，
      // 见 utils/dataService.ts），但调用者鉴权不同——updateStoreStatus 要求
      // 调用者是该门店所属机构自己的 super_admin，本 action 要求调用者是
      // platform_admin，可跨机构对任意门店生效，供【查看门店】抽屉使用
      case 'setStoreStatus': {
        const { storeId, status } = event;
        const validStatuses = ['active', 'inactive'];
        if (!storeId || !validStatuses.includes(status)) {
          return { success: false, error: '参数缺失或 status 非法' };
        }

        const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (!store) return { success: false, error: '门店不存在' };

        if (store.status === status) {
          return { success: true, storeId, status, message: '状态未变化' };
        }

        await db.collection('stores').doc(storeId).update({
          data: {
            status,
            lastStatusChangedBy: openid,
            lastStatusChangedAt: db.serverDate(),
            operationLog: _.push({
              action: 'status_change',
              operatorId: openid,
              operateTime: db.serverDate(),
              before: store.status || '',
              after: status
            })
          }
        });

        return { success: true, storeId, status };
      }

      // 🚪 解除家长/退出授权：平台管理员在【机构管理 -> 查看门店】抽屉里强制
      // 摘除某家门店当前绑定的家长身份，供家长失联/申请错误/机构要求更换家长
      // 等场景使用。与门店自己所属机构的 super_admin 无关（processRoleAudit
      // 的 superAdminForceUnbind 是那条路径），这里同样只鉴权 platform_admin，
      // 可跨机构对任意门店生效。
      //
      // 🛡️ 语义修正：需求原文提出把 user_roles 对应记录的 status 置为
      // "inactive"，但这个值在本项目 user_roles.status 的既有取值域里
      // （pending/approved/guest，见 checkUserRole/manageStoreInviteCode 等
      // 云函数）从未出现过，全站没有任何权限判断逻辑会去识别它——getPermissionFlags
      // 等函数只认 role 字段本身，仅仅打上 status:'inactive' 而不动 role/storeId
      // 不会真的收回这个人的家长权限，反而会造成"看起来解绑了、实际权限完全没变"
      // 的假象。这里改为复用 processRoleAudit superAdminForceUnbind /
      // releaseSelf 已经验证过的做法：把 STORE_PATRIARCH 从 roles 数组里摘掉，
      // 若调用者还兼任其他身份则平滑降级到剩余身份里最高的一档，彻底无身份
      // 才整条清空为 volunteer + 清空门店绑定——这才是"退出授权"在本系统里
      // 真正生效的写法
      case 'unbindStorePatriarch': {
        const { storeId } = event;
        if (!storeId) return { success: false, error: '缺少 storeId 参数' };

        const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (!store) return { success: false, error: '门店不存在' };

        const patriarchOpenId = store.patriarchOpenId || '';
        if (!patriarchOpenId) {
          return { success: false, error: '该门店当前未绑定家长' };
        }

        // 1. 清空门店侧的家长信息，并留痕
        await db.collection('stores').doc(storeId).update({
          data: {
            patriarch: '',
            patriarchOpenId: '',
            operationLog: _.push({
              action: 'unbind_patriarch',
              operatorId: openid,
              operateTime: db.serverDate(),
              before: store.patriarch || patriarchOpenId,
              after: ''
            })
          }
        });

        // 2. 反查该家长自己的 user_roles 记录，摘掉 STORE_PATRIARCH 身份
        //    （见文件头注释：只有确认这条记录确实还持有该身份、且绑定的正是
        //    这家门店时才动它，避免误伤已经在别处变更过身份、只是 stores 侧
        //    引用尚未同步的脏数据）
        const userRoleRes = await db.collection('user_roles').where({ _openid: patriarchOpenId }).limit(1).get();
        const userRoleDoc = userRoleRes.data && userRoleRes.data[0];

        let userRoleUpdated = false;
        if (userRoleDoc) {
          const currentRoles = Array.isArray(userRoleDoc.roles) && userRoleDoc.roles.length > 0
            ? userRoleDoc.roles
            : (userRoleDoc.role && userRoleDoc.role !== 'volunteer' ? [String(userRoleDoc.role).toUpperCase()] : []);

          if (currentRoles.includes('STORE_PATRIARCH') && userRoleDoc.storeId === storeId) {
            const remainingRoles = currentRoles.filter((r) => r !== 'STORE_PATRIARCH');

            let finalRole = 'volunteer';
            let finalStatus = 'approved';
            let finalStoreId = '';
            let finalStoreName = '';
            if (remainingRoles.length > 0) {
              const topRemaining = remainingRoles.reduce((best, r) =>
                (RELEASE_ROLE_RANK[r] || 0) > (RELEASE_ROLE_RANK[best] || 0) ? r : best, remainingRoles[0]);
              finalRole = RELEASE_ROLE_TO_PRIMARY[topRemaining] || 'volunteer';
              finalStatus = topRemaining === 'FAMILY' ? 'guest' : 'approved';
              finalStoreId = userRoleDoc.storeId || '';
              finalStoreName = userRoleDoc.storeName || '';
            }

            await db.collection('user_roles').doc(userRoleDoc._id).update({
              data: {
                role: finalRole,
                status: finalStatus,
                storeId: finalStoreId,
                storeName: finalStoreName,
                roles: remainingRoles,
                revokedAt: db.serverDate(),
                revokedBy: openid,
                forceUnbindBy: openid,
                forceUnbindAt: db.serverDate()
              }
            });
            userRoleUpdated = true;
          }
        }

        return { success: true, storeId, userRoleUpdated };
      }

      case 'updateTenantStatus': {
        const { tenantId, status, reason } = event;
        const validStatuses = ['trial', 'active', 'suspended', 'expired'];
        if (!tenantId || !validStatuses.includes(status)) {
          return { success: false, error: '参数缺失或 status 非法' };
        }
        if (!reason || !String(reason).trim()) {
          return { success: false, error: '请填写状态变更原因' };
        }

        await db.collection('tenants').doc(tenantId).update({
          data: {
            status,
            lastStatusChangeReason: String(reason).trim(),
            lastStatusChangeBy: openid,
            lastStatusChangeAt: db.serverDate()
          }
        });

        return { success: true };
      }

      case 'createOrRenewSubscription': {
        const { tenantId, planType, serviceStartDate, serviceExpireDate, cloudQuota, reason } = event;
        const validPlans = ['basic', 'pro', 'enterprise'];
        if (!tenantId || !validPlans.includes(planType) || !serviceStartDate || !serviceExpireDate) {
          return { success: false, error: '参数缺失: tenantId / planType / serviceStartDate / serviceExpireDate' };
        }
        if (!reason || !String(reason).trim()) {
          return { success: false, error: '请填写开通/续费原因，便于后续对账审计' };
        }

        const existing = await safeGetLatestSubscription(tenantId);

        // 🛡️ 服务端硬校验：basic（免费版）固定套餐门店配额，无论前端弹窗传了什么
        // storeLimit（正常 UI 已锁定为 PLAN_STORE_LIMITS.basic，但不能只靠前端锁——
        // 绕开小程序直接调用云函数、或未来别的调用方忘记锁前端，都得在这里兜底
        // 拦下来），一律强制覆盖为 basic 档配额，不信任客户端传入值。
        // pro/enterprise 未显式传入 storeLimit（或传入非正数）时，回落到该档位
        // 的默认配额——这是「方案一」任务 A 的核心诉求：门店上限跟着套餐档位
        // 自动生效，不需要平台管理员每次开单都手动填一遍
        const effectiveCloudQuota = cloudQuota || (existing && existing.cloudQuota) || {};
        const finalCloudQuota = planType === 'basic'
          ? { ...effectiveCloudQuota, storeLimit: PLAN_STORE_LIMITS.basic }
          : { ...effectiveCloudQuota, storeLimit: (effectiveCloudQuota.storeLimit > 0 ? effectiveCloudQuota.storeLimit : PLAN_STORE_LIMITS[planType]) };

        const renewalEntry = {
          operatorId: openid,
          operateTime: db.serverDate(),
          fromExpireDate: existing ? existing.serviceExpireDate : null,
          toExpireDate: serviceExpireDate,
          reason: String(reason).trim()
        };

        if (existing) {
          await db.collection(TENANT_SUB_COLLECTION).doc(existing._id).update({
            data: {
              planType,
              serviceStartDate,
              serviceExpireDate,
              cloudQuota: finalCloudQuota,
              status: 'active',
              lastRenewedAt: db.serverDate(),
              renewalHistory: _.push(renewalEntry)
            }
          });
          return { success: true, subscriptionId: existing._id };
        }

        const newSubData = {
          tenantId,
          planType,
          serviceStartDate,
          serviceExpireDate,
          cloudQuota: finalCloudQuota,
          status: 'active',
          lastRenewedAt: db.serverDate(),
          renewalHistory: [renewalEntry]
        };
        let createRes;
        try {
          createRes = await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
        } catch (err) {
          // .add() 通常会在集合不存在时自动建表，这里兜底：万一这次环境没有自动建表，
          // 显式建一次再重试一次写入，而不是让机构首次开通订阅直接失败
          if (!isCollectionNotExistError(err)) throw err;
          await db.createCollection(TENANT_SUB_COLLECTION).catch(() => {});
          createRes = await db.collection(TENANT_SUB_COLLECTION).add({ data: newSubData });
        }

        // 首次开通订阅时，机构状态从 trial 转为 active
        await db.collection('tenants').doc(tenantId).update({
          data: { status: 'active' }
        }).catch(() => {});

        return { success: true, subscriptionId: createRes._id };
      }

      // 🛑 终止订阅：误操作/退款/提前解约场景下，收回机构当前生效的付费套餐，
      // 立即降级为 basic（免费版）。
      //
      // 🛡️ 语义修正，与需求原文的三处出入：
      //   1) tenants 表没有 planLevel/plan/subscriptionStatus/expireAt 这些
      //      字段——套餐/到期日期唯一真源是 tenant_subscriptions（见文件头
      //      注释与 checkTenantPermission 文件头同一条架构说明），tenants
      //      表本身只有 status 这一个业务状态字段。这里不碰 tenants.status：
      //      "终止付费套餐"和"暂停整个机构服务"是两个独立维度——已有的
      //      updateTenantStatus/onToggleTenantStatus 才是"暂停机构"的入口，
      //      若这里顺带把 tenants.status 改成 expired，会连带触发 createStore
      //      等云函数里"机构服务已过期，无法新建门店"的拦截，把一次"降级到
      //      免费版"误变成"整个机构被封停"，两者后果完全不对等。
      //   2) 不存在 operation_logs 集合——本项目的审计留痕约定是在对应文档
      //      本身追加数组字段（tenant_subscriptions.renewalHistory /
      //      stores.operationLog，见 createOrRenewSubscription、
      //      updateStoreStatus 等既有写法），这里同样追加一条 renewalHistory
      //      记录，不新开一张全局审计表。
      //   3) tenant_subscriptions.status 字段在现有代码里从未被任何鉴权/
      //      展示逻辑读取过（checkTenantPermission/getNationalDashboard 等
      //      全部只看 planType + serviceExpireDate 判断是否降级），保持写
      //      'active'（代表"这条记录本身是当前生效记录"）不新增 'terminated'
      //      这个全站没有任何地方会识别的取值，语义收窄到 planType 变化即可
      //      让全站所有鉴权路径立即认到降级结果，不需要教会每一处调用方
      //      认识一个新状态值
      case 'terminateTenantSubscription': {
        const { tenantId, reason } = event;
        if (!tenantId) return { success: false, error: '缺少 tenantId 参数' };

        const tenantRes = await db.collection('tenants').doc(tenantId).get().catch(() => null);
        const tenant = tenantRes && tenantRes.data;
        if (!tenant) return { success: false, error: '机构不存在' };

        const existing = await safeGetLatestSubscription(tenantId);
        if (!existing) {
          return { success: false, error: '该机构当前没有生效中的订阅记录，无需终止' };
        }

        const today = new Date().toISOString().slice(0, 10);
        const isExpired = !!existing.serviceExpireDate && existing.serviceExpireDate < today;
        if (existing.planType === 'basic' || isExpired) {
          return { success: false, error: '该机构当前已是免费版或订阅已到期，无需终止' };
        }

        const prevPlanType = existing.planType;
        const terminationEntry = {
          operatorId: openid,
          operateTime: db.serverDate(),
          fromExpireDate: existing.serviceExpireDate || null,
          toExpireDate: today,
          reason: (reason && String(reason).trim()) || '平台管理员终止订阅'
        };

        await db.collection(TENANT_SUB_COLLECTION).doc(existing._id).update({
          data: {
            planType: 'basic',
            serviceExpireDate: today,
            // 与 createOrRenewSubscription 里"basic 固定套餐门店配额"同一条
            // 硬校验保持一致，终止后立即生效，不必等下次某个读路径的
            // isExpired 判断兜底收敛
            cloudQuota: { storeLimit: PLAN_STORE_LIMITS.basic },
            status: 'active',
            lastRenewedAt: db.serverDate(),
            renewalHistory: _.push(terminationEntry)
          }
        });

        const updatedTenantRes = await db.collection('tenants').doc(tenantId).get();

        return {
          success: true,
          message: '订阅已成功终止',
          tenant: updatedTenantRes.data,
          prevPlanType
        };
      }

      default:
        return { success: false, error: `不支持的 action: ${action}` };
    }
  } catch (err) {
    console.error('[manageTenantSubscription] 异常:', err);
    // 🛡️ 严禁把裸的数据库报错（如 -502005 DATABASE_COLLECTION_NOT_EXIST）暴露给
    // 平台管理员控制台——上面各分支已经各自做了自愈/降级，这里是兜底防线：万一
    // 自愈本身也失败（如建表瞬间的并发竞态），也只回一句友好提示
    if (isCollectionNotExistError(err)) {
      return { success: false, error: '系统配置维护中，请联系技术支持' };
    }
    // 🐛 根因修复：此前兜底文案是 `err.message || '租户管理操作失败'`——
    // err.message 可能是任意底层异常的原始英文/数据库措辞，不该被平台管理员
    // 控制台原样展示。统一改为固定友好文案，详细堆栈已经在上面 console.error
    return { success: false, error: '租户管理操作失败，请重试' };
  }
};
