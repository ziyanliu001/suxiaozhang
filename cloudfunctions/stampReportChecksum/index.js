// 云函数：stampReportChecksum
// 客户端提交/编辑餐报后，走此云函数在服务端用 HMAC 密钥为记录写入资金流水防篡改校验码。
// 客户端不持有 HMAC 密钥，无法自行伪造合法校验码，从而保证 "昨日余额+今日收入-今日支出=今日结余"
// 这条资金链在数据库层面被直接改库篡改时可以被发现。
//
// 🛡️ 轻量服务端复核（不阻断提交流程）：saveReport 的主提交路径目前仍是客户端直接写库
// （dataService.ts 的 db.collection('report_logs').add()/.update()），tenantId、金额算术
// 关系都是客户端自己算好传上来的，服务端此前唯一介入的环节就是这里——但过去只是"盖章"，
// 完全不检查盖的章是否合理。现在改为每次盖章前先做两项服务端复核：
// 1. tenantId 纠偏：若记录上的 tenantId 与调用者服务端解析出的真实 tenantId 不一致
//    （伪造/缓存过期/历史遗留缺失），直接以服务端解析结果纠正，防止一条被误标/伪造了
//    tenantId 的记录绕过其余云函数里"按 tenantId 过滤"的隔离边界。
// 2. 算术复核：校验 昨日余额+今日收入-今日支出 是否等于 今日结余（容差 0.01 元），
//    不一致时打上 arithmeticMismatch 标记并写入审计日志，供财务在"风控预警"里排查，
//    但不回滚、不拒绝，不影响提交人当次操作的使用体验。
// 这两项复核都不是"防止恶意客户端提交伪造数据"的根本解法（真正的解法是把 saveReport
// 整个迁到服务端校验后落库），只是在维持现有直连写库路径不变的前提下，把最容易被
// 忽略的两类错误/伪造数据尽快暴露出来。

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const HMAC_SECRET = process.env.LEDGER_HMAC_SECRET || 'yuhua_ledger_default_secret_please_override_in_cloud_env';
const AMOUNT_TOLERANCE = 0.01;

function computeChecksum(item) {
  const yb = (parseFloat(item.yesterdayBalance || 0)).toFixed(2);
  const income = (parseFloat(item.listDonationTotal || 0) + parseFloat(item.otherDonation || 0)).toFixed(2);
  const expense = (parseFloat(item.dailyExpenseTotal || 0) + parseFloat(item.fixedExpenseTotal || 0)).toFixed(2);
  const tb = (parseFloat(item.todayBalance || 0)).toFixed(2);
  const dateString = item.dateString || '';
  const storeId = item.storeId || item.shopName || '';
  const payload = `${dateString}|${storeId}|${yb}|${income}|${expense}|${tb}`;
  return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

function round2(num) {
  return Math.round((parseFloat(num || 0) + Number.EPSILON) * 100) / 100;
}

// 🛡️ 与 checkCanEdit（updateAndRecalculateCascade/deleteMealReport 等）保持一致的权限口径：
// 提交人本人，或同机构 super_admin，或同门店 store_manager/finance，才允许为该记录盖章。
// 此前本函数没有任何身份/权限校验——任何人拿到一个记录 id 就能调用它，相当于给
// "任意人直接改库后再来找我盖一个新的合法校验码" 开了后门，HMAC 防篡改设计形同虚设。
function checkCanStamp(doc, openId, caller) {
  if (!doc || doc._openid === openId) return true;
  if (!caller) return false;

  if (caller.tenantId && doc.tenantId && caller.tenantId !== doc.tenantId) return false;
  if (caller.role === 'super_admin') return true;
  // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
  if (caller.role === 'store_manager' || caller.role === 'finance' || caller.role === 'store_patriarch') {
    return !!((caller.storeId && doc.storeId && caller.storeId === doc.storeId)
      || (caller.storeName && doc.shopName && caller.storeName === doc.shopName));
  }
  return false;
}

exports.main = async (event) => {
  const { id } = event;
  const { OPENID } = cloud.getWXContext();

  if (!id) {
    return { success: false, error: '缺少记录 ID' };
  }
  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  try {
    const docRes = await db.collection('report_logs').doc(id).get();
    const docData = docRes.data;

    if (!docData) {
      return { success: false, error: '记录不存在' };
    }

    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const caller = roleRes.data && roleRes.data[0];

    const allowed = checkCanStamp(docData, OPENID, caller);
    if (!allowed) {
      return { success: false, error: '无权限为该记录盖章' };
    }

    const patch = {};
    const auditEntries = [];

    // 1. tenantId 纠偏：服务端解析出的 tenantId 优先于记录上（客户端写入）的 tenantId
    const callerTenantId = (caller && caller.tenantId) || '';
    if (callerTenantId && docData.tenantId !== callerTenantId) {
      patch.tenantId = callerTenantId;
      auditEntries.push({
        action: 'AUTO_TENANT_CORRECTION',
        detail: `tenantId 由 [${docData.tenantId || '(空)'}] 纠正为 [${callerTenantId}]`
      });
    }

    // 2. 算术复核：昨日余额 + 今日收入 - 今日支出 应等于 今日结余
    const yesterdayBalance = parseFloat(docData.yesterdayBalance || 0);
    const income = parseFloat(docData.listDonationTotal || 0) + parseFloat(docData.otherDonation || 0);
    const expense = parseFloat(docData.dailyExpenseTotal || 0) + parseFloat(docData.fixedExpenseTotal || 0);
    const expectedToday = round2(yesterdayBalance + income - expense);
    const actualToday = round2(docData.todayBalance);
    const arithmeticMismatch = Math.abs(expectedToday - actualToday) > AMOUNT_TOLERANCE;

    patch.arithmeticMismatch = arithmeticMismatch;
    if (arithmeticMismatch) {
      patch.arithmeticExpectedBalance = expectedToday;
      auditEntries.push({
        action: 'ARITHMETIC_MISMATCH_DETECTED',
        detail: `昨日余额(${yesterdayBalance})+收入(${income})-支出(${expense})=${expectedToday}，` +
          `但记录的今日结余为 ${actualToday}，请财务核实`
      });
    }

    patch._checksum = computeChecksum({ ...docData, ...patch });

    await db.collection('report_logs').doc(id).update({ data: patch });

    if (auditEntries.length > 0) {
      await db.collection('report_audit_logs').add({
        data: {
          operator_id: OPENID,
          operator_role: (caller && caller.role) || 'self',
          operate_time: db.serverDate(),
          action: 'stamp_checksum_review',
          target_collection: 'report_logs',
          target_id: id,
          target_date: docData.dateString,
          target_store: docData.shopName,
          findings: auditEntries
        }
      }).catch(e => console.warn('[stampReportChecksum] 审计日志写入失败:', e));
    }

    return { success: true, checksum: patch._checksum, arithmeticMismatch };
  } catch (err) {
    console.error('[stampReportChecksum] 计算/写入校验码失败:', err);
    return { success: false, error: err.message || '写入校验码失败' };
  }
};
