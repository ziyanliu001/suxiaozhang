// 云函数：getRiskAlerts - 财务风控预警日志
//
// 扫描指定门店近 60 天的账本记录，汇总四类预警信号供财务稽核参考：
// 1. 红字冲销频次：isVoid 记录数量（作废过于频繁本身就是一种异常信号，值得财务关注原因）。
// 2. 小票缺失：有支出金额但完全没有上传凭证图片的记录。
// 3. 余额异常突变：昨日余额与前一天实际结余对不上（疑似被跳过/篡改），或单日净变动金额
//    明显偏大（默认阈值 ¥1000，超出食材采购常规量级，可能是录入错误或异常支出）。
// 4. 算术复核不一致：stampReportChecksum 在每次提交/编辑后打上的 arithmeticMismatch 标记
//    （昨日余额+今日收入-今日支出 != 今日结余），这里只是把该标记展示出来供人工复核，
//    不做自动更正。
//
// 权限：仅 finance / super_admin 可调用；finance 只能查看本店，super_admin 限本机构内任意门店。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const SCAN_DAYS = 60;
const BALANCE_JUMP_THRESHOLD = 1000;

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

function isoDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

exports.main = async (event) => {
  const { storeId } = event;
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return { success: false, errMsg: '未获取到用户身份' };
  }
  if (!storeId) {
    return { success: false, errMsg: '缺少 storeId 参数' };
  }

  try {
    const caller = await resolveCaller(OPENID);
    if (!caller || !['finance', 'super_admin'].includes(caller.role)) {
      return { success: false, errMsg: '无权限：仅财务与超级管理员可查看风控预警' };
    }
    if (caller.role === 'finance' && caller.storeId && caller.storeId !== storeId) {
      return { success: false, errMsg: '无权限：不能查看其他门店的风控数据' };
    }

    const startDate = isoDateNDaysAgo(SCAN_DAYS);
    const where = { storeId, dateString: _.gte(startDate) };
    if (caller.tenantId) {
      where.tenantId = caller.tenantId;
    }

    const listRes = await db.collection('report_logs')
      .where(where)
      .orderBy('dateString', 'asc')
      .limit(200)
      .get();

    const records = listRes.data || [];
    const alerts = [];

    let voidCount = 0;
    let missingReceiptCount = 0;
    let balanceAnomalyCount = 0;
    let arithmeticMismatchCount = 0;

    let prevTodayBalance = null;

    records.forEach((item) => {
      if (item.isVoid) {
        voidCount++;
        alerts.push({
          type: 'void',
          level: 'warning',
          dateString: item.dateString,
          message: `${item.dateString} 记录被红字冲销作废`
        });
        return; // 已作废的记录不参与余额链路/算术复核比对
      }

      if (item.arithmeticMismatch) {
        arithmeticMismatchCount++;
        const expected = item.arithmeticExpectedBalance;
        alerts.push({
          type: 'arithmetic_mismatch',
          level: 'danger',
          dateString: item.dateString,
          message: `${item.dateString} 服务端算术复核不通过：按昨日余额+收入-支出计算应为¥${Number(expected).toFixed(2)}，但记录的今日结余为¥${parseFloat(item.todayBalance || 0).toFixed(2)}`
        });
      }

      const expenseAmount = parseFloat(item.expenseAmount || '0');
      const hasReceipt = (item.receiptImages && item.receiptImages.length > 0) ||
        (item.receiptImageList && item.receiptImageList.length > 0);
      if (expenseAmount > 0 && !hasReceipt) {
        missingReceiptCount++;
        alerts.push({
          type: 'missing_receipt',
          level: 'danger',
          dateString: item.dateString,
          message: `${item.dateString} 支出¥${expenseAmount.toFixed(2)}但未上传小票凭证`
        });
      }

      const yesterdayBalance = parseFloat(item.yesterdayBalance || '0');
      const todayBalance = parseFloat(item.todayBalance || '0');

      if (prevTodayBalance !== null && Math.abs(yesterdayBalance - prevTodayBalance) > 0.01) {
        balanceAnomalyCount++;
        alerts.push({
          type: 'balance_break',
          level: 'danger',
          dateString: item.dateString,
          message: `${item.dateString} 昨日余额(¥${yesterdayBalance.toFixed(2)})与前一天实际结余(¥${prevTodayBalance.toFixed(2)})不一致，疑似记录被跳过或篡改`
        });
      }

      const netChange = todayBalance - yesterdayBalance;
      if (Math.abs(netChange) > BALANCE_JUMP_THRESHOLD) {
        balanceAnomalyCount++;
        alerts.push({
          type: 'balance_jump',
          level: 'warning',
          dateString: item.dateString,
          message: `${item.dateString} 单日净变动¥${netChange.toFixed(2)}，明显偏大，建议核实`
        });
      }

      prevTodayBalance = todayBalance;
    });

    // 🌟 漏登预警：昨日/今日均未提交日报（作废记录不算数），门店管理页据此显示
    // "⚠️ 待补登日报"——与上面四类"账目内容有问题"不同，这类是"压根没交账"，
    // 单独统计不塞进 alerts 明细列表，避免和逐条账目异常混在一起
    const todayStr = isoDateNDaysAgo(0);
    const yesterdayStr = isoDateNDaysAgo(1);
    const hasRecentReport = records.some((item) => !item.isVoid && (item.dateString === todayStr || item.dateString === yesterdayStr));
    let daysSinceLastReport = null;
    if (!hasRecentReport) {
      const validRecords = records.filter((item) => !item.isVoid);
      if (validRecords.length > 0) {
        // records 按 dateString 升序排列，最后一条即扫描窗口内最新的一条有效记录
        const lastDateStr = validRecords[validRecords.length - 1].dateString;
        daysSinceLastReport = Math.floor((new Date(todayStr).getTime() - new Date(lastDateStr).getTime()) / (24 * 60 * 60 * 1000));
      }
    }

    // 最近的异常优先展示
    alerts.sort((a, b) => (a.dateString < b.dateString ? 1 : -1));

    return {
      success: true,
      alerts,
      summary: {
        voidCount,
        missingReceiptCount,
        balanceAnomalyCount,
        arithmeticMismatchCount,
        missingReport: !hasRecentReport,
        daysSinceLastReport
      },
      scanRangeDays: SCAN_DAYS
    };
  } catch (err) {
    console.error('[getRiskAlerts] 异常:', err);
    return { success: false, errMsg: err.message || '风控预警查询失败' };
  }
};
