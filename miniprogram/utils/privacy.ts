/**
 * 隐私脱敏工具：姓名 / 手机号 / 身份证号 / 银行账号
 * 用于公开展示场景（微信群报告文案、海报图片、导出列表等），
 * 防止个人信息在对外传播的内容中原样泄露。
 */

export function maskName(name: string): string {
  if (!name) return '';
  const str = String(name).trim();
  if (str.length <= 1) return str + '*';
  if (str.length === 2) return str.charAt(0) + '*';
  return str.charAt(0) + '*' + str.charAt(str.length - 1);
}

/**
 * 了凡四训·隐名集阴德：公开展示时的姓名格式化。
 * - isAnonymous=true：统一展示为"爱心善士"，完全隐去真实姓名
 * - isAnonymous=false：走普通脱敏（maskName），保留首尾字符
 */
export function formatDisplayName(name: string, isAnonymous: boolean): string {
  if (isAnonymous) return '爱心善士';
  return maskName(name);
}

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
