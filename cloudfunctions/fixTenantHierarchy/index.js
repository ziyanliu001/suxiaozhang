// 云函数：fixTenantHierarchy
// 一次性数据迁移/清洗：修正历史上把"厦门海沧三泓愿"误建成独立一级机构、把
// "嵩屿街道敬老中心助餐点"误挂在雨花斋总部机构下的归属错误，并回填受影响
// 机构的 tenants.currentStoreCount 配额计数器。
//
// 🛡️ 安全设计（这是一次不可逆的数据迁移，务必先 dryRun 再 apply）：
// - 仅 platform_admin 可调用。
// - 默认 dryRun（event.apply 不为 true 时），只读、不写库，返回"计划要做什么"的
//   报告；显式传 apply:true 才真正落库，报告结构与 dryRun 完全一致，便于对照。
// - 幂等：可安全重复执行——已经修正过的记录第二次运行会被识别为 already_correct，
//   不会重复移动、也不会把 currentStoreCount 算错。
// - 每个子任务独立 try/catch，单个子任务失败不影响其余子任务继续执行，最终返回
//   一份完整报告（found/changed/skipped/error 四态）供人工核对，不中途抛异常
//   导致后续任务完全不执行。
//
// 🏛️ 业务背景（与 platform-admin 后台/checkTenantPermission 同一套多租户模型）：
// - 雨花公益食堂专区：机构 = yuhuazhai_national（雨花斋·全国总览机构），旗下门店
//   包括"厦门海沧三泓愿""漳州白礁保生雨花斋""测试1"等，门店 orgType 均为 'yuhuazhai'。
// - 社区长者食堂专区：机构 = songyu_elderly_care（本次迁移新建/确保存在），旗下门店
//   "嵩屿街道敬老中心助餐点"，orgType 为 'elderly_canteen'。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const YUHUA_TENANT_ID = 'yuhuazhai_national';
const SONGYU_TENANT_ID = 'songyu_elderly_care';
const SONGYU_TENANT_NAME = '嵩屿街道敬老助餐机构';

const SANQUANYUAN_STORE_NAME = '厦门海沧三泓愿';
const SONGYU_STORE_NAME = '嵩屿街道敬老中心助餐点';

// 🏛️ 「方案一：按机构维度统一授权与门店配额管理」——与 checkTenantPermission/
// createStore/activateTenantSubscription/manageTenantSubscription/processRoleAudit
// 五处完全同一份拷贝（本仓库一贯做法：各云函数独立部署，没有跨函数共享模块机制）
const PLAN_STORE_LIMITS = { basic: 2, pro: 10, enterprise: 30 };

// 📋 仅核对、不修改：厦门海沧三泓愿/漳州白礁保生雨花斋/测试1 三家门店理应全部归属
// 雨花斋总部机构——本次任务只明确要求修正"厦门海沧三泓愿"，另外两家只做一致性
// 核对并如实报告，不在没有明确指令的情况下擅自改动它们的数据
const YUHUA_STORE_NAMES_TO_VERIFY = ['厦门海沧三泓愿', '漳州白礁保生雨花斋', '测试1'];

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

async function requirePlatformAdmin(OPENID) {
  if (!OPENID) return false;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return !!(roleRes.data && roleRes.data.length > 0 && roleRes.data[0].role === 'platform_admin');
}

// 🛡️ 机构名字段在本仓库存在两种历史写法：manageTenantSubscription.createTenant
// 写 `name`，独立的 createTenant 云函数（自助创建新组织）写 `tenantName`——两个
// 字段都要查一遍，避免漏找到用另一条路径建出来的同名机构
async function findTenantsByName(name) {
  const [byName, byTenantName] = await Promise.all([
    db.collection('tenants').where({ name }).get().catch(() => ({ data: [] })),
    db.collection('tenants').where({ tenantName: name }).get().catch(() => ({ data: [] }))
  ]);
  const seen = new Set();
  const merged = [];
  [...(byName.data || []), ...(byTenantName.data || [])].forEach((t) => {
    if (!seen.has(t._id)) { seen.add(t._id); merged.push(t); }
  });
  return merged;
}

async function findStoresByName(storeName) {
  const res = await db.collection('stores').where({ storeName }).get().catch(() => ({ data: [] }));
  return res.data || [];
}

async function recalcStoreCount(tenantId, apply) {
  const countRes = await db.collection('stores').where({ tenantId }).count();
  if (apply) {
    await db.collection('tenants').doc(tenantId).update({ data: { currentStoreCount: countRes.total } }).catch((err) => {
      console.warn('[fixTenantHierarchy] currentStoreCount 回填失败:', tenantId, err);
    });
  }
  return countRes.total;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const isAdmin = await requirePlatformAdmin(OPENID);
  if (!isAdmin) {
    return { success: false, error: '无权限：仅平台管理员可执行数据迁移' };
  }

  const apply = event && event.apply === true;
  const steps = [];
  const touchedTenantIds = new Set([YUHUA_TENANT_ID, SONGYU_TENANT_ID]);

  try {
    // ── 步骤 1：厦门海沧三泓愿 —— 停用误建的一级机构，确保门店归属雨花斋总部 ──
    try {
      const misplacedTenants = (await findTenantsByName(SANQUANYUAN_STORE_NAME))
        .filter((t) => t._id !== YUHUA_TENANT_ID);

      const tenantActions = [];
      for (const t of misplacedTenants) {
        if (t.status === 'suspended' && t.mergedIntoTenantId === YUHUA_TENANT_ID) {
          tenantActions.push({ tenantId: t._id, action: 'already_suspended' });
          continue;
        }
        if (apply) {
          await db.collection('tenants').doc(t._id).update({
            data: {
              // 🛡️ 复用 tenants.status 既有枚举值（trial/active/suspended/expired）
              // 而不是新造一个全站没有任何判断逻辑会识别的状态值——suspended 已经能
              // 让 createStore/processRoleAudit 的机构状态校验正确拦下"误建机构底下
              // 继续建店"这类后续操作，同时保留 mergedIntoTenantId 留痕说明原因
              status: 'suspended',
              mergedIntoTenantId: YUHUA_TENANT_ID,
              mergedAt: db.serverDate(),
              mergedReason: '一次性数据迁移修正：厦门海沧三泓愿应为雨花斋总部机构旗下门店，不是独立一级机构',
              mergedBy: OPENID
            }
          });
        }
        tenantActions.push({ tenantId: t._id, action: apply ? 'suspended' : 'will_suspend' });
        touchedTenantIds.add(t._id);
      }

      const stores = await findStoresByName(SANQUANYUAN_STORE_NAME);
      const storeActions = [];
      if (stores.length === 0) {
        storeActions.push({ action: 'not_found', note: '未找到门店文档「厦门海沧三泓愿」，需要人工核实是否要新建' });
      } else {
        for (const s of stores) {
          const needsTenantFix = s.tenantId !== YUHUA_TENANT_ID;
          const needsOrgTypeFix = s.orgType !== 'yuhuazhai';
          if (!needsTenantFix && !needsOrgTypeFix) {
            storeActions.push({ storeId: s._id, action: 'already_correct' });
            continue;
          }
          if (apply) {
            await db.collection('stores').doc(s._id).update({
              data: {
                tenantId: YUHUA_TENANT_ID,
                orgType: 'yuhuazhai',
                operationLog: _.push({
                  action: 'fix_tenant_hierarchy',
                  operatorId: OPENID,
                  operateTime: db.serverDate(),
                  before: { tenantId: s.tenantId || '', orgType: s.orgType || '' },
                  after: { tenantId: YUHUA_TENANT_ID, orgType: 'yuhuazhai' }
                })
              }
            });
          }
          if (s.tenantId) touchedTenantIds.add(s.tenantId);
          storeActions.push({
            storeId: s._id,
            action: apply ? 'fixed' : 'will_fix',
            before: { tenantId: s.tenantId || '', orgType: s.orgType || '' },
            after: { tenantId: YUHUA_TENANT_ID, orgType: 'yuhuazhai' }
          });
        }
      }

      steps.push({ step: 'sanquanyuan', success: true, tenantActions, storeActions });
    } catch (err) {
      steps.push({ step: 'sanquanyuan', success: false, error: err.message || String(err) });
    }

    // ── 步骤 2：嵩屿街道敬老中心助餐点 —— 确保长者食堂机构存在，门店移出雨花斋总部 ──
    try {
      const songyuTenantRes = await db.collection('tenants').doc(SONGYU_TENANT_ID).get().catch(() => null);
      let tenantAction;
      if (songyuTenantRes && songyuTenantRes.data) {
        tenantAction = { tenantId: SONGYU_TENANT_ID, action: 'already_exists' };
      } else {
        if (apply) {
          await db.collection('tenants').doc(SONGYU_TENANT_ID).set({
            data: {
              name: SONGYU_TENANT_NAME,
              status: 'active',
              createdAt: db.serverDate(),
              createdBy: OPENID
            }
          });
          // 顺带初始化一条 basic 档订阅记录（与 manageTenantSubscription 里
          // ensureNationalTenant 同一套自愈口径），确保 checkTenantPermission/
          // createStore 的配额校验对这家新机构从第一天起就有明确的口径可读，
          // 不会因为查不到订阅记录而各自走"降级默认值"分支
          const todayStr = new Date().toISOString().slice(0, 10);
          await db.collection('tenant_subscriptions').add({
            data: {
              tenantId: SONGYU_TENANT_ID,
              planType: 'basic',
              serviceStartDate: todayStr,
              serviceExpireDate: '2099-12-31',
              cloudQuota: { storeLimit: PLAN_STORE_LIMITS.basic },
              status: 'active',
              lastRenewedAt: db.serverDate(),
              renewalHistory: [{
                operatorId: OPENID,
                operateTime: db.serverDate(),
                fromExpireDate: null,
                toExpireDate: '2099-12-31',
                reason: '一次性数据迁移：新建社区长者食堂机构（fixTenantHierarchy）'
              }]
            }
          }).catch((err) => {
            if (!isCollectionNotExistError(err)) throw err;
          });
        }
        tenantAction = { tenantId: SONGYU_TENANT_ID, action: apply ? 'created' : 'will_create' };
      }

      const stores = await findStoresByName(SONGYU_STORE_NAME);
      const storeActions = [];
      if (stores.length === 0) {
        storeActions.push({ action: 'not_found', note: '未找到门店文档「嵩屿街道敬老中心助餐点」，需要人工核实是否要新建' });
      } else {
        for (const s of stores) {
          const needsTenantFix = s.tenantId !== SONGYU_TENANT_ID;
          const needsOrgTypeFix = s.orgType !== 'elderly_canteen';
          if (!needsTenantFix && !needsOrgTypeFix) {
            storeActions.push({ storeId: s._id, action: 'already_correct' });
            continue;
          }
          if (apply) {
            await db.collection('stores').doc(s._id).update({
              data: {
                tenantId: SONGYU_TENANT_ID,
                orgType: 'elderly_canteen',
                operationLog: _.push({
                  action: 'fix_tenant_hierarchy',
                  operatorId: OPENID,
                  operateTime: db.serverDate(),
                  before: { tenantId: s.tenantId || '', orgType: s.orgType || '' },
                  after: { tenantId: SONGYU_TENANT_ID, orgType: 'elderly_canteen' }
                })
              }
            });
          }
          if (s.tenantId) touchedTenantIds.add(s.tenantId);
          storeActions.push({
            storeId: s._id,
            action: apply ? 'fixed' : 'will_fix',
            before: { tenantId: s.tenantId || '', orgType: s.orgType || '' },
            after: { tenantId: SONGYU_TENANT_ID, orgType: 'elderly_canteen' }
          });
        }
      }

      steps.push({ step: 'songyu', success: true, tenantAction, storeActions });
    } catch (err) {
      steps.push({ step: 'songyu', success: false, error: err.message || String(err) });
    }

    // ── 步骤 3：只读核对——雨花斋旗下另外两家门店（本次不修改，仅报告是否一致） ──
    try {
      const verifyResults = [];
      for (const name of YUHUA_STORE_NAMES_TO_VERIFY) {
        if (name === SANQUANYUAN_STORE_NAME) continue; // 已在步骤 1 处理
        const stores = await findStoresByName(name);
        if (stores.length === 0) {
          verifyResults.push({ storeName: name, status: 'not_found' });
          continue;
        }
        stores.forEach((s) => {
          const ok = s.tenantId === YUHUA_TENANT_ID && s.orgType === 'yuhuazhai';
          verifyResults.push({
            storeName: name,
            storeId: s._id,
            status: ok ? 'ok' : 'mismatch_needs_manual_review',
            tenantId: s.tenantId || '',
            orgType: s.orgType || ''
          });
        });
      }
      steps.push({ step: 'verify_other_yuhua_stores', success: true, verifyResults });
    } catch (err) {
      steps.push({ step: 'verify_other_yuhua_stores', success: false, error: err.message || String(err) });
    }

    // ── 步骤 4：配额回填——对本次涉及的所有机构重新计数 currentStoreCount ──
    try {
      const quotaResults = [];
      for (const tenantId of touchedTenantIds) {
        const count = await recalcStoreCount(tenantId, apply);
        quotaResults.push({ tenantId, currentStoreCount: count, applied: apply });
      }
      steps.push({ step: 'recalc_store_count', success: true, quotaResults });
    } catch (err) {
      steps.push({ step: 'recalc_store_count', success: false, error: err.message || String(err) });
    }

    return {
      success: true,
      apply,
      message: apply
        ? '数据迁移已执行完成，请核对下方 steps 明细'
        : '这是 dryRun 预览结果，尚未写入任何数据。确认无误后传 { apply: true } 重新调用以真正执行',
      steps
    };
  } catch (err) {
    console.error('[fixTenantHierarchy] 异常:', err);
    return { success: false, error: err.message || '数据迁移执行异常', apply, steps };
  }
};
