// 云函数：fixLegacyStoreDataNormalization
// 一次性数据迁移/清洗：三源弘雨花斋（storeId 见 TARGET_STORE_ID）2026 年 7 月前后
// 那批真实历史流水，落库时 shopName 快照写的是多种历史曾用名（"海沧区雨花斋"
// 等），且这批记录同时缺失 storeId 字段。cloudfunctions/getSunshineLedger 与
// getReports 已经各自加了一份"孤儿记录 + 曾用名/关键词"的查询期兼容（治标，
// 每次查询都要多扫一遍），本函数负责治本：把这批历史记录的 storeId/shopName
// 直接改写归一到当前值，改完之后普通的 storeId 精确查询也能命中它们，不再
// 依赖任何一个云函数里的兼容分支。
//
// 🛡️ 安全设计（与 fixTenantHierarchy 同一套约定，这是一次不可逆的数据迁移）：
// - 可调用者：platform_admin（不限门店），或 store_patriarch 且其 user_roles
//   记录的 storeId 恰好等于本次迁移目标 TARGET_STORE_ID——大家长只能对自己
//   所在、且正好是本次硬编码迁移目标的门店生效，不能借这份权限操作别的门店
//   （本函数本身也从不接受客户端传入的 storeId，TARGET_STORE_ID 写死在代码
//   里，双重限定，不存在"大家长权限被拿去改别的门店数据"的口子）。
// - 默认 dryRun（event.apply 不为 true 时），只读、不写库，返回"计划要做什么"
//   的报告；显式传 apply:true 才真正落库。
// - 幂等：查询条件本身要求 storeId 缺失/为空，已经改好的记录第二次运行天然
//   查不到，不会被重复处理。
// - "测试1" 门店核对步骤（步骤 3）仅 platform_admin 可见——这是与本次迁移
//   目标无关的另一家门店的诊断信息（是否有真实流水等），store_patriarch
//   的权限只限定在自己门店范围内，不应该看到别的门店的运营数据，即使只是
//   只读核对。该步骤本身不论 apply 是否为 true 都绝不自动修改任何数据——
//   是否真的是可以隔离的测试脏数据需要平台管理员人工核实后自行处理。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🐛 与 cloudfunctions/getSunshineLedger、getReports 同一份历史曾用名/关键词
// 配置拷贝（各云函数独立部署，无共享模块机制，需要手动同步三处）
const TARGET_STORE_ID = '8e9ed36b6a77084506c0fe6c659304f9';
const LEGACY_SHOP_NAME_ALIASES = ['海沧区雨花斋', '海沧雨花斋', '厦门海沧雨花斋', '嵩屿雨花斋'];
const LEGACY_SHOP_NAME_KEYWORD = '海沧';

// 📋 仅核对、不修改：本次任务额外点名"测试1"这家门店疑似历史测试脏数据，
// 但"是不是真的该隔离"不是本函数能替用户判断的事，只报告现状供人工决策
const SUSPECT_TEST_STORE_NAME = '测试1';

const QUERY_LIMIT = 1000;

// 🛡️ 返回 { authorized, isPlatformAdmin }——isPlatformAdmin 额外区分出来，
// 供步骤 3（"测试1"跨店诊断，与本次迁移目标门店无关）单独收紧，store_patriarch
// 即便通过了下面的 authorized 判定，也不该看到别的门店的运营数据
async function resolveAuthorizedOperator(OPENID) {
  if (!OPENID) return { authorized: false, isPlatformAdmin: false };
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  const roleDoc = roleRes.data && roleRes.data.length > 0 ? roleRes.data[0] : null;
  if (!roleDoc) return { authorized: false, isPlatformAdmin: false };
  if (roleDoc.role === 'platform_admin') return { authorized: true, isPlatformAdmin: true };
  // 大家长仅限于"自己所在门店 === 本次迁移硬编码目标"这一种情况，不能是
  // 任意 store_patriarch——否则等于给了所有大家长跨店改数据的权限
  if (roleDoc.role === 'store_patriarch' && roleDoc.storeId === TARGET_STORE_ID) {
    return { authorized: true, isPlatformAdmin: false };
  }
  return { authorized: false, isPlatformAdmin: false };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 🛡️ 云开发控制台"云端测试"发起的调用，cloud.getWXContext().OPENID 恒为空——
  // 真实小程序端调用永远带着微信客户端签发的真实 OPENID，这个分支在生产流量里
  // 走不到。这里【不】绕过鉴权本身：只是在拿不到 context.OPENID 时，把身份来源
  // 换成 event.operatorOpenId（调用方自己传的、要拿去验证的 openid），随后仍然
  // 走一模一样的 resolveAuthorizedOperator() 数据库查证——传一个既不是
  // platform_admin、也不是本店大家长的 openid 一样会被拒绝。控制台测试时，
  // 把 platform_admin 或本店大家长账号的 openid 填进 event.operatorOpenId 即可
  const effectiveOPENID = OPENID || (event && event.operatorOpenId) || '';
  const { authorized, isPlatformAdmin } = await resolveAuthorizedOperator(effectiveOPENID);
  if (!authorized) {
    return { success: false, error: '无权限：仅平台管理员，或本店（三源弘雨花斋）大家长可执行本次数据迁移' };
  }

  const apply = event && event.apply === true;
  const steps = [];

  try {
    // ── 步骤 1：解析目标门店当前权威名称/业态 ──────────────────────────
    const storeRes = await db.collection('stores').doc(TARGET_STORE_ID).get().catch(() => null);
    const targetStore = storeRes && storeRes.data;
    if (!targetStore) {
      return {
        success: false,
        error: `未找到目标门店文档（storeId: ${TARGET_STORE_ID}），请先核实这个 storeId 是否正确，本函数拒绝在不确定目标门店身份的情况下继续`
      };
    }
    const canonicalStoreName = targetStore.storeName || '';
    if (!canonicalStoreName) {
      return {
        success: false,
        error: `目标门店文档（storeId: ${TARGET_STORE_ID}）缺少 storeName 字段，无法确定要归一到哪个店名，请先补全该门店档案后重试`
      };
    }
    steps.push({
      step: 'resolve_target_store',
      success: true,
      storeId: TARGET_STORE_ID,
      canonicalStoreName,
      orgType: targetStore.orgType || ''
    });

    // ── 步骤 2：report_logs 孤儿历史记录归一（storeId 缺失/为空 + shopName
    //    命中已知曾用名精确列表 或 含"海沧"关键词）──────────────────────
    try {
      const orphanCondition = _.and([
        _.or([{ storeId: _.exists(false) }, { storeId: '' }]),
        _.or([
          { shopName: _.in(LEGACY_SHOP_NAME_ALIASES) },
          { shopName: db.RegExp({ regexp: LEGACY_SHOP_NAME_KEYWORD, options: 'i' }) }
        ])
      ]);
      const candidatesRes = await db.collection('report_logs')
        .where(orphanCondition)
        .limit(QUERY_LIMIT)
        .get();
      const candidates = candidatesRes.data || [];

      const recordActions = [];
      for (const rec of candidates) {
        const before = { storeId: rec.storeId || '', shopName: rec.shopName || '' };
        const after = { storeId: TARGET_STORE_ID, shopName: canonicalStoreName };
        if (apply) {
          await db.collection('report_logs').doc(rec._id).update({
            data: { storeId: TARGET_STORE_ID, shopName: canonicalStoreName }
          });
        }
        recordActions.push({
          reportId: rec._id,
          dateString: rec.dateString || '',
          action: apply ? 'fixed' : 'will_fix',
          before,
          after
        });
      }

      steps.push({
        step: 'normalize_report_logs',
        success: true,
        matchedCount: candidates.length,
        hitQueryLimit: candidates.length >= QUERY_LIMIT,
        recordActions
      });
    } catch (err) {
      steps.push({ step: 'normalize_report_logs', success: false, error: err.message || String(err) });
    }

    // ── 步骤 3：核对"测试1"门店现状（只读，不做任何修改；仅 platform_admin 可见，
    //    见文件头注释——与本次迁移目标门店无关，store_patriarch 权限不覆盖这里）
    if (!isPlatformAdmin) {
      steps.push({
        step: 'verify_suspect_test_store',
        success: true,
        skipped: true,
        note: '本步骤仅 platform_admin 可见，当前操作人是本店大家长，与本次迁移目标门店无关的诊断信息不对其展示'
      });
    } else {
      try {
        const suspectStoresRes = await db.collection('stores').where({ storeName: SUSPECT_TEST_STORE_NAME }).get().catch(() => ({ data: [] }));
        const suspectStores = suspectStoresRes.data || [];
        const verifyResults = [];
        for (const s of suspectStores) {
          const [approvedCountRes, totalCountRes] = await Promise.all([
            db.collection('report_logs').where({ storeId: s._id, approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }).count().catch(() => ({ total: 0 })),
            db.collection('report_logs').where({ storeId: s._id }).count().catch(() => ({ total: 0 }))
          ]);
          verifyResults.push({
            storeId: s._id,
            storeName: s.storeName,
            tenantId: s.tenantId || '',
            orgType: s.orgType || '',
            status: s.status || '',
            approvedReportCount: approvedCountRes.total || 0,
            totalReportCount: totalCountRes.total || 0,
            note: (approvedCountRes.total || 0) > 0
              ? '该门店存在已归档（APPROVED/AUDITED_LOCKED）的真实流水，不建议在没有进一步核实的情况下当作纯测试数据隔离'
              : '未查到已归档流水，是否为纯测试脏数据仍需人工核实后自行在门店管理后台停用/隔离，本函数不做任何自动修改'
          });
        }
        steps.push({
          step: 'verify_suspect_test_store',
          success: true,
          note: '本步骤仅核对，不论 apply 是否为 true 都不会修改任何数据',
          verifyResults: verifyResults.length > 0 ? verifyResults : [{ note: `未找到名为「${SUSPECT_TEST_STORE_NAME}」的门店文档` }]
        });
      } catch (err) {
        steps.push({ step: 'verify_suspect_test_store', success: false, error: err.message || String(err) });
      }
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
    console.error('[fixLegacyStoreDataNormalization] 异常:', err);
    return { success: false, error: err.message || '数据迁移执行异常', apply, steps };
  }
};
