/**
 * 隐私脱敏工具：姓名 / 手机号 / 身份证号 / 银行账号
 * 用于公开展示场景（微信群报告文案、海报图片、导出列表等），
 * 防止个人信息在对外传播的内容中原样泄露。
 */

// 🐛 根因修复：中间固定只留一个 '*'，字符越长脱敏强度反而越弱——四字姓名
// "欧阳志强"此前脱敏成"欧*强"，中间两个字里的"阳志"只剩一个占位符，看起来
// 像是丢了一个字而不是刻意遮蔽；六字机构简称同理。改为按隐去的字符数量
// 逐一替换成等量的 '*'，"欧阳志强" → "欧**强"，脱敏强度不再随姓名变长而
// 打折扣。与 cloudfunctions/manageVolunteerCheckIn、publicVerifyReport、
// pages/index/index.wxs 三处同名实现保持同一套规则（各云函数/WXS 独立
// 部署、无共享模块机制，需要手动同步这四处拷贝）
export function maskName(name: string): string {
  if (!name) return '';
  const str = String(name).trim();
  if (str.length <= 1) return str + '*';
  if (str.length === 2) return str.charAt(0) + '*';
  return str.charAt(0) + '*'.repeat(str.length - 2) + str.charAt(str.length - 1);
}

// 🐛 合规订正（2026-08-30 全平台脱敏专项）：此前"阳善"（isAnonymous=false）
// 分支引用了凡四训"公开真实姓名、长养公信"的理念，直接原样展示全名——但
// 对外公开传播的报告文案/海报/善缘墙/大屏这类不特定公众可见的场景，仍需要
// 遵循个人信息保护的最小披露原则，哪怕捐赠人本人同意公开姓名，也不等同于
// 同意把完整法定姓名广播给互联网上的任何人。"阳善"与"阴德"的区别现在改为
// 仅体现在"是否显示任何姓名痕迹"上——阳善至少展示脱敏后的姓氏/首字，阴德
// 完全不露姓名，两者都不再原样吐出未脱敏全名。真正需要看到完整姓名核对账目
// 的场景（门店内部记账录入/编辑、super_admin/财务的稽核底稿），走的是原始
// donationItems 数据本身（tenantId+角色隔离保护），不经过这个"公开展示"
// 格式化函数，不受本次改动影响
export function formatDisplayName(name: string, isAnonymous: boolean = false): string {
  if (isAnonymous || !name || !String(name).trim()) return '爱心善士';
  return maskName(name);
}

// 🆕 别名导出：与本次脱敏专项约定的公共函数名对齐，语义与 formatDisplayName
// 完全一致（isAnonymous 时统一"爱心善士"，否则按 maskName 规则脱敏姓名），
// 不重复实现一份逻辑——两个名字都能 import，指向同一个函数
export const maskPersonName = formatDisplayName;

export function maskPhone(phone: string): string {
  if (!phone) return '';
  const str = String(phone).replace(/\D/g, '');
  if (str.length < 7) return str.charAt(0) + '****';
  return str.slice(0, 3) + '****' + str.slice(-4);
}

export function maskIdCard(idCard: string): string {
  if (!idCard) return '';
  const str = String(idCard).trim();
  if (str.length < 8) return str.charAt(0) + '****';
  return str.slice(0, 4) + '*'.repeat(str.length - 8) + str.slice(-4);
}

export function maskBankAccount(account: string): string {
  if (!account) return '';
  const str = String(account).replace(/\s/g, '');
  if (str.length < 8) return '****';
  return '**** **** **** ' + str.slice(-4);
}
