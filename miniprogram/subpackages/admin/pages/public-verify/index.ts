import { callFunctionWithTimeout } from '../../../../utils/withTimeout';

// 🛡️ 100% 公开只读页面：扫码进来的是社会公众/捐赠人，绝不能依赖任何登录态或
// user_roles 缓存——本文件不导入 AuthService，也不调用任何需要登录态的接口，
// 只用设备级只读 API（系统信息/胶囊按钮位置）与公开云函数 publicVerifyReport。

interface DonationItem {
  name: string;
  amount: number;
}

interface MaterialItem {
  donor: string;
  item: string;
  quantity: string;
  unit: string;
}

interface ActivityInfo {
  title: string;
  content: string;
  images: Array<{ url: string; thumbUrl: string }>;
}

const APPROVAL_STATUS_LABELS: Record<string, string> = {
  PENDING_APPROVAL: '待店长确认',
  APPROVED: '待财务稽核',
  AUDITED_LOCKED: '已稽核封账'
};

// 🌟 爱心感言墙：本项目没有独立的"用餐老人反馈"数据表，志愿者在"今日大事记"里
// 记的门店日志（activity_logs.content）本身就常常是这一类记录（如谁说了什么、
// 今天菜品的反响），直接复用同一份数据展示，不新增字段/表。当天没有日志时，
// 优雅降级为固定的温馨感言，而不是让感言墙空白
const DEFAULT_TESTIMONIAL = '感恩每一位爱心志愿者的无私付出，你们的善行温暖了每一颗心！';

// 🐛（2026-08-31 紧急修复：验真二维码 scene 45 字符超限）与
// cloudfunctions/getStoreQRCode 的 buildVerifyScene() 配套的解码逻辑——
// 32 位十六进制 _id 那边按 36 进制重新编码成 base36(storeId)+base36(yyyymmdd)
// 不含分隔符的紧凑格式（详见该云函数头部注释），这里原样逆运算还原。
// BigInt 保证 128 位整数精度不丢失，纯字符串正则/parseInt 做不到这一点
// （Number 只有 53 位安全整数精度）。
function base36ToHex(b36Str: string): string {
  // 🛡️ 用 BigInt(36)/BigInt(0) 函数调用而不是 36n/0n 字面量后缀写法——后者
  // 需要 tsconfig target 至少 ES2020 才能编译，本项目 target 是 ES2017
  // （历史既有配置，不为这一处改动牵动全项目编译目标），函数调用写法在
  // 任何 target 下都能编译，运行时行为完全等价
  let n = BigInt(0);
  const base = BigInt(36);
  for (const ch of b36Str) {
    n = n * base + BigInt(parseInt(ch, 36));
  }
  return n.toString(16).padStart(32, '0');
}

Page({
  _storeId: '' as string,

  data: {
    contentTop: 0,

    loading: true,
    errorMsg: '',
    found: false,

    storeName: '',
    dateString: '',
    approvalStatusLabel: '',
    auditedBy: '',
    auditTime: '',
    // 🏛️ 护持家长/日常店长：体现人文双署名文化，无绑定时不展示
    patriarch: '',
    manager: '',

    // 机构类型
    orgType: 'dining' as string, // 'dining' | 'service' | other
    isDiningOrg: true, // derived from orgType: dining/canteen → true, service → false

    yesterdayBalance: '0.00',
    otherDonation: '0.00',
    listDonationTotal: '0.00',
    expenseAmount: '0.00',
    todayBalance: '0.00',
    expenses: '',

    receiptImages: [] as string[],
    donationItems: [] as DonationItem[],

    // 🌟 爱心物资透明墙：当天物资捐赠明细 + 门店当前物资储备状态
    materials: [] as MaterialItem[],
    stapleRiceStatusLabel: '',
    stapleOilStatusLabel: '',

    activity: null as ActivityInfo | null,

    // 🌟 爱心感言墙：见 DEFAULT_TESTIMONIAL 注释
    testimonialText: DEFAULT_TESTIMONIAL,
    testimonialIsDefault: true,

    // 服务指标
    dineInSeniors: 0,
    deliverySeniors: 0,
    dineInVolunteers: 0,
    deliveryVolunteers: 0,
    takeawayCount: 0,
    listeningSeniors: 0,
    totalDineCount: 0,
    totalVolunteers: 0,
    volunteerHours: 0,

    // 善行汇聚平台级公开统计
    platformStoreCount: 0,
    platformReportCount: 0
  },

  onLoad(options: Record<string, string>) {
    const target = this.resolveTarget(options);
    if (!target) {
      this.setData({ loading: false, errorMsg: '二维码信息不完整，无法查询该笔账目' });
      return;
    }
    this._storeId = target.storeId;
    this.fetchReport(target.storeId, target.date);
  },

  // 🐛 根因修复：本页此前是唯一一处没有返回/回家按钮的自定义导航栏页面——
  // 扫码验真这类分享直入场景，页面栈深度通常为 1，用户进来后完全没有
  // 离开路径（只能靠系统手势/物理返回，体验生硬）。改用 <navigation-bar>
  // 共享组件，back+showHomeButton="auto" 会按真实栈深度决定展示返回还是
  // 回家，且组件内部的点击逻辑本就在栈深度为 1 时安全降级为 switchTab 回首页，
  // 不会出现点击后卡死的情况
  onNavLayout(e: { detail: { totalHeight: number } }) {
    this.setData({ contentTop: e.detail.totalHeight + 8 });
  },

  // 兼容三种入口：
  // 1. 直接携带参数打开（分享链接/调试）：?storeId=xxx&date=2026-07-20
  // 2. 扫码进入·旧格式（短种子门店 ID，如 'store_haicang_001'）：
  //    options.scene 格式 t_<storeId>_d_<yyyymmdd>
  // 3. 扫码进入·新紧凑格式（32 位十六进制云数据库 _id）：options.scene 格式
  //    base36(storeId)+base36(yyyymmdd)，不含下划线——与 2 互斥自解释，靠
  //    "是否包含下划线"零成本区分（36 进制字母表 0-9a-z 里没有下划线，
  //    格式 2 恒含下划线），见 cloudfunctions/getStoreQRCode buildVerifyScene()
  //    头部注释。微信小程序码 scene 字段硬限 32 字符，格式 2 对完整 32 位
  //    十六进制 _id 会超限（2026-08-31 线上事故：45 字符生成失败），格式 3
  //    是这次的修复方案
  resolveTarget(options: Record<string, string>): { storeId: string; date: string } | null {
    if (options && options.storeId && options.date) {
      return { storeId: options.storeId, date: this.normalizeDate(options.date) };
    }

    // 术语兼容：请求方习惯称 tenant_id，本页/云函数实际按 storeId 精确定位一笔账目
    // （同一机构下不同门店同一天各自都有报告，tenant_id 无法唯一定位，详见云函数注释）
    if (options && options.tenant_id && options.date) {
      return { storeId: options.tenant_id, date: this.normalizeDate(options.date) };
    }

    const scene = options && options.scene ? decodeURIComponent(options.scene) : '';
    if (scene) {
      const legacyMatch = /^t_(.+)_d_(\d{8})$/.exec(scene);
      if (legacyMatch) {
        return { storeId: legacyMatch[1], date: this.normalizeDate(legacyMatch[2]) };
      }

      // 新紧凑格式：末 5 位是 base36(yyyymmdd)（21 世纪范围内恒为 5 位，见
      // 云函数 buildVerifyScene 头部注释），其余为 base36(storeId)
      if (scene.length > 5 && /^[0-9a-z]+$/.test(scene)) {
        const dateB36 = scene.slice(-5);
        const storeIdB36 = scene.slice(0, -5);
        const dateDigits = String(parseInt(dateB36, 36));
        if (dateDigits.length === 8) {
          return { storeId: base36ToHex(storeIdB36), date: this.normalizeDate(dateDigits) };
        }
      }
    }

    return null;
  },

  normalizeDate(raw: string): string {
    const digits = String(raw || '').replace(/[^0-9]/g, '');
    if (digits.length !== 8) return String(raw || '');
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  },

  async fetchReport(storeId: string, date: string) {
    this.setData({ loading: true, errorMsg: '' });

    try {
      const res = await callFunctionWithTimeout({
        name: 'publicVerifyReport',
        data: { storeId, date }
      });
      const result = res.result as any;

      if (!result || !result.success) {
        this.setData({ loading: false, errorMsg: (result && result.error) || '查询失败，请稍后重试' });
        return;
      }

      if (!result.found) {
        this.setData({ loading: false, found: false, storeName: '', dateString: date });
        return;
      }

      const d = result.data;
      this.setData({
        loading: false,
        found: true,
        storeName: d.storeName || '',
        dateString: d.dateString || date,
        approvalStatusLabel: APPROVAL_STATUS_LABELS[d.approvalStatus] || d.approvalStatus || '',
        auditedBy: d.auditedBy || '',
        auditTime: d.auditTime || '',
        patriarch: d.patriarch || '',
        manager: d.manager || '',
        orgType: d.orgType || 'dining',
        isDiningOrg: (d.orgType || 'dining') !== 'service',
        yesterdayBalance: Number(d.yesterdayBalance || 0).toFixed(2),
        otherDonation: Number(d.otherDonation || 0).toFixed(2),
        listDonationTotal: Number(d.listDonationTotal || 0).toFixed(2),
        expenseAmount: Number(d.expenseAmount || 0).toFixed(2),
        todayBalance: Number(d.todayBalance || 0).toFixed(2),
        expenses: d.expenses || '',
        receiptImages: d.receiptImages || [],
        donationItems: d.donationItems || [],
        materials: d.materials || [],
        stapleRiceStatusLabel: d.stapleRiceStatusLabel || '',
        stapleOilStatusLabel: d.stapleOilStatusLabel || '',
        dineInSeniors: d.dineInSeniors || 0,
        deliverySeniors: d.deliverySeniors || 0,
        dineInVolunteers: d.dineInVolunteers || 0,
        deliveryVolunteers: d.deliveryVolunteers || 0,
        takeawayCount: d.takeawayCount || 0,
        listeningSeniors: d.listeningSeniors || 0,
        totalDineCount: d.totalDineCount || 0,
        totalVolunteers: d.totalVolunteers || 0,
        volunteerHours: d.volunteerHours || 0,
        platformStoreCount: (result as any).platformStats?.storeCount || 0,
        platformReportCount: (result as any).platformStats?.auditedReportCount || 0,
        activity: d.activity || null,
        testimonialText: (d.activity && d.activity.content) ? d.activity.content : DEFAULT_TESTIMONIAL,
        testimonialIsDefault: !(d.activity && d.activity.content)
      });
    } catch (err) {
      console.error('[public-verify] fetchReport 异常:', err);
      this.setData({ loading: false, errorMsg: '网络异常，请稍后重试' });
    }
  },

  onPreviewReceipt(e: any) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.previewImage({ current: url, urls: this.data.receiptImages });
  },

  onPreviewActivityImage(e: any) {
    const url = e.currentTarget.dataset.url;
    if (!url || !this.data.activity) return;
    const urls = this.data.activity.images.map((img) => img.url);
    wx.previewImage({ current: url, urls });
  },

  onShareAppMessage() {
    const { storeName, dateString } = this.data;
    return {
      title: `${storeName || '爱心站点'} · 阳光账本 · ${dateString}`,
      path: `/pages/public-verify/index?storeId=${this._storeId || ''}&date=${dateString}`,
      imageUrl: ''
    };
  },

  onShowShareOptions() {
    wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage'] });
  }
});
