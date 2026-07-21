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

  const status = item.approvalStatus || 'PENDING_APPROVAL';
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
