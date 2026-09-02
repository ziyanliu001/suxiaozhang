// 通知 Tab 红点徽标的数量来源：与 pages/notice/notice.ts 的 buildNotificationItem()
// 共用同一套"这条账务/审核动态是否需要当前角色处理"的判定规则，避免两处判断逻辑长出分叉。
export interface ApprovalRoleFlags {
  isManagerRole: boolean;
  isFinanceRole: boolean;
  isSuperAdmin: boolean;
}

export interface ReportApprovalStatus {
  status: string;
  isMismatch: boolean;
  actionable: boolean;
}

export function evaluateReportStatus(item: any, roleFlags: ApprovalRoleFlags): ReportApprovalStatus {
  const { isManagerRole, isFinanceRole, isSuperAdmin } = roleFlags;

  const yesterdayBalance = parseFloat(item.yesterdayBalance || '0') || 0;
  const totalIncome = (parseFloat(item.otherDonation || '0') || 0) + (parseFloat(item.listDonationTotal || '0') || 0);
  const expenseAmount = parseFloat(item.expenseAmount || '0') || 0;
  const actualBalance = parseFloat(item.todayBalance || item.calculatedTodayBalance || '0') || 0;
  const expected = Math.round((yesterdayBalance + totalIncome - expenseAmount) * 100) / 100;
  const diff = Math.round((actualBalance - expected) * 100) / 100;
  const isMismatch = Math.abs(diff) >= 0.01;

  // 🐛 状态归一修复（与 pages/history/history.ts formattedReports 映射同一根因）：
  // utils/dataService.ts saveReport 现在会给新提交记录显式写入 approvalStatus:
  // 'PENDING'（历史上完全不写这个字段，值是 undefined）。这里原先的
  // `item.approvalStatus || 'PENDING_APPROVAL'` 只处理"字段缺失"这一种情况，
  // 字面值 'PENDING' 是真值不会走 fallback，会原样透传成 'PENDING'——但
  // 'PENDING_APPROVAL' 从来不是真实写入数据库的值，只是这里用来统一表示
  // "尚未审核"的展示态标签。后果：下面 status === 'PENDING_APPROVAL' 分支对
  // 当前所有新提交的记录全部落空，pages/notice/notice.ts buildReminderItem
  // 渲染出空 tag/desc + 通用 📋 图标，custom-tab-bar 的"通知"红点徽标计数
  // 也漏计这些真正待处理的记录。改成"非 APPROVED/AUDITED_LOCKED 一律归一为
  // 'PENDING_APPROVAL'"，与 history.ts 那处修复保持同一套原则
  const status = (item.approvalStatus === 'APPROVED' || item.approvalStatus === 'AUDITED_LOCKED')
    ? item.approvalStatus
    : 'PENDING_APPROVAL';
  let actionable = false;

  if (status === 'PENDING_APPROVAL') {
    actionable = isManagerRole || isSuperAdmin;
  } else if (status === 'APPROVED') {
    actionable = isFinanceRole || isSuperAdmin;
  } else if (status === 'AUDITED_LOCKED') {
    actionable = false;
  }

  if (isMismatch) {
    actionable = actionable || isManagerRole || isFinanceRole || isSuperAdmin;
  }

  return { status, isMismatch, actionable };
}

export function computeActionableCount(reports: any[], roleFlags: ApprovalRoleFlags): number {
  return (reports || []).filter((item) => !item.isVoid && evaluateReportStatus(item, roleFlags).actionable).length;
}
