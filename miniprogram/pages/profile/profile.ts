import { AuthService, hasStoreAdminPrivilege } from '../../utils/authService';
import { DataService } from '../../utils/dataService';
import { getSelectedStore, setSelectedStore, getCachedStoreStatus, fetchAndSyncStoreStatus } from '../../utils/storeManager';
import { computeMyCheckInStats, computeMyCheckInStreak } from '../../utils/checkinStats';
import { getSafeSystemInfo } from '../../utils/util';
import { compressAndUploadScaledImage } from '../../utils/imageCompress';
import { isCloudAvailable, reportCloudSdkErrorIfCorrupted } from '../../utils/cloudGuard';
import { drawVolunteerCertificate } from '../../utils/drawVolunteerCertificate';
import {
  applyRoleViewOverride, getPreviewViewMode, setPreviewViewMode,
  PreviewViewMode, PREVIEW_VIEW_MODE_LABELS
} from '../../utils/viewModePreview';
import { requestOpenSunshineLedger } from '../../utils/sunshineLedgerHandoff';
import { requestOpenCultureFull } from '../../utils/cultureFullHandoff';
import { requestOpenStorePicker } from '../../utils/storePickerHandoff';
import { takeOpenSubscriptionRequest } from '../../utils/subscriptionHandoff';
import { isVirtualStoreName } from '../../utils/storeIdentity';
import { computeBadgeList as computeBadgeListShared } from '../../utils/badgeWall';
import { checkTenantPermission, FEATURE_KEYS, clearTenantPermissionCache, resolveTier, PERMISSION_TIER } from '../../utils/tenantPermission';

const VIEW_MODE_OPTIONS: PreviewViewMode[] = ['SUPER_ADMIN', 'STORE_PATRIARCH', 'STORE_MANAGER', 'FINANCE', 'VOLUNTEER', 'FAMILY'];

// 🛡️ 超级管理员联系方式：普通大家长对同级大家长的权限调整无权直接操作，需线下联系超管处理，
// 客服电话用于紧急联系、微信号用于日常沟通；如后续接入云端配置可改为运行时拉取
const SUPER_ADMIN_CONTACT = {
  phone: '15859242258',
  wechat: 'renfei1888'
};

// 🌟 视角切换半屏弹窗：卡片式选项文案，与 VIEW_MODE_OPTIONS 顺序一一对应
const VIEW_MODE_CARDS: Array<{ mode: PreviewViewMode; label: string; icon: string; desc: string }> = [
  { mode: 'SUPER_ADMIN', label: '超级管理员全景', icon: '👑', desc: '查看全部管理入口与跨店数据，真实操作权限' },
  { mode: 'STORE_PATRIARCH', label: '大家长视角', icon: '🏡', desc: '门店最高管理位，兼具店长与财务全部权限' },
  { mode: 'STORE_MANAGER', label: '店长视角', icon: '🗂️', desc: '门店日常运营与义工管理入口' },
  { mode: 'FINANCE', label: '财务视角', icon: '💰', desc: '账目审核与门店财务统计入口' },
  { mode: 'VOLUNTEER', label: '义工视角', icon: '🤝', desc: '护持打卡、提交餐报等义工专属入口' },
  { mode: 'FAMILY', label: '家人视角', icon: '❤️', desc: '服务对象默认版面，最简洁的关怀视图' }
];

// 🏛️ 多角色兼任"切换身份"面板：roles 数组里的大写 token（与 manageStoreInviteCode/
// processRoleAudit releaseSelf 同一份词汇）<-> 本模块展示用的 label/snake_case 值。
// 不含 FAMILY——"家人"只是退出最后一个身份后的自动兜底展示态（服务端按 status
// 区分，不是一个可以手动切换过去的独立身份），本面板只列可手动切换的四种实体角色
const ROLE_TOKEN_LABELS: Record<string, string> = {
  STORE_PATRIARCH: '大家长',
  STORE_MANAGER: '店长',
  FINANCE: '财务',
  VOLUNTEER: '义工'
};
const ROLE_TOKEN_TO_LOWER: Record<string, 'store_patriarch' | 'store_manager' | 'finance' | 'volunteer'> = {
  STORE_PATRIARCH: 'store_patriarch',
  STORE_MANAGER: 'store_manager',
  FINANCE: 'finance',
  VOLUNTEER: 'volunteer'
};

const CERTIFICATE_CANVAS_ID = 'certificateCanvas';
// 🛡️ "全国总览"/"全部门店" 虚拟聚合门店的 storeId 哨兵值：与 statistics.ts/
// activity-log.ts/daily-menu.ts 的 NATIONAL_STORE_ID_SENTINELS 同一份定义——
// super_admin 在全局门店选择器里选中"全国总览"时，getSelectedStore() 返回的
// storeId 就是这几个字面量之一，不是任何真实门店，绝不能被当成 report_logs.storeId
// 查询条件直接传下去（见 fetchMeritStats 的用法）
const NATIONAL_STORE_ID_SENTINELS = ['national_overview', 'ALL_STORES', 'all', 'ALL', 'yuhuazhai_national'];
// ⚡️ 爱心护持榜 ViewModel 本地缓存失效期：切换 Segment 来回点、频繁 onShow 都不必
// 每次都重新打云函数，10 分钟内命中缓存直接复用——护持榜数据本就不要求逐秒实时
const LEADERBOARD_CACHE_TTL_MS = 10 * 60 * 1000;
// ⚡️ 切换 Segment 时的防抖延迟：快速连点多个榜单 Tab 只在停下来的最后一次真正发起请求
const LEADERBOARD_FETCH_DEBOUNCE_MS = 250;
// 🛡️ "上传后立刻显示新图，但切页/退出重进又变回旧图"的真正根因：lastConfirmedAvatarFileId/
// lastConfirmedAvatarAt 只是 Page 实例上的普通字段（不在 data 里），只存在于内存中。
// 同一次小程序运行期间切换自定义 TabBar 不会重建页面实例，字段能保留、宽限期确实生效；
// 但完整退出小程序再重新打开会重建全新的 Page 实例，这两个字段被重新初始化为 ''/0，
// 宽限期形同虚设——而"云数据库最终一致性延迟"这个宽限期本来要防的场景，恰恰最容易发生在
// "刚上传完就退出重进"这个时间点。于是 loadUserProfile 里 checkUserRole 读到的哪怕是
// 尚未追平的旧 avatarUrl，也会在 withinGrace 恒为 false 的情况下被无条件覆盖回去。
// 用一个本地持久化 key 把这两个字段镜像存一份，页面重新加载时优先从这里恢复，
// 让宽限期跨小程序重启依然生效。
const CONFIRMED_AVATAR_CACHE_KEY = 'confirmed_avatar_grace';

// 🛡️ 门店餐饮与物资统计弹窗的兜底：云函数 statsSummary 正常情况下每个字段都有
// 默认值，但网络异常/云函数返回结构变化时 result.data 可能整体或局部缺失，
// 这里统一做 || 0 归一化，避免 WXML 侧因 null/undefined 渲染出空白或 NaN
function normalizeStoreStats(raw: any) {
  const meal = (raw && raw.mealTotals) || {};
  const todayMat = (raw && raw.todayMaterialTotals) || {};
  const monthMat = (raw && raw.monthMaterialTotals) || {};
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const fallbackToday = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  return {
    today: (raw && raw.today) || fallbackToday,
    mealTotals: {
      breakfastCount: meal.breakfastCount || 0,
      lunchCount: meal.lunchCount || 0,
      dinnerCount: meal.dinnerCount || 0,
      totalCount: meal.totalCount || 0
    },
    todayMaterialTotals: {
      riceCount: todayMat.riceCount || 0,
      flourCount: todayMat.flourCount || 0,
      oilCount: todayMat.oilCount || 0,
      vegetableCount: todayMat.vegetableCount || 0
    },
    monthMaterialTotals: {
      riceCount: monthMat.riceCount || 0,
      flourCount: monthMat.flourCount || 0,
      oilCount: monthMat.oilCount || 0,
      vegetableCount: monthMat.vegetableCount || 0
    }
  };
}

// 🏛️ 家长管理 / 资源兜底：门店人员画像 7 项字段名，与 manageStoreProfile 云函数一致——
// 迁移自已废弃的 pages/patriarch-dashboard，用于展示 pendingProfileUpdate 里
// "店长本次提交了什么"的明细列表
// 🔐 套餐档位文案：与 pages/platform-admin/platform-admin.ts 的 PLAN_LABELS
// 保持同一套措辞，两处独立部署（云函数/页面各自没有共享模块机制），文案硬编码
// 一致即可，不需要额外抽取共享常量
const PLAN_LABELS: Record<string, string> = {
  basic: '基础版',
  pro: '专业版',
  enterprise: '旗舰版'
};

// 🏷️ 公告管理弹窗：内置 7 条常用场景预设文案，与首页「编辑通报内容」弹窗中的
// PRESET_NOTICES 同步，让店长/财务可在两处弹窗快速套用同一套模板
// 🐛 重大隔离漏洞修复：与 index.ts getNoticeTemplate 同一个根因——这份预设文案
// 此前是写死的静态对象（volunteer 甚至直接硬编码"雨花斋的运转离不开..."字样），
// 不管当前门店真实 orgType 是什么，门店管理中心的公告一键套用永远塞进雨花斋
// 专属文案。现改为按真实 orgType 动态生成，措辞口径与 index.ts 完全一致
// （同一批 7 条预设，两个入口理应产出相同结果，不应该因为走的是哪个页面的
// 弹窗而文案不同）
function getNoticeMgmtTemplate(type: string, orgType: string, storeName: string): { tag: string; title: string; content: string } {
  const isYuhuazhai = orgType === 'yuhuazhai';
  const isElderlyCanteen = orgType === 'elderly_canteen';
  const fallbackName = isYuhuazhai ? '雨花斋' : isElderlyCanteen ? '社区助餐点' : '本公益服务站';
  const name = storeName || fallbackName;

  switch (type) {
    case 'opening':
      if (isYuhuazhai) {
        return { tag: '喜讯通报', title: `${name}试营业`, content: `${name}正式开启试营业。秉承敬老爱老、扶弱助困理念，为长者提供健康公益素食午餐。欢迎长辈们前来用餐，也欢迎爱心家人抽空回家做义工，一起践行敬老美德，传递关爱❤️。感恩大家支持！` };
      }
      if (isElderlyCanteen) {
        return { tag: '喜讯通报', title: `${name}试营业喜讯`, content: `${name}正式开启试营业啦！用心为社区长者提供健康、卫生、实惠的助餐服务。欢迎长辈们前来用餐，也欢迎爱心义工加入我们，一起守护社区里的老人家❤️。感恩大家的支持！` };
      }
      return { tag: '喜讯通报', title: `${name}试营业喜讯`, content: `${name}正式开启试营业啦！我们将用心为社区提供公益服务。欢迎大家前来了解，也欢迎爱心志愿者加入我们，一起传递温暖❤️。感恩大家的支持！` };

    case 'volunteer':
      if (isYuhuazhai) {
        return { tag: '义工招募', title: '爱心义工招募', content: `【爱心义工招募】${name}的运转离不开义工家人的倾情护持！现急需择菜、洗碗、传菜义工数名，服务时间：每天上午 8:30 - 12:30。期待您的加入，一起传递温暖！❤️` };
      }
      if (isElderlyCanteen) {
        return { tag: '义工招募', title: '爱心义工招募', content: `【爱心义工招募】${name}的运转离不开爱心义工的无私奉献！急需择菜、洗碗、分餐义工数名，服务时间：每天上午 8:30 - 12:30。期待您的加入，一起传递温暖！❤️` };
      }
      return { tag: '志愿招募', title: '爱心志愿招募', content: `【爱心志愿招募】${name}的运转离不开志愿者的无私奉献！急需多名志愿者协助日常事务，具体服务时间可与我们联系沟通。期待您的加入，一起传递温暖！❤️` };

    case 'supplies':
      if (isYuhuazhai) {
        return { tag: '物资呼吁', title: '爱心物资接力', content: `【爱心物资接力】感恩各位爱心人士的护持！当前${name}大米/食用油储备临界，特向社会呼吁爱心物资接力。每一粒米、每一滴油都饱含满满的心意。衷心感谢您的倾心付出！❤️` };
      }
      if (isElderlyCanteen) {
        return { tag: '物资呼吁', title: '爱心物资接力', content: `【爱心物资接力】感恩各位爱心人士的关心与支持！当前${name}大米/食用油储备临界，特向社会呼吁爱心物资接力，助力长者们吃上热乎饭。每一粒米、每一滴油都饱含满满的心意。衷心感谢您的倾心付出！❤️` };
      }
      return { tag: '物资呼吁', title: '爱心物资接力', content: `【爱心物资接力】感恩各位爱心人士的关心与支持！当前${name}物资储备临界，特向社会呼吁爱心物资接力。每一份物资都饱含满满的心意。衷心感谢您的倾心付出！❤️` };

    case 'weather_closure':
      if (isYuhuazhai) {
        return { tag: '暂停营业', title: '恶劣天气暂停开餐告示', content: `【暂停开餐通知】受恶劣天气影响，为保障各位长者及义工家人的出行安全，${name}将于明日暂停开餐一天。请大家互相转告，切勿空跑。待天气好转后恢复正常开餐。衷心感谢大家的理解与支持！❤️` };
      }
      if (isElderlyCanteen) {
        return { tag: '暂停营业', title: '恶劣天气暂停开餐告示', content: `【暂停开餐通知】受恶劣天气影响，为保障各位长者及义工的出行安全，${name}将于明日暂停开餐一天。请大家互相转告，切勿空跑。待天气好转后恢复正常开餐。衷心感谢大家的理解与支持！❤️` };
      }
      return { tag: '暂停营业', title: '恶劣天气暂停服务告示', content: `【暂停服务通知】受恶劣天气影响，为保障大家的出行安全，${name}将于明日暂停服务一天。请大家互相转告，切勿空跑。待天气好转后恢复正常服务。衷心感谢大家的理解与支持！❤️` };

    case 'renovation_closure':
      if (isYuhuazhai) {
        return { tag: '暂停营业', title: '内部整修/例行消杀停业通知', content: `【例行维护通知】为给长者们提供更加干净、卫生的用餐环境，${name}将于近期进行全店深度清洁消杀与设备整修，期间暂停开餐一天。恢复供餐后欢迎长辈们回家用餐。感恩大家的体谅与护持！❤️` };
      }
      if (isElderlyCanteen) {
        return { tag: '暂停营业', title: '内部整修/例行消杀停业通知', content: `【例行维护通知】为给长者们提供更加干净、卫生的用餐环境，${name}将于近期进行全店深度清洁消杀与设备整修，期间暂停开餐一天。恢复供餐后欢迎长辈们前来用餐。感恩大家的体谅与支持！❤️` };
      }
      return { tag: '暂停营业', title: '内部整修/例行消杀停业通知', content: `【例行维护通知】为给大家提供更加干净、卫生的服务环境，${name}将于近期进行环境清洁与设施整修，期间暂停服务一天。恢复服务后欢迎大家继续前来。感恩大家的体谅与支持！❤️` };

    case 'festival':
      if (isYuhuazhai) {
        return { tag: '日常温馨提醒', title: '节日特别结缘活动通知', content: `【节日欢聚通知】值此佳节到来之际，${name}将于明天中午举办节日特别供餐活动，并为到店用餐的长者准备了一份心意。欢迎长辈们互相转告、欢喜回家用餐！祝大家吉祥安康！🏮` };
      }
      if (isElderlyCanteen) {
        return { tag: '日常温馨提醒', title: '节日特别活动通知', content: `【节日欢聚通知】值此佳节到来之际，${name}将于明天中午举办节日特别供餐活动，并为到店用餐的长者准备了一份心意。欢迎长辈们互相转告、欢喜前来用餐！祝大家节日快乐、身体健康！🏮` };
      }
      return { tag: '日常温馨提醒', title: '节日特别活动通知', content: `【节日活动通知】值此佳节到来之际，${name}将于明天举办节日特别活动。欢迎大家互相转告、欢喜参与！祝大家节日快乐！🏮` };

    case 'thanks':
    default:
      if (isYuhuazhai) {
        return { tag: '感恩致谢', title: '专项爱心致谢', content: `【感恩致谢】特别感谢爱心企业/爱心人士对${name}的慷慨支持，您的善举让更多长者感受到了社会的温暖。衷心感谢您的无私奉献，祝愿平安喜乐、好人一生平安！❤️` };
      }
      return { tag: '感恩致谢', title: '专项爱心致谢', content: `【感恩致谢】特别感谢爱心企业/爱心人士对${name}的慷慨支持，您的善举让更多${isElderlyCanteen ? '长者' : '人'}感受到了社会的温暖。衷心感谢您的无私奉献，祝愿平安喜乐、好人一生平安！❤️` };
  }
}

// 🈁 轻量拼音首字母对照表：仅覆盖门店名称/地名场景中常见的高频汉字（不追求全字库
// 覆盖，本项目未引入任何第三方拼音转换库）。未收录的字符在拼音匹配阶段会被跳过，
// 不影响基础的中文子串匹配能力——两种匹配方式任一命中即视为搜索命中
const PINYIN_INITIAL_MAP: Record<string, string> = {
  '雨': 'y', '花': 'h', '斋': 'z', '社': 's', '区': 'q', '助': 'z', '餐': 'c', '敬': 'j', '老': 'l', '家': 'j', '园': 'y',
  '义': 'y', '工': 'g', '服': 'f', '务': 'w', '站': 'z', '爱': 'a', '心': 'x', '驿': 'y', '全': 'q', '国': 'g', '总': 'z', '览': 'l',
  '省': 's', '市': 's', '县': 'x', '镇': 'z', '村': 'c', '街': 'j', '道': 'd',
  '厦': 'x', '门': 'm', '漳': 'z', '州': 'z', '泉': 'q', '福': 'f', '莆': 'p', '田': 't', '三': 's', '明': 'm',
  '南': 'n', '平': 'p', '龙': 'l', '岩': 'y', '宁': 'n', '德': 'd', '海': 'h', '沧': 'c', '思': 's', '湖': 'h',
  '里': 'l', '集': 'j', '同': 't', '安': 'a', '翔': 'x', '芗': 'x', '城': 'c', '文': 'w', '鲤': 'l', '丰': 'f',
  '泽': 'z', '洛': 'l', '江': 'j', '港': 'g', '晋': 'j', '石': 's', '狮': 's',
  '东': 'd', '西': 'x', '北': 'b', '中': 'z', '新': 'x', '大': 'd', '小': 'x', '店': 'd', '馆': 'g', '院': 'y'
};

function toPinyinInitials(text: string): string {
  return (text || '').split('').map((ch) => PINYIN_INITIAL_MAP[ch] || '').join('');
}

// 🔍 超管门店选择弹窗的搜索匹配：名称/城市/省份直接中文子串匹配；当搜索词为
// 纯字母时，额外用上面的拼音首字母表做一次匹配，两者任一命中即可
function matchStoreSearchKeyword(store: { storeName: string; city?: string; province?: string }, keyword: string): boolean {
  const name = (store.storeName || '').toLowerCase();
  const city = (store.city || '').toLowerCase();
  const province = (store.province || '').toLowerCase();
  if (name.includes(keyword) || city.includes(keyword) || province.includes(keyword)) return true;

  if (/^[a-z]+$/.test(keyword)) {
    const nameInitials = toPinyinInitials(store.storeName || '');
    const cityInitials = toPinyinInitials(store.city || '');
    if (nameInitials.includes(keyword) || cityInitials.includes(keyword)) return true;
  }
  return false;
}

const PATRIARCH_PROFILE_FIELD_LABELS: Record<string, string> = {
  partyMembers: '中共党员',
  socialWorkers: '社会工作者',
  volunteersCount: '志愿者',
  dineInSeniorsCount: '堂食老人',
  deliverySeniorsCount: '送餐老人',
  listeningSeniorsCount: '倾听陪伴老人',
  otherCount: '其他'
};

// 从 createIndexes 云函数返回的摘要字符串（"新建 N 条，已存在跳过 M 条，失败 0 条"）
// 提取数字，供口语化结果展示使用
function parseIndexSummary(summary: string): { created: number; skipped: number; failed: number } {
  const created = parseInt((summary.match(/新建\s*(\d+)\s*条/) || ['', '0'])[1], 10) || 0;
  const skipped = parseInt((summary.match(/跳过\s*(\d+)\s*条/) || ['', '0'])[1], 10) || 0;
  const failed  = parseInt((summary.match(/失败\s*(\d+)\s*条/) || ['', '0'])[1], 10) || 0;
  return { created, skipped, failed };
}

// 🌟 机构类型展示文案：按门店真实 orgType（manageStoreProfile 云函数 get 动作
// 返回，来自 stores.orgType 字段本身）区分归属徽标/文化入口/关于页标题——不靠
// 猜测店名文本、也不靠 tenantId 前缀。orgType 为空（历史门店未补录）时落到
// isSuperAdminView 决定的通用兜底文案，与 index.ts computeConceptCopy 同一套
// 三档（雨花斋/助老食堂-社区助餐/其余机构通用）区分口径，只是措辞按本页语境调整
function computeOrgDisplayCopy(orgType: string, isSuperAdminView: boolean): {
  orgTypeBadge: string; cultureTitle: string; aboutTitle: string;
} {
  if (orgType === 'yuhuazhai') {
    return { orgTypeBadge: '雨花斋', cultureTitle: '雨花文化与每日家训', aboutTitle: '关于雨花斋与阳光账本' };
  }
  if (orgType === 'elderly_canteen') {
    return { orgTypeBadge: '社区助餐', cultureTitle: '敬老助餐文化与每日家训', aboutTitle: '关于社区公益平台与阳光账本' };
  }
  return {
    orgTypeBadge: '',
    cultureTitle: '机构文化与每日家训',
    aboutTitle: isSuperAdminView ? '关于平台与阳光账本' : '关于本站与阳光账本'
  };
}

// 🎨 组织信息配置弹窗·机构类型选项：直接用 manageStoreProfile 云函数的
// VALID_ORG_TYPES 真实取值（不是 onboarding「新建组织」弹窗那份措辞/取值都对不上
// 后端的 orgTypeOptions/onboardingOrgType，两者是完全独立的两套字段，互不影响）。
// 选中后立即持久化写回 stores.orgType，全局品牌/文化文案（computeOrgDisplayCopy）
// 随之自动切换
const ORG_CONFIG_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'elderly_canteen',   label: '社区助餐 / 敬老家园' },
  { value: 'yuhuazhai',         label: '雨花斋' },
  { value: 'volunteer_station', label: '义工服务站 / 公益团队' }
];

Page({
  isNavigating: false,
  // ❤️ 爱心护持榜：ViewModel 本地缓存（10 分钟失效）+ 切换 Segment 防抖计时器，
  // 都是纯运行时状态，不需要触发 setData/持久化，与 isNavigating 同样挂在实例上
  _leaderboardCache: {} as Record<string, { time: number; data: any }>,
  _leaderboardFetchTimer: null as any,
  // 🐛 头像"退出重进又变回旧值"根因：loadUserProfile 里缓存优先渲染（快）与云端
  // fetchUserRole 刷新（慢，多一轮 checkUserRole 云函数往返）各自独立调用
  // applyAvatarUrl，谁的 getTempFileURL 请求先返回完全看网络时序，不保证按发起顺序
  // 落地——一旦云端刷新那次意外先于缓存那次 resolve，随后姗姗来迟的"缓存版"
  // setData 反而会把已经展示的最新头像覆盖回旧值。avatarApplySeq 按【发起顺序】
  // 单调递增，只有序号不小于当前已生效序号的结果才允许 setData，确保后发起的
  // （更新鲜的）结果永远不会被先发起、但后返回的旧结果覆盖。
  avatarApplySeq: 0,
  lastAppliedAvatarSeq: 0,
  // 🐛 fetchSeq 预占号只解决了"同一个 loadUserProfile 周期内，缓存渲染 vs
  // checkUserRole 刷新谁先 resolve"的时序竞争；但即使按发起顺序正确排到了最新一号，
  // checkUserRole 读到的 user_roles 记录本身仍可能是云数据库对"刚刚那次写入"的
  // 最终一致性延迟（写入后极短时间内的读请求命中了还没同步到的副本），返回一个
  // 比"我们自己刚刚上传确认过"的 fileID 更旧的 avatarUrl——这不是客户端时序问题，
  // 单靠调整 seq 无法解决。用这两个字段记录"上一次成功上传后确认为真"的 fileID
  // 与确认时刻，在这之后一段宽限期内，即使 checkUserRole 返回了不一致的旧值，
  // 也优先信任本地刚确认过的结果，而不是照单全收覆盖回去。
  lastConfirmedAvatarFileId: '',
  lastConfirmedAvatarAt: 0,

  // 🐛 防抖锁：onShow 每次切回本 Tab（tabBar 页面反复切入切出，不会重新 onLoad）
  // 都会调用 initMinePage()/loadUserProfile()，两者各自级联一整批云函数请求
  // （护持统计/护持榜/意见箱角标/义工投稿角标/成员申请角标/头像昵称...）。手快
  // 连续切换 Tab 时，上一轮请求还没返回，onShow 又把整批重新触发一次，与
  // statistics.ts fetchStatistics() 曾经的问题同一根因。这两个是纯运行时状态，
  // 不需要触发 setData，与上面 isNavigating 同样挂在实例上
  _initMinePageInFlight: false,
  _loadUserProfileInFlight: false,

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    // 🛡️ 自定义导航栏避让官方胶囊菜单：与 statistics.ts 同款方案，capsuleLeft/windowWidth
    // 用于给右上角"⋯"按钮换算出正确的右侧安全内边距，不再用固定 24rpx 硬编码贴右——
    // 不同机型胶囊按钮的实际左边距不同，硬编码在部分机型上会被胶囊直接盖住/裁切
    windowWidth: 0,
    capsuleLeft: 0,

    // ── 🎨 组织信息配置 Modal（大家长/店长/超管） ──────────────────────────────
    showOrgConfigModal:    false,
    orgConfigName:         '',   // 注册/显示名称
    orgConfigSlogan1:      '',   // 文化寄语 · 第一句
    orgConfigSlogan2:      '',   // 文化寄语 · 第二句
    orgConfigLogoUrl:      '',   // 门店 Logo（云文件 ID 或临时 URL）
    orgConfigSaving:       false,
    orgLogoLoadFailed:     false,   // 🛡️ Logo <image> 加载失败兜底，见 onOrgLogoLoadError
    // 🆕 机构/平台类型：真实 stores.orgType 字段，驱动全局品牌/文化文案。
    // index 供 picker 的 value 绑定，orgConfigOrgType 是实际要提交的 value token——
    // 与 onOnboardingOrgTypeChange/orgTypeIndex 同一套"index + value 双字段"约定
    orgConfigTypeOptions:  ORG_CONFIG_TYPE_OPTIONS,
    orgConfigOrgTypeIndex: 0,
    orgConfigOrgType:      'elderly_canteen',
    // ── ✏️ 快捷修改门店名称 Mini-Modal ───────────────────────────────────
    showEditStoreNameModal: false,
    tempStoreName:          '',   // 编辑中的临时名称
    editingStoreId:         '',   // 弹窗打开时锁定的目标 storeId（super_admin 必须传）
    editStoreNameSaving:    false,
    // ────────────────────────────────────────────────────────────────────

    // ── 🌐 新用户引导入驻 Modal ────────────────────────────────────────
    // 触发条件：用户无任何已审批角色（真正的全新用户），且未曾主动关闭过引导
    // 两条路径：① 创建新组织/门店  ② 通过邀请码加入现有门店
    showOnboardingModal: false,
    onboardingStep: 'choice' as 'choice' | 'create',
    // 创建新组织表单字段
    onboardingOrgName:   '',
    onboardingOrgType:   'charity' as string,
    onboardingStoreName: '',
    onboardingRealName:  '',
    onboardingPhone:     '',
    onboardingCreating:  false,
    // 组织类型选项（UI 选择器用）
    orgTypeOptions: [
      { value: 'charity',     label: '公益慈善' },
      { value: 'elderly_care',label: '助老食堂' },
      { value: 'community',   label: '社区义工站' },
      { value: 'vegetarian',  label: '素食餐厅' },
      { value: 'rescue',      label: '公益救援队' },
      { value: 'other',       label: '其他公益组织' }
    ],
    orgTypeIndex: 0,
    // ────────────────────────────────────────────────────────────────────

    currentUserRole: 'volunteer' as 'super_admin' | 'store_manager' | 'store_patriarch' | 'finance' | 'volunteer' | 'store_family',
    currentStoreName: '',
    // 🏪 门店运营状态：见 utils/storeManager.ts fetchAndSyncStoreStatus/getCachedStoreStatus，
    // 全局态与 Storage 双写同步，"查看店铺状态"菜单标题据此动态渲染
    currentStoreStatus: '',
    // 🛡️ 语义化权限状态：避免模板里反复重复 role 字符串比较
    hasPrivilege: false,
    // 🏛️ 门店管理权限并集：store_patriarch | store_manager | super_admin 任一满足即为 true，
    // 与 utils/authService.ts hasStoreAdminPrivilege() 口径完全一致，用于统一控制
    // 待审批入口显隐、成员申请角标预取等逻辑，避免各处重复枚举三个角色
    isStoreAdmin: false,
    isSuperAdmin: false,
    // 🌸 雨花斋专属功能开关：只由 fetchStoreOrgType() 查到的真实 stores.orgType === 'yuhuazhai'
    // 才置为 true——严禁用 tenantId 前缀猜测（见 initMinePage 根因修复注释：同一 tenantId
    // 前缀下完全可能挂着 elderly_canteen 等非雨花斋门店），初始值给最保守的 false
    isYuhuazhai: false,
    // 🆕 真实机构类型原始值（stores.orgType），供公告一键套用预设文案（见
    // getNoticeMgmtTemplate）等需要区分 elderly_canteen 的场景使用——isYuhuazhai
    // 只是个二值信号，不够精确
    orgType: '' as string,
    // 🆕 "关于与帮助"条目标题：initMinePage 里先给中性默认，fetchStoreOrgType() 拿到
    // 真实 orgType 后用 computeOrgDisplayCopy 覆盖，绝不在真实类型确认前展示任何
    // 具体机构品牌（雨花斋/社区助餐等），避免"社区助餐点被短暂/永久标成雨花斋"
    aboutTitle: '关于平台与阳光账本',
    // 🆕 顶部个人信息卡片的机构/平台归属短标签：同上，中性默认为空（不渲染徽标），
    // 由 fetchStoreOrgType() 按真实 orgType 计算后回填，不臆造未经验证的机构类型
    orgTypeBadge: '',
    // 📸 雨花温情图册与阳光凭证入口：从首页迁移至个人中心，见 loadRecentPhotos()。
    // recentPhotosLoaded 兼做"是否展示该入口"的总闸——义工/家人不加载、全国总览
    // 视角下也不加载（与原首页版本可见范围完全一致），未加载完成前入口不闪现
    recentPhotosTotal: 0,
    recentPhotosLoaded: false,
    // 🌸 门店管理中心「文化配置中心」入口标题：与 aboutTitle 同一套中性默认 + 真实
    // orgType 覆盖的两段式加载，原先是 WXML 里 isYuhuazhai 的内联三元表达式，
    // 收敛到 TS 集中计算
    cultureTitle: '机构文化与每日家训',
    // 🌟 isVolunteer 严格指"已审核通过的真实义工"，用于和 isFamily 互斥区分；
    // isFamily/isServiceUser：新用户/未审核用户的默认身份（家人 · 服务对象），
    // 底层 role 与真实义工共用同一个 'volunteer' 值，只能靠 status !== 'approved'
    // 这个信号区分（见 checkUserRole 云函数：未审核账号 role 恒为 volunteer）
    isVolunteer: false,
    isFamily: false,
    isServiceUser: false,
    // 🏛️ 家长管理 / 资源兜底卡片的显隐开关：家长本人或超管可见
    isPatriarch: false,
    // 💰 财务专属视图开关：严格等于 'finance' 角色（大家长虽含财务权限但用 isPatriarch 分流）
    isFinance: false,
    // 🗂️ 店长专属：精确区分 store_manager（不含家长/超管），驱动店长专属 WXML 分支
    isManager: false,
    // 🌟 视角切换预览：isRealSuperAdmin 恒等于真实身份，用于切换入口自身的显隐判断；
    // currentViewMode 与选项文案，供页面内的切换 Picker 使用
    isRealSuperAdmin: false,
    // 🏢 平台管理员（SaaS 运维方）：与业务角色 isSuperAdmin 彻底独立的另一个维度
    // （详见 authService.ts UserRole 定义处注释），仅用于"开发者与超管工具箱"里
    // "会员开通/续费管理"这一项的显隐判断，不参与任何业务权限计算
    isPlatformAdmin: false,

    // 🌐 超管【门店选择与搜索】弹窗：默认"全国总览"（currentInspectStoreId 为空），
    // 选中具体门店后进入单店巡检视角。这里的字段只在页面运行期间由本弹窗自己的
    // on* 处理函数写入（initMinePage 不会重置它们），与 currentStoreName/currentViewMode
    // 等"预览态"字段是两个独立维度——巡检只影响【门店档案】【门店日志】【门店餐饮与
    // 物资统计】这三张卡片展示的是哪家门店的数据，不改变超管本身的真实身份
    currentInspectStoreId: '',
    currentInspectStoreName: '',
    // 💖 全网爱心支持卡片：从统计页「全国数据看板」迁移过来——那里是数据密集的
    // 运营/财务分析场景，这类温情、鼓励性质的公开展示放在那儿意义不大；这里才是
    // 人人都会打开的个人中心，更适合公开展示。
    // 🐛 数据源已从"全租户所有门店"聚合改为调用与首页"阳光账本"同一个公开只读
    // 云函数 getSunshineLedger（见 fetchStoreLoveWallSummary），只查询用户自己
    // 归属门店的数据——此前借道 getNationalDashboard 会把其他门店的捐赠记录也
    // 一起带出来，不符合"只显示相应归属机构数据"的要求。getSunshineLedger 本身
    // 不做任何角色权限校验（首页阳光账本入口同款设计），家人/义工/财务/店长/
    // 大家长/超管等全部角色都能看到自己门店的这份公开数据
    storeLoveWallLoading: false,
    // 🆕 供 <yangshan-wall storeId="{{myStoreId}}"/> 组件绑定——组件自己拉取
    // 阳善公开名单，这里只需要保存解析出来的门店 ID
    myStoreId: '',
    storeLoveWallMeritRatio: { yangRatioPct: 0, yinRatioPct: 0 },
    showStorePickerModal: false,
    storePickerLoading: false,
    storePickerSearchText: '',
    storePickerAllStores: [] as Array<{ storeId: string; storeName: string; city: string; province: string }>,
    storePickerFilteredStores: [] as Array<{ storeId: string; storeName: string; city: string; province: string }>,
    // 🔐 套餐升级/续费半屏卡片：super_admin/store_patriarch 点击"会员开通/续费
    // 管理"时唤起，展示本机构当前套餐/到期时间，而不是像 platform_admin 那样
    // 跳转 pages/platform-admin（那个页面服务端只认 platform_admin，租户自己的
    // super_admin/家长点进去只会撞见硬拦截的"无权限访问"，体验很差）
    showSubscriptionModal: false,
    subscriptionLoading: false,
    subscriptionInfo: {
      planType: 'basic',
      planLabel: '基础版',
      isExpired: false,
      isExpiringSoon: false,
      // 🆕 isActive：ADVANCED 档位（pro/enterprise）且未到期——用这一个布尔值
      // 驱动弹窗"已开通/未开通"两种状态渲染，而不是在 WXML 里重复拼一遍
      // planType/isExpired 的判断表达式
      isActive: false,
      expireDateStr: ''
    },
    // 🆕 激活码自助兑换：无需人工审批，校验通过立即生效
    // 授权码输入区在新版 UI 中始终展示，无需 showActivationForm 开关
    activationCodeInput: '',
    activationSubmitting: false,
    currentViewMode: 'SUPER_ADMIN' as PreviewViewMode,
    viewModeOptionLabels: VIEW_MODE_OPTIONS.map((m) => PREVIEW_VIEW_MODE_LABELS[m]),
    viewModeOptionIndex: 0,
    // 🌟 视角切换半屏弹窗：常驻卡片列表数据 + 弹窗开关 + 待确认中的选择（点击卡片
    // 只是高亮暂存，点击"确认切换"才真正生效，与 switch-identity/subscription
    // 半屏弹窗同一套交互范式）
    viewModeCards: VIEW_MODE_CARDS,
    showViewModeModal: false,
    viewModeModalPendingMode: 'SUPER_ADMIN' as PreviewViewMode,
    // 🆕 确认按钮文案"确认切换至 [XX视角]"绑定这个字段，随 viewModeModalPendingMode
    // 同步更新（打开弹窗/点选卡片时一起写，避免 WXML 里再去反查 PREVIEW_VIEW_MODE_LABELS）
    viewModeModalPendingLabel: '超级管理员全景',
    // 🆕 模拟视角顶部 Warning 提示条：isRealSuperAdmin 为真且 currentViewMode 不是
    // 'SUPER_ADMIN' 本档时才为 true——与 isSuperAdmin（预览态会随之降级为 false）
    // 是两个独立信号，专门驱动页面顶部的"当前处于模拟视角"提示条 + 一键还原按钮
    isImpersonating: false,
    // 🆕 系统运维模块「清理缓存」动态体积展示：wx.getStorageInfoSync 同步读取，
    // 格式化为形如 "3.2MB" 的展示文案；取不到值时留空，WXML 侧不渲染该行
    cacheSizeText: '',
    stats: {
      volunteerDays: 0,
      volunteerHours: 0,
      submittedReports: 0,
      auditedReports: 0
    },

    // ❤️ 爱心护持榜：本月/年度/总贡献三档切换，前 20 名 + 当前登录用户自己的排名
    leaderboardRange: 'month' as 'month' | 'year' | 'total',
    leaderboardLoading: false,
    leaderboardList: [] as Array<{ rank: number; displayName: string; hours: number; isSelf: boolean }>,
    leaderboardSelfRank: 0,
    leaderboardSelfHours: 0,
    leaderboardGapToNext: 0,
    leaderboardTotalRanked: 0,

    // 🏛️ 家长管理 / 资源兜底：内嵌自已废弃的 pages/patriarch-dashboard，
    // 单独收拢进一个命名空间对象，避免和本页其余字段混在一起
    patriarchData: {
      loading: true,
      currentStoreId: '',
      storeName: '',
      patriarch: '',
      manager: '',
      monthLabel: '',
      monthDiners: 0,
      monthIncome: '0.00',
      monthExpense: '0.00',
      monthNet: '0.00',
      monthNetPositive: true,
      auditedCount: 0,
      totalCount: 0,
      verifyProgressPercent: 0,
      pendingVoidList: [] as any[],
      pendingProfileUpdate: null as any,
      pendingProfileItems: [] as { label: string; value: number }[],
      voidActionInFlight: false,
      profileActionInFlight: false
    },

    // 💰 财务稽核专区·数据看板：3 个 KPI 复用 getPatriarchDashboard（本月收支/
    // 稽核笔数，该云函数已放行 finance 角色查自己绑定门店）+ getRiskAlerts
    // （合规预警，此前在客户端从未被调用过的一个已就绪但闲置的云函数）两路数据，
    // 不新增云函数。见 fetchFinanceAuditData()
    financeAuditData: {
      loading: true,
      pendingReviewCount: 0,  // 待复核凭证 = 本月总笔数 - 已稽核笔数
      monthAuditTotal: '0.00', // 本月稽核总额 = 本月收入 + 本月支出（稽核职责覆盖的总流水规模）
      anomalyCount: 0          // 合规预警/异常 = getRiskAlerts 四类异常计数之和
    },

    // 🆕 大家长视角·底部个人荣誉模块折叠态：爱心护持榜 + 核心荣誉对大家长而言是
    // 次要信息（管理任务优先），默认收起只留一条摘要 + 展开按钮，避免管理向的
    // 大家长页面被拉得过长；其余角色（义工/店长/财务）保持一直展开，不受此字段影响
    patriarchHonorExpanded: false,

    showReleaseModal: false,
    releaseRoleLabel: '',
    // 🛡️ 当前正在操作退出的具体身份（大写，如 'STORE_MANAGER'）：多角色兼任场景下
    // 用户可能同时持有多个身份，退出必须精确指定剥离哪一个，不能笼统按主 role 字段处理
    releaseTargetRole: '',
    isReleasing: false,

    // 🏛️ 切换身份面板：点击"切换身份/退出当前绑定"时，若账号兼任多个身份
    // （cachedRole.roles.length > 1），优先展示这个面板——列出"切换至 X"选项
    // （纯客户端展示态切换，不改动服务端数据）+ 底部"退出当前门店绑定"按钮
    // （转入下面的 showReleaseModal 走真正的服务端卸任）；只有单一身份时跳过
    // 本面板，直接进入退出确认弹窗，与升级前的单身份体验保持一致
    showSwitchIdentityModal: false,
    switchableRoleOptions: [] as Array<{ role: string; label: string }>,

    // 🙋 头像昵称填写规范
    userAvatarUrl: '',
    // 🛡️ 头像加载失败兜底：userAvatarUrl 存在只代表"云端有这个 fileID"，不代表图片真的
    // 加载成功了（例如云存储读权限配置为"仅创建者可读"时，其他人查看会直接加载失败/空白）。
    // 单靠 wx:if="{{userAvatarUrl}}" 无法感知加载失败，必须由 <image> 的 binderror 显式上报，
    // 失败后降级展示 👤 占位图，而不是让用户看到一块空白
    avatarLoadFailed: false,
    // 🛡️ 成员头像加载失败兜底：按 avatarUrl 记录，成员管理列表/跨店成员列表/
    // 已选中成员卡片三处共用（见 onMemberAvatarError）
    memberAvatarFailedMap: {} as Record<string, boolean>,
    userNickName: '',
    avatarUploading: false,

    // 🌟 数字荣誉墙 + 电子证书
    badgeList: [] as Array<{
      id: string; emoji: string; name: string; meaning: string; unlocked: boolean; hint: string;
      unlockDesc: string; progressStatusText: string; progressCurrent: number; progressThreshold: number;
      progressUnit: string; progressPercent: number;
    }>,
    // 🎖️ 徽章详情弹窗：点击核心荣誉墙任一枚徽章时展示名称/图标/解锁条件/进度条
    showBadgeDetailModal: false,
    selectedBadge: null as null | {
      id: string; emoji: string; name: string; meaning: string; unlocked: boolean; hint: string;
      unlockDesc: string; progressStatusText: string; progressCurrent: number; progressThreshold: number;
      progressUnit: string; progressPercent: number;
    },
    showCertificateModal: false,
    certificateTempFilePath: '',
    certificateGenerating: false,
    // 家人版纯文本证书的落款日期："{{年}}年{{月}}月"，在 onOpenCertificateModal 里
    // 按打开时的实际日期动态生成，不硬编码具体年月避免几个月后文案过期失真
    certificateIssueDate: '',

    // 📮 爱心意见箱：小程序原生半屏弹窗，替代微信官方 open-type="feedback"——
    // 提交内容落进本项目自己的 feedback_submissions 集合，店长/运营才看得到
    showFeedbackModal: false,
    feedbackTypeOptions: [
      { key: 'meal', label: '🍱 餐饮菜品' },
      { key: 'env', label: '🧹 门店环境' },
      { key: 'volunteer', label: '🤝 义工服务' },
      { key: 'suggestion', label: '💡 运营建议' }
    ] as Array<{ key: string; label: string }>,
    feedbackSelectedType: 'meal',
    feedbackContent: '',
    feedbackSubmitting: false,

    // 📮 爱心意见箱管理：店长/家长/超管共用，与 patriarch-panel-card 共用同一次
    // 加载时机（initMinePage 里 isPatriarch || isSuperAdmin || 店长 时触发）
    pendingFeedbackCount: 0,
    showFeedbackAdminModal: false,
    feedbackAdminLoading: false,
    feedbackAdminTab: 'pending' as string, // ⏳ 当前选中 Tab：'pending' | 'handled'
    feedbackAdminList: [] as Array<{
      _id: string; nickName: string; type: string; typeLabel: string;
      content: string; status: string; createTimeStr: string; handling?: boolean;
      replyContent?: string; replyByName?: string; replyTimeStr?: string;
    }>,
    feedbackAdminPendingList: [] as Array<{
      _id: string; nickName: string; type: string; typeLabel: string;
      content: string; status: string; createTimeStr: string; handling?: boolean;
      replyContent?: string; replyByName?: string; replyTimeStr?: string;
    }>,
    feedbackAdminHandledList: [] as Array<{
      _id: string; nickName: string; type: string; typeLabel: string;
      content: string; status: string; createTimeStr: string; handling?: boolean;
      replyContent?: string; replyByName?: string; replyTimeStr?: string;
    }>,
    // 💬 回复家人：feedbackReplyingId 标记当前展开回复框的是列表里哪一条（空字符串=
    // 都没展开），同一时间只允许展开一条，避免多个 textarea 抢同一个 feedbackReplyContent
    feedbackReplyingId: '',
    feedbackReplyContent: '',
    feedbackReplySubmitting: false,

    // 📥 待审核的义工餐报与物资：店长/家长/超管共用，与"爱心意见箱管理"同一次
    // 加载时机（initMinePage 里 isPatriarch || isSuperAdmin || 店长 时触发）
    pendingVolunteerSubmissionCount: 0,
    showVolunteerSubmissionAdminModal: false,
    volunteerSubmissionAdminLoading: false,
    volunteerSubmissionAdminList: [] as Array<{
      _id: string; type: string; dateString: string; status: string; createTimeStr: string;
      nickName?: string; mealStatus?: string; breakfastCount?: number; lunchCount?: number;
      dinnerCount?: number; totalCount?: number; menuNote?: string;
      riceCount?: number; flourCount?: number; oilCount?: number; vegetableCount?: number;
      lossNote?: string; processing?: boolean;
    }>,
    // ❌ 驳回原因弹窗：与义工意见箱回复框同一套"记住当前操作的是哪一条"模式
    showRejectSubmissionModal: false,
    rejectSubmissionId: '',
    rejectSubmissionReason: '',
    rejectSubmissionSubmitting: false,
    // 🏷️ 快捷驳回标签：点击直接把常见驳回原因填进 textarea，减少店长手动打字
    quickRejectReasonTags: ['人数填写有误', '物资产量/斤数填错', '重复提交', '凭证/备注不清晰'] as string[],

    // 👥 待审批的本店成员申请（义工/财务）：店长/家长可见，与「爱心意见箱管理」
    // 同一套模态列表 + 角标视觉语言。🏛️ 待审批的高级角色与新店申请（店长/家长/
    // 新建门店）：仅超管可见。两张卡片共用同一个云函数 action listPendingApplications，
    // 服务端按 caller 角色分流返回对应队列，见 processRoleAudit
    pendingMemberApplicationCount: 0,
    showMemberApplicationModal: false,
    memberApplicationLoading: false,
    memberApplicationList: [] as Array<{
      applyId: string; realName: string; phone: string; requestedRole: string;
      requestedRoleLabel: string; applyTimeStr: string;
    }>,
    // ❌ 驳回申请原因弹窗：成员申请队列专用
    showRejectApplicationModal: false,
    rejectApplicationId: '',
    rejectApplicationQueue: 'member' as 'member',
    rejectApplicationReason: '',
    rejectApplicationSubmitting: false,

    // 👥 人员权限管理（已授权成员降级/移出）：店长/大家长/超管可操作
    showMemberManageModal: false,
    memberManageLoading: false,
    memberManageOperating: false,
    memberManageSearch: '',
    memberManageList: [] as Array<{
      applyId: string; realName: string; phone: string; phoneMasked: string;
      role: string; roleLabel: string; roleClass: string; timeStr: string; avatarUrl?: string;
    }>,
    memberManageFilteredList: [] as Array<{
      applyId: string; realName: string; phone: string; phoneMasked: string;
      role: string; roleLabel: string; roleClass: string; timeStr: string; avatarUrl?: string;
    }>,

    // 📞 联系超管：普通大家长遇到同级大家长锁态提示时，一键弹出超管联系电话/微信号
    showContactAdminModal: false,
    superAdminContactPhone: SUPER_ADMIN_CONTACT.phone,
    superAdminContactWechat: SUPER_ADMIN_CONTACT.wechat,

    // 🔐 门店管理员密钥：店长/大家长/超管均可查看已设置状态；大家长/超管额外
    // 可读取明文（服务端按权限决定返回 adminKey 原文还是仅返回 adminKeySet 布尔值）
    storeAdminKey: '',         // 明文，仅大家长/超管可见（服务端控制返回）
    storeAdminKeySet: false,   // 是否已设置（全管理岗位可见）
    storeAdminKeyVisible: false,
    showAdminKeyModal: false,
    adminKeyModalInput: '',
    adminKeyModalSaving: false,

    // 🎫 大家长生成本店邀请码：角色选择弹窗 + 结果展示弹窗
    showInviteModal: false,
    inviteTargetRole: 'VOLUNTEER' as string,
    inviteGenerating: false,
    showInviteResultModal: false,
    inviteResultCode: '',
    inviteResultQrFileId: '',
    inviteResultStoreName: '',
    inviteResultExpiresAt: 0,
    inviteQrLoadFailed: false,   // 🛡️ 邀请二维码 <image> 加载失败兜底，见 onInviteQrLoadError

    // 🛡️ 超管撤销管理权限：从成员卡片列表选择，或手动输入账号编号（兜底）
    showForceUnbindModal: false,
    forceUnbindMemberLoading: false,
    forceUnbindMemberList: [] as Array<{
      applyId: string; realName: string; phone: string; phoneMasked: string;
      role: string; roleLabel: string; storeName: string;
      avatarUrl?: string; openId?: string;
    }>,
    forceUnbindFilteredList: [] as Array<{
      applyId: string; realName: string; phone: string; phoneMasked: string;
      role: string; roleLabel: string; storeName: string;
      avatarUrl?: string; openId?: string;
    }>,
    forceUnbindSearchQuery: '',
    forceUnbindSelectedMember: null as null | {
      applyId: string; realName: string; phone?: string; phoneMasked?: string;
      roleLabel: string; storeName: string; avatarUrl?: string; openId?: string;
    },
    forceUnbindInput: '',              // 手动输入账号编号（兜底，无法从列表找到时使用）
    showForceUnbindManualInput: false, // 手动输入区折叠状态：默认收起，点击"找不到？"后展开
    forceUnbindSaving: false,
    forceUnbindResult: '',  // 操作结果描述，成功后展示
    // 🔑 超管重置门店密钥：门店选择卡片 + 新密钥输入
    showResetStoreKeyModal: false,
    resetStoreKeyStoreId: '',
    resetStoreKeyStoreName: '',
    resetStoreKeyStoreList: [] as Array<{ storeId: string; storeName: string }>,
    resetStoreKeyStoreListLoading: false,
    resetStoreKeyInput: '',
    resetStoreKeySaving: false,
    resetStoreKeyIsClearMode: false,
    // 门店搜索列表交互状态
    resetStoreKeyShowList: false,             // 是否展开门店选择列表
    resetStoreKeySearchText: '',              // 搜索框输入
    resetStoreKeyFilteredList: [] as Array<{ storeId: string; storeName: string }>,
    createIndexesRunning: false,      // 🗂️ 刷新数据库索引运行态锁
    // 🆕 系统管理面板「更多系统工具」折叠区展开态：一键加速系统/DEV 模拟开通是
    // 低频运维项，默认折叠收起，减少常驻占地方的零散提示块
    showAdminMoreTools: false,

    // 📢 公告管理半屏弹窗
    showNoticeManagementModal: false,
    noticeManagementList: [] as any[],
    noticeManagementLoading: false,
    noticeManagementView: 'list' as 'list' | 'edit',
    noticeMgmtEditId: '',
    noticeMgmtEditTitle: '',
    noticeMgmtEditContent: '',
    noticeMgmtEditTag: '',
    noticeMgmtSaving: false,
    noticeMgmtDeletingId: '',

    // 🍚 门店餐饮与物资统计：不新建汇总表，即时查询 volunteer_submissions/
    // material_logs（见 manageVolunteerSubmission 的 statsSummary 动作），
    // 义工/店长/家长/超管共用同一个入口和同一份数据
    showStoreStatsModal: false,
    storeStatsLoading: false,
    storeStats: {
      today: '',
      mealTotals: { breakfastCount: 0, lunchCount: 0, dinnerCount: 0, totalCount: 0 },
      todayMaterialTotals: { riceCount: 0, flourCount: 0, oilCount: 0, vegetableCount: 0 },
      monthMaterialTotals: { riceCount: 0, flourCount: 0, oilCount: 0, vegetableCount: 0 }
    },
    // 🌱 今日三餐人数 + 今日物资消耗是否全为 0——用于弹窗底部"今日暂无录入数据"
    // 空状态引导的显隐判断，见 onOpenStoreStatsModal
    storeStatsAllZero: false,

    // 🆕 店长视角【本店数据概览】2x2 核心指标卡片：今日用餐人次/今日义工打卡
    // 直接复用 manageVolunteerSubmission 的 statsSummary 聚合结果（该云函数
    // 早已为「门店餐饮与物资统计」弹窗算好 mealTotals.totalCount 与
    // todayVolunteerCount，这里只是额外取用同一份数据，不新增云函数）；
    // 待审批事项无需单独字段，直接在 WXML 里对 pendingMemberApplicationCount/
    // pendingVolunteerSubmissionCount/pendingFeedbackCount 三个已加载的角标求和；
    // 结余概览见 fetchManagerTodaySnapshot 注释
    todayMealsCount: 0,
    todayVolunteersCount: 0,
    storeNetBalance: '0.00',

    // 💌 家人端【我的反馈与回复】：与提交共用同一个半屏弹窗，靠 feedbackModalTab
    // 切换两块内容；unreadReplyCount 只对家人身份加载（initMinePage 里 isFamily 时触发）
    unreadReplyCount: 0,
    feedbackModalTab: 'submit' as 'submit' | 'mine',
    myFeedbackLoading: false,
    myFeedbackList: [] as Array<{
      _id: string; type: string; typeLabel: string; content: string; status: string;
      createTimeStr: string; replyContent?: string; replyByName?: string; replyTimeStr?: string;
    }>,

    // 🍱 义工现场服务工具：菜单人数 + 物资消耗，两个独立的半屏填报 Sheet，均已
    // 提炼为独立自定义组件（daily-menu-modal/material-usage-modal，与首页共用），
    // 表单状态/提交逻辑在组件内部，页面只持有控制显隐的这两个字段
    showDailyMenuModal: false,
    showMaterialUsageModal: false,

    // 📄 义工版【我的餐报提交记录】：查的是 volunteer_submissions（义工自己提交的
    // 菜单/物资原始记录），不是 report_logs——义工从不写 report_logs，那张表继续
    // 只服务店长/财务的正式台账历史（/pages/history/history?view=mine）
    showMyVolunteerSubmissionsModal: false,
    myVolunteerSubmissionsLoading: false,
    // 🔴 "我的餐报提交记录"入口角标：myVolunteerSubmissionsList 里 status==='rejected'
    // 的条数，见 fetchMyVolunteerSubmissions()
    rejectedCount: 0,
    myVolunteerSubmissionsList: [] as Array<{
      _id: string; type: string; dateString: string; status: string; createTimeStr: string;
      mealStatus?: string; breakfastCount?: number; lunchCount?: number; dinnerCount?: number;
      totalCount?: number; menuNote?: string;
      riceCount?: number; flourCount?: number; oilCount?: number; vegetableCount?: number;
      lossNote?: string; rejectReason?: string;
    }>,
    // 📊 「我的提交与数据」弹窗顶部月度统计摘要，见 computeMonthlySubmissionStats()
    monthlySubmissionStats: { total: 0, approved: 0, pending: 0, rejected: 0 },
  },

  onLoad() {
    this.calculateNavBarHeight();
    this.hydrateConfirmedAvatarFromStorage();
  },

  // 🛡️ 从本地持久化恢复"上一次上传确认为真"的头像记录：见 CONFIRMED_AVATAR_CACHE_KEY
  // 处的根因说明。只在页面刚创建（onLoad）时读一次即可——之后同一个实例存活期间
  // 一直靠内存里的这两个字段，onChooseAvatar 成功时会同步更新内存与本地持久化两处。
  hydrateConfirmedAvatarFromStorage() {
    try {
      const saved = wx.getStorageSync(CONFIRMED_AVATAR_CACHE_KEY);
      if (saved && saved.fileId && typeof saved.at === 'number') {
        this.lastConfirmedAvatarFileId = saved.fileId;
        this.lastConfirmedAvatarAt = saved.at;
      }
    } catch (err) {
      console.warn('[profile] 恢复头像确认记录失败:', err);
    }
  },

  onShow() {
    console.log('[verify] profile.onShow 已触发, 当前 userAvatarUrl=', this.data.userAvatarUrl);
    this.isNavigating = false;

    // 🐛 性能修复（Page.onShow took 67ms 警告）：initMinePage() 在真正发起网络
    // 请求之前，有一大段纯同步的角色/门店展示态计算（storageRole/globalData 融合、
    // applyRoleViewOverride 等），loadUserProfile()/refreshStoreStatus() 各自也有
    // 一小段同步的"先读缓存 setData 一次"逻辑——这些同步开销此前直接算在 onShow
    // 本次调用栈里，onShow 本身要等这些计算全部跑完才能 return。用 wx.nextTick
    // 把这三个调用挪到下一个任务队列，onShow 自身几乎立即返回；三者内部原有的
    // _initMinePageInFlight/_loadUserProfileInFlight 防抖锁不受影响，视觉上
    // 仍是同一帧内完成，用户感知不到延迟，只是不再计入 onShow 本身的耗时
    wx.nextTick(() => {
      this.initMinePage();
      this.loadUserProfile();
      this.refreshStoreStatus();
    });

    // 🌟 同步自定义 TabBar 高亮态（见 index.ts onShow 中的说明）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }

    // 📦 统计页/其他页跳转过来后自动唤起套餐订购弹窗（避免"请在个人中心开通"死循环）
    if (takeOpenSubscriptionRequest()) {
      // initMinePage 是异步的，稍等一帧确保角色数据已就绪再唤起弹窗
      setTimeout(() => this.onOpenSubscriptionModal(), 300);
    }
  },

  // 🛡️ 内存泄漏防护：profile 是 tabBar 页面，正常使用中几乎不会真正走到 onUnload
  // （切 Tab 只触发 onHide，实例常驻到小程序退出），但页面存活期间持有的
  // _leaderboardFetchTimer 是一个尚未触发的 setTimeout 防抖计时器
  // （fetchLeaderboard 里创建）——用户切走后如果不清掉，它仍会在背景按原计划
  // 触发一次不再需要展示的 setData。onHide/onUnload 都清一次，避免计时器悬空。
  // 两个 InFlight 锁不在这里复位：它们各自的 try/finally 或 .finally() 已经能
  // 保证请求无论成功/失败/页面是否可见都会在自己的异步链路末尾正确清零，这里
  // 提前清零反而会在用户快速切回本 Tab 时，跟仍在途的上一轮请求形成新的并发
  onHide() {
    this.clearPendingLeaderboardTimer();
  },

  onUnload() {
    this.clearPendingLeaderboardTimer();
  },

  clearPendingLeaderboardTimer() {
    if (this._leaderboardFetchTimer) {
      clearTimeout(this._leaderboardFetchTimer);
      this._leaderboardFetchTimer = null;
    }
  },

  calculateNavBarHeight() {
    try {
      const sysInfo = getSafeSystemInfo();
      const statusBarHeight = sysInfo.statusBarHeight || 20;
      const windowWidth = sysInfo.windowWidth || 375;
      const menuButton = wx.getMenuButtonBoundingClientRect();
      let navBarHeight = 44;
      // 官方胶囊默认宽度约 87px 的兜底估算，避免 API 不可用时右侧完全不避让
      let capsuleLeft = windowWidth - 87;
      if (menuButton) {
        navBarHeight = (menuButton.top - statusBarHeight) * 2 + menuButton.height;
        capsuleLeft = menuButton.left;
      }
      this.setData({
        statusBarHeight,
        navBarHeight: navBarHeight || 44,
        windowWidth,
        capsuleLeft
      });
    } catch (e) {
      console.warn('Calc height fallback:', e);
    }
  },

  async initMinePage() {
    let role: string = 'volunteer';
    let storeName = '';

    const cachedRoleInfo = AuthService.getCachedRoleInfo();
    if (cachedRoleInfo && cachedRoleInfo.role) {
      role = cachedRoleInfo.role;
      storeName = cachedRoleInfo.storeName || '';
    }

    // 🐛 根因修复："已选超级管理员，个人页却仍按店长渲染"：trueServerRole 是
    // checkUserRole 云函数下发、AuthService 缓存的服务端真实角色快照，在下面
    // storageRole 覆盖 role 之前先留一份。此前 isRealSuperAdmin/isPlatformAdmin
    // 直接用 role 计算，而 role 会被 storageRole（store-picker 角色胶囊"手动切换
    // 身份"写入的 current_user_role）无条件覆盖——超管只要曾经切换到过任意一个
    // 门店角色视角，role 就永久变成那个角色，isRealSuperAdmin 也随之被错误拉低
    // 为 false，连累"开发者与超管工具箱"消失、"视角切换预览"入口本身也一起消失
    // （下面 applyRoleViewOverride 的 realRole 参数同样吃了这个污染）。这两个
    // "真身份"标志位必须锚定在 trueServerRole 上，永远不受 storageRole 影响。
    const trueServerRole = (cachedRoleInfo && cachedRoleInfo.role) || 'volunteer';

    // 🌟 家人（服务对象）默认判定：新用户/未审核用户在 checkUserRole 云函数里
    // role 恒为 'volunteer' 且 status !== 'approved'，用这个组合区分"真实义工"
    // 与"默认家人视角"，不会误伤已审核通过的真实义工（那时 status === 'approved'）。
    // 这只是没有手动切换过身份时的兜底默认值，下面 storageRole 一旦存在就优先生效
    let isFamily = role === 'volunteer' && (!cachedRoleInfo || cachedRoleInfo.status !== 'approved');

    // 🛡️ 强制优先读取切换后的生效角色，严禁被 cachedRoleInfo 覆盖降级：store-picker
    // 切身份/切店（首页的全局 storePicker、本页嵌入的 patriarchStorePicker 都共用
    // 同一套 _applyRoleSwitch 持久化逻辑）会同步写入这个 key——只要它存在，就必须
    // 无条件以它为准，完全不再理会上面基于 cachedRoleInfo 算出的默认值/isFamily
    // 兜底判断，否则"选了家长/家人但刷新后又被服务端缓存的 volunteer 打回原形"。
    // 收敛调用 AuthService.resolveEffectiveRole——与 index.ts initCurrentUserRole
    // 共用同一份集中实现（含"生效角色与持久化缓存不一致时自动回写"），不再各自
    // 维护一份几乎一样的判断逻辑
    // 🛡️ 多信号融合：依次尝试三个来源，取最新、最精确的生效角色
    // 1) current_user_role（手动切换身份写入，最高优先级）
    // 2) app.globalData.currentStore.role（store-picker storechange 事件后立即同步，
    //    可能比 current_user_role 更晚落地，适合作为 Storage 为空时的补充信号）
    // 3) cachedRoleInfo.role（服务端真实角色快照，兜底默认）
    const storageRole = wx.getStorageSync('current_user_role');

    // 🌟 globalData 补充信号：store-picker 触发的 _applyRoleSwitch 会同时写
    // current_user_role 与 app.globalData.currentStore，两者理论上同步落地；
    // 但在极端情况（Storage 写失败或时序差异）下，globalData 可以作为一致性兜底
    const app = getApp() as any;
    const globalStoreRole = (app && app.globalData && app.globalData.currentStore && app.globalData.currentStore.role) || '';
    // globalStoreRole 是大写 token（如 'VOLUNTEER'/'MANAGER'/'PATRIARCH'），需要映射到 snake_case
    const globalRoleMap: Record<string, string> = {
      MANAGER: 'store_manager', STORE_MANAGER: 'store_manager',
      FINANCE: 'finance',
      PATRIARCH: 'store_patriarch', STORE_PATRIARCH: 'store_patriarch',
      ADMIN: 'super_admin', SUPER_ADMIN: 'super_admin',
      VOLUNTEER: 'volunteer',
      FAMILY: 'store_family', STORE_FAMILY: 'store_family'
    };
    const globalRoleLower = globalStoreRole ? (globalRoleMap[globalStoreRole.toUpperCase()] || '') : '';

    if (storageRole) {
      const persistedRole = (cachedRoleInfo && cachedRoleInfo.role) || 'volunteer';
      // 🐛 超级管理员专属豁免：current_user_role 对超管只是展示层的视角切换预览
      // 或 store-picker 切门店时的角色模拟，并不代表真实角色发生了变更——不能走
      // resolveEffectiveRole → overwriteCachedRole 把 auth_user_role 持久化缓存
      // 覆写成被预览的非超管角色。否则下次 initMinePage()（如切换视角后立即刷新）
      // 时 getCachedRoleInfo().role 会返回已被污染的角色而不是 'super_admin'，
      // 导致 isRealSuperAdmin 被错误拉低为 false，"管理视角切换"卡片随之消失。
      if (trueServerRole === 'super_admin') {
        role = storageRole.toLowerCase();
      } else {
        role = AuthService.resolveEffectiveRole(persistedRole).toLowerCase();
      }
      // 手动切换的具体身份说了算：选家人就是家人，选除家人外的任何身份
      // （含义工/家长/店长/财务/超管）都不再是"默认未审核家人"视角
      isFamily = role === 'store_family';
    } else if (globalRoleLower && globalRoleLower !== role) {
      // 🌟 Storage 无明确记录时，globalData 是第二信号：首页 store-picker 刚切换过
      // 身份、但 current_user_role 尚未落地（极少数情况），用 globalData 补全
      role = globalRoleLower;
      isFamily = role === 'store_family';
    } else {
      // 🛡️ 三路信号都缺失时：兜底仍用 cachedRoleInfo 的服务端快照，但此时必须
      // 重新判定 isFamily——服务端值恒为 'volunteer'，不能区分"真实义工"与
      // "默认家人视角"，需用 status !== 'approved' 再做一次精确区分
      isFamily = role === 'volunteer' && (!cachedRoleInfo || cachedRoleInfo.status !== 'approved');
    }
    console.log('[verify] initMinePage 角色解析: cachedRole=', cachedRoleInfo && cachedRoleInfo.role, 'storageRole=', storageRole, 'globalRole=', globalRoleLower, '-> 生效role=', role);

    const storageStoreName = wx.getStorageSync('current_store_name');
    if (storageStoreName) {
      storeName = storageStoreName;
    }

    if (!storeName) {
      const activeStore = getSelectedStore();
      if (activeStore && activeStore.storeName) {
        storeName = activeStore.storeName;
      }
    }

    // 🐛 用 trueServerRole（服务端真实角色快照），不用可能已被 storageRole
    // 覆盖的 role——这两个是"真身份"标志位，任何本地切换视角/预览都不该动摇。
    // 🛡️ 双信号兜底：当 cachedRoleInfo 尚未刷新（极端冷启动/缓存清除场景）时，
    // globalRoleLower === 'super_admin' 作为补充信号，避免"管理视角切换"卡片消失
    const isRealSuperAdmin = trueServerRole === 'super_admin' || globalRoleLower === 'super_admin';
    // 🏢 平台管理员：与业务角色是两个独立维度，platform_admin 不会经过下面的
    // applyRoleViewOverride 预览覆盖（那套只针对 super_admin），直接按真实角色判定
    const isPlatformAdmin = trueServerRole === 'platform_admin';

    // 🌟 视角切换预览：仅真实身份为 super_admin 时才可能生效，展示层降级模拟
    // 店长/财务视角；hasPrivilege 随预览角色一并变化（volunteer 视角下应隐藏管理入口）
    // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
    // 🐛 realRole 参数必须传 trueServerRole，不能传 role——否则超管一旦切换过
    // 门店角色视角，这里的 realRole !== 'super_admin' 会直接短路返回，"视角切换
    // 预览"这张卡片本身（WXML 用 isRealSuperAdmin 控制显隐）和降级模拟功能
    // 会一起失效
    //
    // 🐛 核心 Bug 修复："选择服务站点与身份"弹窗切换身份后，个人中心角色被覆盖
    // 还原：storageRole（手动切换，上面已解析进 role）与"管理视角切换"预览
    // （super_admin_preview_view_mode，applyRoleViewOverride 内部读取）是两套
    // 完全独立的本地覆盖机制。此前不论 storageRole 是否存在，都无条件跑一遍
    // applyRoleViewOverride——如果超管此前用过"管理视角切换"预览过任意非默认
    // 角色（哪怕是很久以前、且从未点过"还原超管视角"清空这份预览态），这份陈旧
    // 的预览选择就会在每次 initMinePage()（含每次 onShow）时把刚刚手动切换好的
    // storageRole 结果直接覆盖回预览角色，表现为"明明刚在门店选择器/切换身份
    // 弹窗里选了身份，一进个人中心又变回另一个角色"。
    // 手动切换是用户在【选择服务站点与身份】/【切换身份】弹窗里的显式、最新操作，
    // 必须无条件优先于可能陈旧的视角预览——只有完全没有手动切换记录
    // （storageRole 为空）时，才轮到 applyRoleViewOverride 的预览覆盖生效。
    // isRealSuperAdmin 不受这里影响，"管理视角切换"卡片本身依旧正常展示；
    // 该卡片自己的 onConfirmViewModeModal/onResetToDefaultViewMode（见下方
    // applyViewModeSwitch）会在用户显式选择/还原视角时清空 storageRole，让预览
    // 重新拿回控制权——这就是需求里"除非用户主动点击了还原按钮"的落地方式
    // 🐛 门店管理中心卡片消失的根因：这里的 isSuperAdmin 是"当前展示角色是否为
    // 超管"的展示态标志（WXML 全站都拿它当"只有超管本人视角才显示"的互斥开关），
    // 不是"真实身份是否为超管"——那是 isRealSuperAdmin 的职责。手动切换成
    // store_manager/finance/store_patriarch/volunteer/store_family 后，role 已经
    // 不是 'super_admin' 了，这里却仍然把 isSuperAdmin 恒等于 isRealSuperAdmin
    // （true），导致【门店管理中心】等一堆 wx:if="{{isManager && !isSuperAdmin}}"
    // 的角色专属卡片，在"超管手动切到店长视角"这个组合状态下被误判为"仍是超管
    // 视角"而集体消失，同时还错误触发了【巡检提示条】等只该在真正超管视角出现
    // 的顶部提示条一起堆叠。改为与 applyRoleViewOverride 内部 switch 分支完全
    // 一致的口径：只有手动选择的展示角色本身就是 'super_admin' 时才为 true
    const overridden = storageRole
      ? {
          currentUserRole: role, isVolunteer: role === 'volunteer',
          isManager: role === 'store_manager' || role === 'store_patriarch',
          isFinance: role === 'finance' || role === 'store_patriarch',
          isSuperAdmin: role === 'super_admin',
          isFamily
        }
      : applyRoleViewOverride(trueServerRole, {
          currentUserRole: role, isVolunteer: role === 'volunteer',
          isManager: role === 'store_manager' || role === 'store_patriarch',
          isFinance: role === 'finance' || role === 'store_patriarch',
          isSuperAdmin: isRealSuperAdmin,
          isFamily
        });
    const displayRole = overridden.currentUserRole;
    const hasPrivilege = displayRole === 'store_manager' || displayRole === 'finance' || displayRole === 'store_patriarch' || displayRole === 'super_admin';
    // 🏛️ 门店审批权限并集：统一走 hasStoreAdminPrivilege()，与云函数口径保持一致
    const isStoreAdmin = hasStoreAdminPrivilege(displayRole);
    // 🐛 根因修复（第二版）：视角提示 Banner（sa-status-bar）与"管理视角切换"卡片
    // （view-mode-switch-card）都读同一个 currentViewMode/viewModeOptionIndex，
    // 但 storageRole（store-picker 手动切换身份，最高优先级）与"视角切换预览"
    // 是两套完全独立的本地存储。上一版修复把 storageRole 命中时的 currentViewMode
    // 硬编码为 'SUPER_ADMIN'，确实修好了 Banner（不再显示过期的预览文案），却
    // 引入新问题：view-mode-switch-card 没有 isImpersonating 这层门槛、只要
    // isRealSuperAdmin 就常驻显示，于是不管手动切到哪个角色，它都会一直显示
    // "超级管理员全景"这个写死的默认值——超管手动切到店长后，页面明明整屏都是
    // 店长内容，这张卡片却继续大喇喇写着"超级管理员全景"，文不对题。
    // 根本问题不是"要不要显示预览态"，而是"预览态的取值必须真实反映当前正在
    // 展示的角色"——手动切换本质上也是一种"当前正在以 XX 视角浏览"，只是触发
    // 方式（store-picker）与视角切换弹窗不同，二者的展示结果理应统一。这里改为
    // 把 storageRole 对应的 role 映射到同一套 PreviewViewMode 枚举，Banner 和
    // 卡片这下读到的都是与页面实际内容一致的值，不再需要靠"强制清零"掩盖错位
    const roleToViewMode: Record<string, PreviewViewMode> = {
      super_admin: 'SUPER_ADMIN',
      store_patriarch: 'STORE_PATRIARCH',
      store_manager: 'STORE_MANAGER',
      finance: 'FINANCE',
      volunteer: 'VOLUNTEER',
      store_family: 'FAMILY'
    };
    const currentViewMode = storageRole
      ? (roleToViewMode[role] || 'SUPER_ADMIN')
      : getPreviewViewMode();
    // 🏛️ 家长管理卡片显隐：VIEW_MODE_OPTIONS 现已补齐 STORE_PATRIARCH 档位，
    // displayRole === 'store_patriarch' 既可能是真实角色本身就是家长，也可能是
    // 超管切到了"大家长视角"预览——两种情况都应该展示家长管理卡片，口径不变
    const isPatriarch = displayRole === 'store_patriarch';
    // 💰 财务专属：严格等于 finance 角色本身（大家长虽继承财务权限，但用 isPatriarch
    // 分流自己的视图，不在这里与 isFinance 混用，避免财务板块重复出现）
    const isFinance = displayRole === 'finance';
    // 🗂️ 店长专属：用于在 WXML 里精确区分"只有店长才看到"的内容，不包括家长/超管
    const isManager = displayRole === 'store_manager';
    // 🌟 isVolunteer/isFamily 均已随 applyRoleViewOverride 一起降级模拟：真实
    // 义工视角下 isVolunteer=true、isFamily=false；家人视角下相反。两者底层
    // currentUserRole 都是 'volunteer'，靠 isFamily 区分展示哪一套版面
    isFamily = overridden.isFamily;
    const isVolunteer = overridden.isVolunteer;
    console.log('[verify] initMinePage 计算结果: displayRole=', displayRole, 'isPatriarch=', isPatriarch, 'isFinance=', isFinance, 'isFamily=', isFamily, 'isVolunteer=', isVolunteer);

    // 🐛 根因修复："社区助餐点被标成雨花斋"：此前这里用 tenantId.startsWith('yuhuazhai')
    // 当"是否雨花斋"的信号——但 tenantId 只是历史租户/建店命名空间，同一个 tenantId
    // 前缀下完全可能挂着 elderly_canteen（社区助餐点）等非雨花斋门店，这个猜测口径
    // 从根上就不可靠，绝不能拿来驱动品牌/机构类型展示。isYuhuazhai 与 orgTypeBadge/
    // cultureTitle/aboutTitle 现在统一先用中性默认（"未知机构"既不猜雨花斋也不猜
    // 社区助餐），下方 fetchStoreOrgType() 查到 stores.orgType 真实值后立即用它覆盖
    // ——宁可首屏短暂显示通用文案，也绝不允许把错误的品牌标签展示给用户
    const isYuhuazhai = false;
    const orgCopy = computeOrgDisplayCopy('', overridden.isSuperAdmin);
    const aboutTitle = orgCopy.aboutTitle;
    const orgTypeBadge = orgCopy.orgTypeBadge;
    const cultureTitle = orgCopy.cultureTitle;

    // 🐛 顶部"归属机构"与巡检门店脱节的根因：onSelectInspectStore 只在触发那一刻
    // 单独 setData 过一次 currentStoreName，是个"一次性"展示态；但 initMinePage()
    // 在每次 onShow（切 Tab 回来）都会重新跑到这里，用 current_store_name 本地缓存/
    // getSelectedStore() 重新算一遍 storeName 并整体覆盖 currentStoreName，把刚才
    // 巡检门店时写入的展示值悄悄冲掉，变回超管自己绑定的门店（或空）——与下方
    // sa-store-indicator Pill 展示的巡检门店对不上。这里显式接管：真超管处于巡检
    // 具体门店（currentInspectStoreId 非空，即非"全国总览"）时，"归属机构"必须
    // 跟随巡检目标，而不是走通用的本地缓存/全局已选门店兜底路径
    if (isRealSuperAdmin && this.data.currentInspectStoreId) {
      storeName = this.data.currentInspectStoreName || storeName;
    }

    this.setData({
      currentUserRole: displayRole as any,
      currentStoreName: storeName,
      hasPrivilege,
      isStoreAdmin,
      isSuperAdmin: overridden.isSuperAdmin,
      isRealSuperAdmin,
      isPlatformAdmin,
      isPatriarch,
      isFinance,
      isManager,
      isVolunteer,
      isFamily,
      isServiceUser: isFamily,
      isYuhuazhai,
      aboutTitle,
      orgTypeBadge,
      cultureTitle,
      currentViewMode,
      viewModeOptionIndex: VIEW_MODE_OPTIONS.indexOf(currentViewMode),
      isImpersonating: isRealSuperAdmin && currentViewMode !== 'SUPER_ADMIN'
    });

    // 🆕 系统运维模块的缓存体积展示仅超管工具箱可见，非超管账号跳过这次同步读取
    if (isRealSuperAdmin) {
      this.refreshCacheSize();
    }

    // fetchMeritStats 按真实角色查询（super_admin 本就同时满足 store_manager/finance 两类统计条件，
    // 预览视角切换时无需重新查询，WXML 侧的显隐已经按 currentUserRole 展示角色自动收敛）
    this.loadVolunteerStats();
    // ❤️ 爱心护持榜：家人视角没有护持数据，不加载；命中 10 分钟本地缓存时不打云函数
    // （fetchLeaderboard 自带 ViewModel 缓存 + 连点防抖，不需要下面这道锁）
    if (!isFamily) {
      this.fetchLeaderboard();
    }

    // 🐛 防抖锁：下面这一批才是 initMinePage() 里真正的网络开销所在（护持统计/
    // 家长大盘/意见箱角标/义工投稿角标/成员申请角标/未读回复角标）。tabBar 页面
    // 反复切入切出时，onShow 可能在上一轮这批请求还没返回就又触发一次
    // initMinePage()——已有一轮在途时直接跳过本轮，等它自己 finally 解锁，而不是
    // 让两轮并发叠加产生重复请求。上面已经落地的角色/门店名等同步展示态完全不受
    // 这道锁影响，任何调用方（含"切换预览视角"等需要立即刷新展示的场景）都始终
    // 能拿到最新值，只有这条尾巴上的后台数据刷新会被去重
    if (this._initMinePageInFlight) {
      console.log('[profile][initMinePage] 已有一轮后台数据刷新在途，跳过本次重复触发');
      return;
    }
    this._initMinePageInFlight = true;

    const pendingFetches: Promise<any>[] = [this.fetchMeritStats(role), this.fetchStoreOrgType(), this.loadRecentPhotos()];

    // 🏛️ 家长管理 / 资源兜底：仅家长本人或超管（含预览降级后的超管，与卡片
    // wx:if 口径保持一致）才需要加载，避免给普通义工/店长/财务发多余的云函数请求
    if (isPatriarch || overridden.isSuperAdmin) {
      pendingFetches.push(this.fetchPatriarchDashboardData());
    }

    // 💰 财务稽核专区【数据看板】：仅 isFinance（严格等于 finance 角色本身，
    // 不含继承了财务权限的大家长——大家长有自己的家长大盘卡片）
    if (isFinance) {
      pendingFetches.push(this.fetchFinanceAuditData());
    }

    // 📮 爱心意见箱管理入口的可见范围：大家长/店长/超管（财务义工无管理面板）
    // 口径与 hasStoreAdminPrivilege() 完全一致，不再各处重复枚举三个角色
    if (isStoreAdmin) {
      pendingFetches.push(this.fetchPendingFeedbackCount());
      pendingFetches.push(this.fetchPendingVolunteerSubmissions());
      pendingFetches.push(this.fetchPendingApplications());
      // 🔐 管理员密钥状态：在管理面板里展示，与其他管理数据同一批并发加载
      pendingFetches.push(this.loadStoreAdminKey());
    }

    // 🆕 店长专属【本店数据概览】2x2 卡片：仅 isManager（不含大家长/超管，两者
    // 各有自己的大盘卡片）时拉取今日用餐人次/今日义工打卡/结余概览
    if (isManager) {
      pendingFetches.push(this.fetchManagerTodaySnapshot());
    }

    // 💌 家人端未读回复红点：与上面管理端角标是两套完全独立的计数
    // （一个数"店里有几条没处理"，一个数"我提交的意见有几条被回复了没看"）
    if (isFamily) {
      pendingFetches.push(this.fetchUnreadReplyCount());
    }

    // 🔴 义工端"我的餐报提交记录"入口角标：提前查一次自己的提交列表算出
    // rejectedCount，让红点在打开半屏弹窗之前就能在入口上看到，与上面
    // fetchPendingVolunteerSubmissions() 给店长端角标提前预取的做法保持一致
    if (isVolunteer && !isFamily) {
      pendingFetches.push(this.fetchMyVolunteerSubmissions(true));
    }

    // 💖 全网爱心支持卡片数据：改走公开只读云函数 getSunshineLedger（不做任何
    // 角色权限校验，与首页阳光账本入口同款），全部角色都可以发起这次查询，
    // 不再像 getNationalDashboard 那样需要跟后端 ALLOWED_ROLES 白名单对齐——
    // fetchStoreLoveWallSummary 内部会先解析用户自己归属的门店 storeId，
    // 解析不到（无绑定门店的新用户）时函数自己直接跳过，不发起无效请求
    pendingFetches.push(this.fetchStoreLoveWallSummary());

    try {
      await Promise.allSettled(pendingFetches);
    } finally {
      this._initMinePageInFlight = false;
    }

    // 🌐 新用户引导：全新未归属用户（无门店/角色）且本会话尚未触发过引导时弹出
    // isFamily 为 true 代表"无已审批角色"（见 line 684 逻辑），同时要求未主动关闭过引导
    if (isFamily && !(this as any)._onboardingShown && !wx.getStorageSync('onboarding_dismissed')) {
      (this as any)._onboardingShown = true;
      this.setData({ showOnboardingModal: true });
    }
  },

  // 🌟 拉取当前绑定门店的真实 orgType（stores.orgType，见 manageStoreProfile
  // 云函数 get 动作），用它覆盖 initMinePage 里先起的中性默认文案——只有这一步
  // 才能精确区分 yuhuazhai / elderly_canteen（社区助餐）/ 其余机构类型，同时
  // 一并回填 isYuhuazhai（此前由不可靠的 tenantId 前缀猜测驱动，会导致
  // "社区助餐点被标成雨花斋"这类误判——见 initMinePage 里的根因修复注释），
  // 让门店文化/温情故事/证书落款等一整批 isYuhuazhai 三元表达式都跟着一起归正。
  // 超管在"全国总览"视角下没有绑定具体门店，云函数会返回"您尚未绑定门店"，
  // 属于预期内的空结果，静默跳过即可，不影响其余展示
  async fetchStoreOrgType() {
    if (!isCloudAvailable()) return;
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'get' }
      });
      const orgType = (res && res.result && res.result.data && res.result.data.orgType) || '';
      if (!orgType) return;
      this.setData({
        orgType,
        isYuhuazhai: orgType === 'yuhuazhai',
        ...computeOrgDisplayCopy(orgType, this.data.isSuperAdmin)
      });
    } catch (err) {
      // 静默失败：已有中性兜底文案在展示，不会误显示任何机构品牌标签
      console.warn('[profile][fetchStoreOrgType] 查询真实机构类型失败:', err);
    }
  },

  // 📸 雨花温情图册与阳光凭证：原首页入口卡的数据加载逻辑原样迁移到个人中心——
  // 只取总张数用于入口角标展示（不需要缩略图数组），云函数与跳转目标
  // （getPhotoArchive / onGoToPhotoArchive 均未变），可见范围口径与原首页版本一致：
  // 全国总览视角不展示该入口，这里直接让 recentPhotosLoaded 保持 false 达到同等效果
  // （本页顶层 data.currentStoreId 从未被真正赋值过，改用 getSelectedStore() 现取，
  // 与本文件其余读取当前生效门店的写法保持一致）
  async loadRecentPhotos() {
    if (!isCloudAvailable()) return;
    const activeStore = getSelectedStore();
    const storeId = activeStore.storeId || '';
    if (storeId === 'national_overview' || storeId === 'ALL_STORES') return;
    try {
      const res = await wx.cloud.callFunction({
        name: 'getPhotoArchive',
        data: { storeId, photoType: 'all', limit: 1 }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({
          recentPhotosTotal: result.total || 0,
          recentPhotosLoaded: true
        });
      }
    } catch (e) {
      console.warn('[profile][loadRecentPhotos] 加载失败:', e);
    }
  },

  // 点击图册入口卡，导航到 history 页图册模式——与原首页入口跳转目标完全一致
  onGoToPhotoArchive() {
    wx.navigateTo({ url: '/pages/history/history?mode=photo' });
  },

  // ─────────────────────────────────────────────────────────────────────
  // 🌐 新用户引导入驻：创建新组织 / 通过邀请码加入
  // ─────────────────────────────────────────────────────────────────────

  onDismissOnboarding() {
    // 用户主动关闭引导，记录到 Storage，下次不再自动弹出
    wx.setStorageSync('onboarding_dismissed', true);
    this.setData({ showOnboardingModal: false, onboardingStep: 'choice' });
  },

  onOnboardingChooseCreate() {
    this.setData({ onboardingStep: 'create' });
  },

  onOnboardingChooseJoin() {
    // 引导用户输入邀请码——复用现有的邀请码核销弹窗
    this.setData({ showOnboardingModal: false, onboardingStep: 'choice' });
    wx.setStorageSync('onboarding_dismissed', true);
    // 打开邀请码核销入口（复用义工申请流程里的 input invite code 路径）
    wx.navigateTo({ url: '/pages/join-store/join-store' }).catch(() => {
      // 如果页面不存在，退回到通知页提示用户向大家长索取邀请码
      wx.showModal({
        title: '如何加入门店',
        content: '请向所在门店的大家长索取 6 位邀请码，在首页"加入门店"处输入即可自动绑定。',
        showCancel: false,
        confirmText: '知道了'
      });
    });
  },

  onOnboardingOrgNameInput(e: any) {
    const orgName = (e.detail.value || '').trim();
    // 门店名若未单独填写，与组织名联动
    if (!this.data.onboardingStoreName || this.data.onboardingStoreName === (this.data.onboardingOrgName)) {
      this.setData({ onboardingOrgName: orgName, onboardingStoreName: orgName });
    } else {
      this.setData({ onboardingOrgName: orgName });
    }
  },

  onOnboardingStoreNameInput(e: any) {
    this.setData({ onboardingStoreName: (e.detail.value || '').trim() });
  },

  onOnboardingRealNameInput(e: any) {
    this.setData({ onboardingRealName: (e.detail.value || '').trim() });
  },

  onOnboardingPhoneInput(e: any) {
    this.setData({ onboardingPhone: (e.detail.value || '').trim() });
  },

  onOnboardingOrgTypeChange(e: any) {
    const idx = Number(e.detail.value);
    const options = this.data.orgTypeOptions as any[];
    this.setData({
      orgTypeIndex: idx,
      onboardingOrgType: (options[idx] && options[idx].value) || 'charity'
    });
  },

  onOnboardingBackToChoice() {
    this.setData({ onboardingStep: 'choice' });
  },

  async onSubmitCreateOrg() {
    if (this.data.onboardingCreating) return;
    const { onboardingOrgName: orgName, onboardingStoreName: storeName,
            onboardingRealName: realName, onboardingPhone: phone,
            onboardingOrgType: orgType } = this.data;

    if (!orgName) { wx.showToast({ title: '请填写组织名称', icon: 'none' }); return; }
    if (!storeName) { wx.showToast({ title: '请填写门店/站点名称', icon: 'none' }); return; }
    if (!realName) { wx.showToast({ title: '请填写您的姓名', icon: 'none' }); return; }

    this.setData({ onboardingCreating: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'createTenant',
        data: { orgName, storeName, realName, phone, orgType }
      }) as any;
      const result = res && res.result;

      if (!result || !result.success) {
        wx.showToast({ title: result.error || '创建失败，请重试', icon: 'none', duration: 3000 });
        return;
      }

      // 创建成功：刷新角色缓存并关闭引导
      wx.setStorageSync('onboarding_dismissed', true);
      this.setData({
        showOnboardingModal: false,
        onboardingStep: 'choice',
        onboardingCreating: false
      });
      wx.showToast({ title: result.message || '创建成功！', icon: 'success', duration: 3000 });

      // 短暂延迟后刷新角色（云函数已写入 user_roles，最终一致性延迟 ~300ms）
      setTimeout(() => {
        AuthService.fetchUserRole().finally(() => this.initMinePage());
      }, 800);

    } catch (err: any) {
      console.error('[onSubmitCreateOrg]', err);
      wx.showToast({ title: err.message || '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ onboardingCreating: false });
    }
  },

  // ─────────────────────────────────────────────────────────────────────

  // 🏛️ 家长管理 / 资源兜底：迁移自已废弃的 pages/patriarch-dashboard，
  // 合并了原页面 initStore() + fetchDashboard() 两步——家长/督导锁定本店，
  // 超管沿用全局门店切换器选中的门店（与 store-profile/daily-menu 一致）
  async fetchPatriarchDashboardData() {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }
    const store = getSelectedStore();
    const storeId = (roleInfo && roleInfo.role === 'store_patriarch' && roleInfo.storeId) || store.storeId || '';

    this.setData({ 'patriarchData.currentStoreId': storeId, 'patriarchData.loading': true });

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'getPatriarchDashboard',
        data: { storeId: this.data.patriarchData.currentStoreId }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载大盘失败', icon: 'none' });
        return;
      }

      // 🛡️ 崩溃修复：result.success 为 true 不保证 result.data 一定存在（服务端
      // 异常分支可能只置了 success 却漏填 data）——此前直接 `result.data` 解构，
      // data 一旦是 undefined，下面 data.pendingProfileUpdate 立刻抛出
      // "Cannot read property 'pendingProfileUpdate' of undefined"
      const data = result.data || {};
      const pendingProfileItems = data.pendingProfileUpdate
        ? Object.keys(PATRIARCH_PROFILE_FIELD_LABELS)
            .filter((f) => data.pendingProfileUpdate[f] !== undefined)
            .map((f) => ({ label: PATRIARCH_PROFILE_FIELD_LABELS[f], value: data.pendingProfileUpdate[f] }))
        : [];

      // 🆕 防伪验真进度条百分比：在这里算好一个 0-100 的整数，WXML 只做
      // style="width: {{...}}%" 纯变量输出，不在模板里写除法/取整表达式
      const auditedCount = data.auditedCount || 0;
      const totalCount = data.totalCount || 0;
      const verifyProgressPercent = totalCount > 0 ? Math.round((auditedCount / totalCount) * 100) : 0;

      this.setData({
        patriarchData: {
          ...this.data.patriarchData,
          currentStoreId: data.storeId || this.data.patriarchData.currentStoreId,
          storeName: data.storeName || '',
          patriarch: data.patriarch || '',
          manager: data.manager || '',
          monthLabel: data.monthLabel || '',
          monthDiners: data.monthDiners || 0,
          monthIncome: (data.monthIncome || 0).toFixed(2),
          monthExpense: (data.monthExpense || 0).toFixed(2),
          monthNet: Math.abs(data.monthNet || 0).toFixed(2),
          monthNetPositive: (data.monthNet || 0) >= 0,
          auditedCount,
          totalCount,
          verifyProgressPercent,
          pendingVoidList: Array.isArray(data.pendingVoidList) ? data.pendingVoidList : [],
          pendingProfileUpdate: data.pendingProfileUpdate || null,
          pendingProfileItems
        }
      });
    } catch (err) {
      console.error('[fetchPatriarchDashboardData] 加载家长大盘异常:', err);
      reportCloudSdkErrorIfCorrupted(err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ 'patriarchData.loading': false });
    }
  },

  // 💰 财务稽核专区【数据看板】3 项 KPI：
  // ① 待复核凭证 = 本月总笔数 - 已稽核（AUDITED_LOCKED）笔数——复用
  //    getPatriarchDashboard（已放行 finance 角色查自己绑定门店，见该云函数
  //    resolveTarget 的调整），不新增云函数。
  // ② 本月稽核总额 = 本月收入 + 本月支出——同一次 getPatriarchDashboard 调用
  //    附带算出，反映财务本月责任范围内的总流水规模。
  // ③ 合规预警/异常 = getRiskAlerts 四类异常计数之和（红字冲销/小票缺失/
  //    余额异常/算术复核不一致）——这个云函数此前在客户端从未被调用过，
  //    本就是为财务准备的只读风控扫描，这里首次真正接上前端
  async fetchFinanceAuditData() {
    if (!isCloudAvailable()) return;

    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }
    const store = getSelectedStore();
    const storeId = (roleInfo && roleInfo.role === 'finance' && roleInfo.storeId) || store.storeId || '';
    if (!storeId) {
      this.setData({ 'financeAuditData.loading': false });
      return;
    }

    this.setData({ 'financeAuditData.loading': true });
    try {
      const [dashboardRes, riskRes] = await Promise.all([
        wx.cloud.callFunction({ name: 'getPatriarchDashboard', data: { storeId } }),
        wx.cloud.callFunction({ name: 'getRiskAlerts', data: { storeId } })
      ]);

      const dashboardResult: any = dashboardRes.result;
      const dashboardData = (dashboardResult && dashboardResult.success && dashboardResult.data) || null;
      const totalCount = (dashboardData && dashboardData.totalCount) || 0;
      const auditedCount = (dashboardData && dashboardData.auditedCount) || 0;
      const monthIncome = (dashboardData && dashboardData.monthIncome) || 0;
      const monthExpense = (dashboardData && dashboardData.monthExpense) || 0;

      const riskResult: any = riskRes.result;
      const summary = (riskResult && riskResult.success && riskResult.summary) || {};
      const anomalyCount = (summary.voidCount || 0) + (summary.missingReceiptCount || 0)
        + (summary.balanceAnomalyCount || 0) + (summary.arithmeticMismatchCount || 0);

      this.setData({
        financeAuditData: {
          loading: false,
          pendingReviewCount: Math.max(0, totalCount - auditedCount),
          monthAuditTotal: (monthIncome + monthExpense).toFixed(2),
          anomalyCount
        }
      });
    } catch (err) {
      console.error('[fetchFinanceAuditData] 加载财务稽核数据异常:', err);
      reportCloudSdkErrorIfCorrupted(err);
      this.setData({ 'financeAuditData.loading': false });
    }
  },

  // 🆕 店长视角【本店数据概览】2x2 卡片数据源：
  // ① 今日用餐人次 / 今日义工打卡——直接复用 manageVolunteerSubmission 的
  //    statsSummary 聚合（与「门店餐饮与物资统计」弹窗、store-profile 的
  //    "今日护持"同源，todayVolunteerCount 是当天已采纳提交里的去重提交人数，
  //    没有编造一个假的打卡系统），不新增云函数。
  // ② 爱心积攒/结余——复用 getPreviousBalance（本用于"新建报告时预填昨日结余"）：
  //    传入"明天"作为 targetDateString，其内部按【明天的前一天】即今天去查
  //    report_logs，天然拿到本店最新一次已知结余（当天尚未提交时会按其自带的
  //    降级逻辑回落到最近一次历史记录，不会显示为空/0 误导店长）。两路请求
  //    互相独立、互不阻塞，任一失败都静默保留默认展示值
  async fetchManagerTodaySnapshot() {
    if (!isCloudAvailable()) return;

    const fetchTodayCounts = (async () => {
      try {
        const res: any = await wx.cloud.callFunction({
          name: 'manageVolunteerSubmission',
          data: { action: 'statsSummary' }
        });
        const result = res.result;
        if (result && result.success) {
          const data = result.data || {};
          this.setData({
            todayMealsCount: (data.mealTotals && data.mealTotals.totalCount) || 0,
            todayVolunteersCount: data.todayVolunteerCount || 0
          });
        }
      } catch (err) {
        console.warn('[fetchManagerTodaySnapshot] 加载今日用餐/打卡统计失败:', err);
      }
    })();

    const fetchBalance = (async () => {
      const store = getSelectedStore();
      const storeName = store.storeName || this.data.currentStoreName;
      if (!storeName) return;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const pad = (n: number) => String(n).padStart(2, '0');
      const tomorrowStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
      try {
        const result = await DataService.getPreviousBalance(storeName, '', tomorrowStr, store.storeId);
        if (result.success && result.data && result.data.balance != null) {
          this.setData({ storeNetBalance: (parseFloat(result.data.balance) || 0).toFixed(2) });
        }
      } catch (err) {
        console.warn('[fetchManagerTodaySnapshot] 加载结余概览失败:', err);
      }
    })();

    await Promise.allSettled([fetchTodayCounts, fetchBalance]);
  },

  // 💖 全网爱心支持卡片：调用与首页「☀️ 阳光账本」入口同一个公开只读云函数
  // getSunshineLedger，只查询用户自己归属门店的「发心分布比例」这块温情、
  // 非运营数据——门店总数/服务人次/义工工时等跨店经营数据不在个人页展示，
  // 那些留给统计页专属大屏。
  // 🐛 此前借道 getNationalDashboard（rangeType='all' + filterMode='national'）
  // 会把全租户所有门店的捐赠记录都聚合进来，用户看到的可能是别的门店的数据，
  // 不符合"只显示相应归属机构数据"的要求；getSunshineLedger 本身按 storeId
  // 严格收窄、且不做任何角色权限校验，天然适合"全员可见、仅本店数据"的场景
  // 🆕 最新公开随喜名单已抽成独立的 <yangshan-wall storeId="{{myStoreId}}"/>
  // 组件自行拉取（同一个 storeId、同一个云函数，组件内部再发一次请求），
  // 这里只需要把解析出的 storeId 存进 myStoreId 供 WXML 绑定，不再重复
  // 保留 donors 列表这份数据
  async fetchStoreLoveWallSummary() {
    if (!isCloudAvailable()) return;
    const storeId = await this.resolveManageStoreId();
    if (!storeId) return;
    this.setData({ myStoreId: storeId });

    this.setData({ storeLoveWallLoading: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'getSunshineLedger',
        data: { storeId }
      });
      const result = res.result;
      if (!result || !result.success) return;

      this.setData({
        storeLoveWallMeritRatio: {
          yangRatioPct: result.yangRatioPct || 0,
          yinRatioPct: result.yinRatioPct || 0
        }
      });
    } catch (err) {
      console.error('[fetchStoreLoveWallSummary] 加载本店爱心支持摘要异常:', err);
    } finally {
      this.setData({ storeLoveWallLoading: false });
    }
  },

  // 📮 爱心意见箱管理：门店 ID 解析口径与 fetchPatriarchDashboardData 一致——
  // 优先用角色绑定的门店，兜底取全局门店切换器当前选中的门店
  async resolveManageStoreId(): Promise<string> {
    let roleInfo = AuthService.getCachedRoleInfo();
    if (!roleInfo) {
      const result = await AuthService.fetchUserRole();
      roleInfo = result.roleInfo || null;
    }
    const store = getSelectedStore();
    return (roleInfo && roleInfo.storeId) || store.storeId || '';
  },

  async fetchPendingFeedbackCount() {
    if (!isCloudAvailable()) return;
    try {
      const storeId = await this.resolveManageStoreId();
      if (!storeId) return;

      const res: any = await wx.cloud.callFunction({
        name: 'submitFeedback',
        data: { action: 'count', storeId }
      });
      const result = res.result;
      if (result && result.success) {
        this.setData({ pendingFeedbackCount: (result.data && result.data.count) || 0 });
      }
    } catch (err) {
      console.warn('[fetchPendingFeedbackCount] 加载未处理意见数量失败:', err);
    }
  },

  // 🐛 防抖遮罩：复用已有的 loading 态字段做防抖判定，拦截打开动画/网络往返期间的
  // 连续点击——此前无任何拦截，手速快或网络慢时会并发打出多个重复的云函数请求
  async onOpenFeedbackAdminModal() {
    if (this.data.feedbackAdminLoading) return;
    this.setData({
      showFeedbackAdminModal: true, feedbackAdminLoading: true,
      feedbackAdminTab: 'pending', feedbackAdminList: [],
      feedbackAdminPendingList: [], feedbackAdminHandledList: [],
      feedbackReplyingId: '', feedbackReplyContent: ''
    });

    try {
      const storeId = await this.resolveManageStoreId();
      const res: any = await wx.cloud.callFunction({
        name: 'submitFeedback',
        data: { action: 'list', storeId }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载失败', icon: 'none' });
        return;
      }
      const list = Array.isArray(result.data?.list) ? result.data.list : [];
      this.setData({ feedbackAdminList: list });
      this._rebuildFeedbackTabLists();
    } catch (err) {
      console.error('[onOpenFeedbackAdminModal] 加载意见列表异常:', err);
      // 🛡️ 云端 submitFeedback 已经把 -502005（意见箱集合尚未初始化）当作"空列表"
      // 处理，正常不会再抛到这里——这里是兜底：万一云端还是旧版本代码没重新部署，
      // 至少不能让店长端直接崩溃/报出一串英文错误码
      if (this.isCollectionNotExistError(err)) {
        wx.showToast({ title: '意见箱数据库初始化中，请联系店长或重新尝试', icon: 'none', duration: 3000 });
      } else {
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      }
    } finally {
      this.setData({ feedbackAdminLoading: false });
    }
  },

  // -502005 DATABASE_COLLECTION_NOT_EXIST：云函数内部已对 count/list 做了优雅
  // 降级，理论上不会再抛到客户端；这里只是防御一层"云函数还没重新部署"的旧版本场景
  isCollectionNotExistError(err: any): boolean {
    return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String((err && (err.errMsg || err.message)) || '')));
  },

  onCloseFeedbackAdminModal() {
    this.setData({ showFeedbackAdminModal: false });
  },

  // 重新计算 pending/handled 两个衍生列表（每次 feedbackAdminList 变更后调用）
  // 🛡️ 崩溃修复：this.data.feedbackAdminList 理论上恒为数组（data 声明 + 写入点
  // 均已加固），这里再兜底一层 Array.isArray——避免未来任何新写入点遗漏防护时，
  // 本方法直接对非数组调用 .filter() 崩溃
  _rebuildFeedbackTabLists() {
    const all = Array.isArray(this.data.feedbackAdminList) ? this.data.feedbackAdminList : [];
    this.setData({
      feedbackAdminPendingList: all.filter((i) => i.status !== 'handled'),
      feedbackAdminHandledList: all.filter((i) => i.status === 'handled')
    });
  },

  onSwitchFeedbackAdminTab(e: any) {
    const tab = e.currentTarget.dataset.tab as string;
    if (!tab || tab === this.data.feedbackAdminTab) return;
    this.setData({ feedbackAdminTab: tab, feedbackReplyingId: '', feedbackReplyContent: '' });
  },

  async onMarkFeedbackHandled(e: any) {
    const feedbackId = e.currentTarget.dataset.id;
    if (!feedbackId) return;

    const list = this.data.feedbackAdminList;
    const idx = list.findIndex((item) => item._id === feedbackId);
    if (idx === -1 || list[idx].handling) return;

    this.setData({ [`feedbackAdminList[${idx}].handling`]: true });

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'submitFeedback',
        data: { action: 'markHandled', feedbackId }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        this.setData({ [`feedbackAdminList[${idx}].handling`]: false });
        return;
      }

      this.setData({
        [`feedbackAdminList[${idx}].status`]: 'handled',
        [`feedbackAdminList[${idx}].handling`]: false,
        pendingFeedbackCount: Math.max(0, this.data.pendingFeedbackCount - 1)
      });
      this._rebuildFeedbackTabLists();
      wx.showToast({ title: '已标记为处理', icon: 'success' });
    } catch (err) {
      console.error('[onMarkFeedbackHandled] 操作异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      this.setData({ [`feedbackAdminList[${idx}].handling`]: false });
    }
  },

  // 💬 回复家人：展开/收起某一条意见下方的回复输入框，同一时间只展开一条——
  // 再次点击同一条会收起（当作取消），点击另一条会自动切走并清空未提交的草稿
  onToggleFeedbackReplyBox(e: any) {
    const feedbackId = e.currentTarget.dataset.id;
    const isSameOne = this.data.feedbackReplyingId === feedbackId;
    this.setData({
      feedbackReplyingId: isSameOne ? '' : feedbackId,
      feedbackReplyContent: ''
    });
  },

  onFeedbackReplyInput(e: any) {
    this.setData({ feedbackReplyContent: e.detail.value });
  },

  async onSubmitFeedbackReply() {
    const feedbackId = this.data.feedbackReplyingId;
    if (!feedbackId || this.data.feedbackReplySubmitting) return;

    const replyContent = (this.data.feedbackReplyContent || '').trim();
    if (!replyContent) {
      wx.showToast({ title: '请输入回复内容', icon: 'none' });
      return;
    }

    const list = this.data.feedbackAdminList;
    const idx = list.findIndex((item) => item._id === feedbackId);
    if (idx === -1) return;

    this.setData({ feedbackReplySubmitting: true });

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'submitFeedback',
        data: { action: 'reply', feedbackId, replyContent }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '回复失败', icon: 'none' });
        return;
      }

      const wasUnhandled = list[idx].status !== 'handled';
      this.setData({
        [`feedbackAdminList[${idx}].status`]: 'handled',
        [`feedbackAdminList[${idx}].replyContent`]: replyContent,
        [`feedbackAdminList[${idx}].replyTimeStr`]: '刚刚',
        feedbackReplyingId: '',
        feedbackReplyContent: '',
        pendingFeedbackCount: wasUnhandled ? Math.max(0, this.data.pendingFeedbackCount - 1) : this.data.pendingFeedbackCount
      });
      this._rebuildFeedbackTabLists();
      wx.showToast({ title: '回复成功', icon: 'success' });
    } catch (err) {
      console.error('[onSubmitFeedbackReply] 回复异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ feedbackReplySubmitting: false });
    }
  },

  // 🛡️ "确认作废"前强确认：approvePendingVoid 会把记录标记为 isVoid、级联重算
  // 此后所有日期的结余流水、并写入审计日志——影响面不亚于"确认封账"（index.ts
  // 的 onConfirmFinanceLock 就为此弹了 wx.showModal），此前这里一点即执行、
  // 没有任何二次确认，手滑一下就永久作废一条账目且牵连后续流水，风险与保护力度
  // 明显不对等，这里补齐。"驳回"影响仅是清除挂起标记、不改动账目本身，维持
  // 原有的一键处理，不需要同等强度的确认
  async onDecideVoid(e: any) {
    if (this.data.patriarchData.voidActionInFlight) return;
    const { id, action } = e.currentTarget.dataset; // action: 'approve' | 'reject'
    const cloudAction = action === 'approve' ? 'approvePendingVoid' : 'rejectPendingVoid';

    if (action === 'approve') {
      const target = (this.data.patriarchData.pendingVoidList || []).find((r: any) => r.docId === id);
      const dateLabel = target && target.dateString ? `${target.dateString} 的` : '这条';
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '⚠️ 确认作废？',
          content: `确认作废${dateLabel}账目记录吗？作废后将级联重算此后所有日期的结余流水，且不可撤销。`,
          confirmText: '确认作废',
          confirmColor: '#D32F2F',
          cancelText: '我再想想',
          success: (res) => resolve(!!res.confirm),
          fail: () => resolve(false)
        });
      });
      if (!confirmed) return;
    }

    this.setData({ 'patriarchData.voidActionInFlight': true });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageReportApproval',
        data: { action: cloudAction, docId: id }
      });
      const result = res.result;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.errMsg) || '操作失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: action === 'approve' ? '已确认作废' : '已驳回申请', icon: 'success' });
      this.fetchPatriarchDashboardData();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ 'patriarchData.voidActionInFlight': false });
    }
  },

  async onDecideProfileUpdate(e: any) {
    if (this.data.patriarchData.profileActionInFlight) return;
    const { action } = e.currentTarget.dataset; // action: 'approve' | 'reject'
    const cloudAction = action === 'approve' ? 'approveProfileUpdate' : 'rejectProfileUpdate';

    this.setData({ 'patriarchData.profileActionInFlight': true });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: cloudAction, storeId: this.data.patriarchData.currentStoreId }
      });
      const result = res.result;
      wx.hideLoading();
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: action === 'approve' ? '已确认变更' : '已驳回申请', icon: 'success' });
      this.fetchPatriarchDashboardData();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ 'patriarchData.profileActionInFlight': false });
    }
  },

  // 🙋 头像昵称填写规范：优先用缓存的 RoleInfo 秒开显示，再静默刷新一次确保最新
  loadUserProfile() {
    console.log('[verify] loadUserProfile 已触发, lastConfirmedAvatarFileId=', this.lastConfirmedAvatarFileId);
    const cached = AuthService.getCachedRoleInfo();
    console.log('[verify] 本地缓存 cached.avatarUrl=', cached && cached.avatarUrl);
    if (cached) {
      this.applyAvatarUrl(cached.avatarUrl || '');
      this.setData({ userNickName: cached.nickName || '' });
    }

    // 🐛 防抖锁：seq 号机制（见下方）已经能保证"后发起的结果不会被先发起、但后
    // resolve 的旧结果覆盖"，但没能阻止 tabBar 页面反复切入切出时 onShow 一次次
    // 并发发起全新的 fetchUserRole() 请求本身——每一次都是一趟完整的
    // checkUserRole 云函数往返，属于纯粹浪费。已有一轮在途时直接跳过本轮，
    // 等它自己 finally 解锁后，下一次真正的 onShow 自然会重新触发
    if (this._loadUserProfileInFlight) {
      console.log('[profile][loadUserProfile] 已有一轮刷新在途，跳过本次重复触发');
      return;
    }
    this._loadUserProfileInFlight = true;

    // 🐛 关键修复：seq 号必须在发起 fetchUserRole 请求的这一刻就同步占好，不能等
    // checkUserRole 网络请求真正 resolve 之后才在 .then 回调里临时取号——原来的写法
    // 会导致"发起得早、但这一轮网络恰好慢"的请求，仅仅因为"resolve 得晚"就被误判成
    // "更新鲜"，进而把已经正确展示的新头像覆盖回它自己携带的旧数据（截图里 seq=7 新
    // 头像被 seq=8 的旧头像覆盖、seq=10 新头像又被 seq=11 旧头像覆盖，就是这个根因）。
    // 号的大小现在只取决于"这次 loadUserProfile 调用本身发生的时间"，与网络快慢无关。
    const fetchSeq = ++this.avatarApplySeq;
    AuthService.fetchUserRole().then(result => {
      console.log('[verify] fetchUserRole resolve, success=', result.success, 'roleInfo.avatarUrl=', result.roleInfo && result.roleInfo.avatarUrl);
      if (result.success && result.roleInfo) {
        // 🐛 云数据库最终一致性兜底：见类定义处 lastConfirmedAvatarFileId 的注释——
        // 如果这次 checkUserRole 返回的 avatarUrl 跟"刚上传成功、已确认为真"的
        // fileID 对不上，且还在宽限期内，大概率是写入后的读请求命中了还没追平的
        // 副本，不是用户真的换了新头像，此时保留本地已确认的展示，不覆盖回去。
        const CONFIRMED_AVATAR_GRACE_MS = 5 * 60 * 1000;
        const fetchedAvatarUrl = result.roleInfo.avatarUrl || '';
        const withinGrace = this.lastConfirmedAvatarFileId
          && (Date.now() - this.lastConfirmedAvatarAt) < CONFIRMED_AVATAR_GRACE_MS;
        if (withinGrace && fetchedAvatarUrl !== this.lastConfirmedAvatarFileId) {
          console.warn(
            '[profile] checkUserRole 返回的 avatarUrl 与刚确认的上传结果不一致，' +
            '宽限期内忽略，保留本地已确认值:', fetchedAvatarUrl, 'vs', this.lastConfirmedAvatarFileId
          );
        } else {
          this.applyAvatarUrl(fetchedAvatarUrl, fetchSeq);
        }
        this.setData({ userNickName: result.roleInfo.nickName || '' });
      }
    }).catch(err => {
      console.warn('[profile] loadUserProfile 刷新失败:', err);
    }).finally(() => {
      this._loadUserProfileInFlight = false;
    });
  },

  // 🐛 头像"严重放大只看到局部色块"根因修复：这里此前会对 cloud:// 开头的 avatarUrl
  // 额外调用 wx.cloud.downloadFile 换成本地临时文件路径再 setData（更早之前甚至读成
  // data: base64 URI），逐层排查（原始临时路径正常 → 本地压缩后 mainPath 正常 →
  // 只有走完云端上传/下载这一轮往返后才变成色块）已经定位到问题就出在这个手动
  // downloadFile 转换步骤本身。本项目其余所有图片（食谱、支出凭证、日常日志等）都是
  // 直接把 cloud:// fileID 原样绑定到 <image src>，交给微信原生 <image> 组件自行解析，
  // 从未出现过这类问题——现改为同款做法，不再手动 downloadFile，avatarUrl 是什么就
  // 原样展示什么，与全项目其余图片保持完全一致的绑定方式。
  // 🐛 seq 支持外部预先占号（见 loadUserProfile 里 fetchUserRole 分支的注释）：
  // 号必须按【发起时刻】分配，而不是按【resolve 时刻】分配，否则一次发起得早、
  // 但网络恰好慢的请求会因为"最后才 resolve"被误判成最新，把它携带的旧数据
  // 盖过已经正确展示的新头像。不传时退回自增（用于同步/无需等待网络的分支）。
  applyAvatarUrl(avatarUrl: string, preAssignedSeq?: number) {
    const seq = preAssignedSeq !== undefined ? preAssignedSeq : ++this.avatarApplySeq;
    if (seq < this.lastAppliedAvatarSeq) {
      // 已经有发起时间更晚（更新鲜）的一次调用抢先落地过，这次是姗姗来迟的旧结果，丢弃
      return;
    }
    this.lastAppliedAvatarSeq = seq;

    const patch = { userAvatarUrl: avatarUrl || '', avatarLoadFailed: false };
    // 🐛 强制经历一次"从空到有"，绕开个别基础库版本下 <image> 的 src 从一个已加载过的
    // 旧地址直接切到新地址时不重新发起请求的怪癖（低概率，但作为兜底保留）。
    const prevUrl = this.data.userAvatarUrl;
    if (prevUrl && patch.userAvatarUrl && prevUrl !== patch.userAvatarUrl) {
      this.setData({ userAvatarUrl: '', avatarLoadFailed: false });
      wx.nextTick(() => {
        this.setData(patch);
      });
    } else {
      this.setData(patch);
    }
  },

  // 🛡️ 头像 <image> 加载失败兜底：常见于云存储读权限未设为"所有用户可读"时，
  // 其他人（非上传者本人）查看会直接加载失败——不管什么原因，降级展示占位图，
  // 而不是留一块空白框给用户
  onAvatarLoadError(e: any) {
    console.warn('[profile] 头像加载失败，降级为占位图:', e.detail);
    this.setData({ avatarLoadFailed: true });
  },

  // 🛡️ 成员头像 <image> 加载失败兜底：成员管理列表/跨店成员列表/已选中成员卡片
  // 三处共用同一个 memberAvatarFailedMap（按 avatarUrl 记录），命中后各自的
  // wx:else 分支会自动切换成已有的姓氏首字占位圆圈，不留裂图
  onMemberAvatarError(e: any) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    console.warn('[onMemberAvatarError] 成员头像加载失败:', url);
    this.setData({ memberAvatarFailedMap: { ...this.data.memberAvatarFailedMap, [url]: true } });
  },

  // 选择微信头像（官方 chooseAvatar 能力）：拿到本地临时文件后压缩上传至云存储，再落库。
  // 依赖手机微信客户端基础库 >= 2.21.2；版本过低时该回调不会触发，属已知限制。
  async onChooseAvatar(e: any) {
    const tempAvatarUrl = e.detail && e.detail.avatarUrl;
    if (!tempAvatarUrl) {
      console.warn('[onChooseAvatar] e.detail.avatarUrl 为空，微信未返回临时头像文件');
      return;
    }

    this.setData({ avatarUploading: true });
    wx.showLoading({ title: '头像上传中...', mask: true });

    // 🛡️ 云开发就绪防护：与 authService.ts 里 fetchUserRole/updateProfile 同款判定口径。
    // 此前 wx.cloud.uploadFile（压缩上传这一步）之前完全没有这道检查——如果云初始化还没
    // 完成就调用，会直接抛出 "Cloud API isn't enabled" 而不是走后面 updateProfile 那句
    // 更友好的 CLOUD_SDK_UNAVAILABLE 提示，用户只会看到笼统的"头像上传失败，请重试"，
    // 看不出真正原因是云还没就绪。提前拦截，给出更明确的提示，且不发起注定失败的请求。
    if (!isCloudAvailable()) {
      wx.hideLoading();
      this.setData({ avatarUploading: false });
      wx.showToast({ title: '云服务尚未就绪，请稍后重试', icon: 'none' });
      return;
    }

    try {
      // 🐛 头像"被严重放大只看到局部色块"根因修复（最终版）：真正原因是主图经过本地
      // Canvas 重绘-导出这一整套流程，在部分设备/基础库的 Canvas 2D 实现上不可靠——本项目
      // 早前修复"食谱/门店日志照片主体被裁切"时就踩过同一类问题，解法是让主图完全绕开
      // Canvas、直接上传原始临时文件（见 imageCompress.ts compressAndUploadImage 的注释）。
      // 头像不需要缩略图，因此彻底不再触碰 Canvas。
      const uploaded = await compressAndUploadScaledImage(tempAvatarUrl, 'users/avatars');

      const result = await AuthService.updateProfile({ avatarUrl: uploaded.url });

      wx.hideLoading();
      this.setData({ avatarUploading: false });

      if (result.success) {
        // 🐛 优先用本地临时路径（tempAvatarUrl）立即更新视图，不等云端 fileID 转临时链接
        // 那一轮网络往返——本地路径此刻已经是裁剪压缩后的正方形图，直接可用，视觉上更即时，
        // 也避免了 cloud:// fileID 在少数设备/基础库上无法被 <image> 直接解析的问题
        //
        // 🛡️ 这里也要走 avatarApplySeq 序号，而不是裸 setData：如果本页面在这次上传之前
        // 还有一个尚未 resolve 的 applyAvatarUrl（比如页面首次打开时那次 loadUserProfile
        // 触发的 fetchUserRole 请求还没回来），旧请求晚一点才 resolve 的话，会把刚上传成功
        // 的新头像又覆盖回旧值。把这次乐观展示也计入序号，能让所有更早发起的旧请求
        // 事后一律被判定为过期而丢弃。
        const seq = ++this.avatarApplySeq;
        this.lastAppliedAvatarSeq = seq;
        this.setData({ userAvatarUrl: tempAvatarUrl, avatarLoadFailed: false });

        // 🐛 记录"刚上传确认为真"的 fileID + 时刻：见类定义处 lastConfirmedAvatarFileId
        // 的注释，供后续 loadUserProfile 的 checkUserRole 分支判断是否命中最终一致性
        // 延迟、要不要信任这次云端读到的 avatarUrl。
        this.lastConfirmedAvatarFileId = uploaded.url;
        this.lastConfirmedAvatarAt = Date.now();
        // 🛡️ 同步镜像一份到本地持久化：见 CONFIRMED_AVATAR_CACHE_KEY 处的根因说明，
        // 让这层宽限期保护跨小程序退出重进依然生效，而不是只活在这个页面实例的内存里
        try {
          wx.setStorageSync(CONFIRMED_AVATAR_CACHE_KEY, {
            fileId: this.lastConfirmedAvatarFileId,
            at: this.lastConfirmedAvatarAt
          });
        } catch (storageErr) {
          console.warn('[profile] 持久化头像确认记录失败:', storageErr);
        }

        wx.showToast({ title: '头像已更新', icon: 'success' });
      } else {
        wx.showToast({ title: result.error || '头像保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ avatarUploading: false });
      console.error('[profile] onChooseAvatar 异常:', err);
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' });
    }
  },

  // 昵称编辑（官方 <input type="nickname"> 能力）：失焦后保存
  async onNicknameBlur(e: any) {
    const nickName = ((e.detail && e.detail.value) || '').trim();
    if (!nickName || nickName === this.data.userNickName) {
      return;
    }

    const previous = this.data.userNickName;
    this.setData({ userNickName: nickName });

    const result = await AuthService.updateProfile({ nickName });
    if (result.success) {
      wx.showToast({ title: '昵称已更新', icon: 'success' });
    } else {
      // 保存失败则回退显示，避免界面与云端数据不一致
      this.setData({ userNickName: previous });
      wx.showToast({ title: result.error || '昵称保存失败', icon: 'none' });
    }
  },

  onTapEditProfileHint() {
    wx.showToast({ title: '点击头像可更换头像，点击昵称文字可编辑', icon: 'none' });
  },

  // "我的" 快捷操作面板：不改变本页其余部分，只是额外补一个小型 Bottom Sheet 入口
  onOpenQuickSheet() {
    const sheet = this.selectComponent('#mineQuickSheet');
    if (sheet && sheet.open) {
      sheet.open();
    }
  },

  // 🌟 超级管理员视角切换：半屏卡片弹窗，替换原生 picker 绿色弹窗。
  // 仅在 isRealSuperAdmin 为真时才会被 WXML 渲染出触发入口，各处理函数再做二次校验兜底。
  onOpenViewModeModal() {
    if (!this.data.isRealSuperAdmin) return;
    const mode = this.data.currentViewMode;
    this.setData({
      showViewModeModal: true,
      viewModeModalPendingMode: mode,
      viewModeModalPendingLabel: PREVIEW_VIEW_MODE_LABELS[mode] || ''
    });
  },

  onCloseViewModeModal() {
    this.setData({ showViewModeModal: false });
  },

  // 点击卡片仅暂存待选视角（连同展示用的 label）、高亮对应 Card，不立即生效——
  // 须点击"确认切换"才真正落地 currentViewMode/触发页面刷新，交互解耦：draft
  // 暂存与真正生效是两个独立步骤，与 switch-identity 半屏弹窗同一套范式
  onSelectViewModeCard(e: any) {
    const mode = e.currentTarget.dataset.mode as PreviewViewMode;
    if (!mode) return;
    this.setData({
      viewModeModalPendingMode: mode,
      viewModeModalPendingLabel: PREVIEW_VIEW_MODE_LABELS[mode] || ''
    });
  },

  onConfirmViewModeModal() {
    if (!this.data.isRealSuperAdmin) return;
    const mode = this.data.viewModeModalPendingMode as PreviewViewMode;
    if (!mode) return;
    this.applyViewModeSwitch(mode);
  },

  // 🆕 恢复默认视角：跳过"选卡片→点确认"两步，一键直接切回超级管理员全景，
  // 与 onConfirmViewModeModal 共用同一套应用+反馈逻辑
  onResetToDefaultViewMode() {
    if (!this.data.isRealSuperAdmin) return;
    this.applyViewModeSwitch('SUPER_ADMIN');
  },

  // 🆕 真正落地一次视角切换：写入本地预览态（setPreviewViewMode）、关闭弹窗、
  // toast 反馈、刷新本页展示——onConfirmViewModeModal/onResetToDefaultViewMode
  // 两个入口共用，避免重复维护同一段逻辑
  applyViewModeSwitch(mode: PreviewViewMode) {
    setPreviewViewMode(mode);
    // 🐛 核心修复配套："选择服务站点与身份"/"切换身份"弹窗手动切换后写入的
    // current_user_role 现在对 initMinePage() 拥有最高优先级（见该方法内
    // applyRoleViewOverride 调用处的注释），如果这里不清空它，用户在本弹窗
    // 显式选择的预览视角/点击"还原超管视角"都会被那份手动切换记录盖回去，
    // 形同虚设。这里正是需求里"除非用户主动点击了还原按钮"允许覆盖手动切换的
    // 唯一入口——onConfirmViewModeModal（确认切换到任意视角）与
    // onResetToDefaultViewMode（还原超管视角）都共用这个方法
    //
    // 🐛 光清 current_user_role 还不够：initMinePage() 的第二优先级信号
    // app.globalData.currentStore.role 也会被同一次手动切换写入（store-picker
    // _applyRoleSwitch），且不会随 current_user_role 一起被上面这行清空——如果
    // 留着不管，storageRole 一清空，globalRoleLower 这个兜底信号立刻带着同一个
    // 陈旧角色重新顶上来，等于换了个路径把刚清掉的 bug 又变出来一次。这里一并
    // 归位为当前真实身份（超管），两个信号才能保持一致
    wx.removeStorageSync('current_user_role');
    const app = getApp() as any;
    if (app && app.globalData && app.globalData.currentStore) {
      app.globalData.currentStore.role = 'ADMIN';
    }
    this.setData({ showViewModeModal: false });
    wx.showToast({
      title: `已切换至${PREVIEW_VIEW_MODE_LABELS[mode]}`,
      icon: 'success'
    });

    // 立即刷新本页展示；首页会在下次 onShow（切换 Tab）时自动应用同一预览角色
    this.initMinePage();
  },

  /**
   * 任务C：加载本地护持统计（与首页共享同一组 localStorage 数据）
   */
  // 🏪 门店隔离：改为按当前门店动态过滤 my_checkin_logs（见 computeMyCheckInStats），
  // 不再直接读全局递增计数器——切换门店后这里展示的天数/工时只统计在当前门店的贡献
  loadVolunteerStats() {
    try {
      const activeStore = getSelectedStore();
      const scopedStats = computeMyCheckInStats(
        (activeStore && activeStore.storeId) || '',
        (activeStore && activeStore.storeName) || ''
      );

      this.setData({
        'stats.volunteerDays': scopedStats.days,
        'stats.volunteerHours': scopedStats.hours,
        'stats.volunteerCheckInCount': scopedStats.count
      });
      this.computeBadgeList();
    } catch (err) {
      console.warn('[mine] 读取护持统计数据失败:', err);
    }
  },

  // 🌟 数字荣誉墙：根据最新的护持天数/累计工时重新计算每枚徽章的解锁状态与提示文案。
  // stats 有两处独立更新入口（本地缓存的 loadVolunteerStats 与云端校准的 fetchMeritStats），
  // 两处都要各自触发一次重算，确保徽章墙始终反映当前已知的最新数据，不会停留在旧状态。
  computeBadgeList() {
    const volunteerDays = this.data.stats.volunteerDays || 0;
    const volunteerHours = this.data.stats.volunteerHours || 0;
    // 🔥 连续护持天数（streak）纯本地打卡流水计算，与云端校准的 days/hours 各自
    // 独立取数互不影响——不管调用方（loadVolunteerStats/fetchMeritStats 等）当次
    // 走的是本地口径还是云端校准口径，streak 统一按当前选中门店自行推算一次
    const activeStore = getSelectedStore();
    const volunteerStreak = computeMyCheckInStreak(
      (activeStore && activeStore.storeId) || '',
      (activeStore && activeStore.storeName) || ''
    );
    // 解锁规则/阈值提取到 utils/badgeWall.ts 共享给 journey.ts 的 3 列勋章墙，
    // 这里只是调用同一份计算，不再各画一套
    this.setData({ badgeList: computeBadgeListShared(volunteerDays, volunteerHours, volunteerStreak) });
  },

  async fetchMeritStats(role: string) {
    try {
      const db = wx.cloud.database();
      const openid = AuthService.getOpenid() || '';
      // 🛡️ 数据库缺索引告警根因：下面两条 report_logs count() 都曾只按 createdBy/auditedBy
      // 过滤，没有 tenantId 前缀，等于对全表（跨所有机构）做扫描。tenantId 是
      // tenantId_date 复合索引的前导字段，查询条件必须带上它才能真正走到索引，
      // 而不是退化成全表扫描；同时也顺带堵住了"跨租户读到别的机构统计数字"的隔离漏洞。
      const cachedRoleInfo = AuthService.getCachedRoleInfo();
      const tenantId = (cachedRoleInfo && cachedRoleInfo.tenantId) || '';
      // 🏪 门店隔离：本页顶层 data.currentStoreId 从未被真正赋值过（只有
      // patriarchData.currentStoreId 这个同名但不同用途的嵌套字段），这里直接现取
      // 当前生效门店，确保"登记餐报/稽核账本"只统计当前门店，不会把用户在别的门店
      // 的历史记录也计进来
      // 🐛 根因修复：super_admin 在门店选择器里选中"全国总览"时，getSelectedStore()
      // 返回的 storeId 是 NATIONAL_STORE_ID_SENTINELS 里的字面量哨兵值（如
      // 'national_overview'），不是任何真实门店——此前直接把这个哨兵值当门店 id
      // 传给 report_logs.storeId 查询条件，注定查不到任何匹配记录（"登记餐报"/
      // "已稽核账本"荣誉墙数字对超管永远显示 0），还会打出云开发数据库索引建议
      // 告警（查询条件带着这类脏值触发扫描提示）。命中哨兵值时统一归空，让下面
      // `tenantId && storeId` 的判断自然跳过这两条查询，不再发出这种注定无意义
      // 的请求
      const activeStore = getSelectedStore();
      const rawStoreId = (activeStore && activeStore.storeId) || '';
      const storeId = NATIONAL_STORE_ID_SENTINELS.includes(rawStoreId) ? '' : rawStoreId;

      let submittedCount = 0;
      let auditedCount = 0;

      try {
        // 🐛 严重根因修复：report_logs 集合从未写过 createdBy 字段（createdBy 只在
        // stores/notice/daily_menu 等其他集合里使用），提交人身份统一走云开发自动
        // 挂载的 _openid（updateReportLog/getReports/manageReportApproval 等云函数
        // 判断"是否为提交人本人"全都用的是 docData._openid）。此前按 createdBy 查询，
        // 查询条件恒不命中，"登记餐报"这项荣誉墙统计对所有人都是 0。
        // 🏛️ 权限向下继承：大家长同样可能承担日常提交/稽核工作，统计口径一并覆盖
        if ((role === 'store_manager' || role === 'store_patriarch' || role === 'super_admin') && tenantId && storeId) {
          const subRes = await db.collection('report_logs')
            .where({
              tenantId,
              storeId,
              _openid: openid
            })
            .count();
          submittedCount = subRes.total || 0;
        }

        // 🛡️ 已知局限（非本次可修复范围）：report_logs.auditedBy 由 manageReportApproval
        // 写入的是角色标签字符串（如"财务稽核员"/"大家长"），不是个人 openid——真正的
        // 个人操作者身份只记录在独立的 report_audit_logs.operator_id 里，report_logs
        // 文档本身不具备"这条记录是谁个人稽核的"这个字段，无法在这条查询上做到与
        // submittedCount 同等的个人隔离，暂时只能收窄到"当前门店 + 本机构"维度
        // （即"本店已稽核的账目数"，不是"我个人稽核过的账目数"）。
        // 这两个数字是直接展示给用户的"已提交/已稽核"荣誉墙统计，不是单纯的"是否存在"
        // 判断，所以不能用 limit(1) 替代——limit(1) 只能回答"有没有"，答不出"有多少"。
        if ((role === 'finance' || role === 'store_patriarch' || role === 'super_admin') && tenantId && storeId) {
          const audRes = await db.collection('report_logs')
            .where({
              tenantId,
              storeId,
              auditedBy: db.command.exists(true)
            })
            .count();
          auditedCount = audRes.total || 0;
        }
      } catch (dbErr) {
        console.warn('[fetchMeritStats] 数据库查询失败，使用兜底数据:', dbErr);
      }

      // 🏪 门店隔离：与 loadVolunteerStats 同一套口径，按当前门店动态过滤
      // my_checkin_logs，不再直接读全局递增计数器
      const scopedStats = computeMyCheckInStats(storeId, (activeStore && activeStore.storeName) || '');

      this.setData({
        stats: {
          volunteerDays: scopedStats.days,
          volunteerHours: scopedStats.hours,
          volunteerCheckInCount: scopedStats.count,
          submittedReports: submittedCount,
          auditedReports: auditedCount
        }
      });
      this.computeBadgeList();
    } catch (err) {
      console.error('[fetchMeritStats] 加载失败:', err);
      const fallbackStore = getSelectedStore();
      const fallbackStats = computeMyCheckInStats(
        (fallbackStore && fallbackStore.storeId) || '',
        (fallbackStore && fallbackStore.storeName) || ''
      );

      this.setData({
        stats: {
          volunteerDays: fallbackStats.days,
          volunteerHours: fallbackStats.hours,
          volunteerCheckInCount: fallbackStats.count,
          submittedReports: 0,
          auditedReports: 0
        }
      });
      this.computeBadgeList();
    }
  },

  // ❤️ 切换爱心护持榜 Segment：[本月榜]/[年度榜]/[总贡献榜]
  onSwitchLeaderboardRange(e: any) {
    const range = e.currentTarget.dataset.range;
    if (!range || range === this.data.leaderboardRange) return;
    this.setData({ leaderboardRange: range });
    this.fetchLeaderboard(range);
  },

  // ❤️ 爱心护持榜数据加载：10 分钟 ViewModel 本地缓存（同门店+同榜单档位命中即用，
  // 不重新打云函数）+ 切换 Segment 连点防抖，两者共同减少护持榜对云函数的调用频率，
  // 消除频繁请求 volunteer_duty_logs 聚合查询带来的加载卡顿
  fetchLeaderboard(range?: 'month' | 'year' | 'total', forceRefresh = false) {
    if (this.data.isFamily) return;

    const targetRange = range || this.data.leaderboardRange;
    const activeStore = getSelectedStore();
    const storeId = (activeStore && activeStore.storeId) || '';
    if (!storeId) return;

    // 🐛 崩溃修复：_leaderboardCache 是挂在页面实例上的纯运行时对象，不经过
    // data，框架不负责初始化/合并它——开发工具热重载等边界场景下曾观察到它
    // 读到 undefined（TypeError: Cannot read property 'xxx_month' of
    // undefined），且这段代码在 setTimeout 之外、没有 try/catch 包裹，抛出的
    // 异常会直接阻断 initMinePage() 级联调用链、打断页面渲染。这里无条件先
    // 兜底重建成空对象，保证下面这次读取与稍后 setTimeout 回调里的写入
    // （同一个对象引用）任何时候都不会再抛出
    if (!this._leaderboardCache) {
      this._leaderboardCache = {};
    }

    const cacheKey = `${storeId}_${targetRange}`;
    if (!forceRefresh) {
      const cached = this._leaderboardCache[cacheKey];
      if (cached && (Date.now() - cached.time) < LEADERBOARD_CACHE_TTL_MS) {
        this.applyLeaderboardResult(cached.data);
        return;
      }
    }

    if (this._leaderboardFetchTimer) {
      clearTimeout(this._leaderboardFetchTimer);
    }

    this.setData({ leaderboardLoading: true });
    this._leaderboardFetchTimer = setTimeout(async () => {
      try {
        if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
        const res: any = await wx.cloud.callFunction({
          name: 'manageVolunteerCheckIn',
          data: { action: 'leaderboard', range: targetRange, storeId }
        });
        // 🛡️ res.result 在个别基础库/网络异常场景下可能整个是 undefined，
        // 兜底成 null 再判断，不直接解构/取属性
        const result = (res && res.result) || null;
        if (result && result.success) {
          if (!this._leaderboardCache) {
            this._leaderboardCache = {};
          }
          this._leaderboardCache[cacheKey] = { time: Date.now(), data: result };
          this.applyLeaderboardResult(result);
        } else {
          this.setData({ leaderboardLoading: false });
        }
      } catch (err) {
        console.warn('[fetchLeaderboard] 加载失败:', err);
        this.setData({ leaderboardLoading: false });
      }
    }, LEADERBOARD_FETCH_DEBOUNCE_MS);
  },

  // 🛡️ 崩溃修复：result.list 此前只用 `|| []` 兜底假值（undefined/null/0/''），
  // 云函数一旦因为异常分支返回了非数组的真值（例如误把单个对象当列表塞进
  // 字段），`|| []` 完全挡不住——这个非数组值会原样写进 leaderboardList，
  // wxml 里的 leaderboardList.length / wx:for 立刻抛出 "Cannot read property
  // 'length' of undefined"（WASubContext.js）级别的渲染层崩溃。改用
  // Array.isArray 严格校验，任何非数组取值一律兜底成空数组
  applyLeaderboardResult(result: any) {
    const safeList = Array.isArray(result?.list) ? result.list : [];
    this.setData({
      leaderboardList: safeList,
      leaderboardSelfRank: result?.selfRank || 0,
      leaderboardSelfHours: result?.selfHours || 0,
      leaderboardGapToNext: result?.gapToNext || 0,
      leaderboardTotalRanked: result?.totalRanked || 0,
      leaderboardLoading: false
    });
  },

  // 🛡️ 身份词汇换算：this.data.currentUserRole（snake_case 展示态，isFamily 为真时
  // 底层其实还是 'volunteer'）-> roles 数组里的大写 token，供"切换身份"面板判断
  // 当前正在查看的是哪一档、以及退出时该向服务端声明剥离哪一个
  currentRoleToken(): string {
    if (this.data.isFamily) return 'FAMILY';
    const map: Record<string, string> = {
      store_manager: 'STORE_MANAGER',
      store_patriarch: 'STORE_PATRIARCH',
      finance: 'FINANCE',
      volunteer: 'VOLUNTEER',
      super_admin: 'SUPER_ADMIN'
    };
    return map[this.data.currentUserRole] || 'VOLUNTEER';
  },

  // 🏛️ 多角色兼任入口：账号持有 2 个及以上身份（roles.length > 1）时，优先展示
  // "切换身份"面板；只有单一身份（或未升级的历史记录，roles 缺失/长度 ≤1）时，
  // 跳过面板直接进入退出确认弹窗，与升级前的单身份体验完全一致
  onReleaseUserRole() {
    if (this.isNavigating) return;

    const cachedRole = AuthService.getCachedRoleInfo();
    const heldRoles = (cachedRole && Array.isArray(cachedRole.roles)) ? cachedRole.roles : [];

    if (heldRoles.length > 1) {
      const currentToken = this.currentRoleToken();
      const switchableRoleOptions = heldRoles
        .filter((r: string) => r !== currentToken && ROLE_TOKEN_LABELS[r])
        .map((r: string) => ({ role: r, label: ROLE_TOKEN_LABELS[r] }));

      this.setData({
        showSwitchIdentityModal: true,
        switchableRoleOptions
      });
      return;
    }

    this.onOpenReleaseConfirmModal();
  },

  onCloseSwitchIdentityModal() {
    this.setData({ showSwitchIdentityModal: false });
  },

  // 🔄 切换至已持有的另一档身份：纯客户端展示态切换（两个身份都已由服务端合法
  // 核销授权过，不需要也不应该为"换个视角看"这件事再打一次云函数）。与
  // store-picker.ts _applyRoleSwitch 同一套本地存储 key，保持两处切换身份的
  // 落地效果一致
  onSwitchToRole(e: any) {
    const role = e.currentTarget.dataset.role;
    const storageRole = ROLE_TOKEN_TO_LOWER[role];
    if (!storageRole) return;

    const cachedRole = AuthService.getCachedRoleInfo();
    const storeId = (cachedRole && cachedRole.storeId) || '';
    const storeName = (cachedRole && cachedRole.storeName) || this.data.currentStoreName;

    wx.setStorageSync('current_user_role', storageRole);
    wx.setStorageSync('current_store_name', storeName);
    wx.setStorageSync('active_store_id', storeId);
    AuthService.overwriteCachedRole(storageRole);

    const app = getApp() as any;
    if (app && app.globalData) {
      app.globalData.currentStore = { storeId, storeName, role };
    }

    // 🆕 状态落地后立即重新计算 isVolunteer/isFinance/isPatriarch 等标记位，
    // 不等弹窗关闭动画结束——initMinePage 内部自行走一遍 storageRole 优先的
    // 角色解析（见该方法注释），与这里刚写入的 current_user_role 保持一致
    this.initMinePage();

    // 🆕 延迟 200ms 关闭弹窗 + 成功态 Toast，让用户先看清楚是切到了哪个身份，
    // 与 store-picker.ts _applyRoleSwitch 同一套节奏
    setTimeout(() => {
      this.setData({ showSwitchIdentityModal: false });
      wx.showToast({ title: '已切换身份', icon: 'success' });
    }, 200);
  },

  // 🚪 从"切换身份"面板转入退出确认弹窗：退出的目标固定为当前正在查看的这一档身份
  onOpenReleaseConfirmModal() {
    const roleMap: Record<string, string> = {
      'store_manager': '店长',
      'finance': '财务',
      'super_admin': '超级管理员',
      'store_patriarch': '大家长',
      'store_family': '家人'
    };
    const roleLabel = roleMap[this.data.currentUserRole] || '管理员';

    this.setData({
      showSwitchIdentityModal: false,
      showReleaseModal: true,
      releaseRoleLabel: roleLabel,
      releaseTargetRole: this.currentRoleToken()
    });
  },

  stopPropagation() {},

  onCancelReleaseModal() {
    if (this.data.isReleasing) return;
    this.setData({ showReleaseModal: false });
  },

  // 🛡️ 根因修复：此前这里只清本地 storage，从未通知服务端——user_roles 记录里的
  // role/storeId 原封不动，下次任意页面重新 fetchUserRole() 时服务端照样吐回卸任前
  // 的角色，权限在用户毫不知情的情况下自动复活，与弹窗"该操作不可逆"的承诺完全相反。
  // 现在改为先调用 processRoleAudit(action:'releaseSelf', targetRole) 让服务端真正
  // 剥离这一个具体身份——服务端会按 caller.roles 数组算出"剥离后剩余身份里权限
  // 最高的一档"作为降级结果（remainingRole/remainingStatus），仍持有其他身份时
  // 平滑切回那一档展示，彻底无身份时才清空门店绑定。
  //
  // 🛡️ 不再用 AuthService.clearAuth() 整体清空登录态——那会连 openid 一起丢弃，
  // 逼用户重新走一遍登录，而这里退出的只是某一个身份，不是注销账号。改为重新
  // 拉取 AuthService.fetchUserRole()（服务端刚写入的最新角色）+ 同步本地
  // current_user_role 展示态存储，避免 initMinePage() 的"storageRole 优先"读取
  // 逻辑覆盖回卸任前的旧值；也不再强制 reLaunch 跳首页，原地刷新即可平滑过渡
  async onConfirmReleaseRole() {
    if (this.data.isReleasing) return;
    this.setData({ isReleasing: true });

    wx.showLoading({ title: '安全卸任中...' });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { action: 'releaseSelf', targetRole: this.data.releaseTargetRole }
      });
      const result: any = res.result;
      wx.hideLoading();

      if (!result || !result.success) {
        this.setData({ isReleasing: false });
        wx.showModal({ title: '无法卸任', content: (result && result.error) || '卸任失败，请重试', showCancel: false });
        return;
      }

      await AuthService.fetchUserRole();

      const storageRole = (result.remainingRole === 'volunteer' && result.remainingStatus !== 'approved')
        ? 'store_family'
        : (result.remainingRole || 'volunteer');
      wx.setStorageSync('current_user_role', storageRole);
      if (!result.hasRemainingRoles) {
        // 彻底无身份可降级：门店绑定已被服务端清空，本地这两份缓存也一并清理，
        // 避免残留旧门店名/旧胶囊解锁记录
        wx.removeStorageSync('current_store_name');
        wx.removeStorageSync('my_authorized_roles');
      }

      this.setData({ showReleaseModal: false, isReleasing: false });
      wx.showToast({ title: '已成功退出该身份', icon: 'success' });

      this.initMinePage();
    } catch (err) {
      wx.hideLoading();
      console.error('[onConfirmReleaseRole] 卸任异常:', err);
      this.setData({ isReleasing: false });
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  onTriggerActivate() {
    wx.showModal({
      title: '🔑 激活特权身份',
      content: '请移步至主页，在门店选择器中选择您要激活的门店与身份，并输入超级管理员提供的激活码进行绑定。',
      showCancel: false,
      confirmColor: '#8C1D18',
      success: () => {
        if (this.isNavigating) return;
        this.isNavigating = true;
        wx.switchTab({
          url: '/pages/index/index',
          fail: () => {
            this.isNavigating = false;
          }
        });
      }
    });
  },

  // 📜 服务历程：原 onGoToJourney，首页打卡卡片精简后"服务历程"入口收拢到
  // 个人页"日常记录"列表统一承载。这个入口现在只出现在 !isFamily 分组里
  // （家人分支已改用 onGoToActivityLog 直达门店日志），故不再需要按 isFamily
  // 分流目标页面，固定跳个人打卡历程页即可
  onTapServiceHistory() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/journey/journey',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🌟 数字荣誉墙：点击任一枚徽章，弹出详情弹窗展示名称/图标/解锁条件/当前进度条——
  // 不再区分已解锁/未解锁走不同分支（原先已解锁直接跳证书、未解锁只弹 toast），
  // 统一体验更清晰；查看电子证书仍走 honor-wall-header 里独立的"义工证书"入口
  // （onGoToBadges），两者不冲突
  onTapBadge(e: any) {
    const id = e.currentTarget.dataset.id;
    const badge = (this.data.badgeList || []).find((b: any) => b.id === id);
    if (!badge) return;

    this.setData({ showBadgeDetailModal: true, selectedBadge: badge });
  },

  onCloseBadgeDetailModal() {
    this.setData({ showBadgeDetailModal: false });
  },

  // 🎖️ 分享荣誉：徽章详情弹窗里"分享荣誉"按钮（open-type="share"，仅已解锁徽章
  // 展示）触发的标准微信分享卡片，按当前选中徽章动态生成标题
  onShareAppMessage() {
    const badge = this.data.selectedBadge;
    if (badge && badge.unlocked) {
      return {
        title: `我在雨花斋解锁了「${badge.name}」荣誉徽章，一起来护持吧！`,
        path: '/pages/index/index'
      };
    }
    return {
      title: '雨花爱心餐报助手 · 一起护持爱心餐桌',
      path: '/pages/index/index'
    };
  },

  // 🛡️ 义工证书生成前的空值校验：不直接信任 this.data 上可能滞后的
  // userNickName/stats/currentStoreName（例如页面刚 onShow、initMinePage 里的异步
  // fetchMeritStats 还没回来就点了这个入口），现场重新兜底取一遍——护持天数/工时
  // 来自本地 my_checkin_logs 本就同步读取无竞态，这里额外用 computeMyCheckInStats
  // 现算一遍而不是信任可能残留旧门店视角的 this.data.stats，门店名/昵称同样各自
  // 兜底到 AuthService 缓存/getSelectedStore()，确保传给 Canvas 绘制的一定是非空值
  resolveCertificateProfile(): { nickname: string; storeName: string; storeId: string; qrStoreId: string; days: number; hours: number; certNo: string } {
    const cachedRole = AuthService.getCachedRoleInfo();
    const activeStore = getSelectedStore();
    // 🌐 证书右下角二维码始终指向当前实际选中的门店（哪怕正文按全国总览聚合工时），
    // 与下面 storeId（工时统计口径，全国总览时会置空改为不限门店）分开维护
    const qrStoreId = (activeStore && activeStore.storeId) || (cachedRole && cachedRole.storeId) || '';

    // 🛡️ 严格权限隔离：仅 super_admin 允许查看"全国总览"聚合工时并生成对应证书——
    // 大家长/店长/财务/义工/家人一律禁止，与 store-picker 组件"全国总览"虚拟条目
    // 仅对已核验 super_admin 展示的口径完全一致（见 components/store-picker/
    // store-picker.ts isVerifiedSuperAdmin）。哪怕 currentStoreName/getSelectedStore()
    // 因历史脏数据或极端时序偶然携带"全国总览"字样，非超管账号也必须强制过滤掉该值、
    // 收敛回自己真实绑定的具体门店，绝不据此统计全部门店工时或在证书上印出"全国总览"
    const rawStoreName = this.data.currentStoreName || (activeStore && activeStore.storeName) || (cachedRole && cachedRole.storeName) || '';
    const isNational = this.data.isSuperAdmin && isVirtualStoreName(rawStoreName);

    const storeId = isNational ? '' : qrStoreId;
    const storeName = isNational ? '全国总览' : (isVirtualStoreName(rawStoreName) ? '' : rawStoreName);
    const nickname = this.data.userNickName || (cachedRole && cachedRole.nickName) || '爱心义工';

    const scopedStats = computeMyCheckInStats(storeId, storeName, isNational);
    // 🐛 全国总览分支不做 this.data.stats 兜底回退——那份数据始终是"当前单店"口径，
    // 用它兜底聚合结果会让全国总览证书悄悄显示成单店数字
    const days = isNational ? scopedStats.days : (scopedStats.days || this.data.stats.volunteerDays || 0);
    const hours = isNational ? scopedStats.hours : (scopedStats.hours || this.data.stats.volunteerHours || 0);

    // 🔖 专属证书编号：openid + 门店 + 当天日期派生的确定性短码，同一账号同一天
    // 多次打开生成的编号保持一致，不需要额外的云端序列号表
    const openid = AuthService.getOpenid() || '';
    const todayCompact = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let hash = 0;
    const hashSrc = openid + storeId;
    for (let i = 0; i < hashSrc.length; i++) {
      hash = (hash * 31 + hashSrc.charCodeAt(i)) >>> 0;
    }
    const certNo = `YH${todayCompact}-${hash.toString(16).toUpperCase().padStart(6, '0').slice(-6)}`;

    return { nickname, storeName, storeId, qrStoreId, days, hours, certNo };
  },

  // 义工证书：异步绘制一张长图证书（Canvas 2D），绘制完成后展示为可保存的全屏预览
  async onGoToBadges() {
    const { nickname: userNickName, storeName: currentStoreName, qrStoreId, days: certDays, hours: certHours, certNo } = this.resolveCertificateProfile();

    // 🛡️ 零工时拦截：没有任何护持记录时生成的证书正文只会是"0 天 0 小时"，
    // 既无意义也容易被截图滥用，直接在绘制前拦下，不消耗一次 Canvas 绘制
    if (certHours <= 0 || certDays <= 0) {
      wx.showToast({ title: '当前暂无护持工时，无法生成证书', icon: 'none' });
      return;
    }

    this.setData({
      showCertificateModal: true,
      certificateTempFilePath: '',
      certificateGenerating: true
    });
    wx.showLoading({ title: '正在生成证书...', mask: true });

    // 🌟 证书右下角的小程序码：复用 getStoreQRCode，但带上 purpose: 'certificate'——
    // 该云函数默认只允许店长/超管生成门店推广二维码，普通义工调用会被拒绝；证书场景下
    // 已经放宽为"任何角色都可以生成自己所属门店的二维码"（见云函数侧改动），
    // 这里获取失败也不阻断证书生成，只是最终图上不显示二维码
    let qrCodeLocalPath = '';
    try {
      const storeId = qrStoreId;
      if (storeId) {
        const qrRes = await wx.cloud.callFunction({
          name: 'getStoreQRCode',
          data: { storeId, storeName: currentStoreName, purpose: 'certificate' }
        });
        const qrResult = qrRes.result as any;
        if (qrResult && qrResult.success && qrResult.fileID) {
          const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
          qrCodeLocalPath = downRes.tempFilePath;
        } else {
          console.warn('[onGoToBadges] 小程序码生成失败:', qrResult && qrResult.error);
        }
      }
    } catch (qrErr) {
      console.warn('[onGoToBadges] 小程序码获取异常，证书将不显示二维码:', qrErr);
    }

    // Canvas 节点要等 wx:if="{{showCertificateModal}}" 对应的 <canvas> 真正挂载渲染后
    // 才能被 selectorQuery 查到，这里延迟一小段时间与其它海报生成流程保持一致的做法
    setTimeout(() => {
      const query = wx.createSelectorQuery();
      query.select('#' + CERTIFICATE_CANVAS_ID)
        .fields({ node: true, size: true })
        .exec(async (res) => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading();
            this.setData({ certificateGenerating: false });
            wx.showToast({ title: '证书生成失败', icon: 'none' });
            return;
          }

          const canvas = res[0].node;
          try {
            await drawVolunteerCertificate({
              canvas,
              nickname: userNickName,
              days: certDays,
              hours: certHours,
              qrCodeTempPath: qrCodeLocalPath,
              width: 340,
              height: 480,
              storeName: currentStoreName,
              certNo
            });

            wx.canvasToTempFilePath({
              canvas,
              success: (tempRes) => {
                this.setData({ certificateTempFilePath: tempRes.tempFilePath, certificateGenerating: false });
                wx.hideLoading();
              },
              fail: (err) => {
                wx.hideLoading();
                this.setData({ certificateGenerating: false });
                console.error('[onGoToBadges] canvasToTempFilePath 失败:', err);
                wx.showToast({ title: '证书生成失败', icon: 'none' });
              }
            });
          } catch (drawErr) {
            wx.hideLoading();
            this.setData({ certificateGenerating: false });
            console.error('[onGoToBadges] 绘制失败:', drawErr);
            wx.showToast({ title: '证书绘制失败', icon: 'none' });
          }
        });
    }, 300);
  },

  onCloseCertificateModal() {
    this.setData({ showCertificateModal: false });
  },

  // 🖼️ 点击证书图片全屏预览：wx.previewImage 自带的系统工具栏本就包含"发送给朋友/
  // 收藏/保存图片"，与 image 组件的 show-menu-by-longpress 长按菜单互为补充——
  // 很多用户不知道要长按，点一下就能进入预览态更符合直觉
  onPreviewCertificateImage() {
    const filePath = this.data.certificateTempFilePath;
    if (!filePath) return;
    wx.previewImage({ current: filePath, urls: [filePath] });
  },

  // 🛡️ 证书图片加载失败兜底：certificateTempFilePath 是本地临时文件路径，
  // 小概率会在渲染前被系统清理掉——加载失败时清空该字段，退回展示 Canvas
  // （wx:if="{{!certificateTempFilePath}}" 会重新接管），并提示用户重新生成
  onCertificateLoadError(e: any) {
    console.warn('[onCertificateLoadError] 证书图片加载失败:', e && e.detail);
    this.setData({ certificateTempFilePath: '' });
    wx.showToast({ title: '证书图片加载失败，请重新生成', icon: 'none' });
  },

  onSaveCertificateToAlbum() {
    const filePath = this.data.certificateTempFilePath;
    if (!filePath) {
      wx.showToast({ title: '证书尚未生成完成，请稍候', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: '证书已保存至相册，快去分享朋友圈吧', icon: 'success', duration: 2500 });
      },
      fail: (err: any) => {
        if (err.errMsg && err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许小程序访问相册，才能保存证书图片',
            confirmText: '去设置',
            success: (res) => {
              if (res.confirm) wx.openSetting();
            }
          });
        } else {
          console.warn('[onSaveCertificateToAlbum] 保存失败:', err);
          wx.showToast({ title: '保存失败，请重试', icon: 'none' });
        }
      }
    });
  },

  // 🖼️ 家人证书专属保存按钮：家人证书是纯 WXML 文本渲染，没有对应的 Canvas 长图——
  // 与义工分支共用 certificateTempFilePath 这个字段判断：理论上家人分支永远是空的
  // （onOpenCertificateModal 每次打开都会清空它），直接给温情提示；万一将来家人分支也
  // 接上图片生成，这里已经能直接复用 onSaveCertificateToAlbum 走相册保存，不用改这里
  onSaveCertificateImage() {
    if (this.data.certificateTempFilePath) {
      this.onSaveCertificateToAlbum();
      return;
    }
    wx.showToast({ title: '感恩家人的护持与陪伴！', icon: 'none' });
  },

  // 📄 我的餐报提交记录：义工从不写 report_logs（见 volunteer_submissions 相关注释），
  // 对义工来说这个入口原本导向的"我的正式台账历史"永远是空列表——改为按角色分流：
  // 义工打开自己的 volunteer_submissions 记录弹窗，其余角色（店长/财务/超管）
  // 保持原有行为不变，仍是真实的 report_logs 历史页
  onGoToMySubmissions() {
    if (this.data.isVolunteer && !this.data.isFamily) {
      this.onOpenMyVolunteerSubmissions();
      return;
    }

    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/history/history?view=mine',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onOpenMyVolunteerSubmissions() {
    this.setData({ showMyVolunteerSubmissionsModal: true });
    this.fetchMyVolunteerSubmissions();
  },

  onCloseMyVolunteerSubmissionsModal() {
    this.setData({ showMyVolunteerSubmissionsModal: false });
  },

  // 🐛 根因修复："点击已驳回记录无反应"：此前列表卡片没有绑定任何 bindtap，
  // 点了完全没反应。待店长确认/已采纳两种状态目前没有额外可交互的内容（原因/
  // 详情已经直接展示在卡片上），点击时不做动作。
  // ✏️ 重新修改并提交：已驳回的记录点击卡片本身或"重新修改并提交"按钮时，
  // 直接把这条记录的原始数据带回对应的填报表单（菜单人数/物资消耗）并关掉
  // "我的提交记录"列表弹窗——不再经过中间的"驳回原因详情"弹窗，驳回原因已经
  // 直接展示在列表卡片上了（见 .my-vs-reject-reason），没必要多一层确认才能
  // 进入编辑。复用已有的 submit 动作生成一条新的 pending 记录，被驳回的这条
  // 仍留在列表里作为历史留痕，不做任何删除/覆盖（如需清掉见 onDeleteMyVolunteerSubmission）
  onTapMyVolunteerSubmissionItem(e: any) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.myVolunteerSubmissionsList[index];
    if (!item || item.status !== 'rejected') return;

    if (item.type === 'menu') {
      const modal = this.selectComponent('#dailyMenuModal') as any;
      if (modal) modal.presetForm(item);
      this.setData({
        showMyVolunteerSubmissionsModal: false,
        showDailyMenuModal: true
      });
    } else {
      const modal = this.selectComponent('#materialUsageModal') as any;
      if (modal) modal.presetForm(item);
      this.setData({
        showMyVolunteerSubmissionsModal: false,
        showMaterialUsageModal: true
      });
    }
  },

  // 🗑️ 删除/撤销已驳回或待审核记录：义工确认不再需要这条记录时，彻底清掉它——
  // 已驳回的是"不改了不重提了"，待审核的是"提交手滑了，店长还没处理，先撤回"。
  // 服务端 deleteMine 动作会再校验一次"必须是本人提交 + 状态仍是 rejected/pending"，
  // 双重防线避免误删已经被店长采纳入库的记录
  async onDeleteMyVolunteerSubmission(e: any) {
    if (!isCloudAvailable()) return;
    const index = e.currentTarget.dataset.index;
    const item = this.data.myVolunteerSubmissionsList[index];
    if (!item || (item.status !== 'rejected' && item.status !== 'pending')) return;

    const isPending = item.status === 'pending';
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: isPending ? '撤销提交' : '删除记录',
        content: isPending ? '确定要撤销并删除这条尚未审核的提交吗？' : '确定要删除此条已驳回记录吗？',
        confirmText: isPending ? '撤销' : '删除',
        confirmColor: '#C0392B',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerSubmission',
        data: { action: 'deleteMine', id: item._id }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '删除失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: isPending ? '已撤销' : '已删除', icon: 'success' });
      this.fetchMyVolunteerSubmissions();
    } catch (err) {
      console.error('[onDeleteMyVolunteerSubmission] 删除异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  // 🔒 申请冲销：已采纳入库记录对非超管的替代入口——不触发任何撤回/删除动作，
  // 只弹出说明引导线下联系店长处理，与 onRevokeApprovedSubmission（仅超管可见）
  // 彻底分开，避免普通提交人误触发级联扣减统计数据
  onRequestWriteOff() {
    wx.showModal({
      title: '暂不支持自助撤回',
      content: '该记录已采纳入库，如需修改请联系店长发起冲销',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 🔄 撤回已采纳入库的记录：与 onDeleteMyVolunteerSubmission 分开单独成一个
  // 处理函数——这条记录已经把数据合并进了门店当天的 report_logs/material_logs，
  // 撤回不只是删记录本身，还要先把当初写入的贡献反向冲减掉，风险和确认文案都
  // 与"删一条还没生效的 pending/rejected 草稿"不同。
  // 🛡️ 仅超级管理员可见/可执行（见 wxml wx:if="{{isRealSuperAdmin}}"，此处再做一次
  // 二次校验兜底）：已采纳入库的记录级联影响门店账本/库存统计，普通提交人一律
  // 走 onRequestWriteOff 的"联系店长"提示，不再允许自助撤回。服务端 revokeMine
  // 同步校验一次"必须是超级管理员 + 状态仍是 approved + 所在日期未封账"，如果
  // 账本在此期间已被别的记录覆盖或已被财务封账，会拒绝撤回并原样报错
  async onRevokeApprovedSubmission(e: any) {
    if (!isCloudAvailable()) return;
    if (!this.data.isRealSuperAdmin) return;
    const index = e.currentTarget.dataset.index;
    const item = this.data.myVolunteerSubmissionsList[index];
    if (!item || item.status !== 'approved') return;

    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '撤回记录',
        content: '该记录已计入库房/账本，撤回将级联扣减统计数据，确定撤回吗？',
        confirmText: '确定撤回',
        confirmColor: '#C0392B',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerSubmission',
        data: { action: 'revokeMine', id: item._id }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '撤回失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已撤回', icon: 'success' });
      // 📊 统计数据刷新闭环：fetchMyVolunteerSubmissions 内部会重新计算
      // monthlySubmissionStats（本月提交/已采纳/待确认/已驳回）与 rejectedCount
      // 角标并 setData，确保弹窗顶部摘要与个人页角标同步撤回结果
      this.fetchMyVolunteerSubmissions();
    } catch (err) {
      console.error('[onRevokeApprovedSubmission] 撤回异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  // 🔴 silent=true 供 initMinePage() 在打开半屏弹窗之前静默预取角标数字用——
  // 与 fetchPendingVolunteerSubmissions() 给店长端角标预取的做法一致：不弹
  // loading 态、失败也只 console.warn，不打扰用户；显式打开弹窗（silent 缺省
  // false）时才保留原有的 loading 态与失败 toast 反馈
  async fetchMyVolunteerSubmissions(silent: boolean = false) {
    if (!isCloudAvailable()) return;
    if (!silent) {
      this.setData({ myVolunteerSubmissionsLoading: true });
    }

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerSubmission',
        data: { action: 'myList' }
      });
      const result = res.result;
      if (!result || !result.success) {
        if (!silent) {
          wx.showToast({ title: (result && result.error) || '加载失败', icon: 'none' });
        }
        return;
      }
      const list = Array.isArray(result.data?.list) ? result.data.list : [];
      // 🔴 我的餐报提交记录入口角标：与 wxml 里 rejectedCount > 0 时展示的
      // unread-badge 对应，统计有几条已被店长驳回、还没重新修改提交
      const rejectedCount = list.filter((item: any) => item && item.status === 'rejected').length;
      this.setData({ myVolunteerSubmissionsList: list, rejectedCount, monthlySubmissionStats: this.computeMonthlySubmissionStats(list) });
    } catch (err) {
      console.error('[fetchMyVolunteerSubmissions] 加载异常:', err);
      if (!silent) {
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      }
    } finally {
      if (!silent) {
        this.setData({ myVolunteerSubmissionsLoading: false });
      }
    }
  },

  // 📊 「我的提交与数据」弹窗顶部的月度统计摘要：合并原"我的统计数据"入口——
  // 只在客户端对已经拉取到的 myVolunteerSubmissionsList（最近最多 50 条）按
  // 当月 dateString 前缀过滤计数，不额外请求云函数；完整的多维度统计仍通过
  // onGoToStatistics 跳转独立的统计页
  computeMonthlySubmissionStats(list: any[]) {
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const thisMonth = (list || []).filter((item: any) => item && String(item.dateString || '').startsWith(monthPrefix));

    return {
      total: thisMonth.length,
      approved: thisMonth.filter((item: any) => item.status === 'approved').length,
      pending: thisMonth.filter((item: any) => item.status === 'pending').length,
      rejected: thisMonth.filter((item: any) => item.status === 'rejected').length
    };
  },

  // 📥 待审核的义工餐报与物资：店长/家长/超管入口，与 resolveManageStoreId
  // （爱心意见箱管理同一套门店范围收敛）共用
  async fetchPendingVolunteerSubmissions() {
    if (!isCloudAvailable()) return;
    try {
      const storeId = await this.resolveManageStoreId();
      if (!storeId) return;

      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerSubmission',
        data: { action: 'listPending', storeId }
      });
      const result = res.result;
      if (result && result.success) {
        const list = Array.isArray(result.data?.list) ? result.data.list : [];
        this.setData({ volunteerSubmissionAdminList: list, pendingVolunteerSubmissionCount: list.length });
      }
    } catch (err) {
      console.warn('[fetchPendingVolunteerSubmissions] 加载失败:', err);
    }
  },

  onOpenVolunteerSubmissionAdminModal() {
    if (this.data.volunteerSubmissionAdminLoading) return;
    this.setData({ showVolunteerSubmissionAdminModal: true, volunteerSubmissionAdminLoading: true });
    this.fetchPendingVolunteerSubmissions().finally(() => {
      this.setData({ volunteerSubmissionAdminLoading: false });
    });
  },

  onCloseVolunteerSubmissionAdminModal() {
    this.setData({ showVolunteerSubmissionAdminModal: false });
  },

  async onOpenNoticeManagement() {
    this.setData({
      showNoticeManagementModal: true,
      noticeManagementView: 'list',
      noticeManagementList: [],
      noticeManagementLoading: true
    });
    await this.fetchNoticeManagementList();
  },

  onCloseNoticeManagementModal() {
    if (this.data.noticeMgmtSaving) return;
    this.setData({ showNoticeManagementModal: false });
  },

  async fetchNoticeManagementList() {
    if (!isCloudAvailable()) {
      this.setData({ noticeManagementLoading: false });
      return;
    }
    this.setData({ noticeManagementLoading: true });
    try {
      const storeId = await this.resolveManageStoreId();
      const res: any = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: { action: 'list', storeId }
      });
      const result = res.result;
      const list = (result && result.success && Array.isArray(result.data)) ? result.data : [];
      this.setData({ noticeManagementList: list });
    } catch (err) {
      console.error('[fetchNoticeManagementList] 失败:', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ noticeManagementLoading: false });
    }
  },

  onNoticeManagementCreate() {
    this.setData({
      noticeManagementView: 'edit',
      noticeMgmtEditId: '',
      noticeMgmtEditTitle: '',
      noticeMgmtEditContent: '',
      noticeMgmtEditTag: '喜讯通报'
    });
  },

  onNoticeManagementEdit(e: any) {
    const id = e.currentTarget.dataset.id;
    const item = (this.data.noticeManagementList as any[]).find((n: any) => n._id === id);
    if (!item) return;
    this.setData({
      noticeManagementView: 'edit',
      noticeMgmtEditId: item._id,
      noticeMgmtEditTitle: item.title || '',
      noticeMgmtEditContent: item.content || '',
      noticeMgmtEditTag: item.tag || '喜讯通报'
    });
  },

  onNoticeManagementBackToList() {
    this.setData({ noticeManagementView: 'list' });
  },

  // 🏷️ 公告编辑弹窗：一键套用内置预设文案（与首页通报弹窗 onApplyPreset 同款逻辑）
  onNoticeMgmtApplyPreset(e: any) {
    const key = e.currentTarget.dataset.key;
    // 🛡️ 与 index.ts onApplyPreset 同一套防护：currentStoreName 在全国总览视角下
    // 是"全国总览"虚拟聚合名，不能塞进通报正文，让模板自己的兜底称谓接管
    const rawStoreName = this.data.currentStoreName || '';
    const isVirtualStoreName = rawStoreName === '全国总览' || rawStoreName === 'ALL_STORES';
    const storeName = isVirtualStoreName ? '' : rawStoreName;
    const preset = getNoticeMgmtTemplate(key, this.data.orgType, storeName);
    if (preset) {
      this.setData({
        noticeMgmtEditTag: preset.tag,
        noticeMgmtEditTitle: preset.title,
        noticeMgmtEditContent: preset.content
      });
      wx.showToast({ title: '已导入预设文案', icon: 'success', duration: 1500 });
    }
  },

  onNoticeMgmtTitleInput(e: any) {
    this.setData({ noticeMgmtEditTitle: e.detail.value });
  },

  onNoticeMgmtContentInput(e: any) {
    this.setData({ noticeMgmtEditContent: e.detail.value });
  },

  async onNoticeManagementSave() {
    if (this.data.noticeMgmtSaving) return;
    const title = (this.data.noticeMgmtEditTitle || '').trim();
    const content = (this.data.noticeMgmtEditContent || '').trim();
    if (!title) {
      wx.showToast({ title: '请填写公告标题', icon: 'none' });
      return;
    }
    if (!content) {
      wx.showToast({ title: '请填写公告正文', icon: 'none' });
      return;
    }
    if (!isCloudAvailable()) return;
    this.setData({ noticeMgmtSaving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const storeId = await this.resolveManageStoreId();
      const id = this.data.noticeMgmtEditId;
      const res: any = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: {
          action: id ? 'update' : 'create',
          id: id || undefined,
          storeId,
          tag: this.data.noticeMgmtEditTag || '喜讯通报',
          title,
          content,
          isActive: true
        }
      });
      const result = res.result;
      if (result && result.success) {
        wx.showToast({ title: id ? '公告已更新' : '公告发布成功', icon: 'success', duration: 2000 });
        // 平滑关闭弹窗，并在后台刷新列表以便下次打开时数据是最新的
        this.setData({ showNoticeManagementModal: false, noticeManagementView: 'list' });
        this.fetchNoticeManagementList();
        // 通知首页走马灯在下次 onShow 时刷新公告数据
        try {
          const app = getApp() as any;
          if (app && app.globalData) app.globalData.noticesDirty = true;
        } catch (_) { /* ignore */ }
      } else {
        const errMsg: string = (result && result.error) || '保存失败';
        const isCollectionMissing = /collection not exist|502005/i.test(errMsg);
        wx.showToast({
          title: isCollectionMissing
            ? '数据库初始化中，请先在云开发控制台创建 notices 集合'
            : errMsg,
          icon: 'none',
          duration: isCollectionMissing ? 3000 : 2000
        });
      }
    } catch (err) {
      console.error('[onNoticeManagementSave] 失败:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ noticeMgmtSaving: false });
    }
  },

  async onNoticeManagementDelete(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.noticeMgmtDeletingId) return;
    const confirmed = await new Promise<boolean>(resolve => {
      wx.showModal({
        title: '确认删除',
        content: '删除后公告将立即从走马灯中移除，确认删除？',
        confirmText: '删除',
        confirmColor: '#E53E3E',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;
    if (!isCloudAvailable()) return;
    this.setData({ noticeMgmtDeletingId: id });
    wx.showLoading({ title: '删除中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: { action: 'delete', id }
      });
      const result = res.result;
      if (result && result.success) {
        wx.showToast({ title: '公告已删除', icon: 'success' });
        await this.fetchNoticeManagementList();
      } else {
        wx.showToast({ title: (result && result.error) || '删除失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[onNoticeManagementDelete] 失败:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ noticeMgmtDeletingId: '' });
    }
  },

  async onNoticeManagementToggleActive(e: any) {
    const id = e.currentTarget.dataset.id;
    const item = (this.data.noticeManagementList as any[]).find((n: any) => n._id === id);
    if (!item || this.data.noticeMgmtDeletingId) return;
    if (!isCloudAvailable()) return;
    this.setData({ noticeMgmtDeletingId: id });
    try {
      const storeId = await this.resolveManageStoreId();
      const res: any = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: {
          action: 'update',
          id,
          storeId,
          tag: item.tag || '喜讯通报',
          title: item.title,
          content: item.content,
          isActive: !item.is_active
        }
      });
      const result = res.result;
      if (result && result.success) {
        await this.fetchNoticeManagementList();
      } else {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[onNoticeManagementToggleActive] 失败:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ noticeMgmtDeletingId: '' });
    }
  },

  // 👥 待审批的成员申请：门店自治架构，仅大家长/店长拉取本店成员（义工/财务/店长）
  // 的申请队列；超管已从事前审批中彻底剥离，不再消费此接口的 elevated 队列
  async fetchPendingApplications() {
    if (!isCloudAvailable()) return;
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { action: 'listPendingApplications' }
      });
      const result = res.result;
      if (!result || !result.success) return;

      const list = Array.isArray(result.data) ? result.data : [];
      if (result.queueType === 'member') {
        this.setData({ memberApplicationList: list, pendingMemberApplicationCount: list.length });
      }
      // elevated 队列（超管专属）不再在客户端展示——超管已彻底退出事前审批流
    } catch (err) {
      console.warn('[fetchPendingApplications] 加载失败:', err);
    }
  },

  onOpenMemberApplicationModal() {
    if (this.data.memberApplicationLoading) return;
    this.setData({ showMemberApplicationModal: true, memberApplicationLoading: true });
    this.fetchPendingApplications().finally(() => {
      this.setData({ memberApplicationLoading: false });
    });
  },

  onCloseMemberApplicationModal() {
    this.setData({ showMemberApplicationModal: false });
  },

  // 👥 人员权限管理：展示本店已授权的管理岗位成员（财务/店长/大家长），提供降级/移出操作
  async onOpenMemberManageModal() {
    if (!isCloudAvailable()) return;
    this.setData({
      showMemberManageModal: true,
      memberManageLoading: true,
      memberManageList: [],
      memberManageFilteredList: [],
      memberManageSearch: ''
    });
    try {
      const roleInfo = AuthService.getCachedRoleInfo();
      const storeId = roleInfo && roleInfo.storeId;
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { action: 'listAuditQueue', tab: 'approved', storeId }
      });
      const result = res.result;
      if (result && result.success) {
        const ELEVATED = ['finance', 'store_manager', 'store_patriarch'];
        const roleClassMap: Record<string, string> = {
          store_patriarch: 'orange',
          finance: 'blue',
          store_manager: 'purple'
        };
        const maskPhone = (p: string) => {
          if (!p || p.length < 7) return p || '';
          return p.slice(0, 3) + '****' + p.slice(-4);
        };
        const list = (Array.isArray(result.data) ? result.data : [])
          .filter((m: any) => ELEVATED.includes(m.role))
          .map((m: any) => ({
            ...m,
            phoneMasked: maskPhone(m.phone || ''),
            roleClass: roleClassMap[m.role] || 'default'
          }));
        this.setData({ memberManageList: list, memberManageFilteredList: list });
      }
    } catch (err) {
      console.warn('[profile] onOpenMemberManageModal 加载失败:', err);
    } finally {
      this.setData({ memberManageLoading: false });
    }
  },

  onCloseMemberManageModal() {
    this.setData({ showMemberManageModal: false, memberManageSearch: '' });
  },

  onMemberManageSearch(e: any) {
    const query = (e.detail.value || '').trim();
    this.setData({ memberManageSearch: query });
    const list = this.data.memberManageList;
    if (!query) {
      this.setData({ memberManageFilteredList: list });
      return;
    }
    const lower = query.toLowerCase();
    const filtered = list.filter((m) =>
      (m.realName && m.realName.toLowerCase().includes(lower)) ||
      (m.phone && m.phone.includes(query))
    );
    this.setData({ memberManageFilteredList: filtered });
  },

  // 📞 联系超管：同级大家长锁态提示旁的快捷入口，弹窗展示超管电话与微信号
  onContactAdmin() {
    this.setData({ showContactAdminModal: true });
  },

  onCloseContactAdminModal() {
    this.setData({ showContactAdminModal: false });
  },

  onCallSuperAdmin() {
    const phone = this.data.superAdminContactPhone;
    if (!phone) return;
    wx.makePhoneCall({ phoneNumber: phone });
  },

  onCopySuperAdminWechat() {
    const wechat = this.data.superAdminContactWechat;
    if (!wechat) return;
    wx.setClipboardData({
      data: wechat,
      success: () => wx.showToast({ title: '已复制超管微信号', icon: 'success' })
    });
  },

  async onDemoteToVolunteer(e: any) {
    const { id, name } = e.currentTarget.dataset;
    if (!id || this.data.memberManageOperating) return;
    const displayName = name || '该成员';
    const { confirm } = await wx.showModal({
      title: '确认降级',
      content: `确定将【${displayName}】降级为普通义工吗？降级后其将失去门店日常管理权限，且不可撤回。`,
      confirmText: '确认降级',
      confirmColor: '#E03131'
    });
    if (!confirm) return;
    this.setData({ memberManageOperating: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerBinding',
        data: { targetId: id, action: 'changeRole', newRole: 'volunteer' }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: result?.error || '操作失败', icon: 'none', duration: 2500 });
        return;
      }
      wx.showToast({ title: '已降级为义工', icon: 'success' });
      const newList = this.data.memberManageList.filter((m) => m.applyId !== id);
      const newQuery = this.data.memberManageSearch;
      const lower = newQuery.toLowerCase();
      const newFiltered = newQuery
        ? newList.filter((m) =>
            (m.realName && m.realName.toLowerCase().includes(lower)) ||
            (m.phone && m.phone.includes(newQuery))
          )
        : newList;
      this.setData({ memberManageList: newList, memberManageFilteredList: newFiltered });
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this.setData({ memberManageOperating: false });
    }
  },

  async onRemoveFromStore(e: any) {
    const { id, name } = e.currentTarget.dataset;
    if (!id || this.data.memberManageOperating) return;
    const displayName = name || '该成员';
    const { confirm } = await wx.showModal({
      title: '确认移出',
      content: `确定将【${displayName}】移出本店吗？移出后权限立即撤销，对方需重新申请才能加入。`,
      confirmText: '确认移出',
      confirmColor: '#E03131'
    });
    if (!confirm) return;
    this.setData({ memberManageOperating: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerBinding',
        data: { targetId: id, action: 'unbind' }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: result?.error || '操作失败', icon: 'none', duration: 2500 });
        return;
      }
      wx.showToast({ title: '已移出门店', icon: 'success' });
      const newList = this.data.memberManageList.filter((m) => m.applyId !== id);
      const newQuery = this.data.memberManageSearch;
      const lower = newQuery.toLowerCase();
      const newFiltered = newQuery
        ? newList.filter((m) =>
            (m.realName && m.realName.toLowerCase().includes(lower)) ||
            (m.phone && m.phone.includes(newQuery))
          )
        : newList;
      this.setData({ memberManageList: newList, memberManageFilteredList: newFiltered });
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this.setData({ memberManageOperating: false });
    }
  },

  // ============ 🔐 管理员密钥查看 / 修改（profile 页内联弹窗） ============

  async loadStoreAdminKey() {
    if (!isCloudAvailable()) return;
    try {
      const roleInfo = AuthService.getCachedRoleInfo();
      const store = getSelectedStore();
      const storeId = (roleInfo && roleInfo.storeId) || store.storeId || '';
      if (!storeId) return;
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'get', storeId }
      });
      const data = res.result && res.result.data;
      if (data) {
        this.setData({
          storeAdminKeySet: !!data.adminKeySet,
          storeAdminKey: data.adminKey || ''   // 仅大家长/超管返回明文，其余为 ''
        });
      }
    } catch (err) {
      console.warn('[profile] loadStoreAdminKey 失败:', err);
    }
  },

  onToggleAdminKeyVisible() {
    this.setData({ storeAdminKeyVisible: !this.data.storeAdminKeyVisible });
  },

  onOpenAdminKeyModal() {
    if (this.data.adminKeyModalSaving) return;
    const { isPatriarch, isSuperAdmin } = this.data;
    if (!isPatriarch && !isSuperAdmin) {
      wx.showToast({ title: '仅大家长/超管可修改密钥', icon: 'none' });
      return;
    }
    this.setData({
      showAdminKeyModal: true,
      adminKeyModalInput: this.data.storeAdminKey   // 预填当前明文（大家长/超管已持有）
    });
  },

  onCloseAdminKeyModal() {
    if (this.data.adminKeyModalSaving) return;
    this.setData({ showAdminKeyModal: false, adminKeyModalInput: '' });
  },

  onAdminKeyModalInput(e: any) {
    this.setData({ adminKeyModalInput: e.detail.value });
  },

  async onSaveAdminKeyFromProfile() {
    if (this.data.adminKeyModalSaving) return;
    const newKey = (this.data.adminKeyModalInput || '').trim();
    const roleInfo = AuthService.getCachedRoleInfo();
    const store = getSelectedStore();
    const storeId = (roleInfo && roleInfo.storeId) || store.storeId || '';
    if (!storeId) {
      wx.showToast({ title: '无法获取门店信息', icon: 'none' });
      return;
    }
    this.setData({ adminKeyModalSaving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'update', storeId, adminKey: newKey }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }
      this.setData({
        showAdminKeyModal: false,
        adminKeyModalInput: '',
        storeAdminKeySet: newKey.length > 0,
        storeAdminKey: newKey,
        storeAdminKeyVisible: false
      });
      wx.showToast({ title: newKey ? '密钥已更新' : '密钥已清除', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ adminKeyModalSaving: false });
    }
  },

  _removeApplicationFromQueue(id: string, queue: 'member') {
    const next = this.data.memberApplicationList.filter((item) => item.applyId !== id);
    this.setData({ memberApplicationList: next, pendingMemberApplicationCount: next.length });
  },

  // 🛡️ 高权限角色审批前强确认：member 队列里的财务/店长/大家长申请在授权前弹一次
  // 强确认，volunteer 维持一键通过的轻量体验
  async onApproveApplication(e: any) {
    const id = e.currentTarget.dataset.id;
    const queue = e.currentTarget.dataset.queue as 'member';
    if (!id) return;

    const list = this.data.memberApplicationList;
    const item = (list as any[]).find((r) => r.applyId === id);

    // member 队列中 finance/store_manager/store_patriarch 是高权限角色，需二次确认；
    // volunteer 维持一键通过的轻量体验
    const isSensitive = item && ['finance', 'store_manager', 'store_patriarch'].includes(item.requestedRole);

    if (isSensitive && item) {
      const displayName = item.realName || '该申请人';
      const content = item.requestedRole === 'store_patriarch'
        ? `授权后「${displayName}」将成为本店大家长，获得全店成员管理权限，请确认您信任该成员。`
        : item.requestedRole === 'store_manager'
          ? `授权后「${displayName}」将以【店长】身份管理门店日常事务，确认通过吗？`
          : `授权后「${displayName}」将以【财务】身份操作/查看门店账本，确认通过吗？`;

      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '⚠️ 高权限角色确认',
          content,
          confirmText: '确认通过',
          confirmColor: '#D32F2F',
          cancelText: '我再想想',
          success: (res) => resolve(!!res.confirm),
          fail: () => resolve(false)
        });
      });
      if (!confirmed) return;
    }

    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { applyId: id, action: 'approve' }
      });
      const result = res.result;
      wx.hideLoading();

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        return;
      }
      this._removeApplicationFromQueue(id, queue);
      wx.showToast({ title: '已通过', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      console.error('[onApproveApplication] 异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  onOpenRejectApplicationModal(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ showRejectApplicationModal: true, rejectApplicationId: id, rejectApplicationQueue: 'member', rejectApplicationReason: '' });
  },

  onCloseRejectApplicationModal() {
    if (this.data.rejectApplicationSubmitting) return;
    this.setData({ showRejectApplicationModal: false, rejectApplicationId: '' });
  },

  onRejectApplicationReasonInput(e: any) {
    this.setData({ rejectApplicationReason: e.detail.value });
  },

  async onSubmitRejectApplication() {
    if (this.data.rejectApplicationSubmitting) return;

    const id = this.data.rejectApplicationId;
    const queue = this.data.rejectApplicationQueue;
    const rejectReason = (this.data.rejectApplicationReason || '').trim();
    if (!id) return;
    if (!rejectReason) {
      wx.showToast({ title: '请填写拒绝原因', icon: 'none' });
      return;
    }

    this.setData({ rejectApplicationSubmitting: true });

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { applyId: id, action: 'reject', rejectReason }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        return;
      }
      this._removeApplicationFromQueue(id, queue);
      this.setData({ showRejectApplicationModal: false, rejectApplicationId: '' });
      wx.showToast({ title: '已拒绝', icon: 'none' });
    } catch (err) {
      console.error('[onSubmitRejectApplication] 异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ rejectApplicationSubmitting: false });
    }
  },

  // ✅ 一键采纳入库：type='menu' 时尝试合并进当日 report_logs（仅字段级更新已
  // 存在的文档，绝不新建——见 manageVolunteerSubmission 云函数头部安全边界说明），
  // type='material' 时归档进 material_logs 消耗流水
  async onApproveSubmission(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    const list = this.data.volunteerSubmissionAdminList;
    const idx = list.findIndex((item) => item._id === id);
    if (idx === -1 || list[idx].processing) return;

    this.setData({ [`volunteerSubmissionAdminList[${idx}].processing`]: true });

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerSubmission',
        data: { action: 'approve', id }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        this.setData({ [`volunteerSubmissionAdminList[${idx}].processing`]: false });
        return;
      }

      const nextList = this.data.volunteerSubmissionAdminList.filter((item) => item._id !== id);
      this.setData({
        volunteerSubmissionAdminList: nextList,
        pendingVolunteerSubmissionCount: nextList.length
      });
      wx.showToast({ title: result.message || '已成功采纳并同步入库', icon: 'success', duration: 2500 });
    } catch (err) {
      console.error('[onApproveSubmission] 操作异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      this.setData({ [`volunteerSubmissionAdminList[${idx}].processing`]: false });
    }
  },

  onOpenRejectModal(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ showRejectSubmissionModal: true, rejectSubmissionId: id, rejectSubmissionReason: '' });
  },

  onCloseRejectModal() {
    if (this.data.rejectSubmissionSubmitting) return;
    this.setData({ showRejectSubmissionModal: false, rejectSubmissionId: '' });
  },

  onRejectSubmissionReasonInput(e: any) {
    this.setData({ rejectSubmissionReason: e.detail.value });
  },

  // 🏷️ 快捷驳回标签：点击即把该短语填入 textarea，覆盖当前内容（与"选一个现成理由"
  // 的直觉一致，不追加拼接，避免点多个标签后文字乱七八糟）
  onQuickRejectReasonTagTap(e: any) {
    const tag = e.currentTarget.dataset.tag;
    if (!tag) return;
    this.setData({ rejectSubmissionReason: tag });
  },

  async onSubmitRejectSubmission() {
    if (this.data.rejectSubmissionSubmitting) return;

    const id = this.data.rejectSubmissionId;
    const rejectReason = (this.data.rejectSubmissionReason || '').trim();
    if (!id) return;
    if (!rejectReason) {
      wx.showToast({ title: '请填写或选择驳回原因', icon: 'none' });
      return;
    }

    this.setData({ rejectSubmissionSubmitting: true });

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageVolunteerSubmission',
        data: { action: 'reject', id, rejectReason }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        return;
      }

      const nextList = this.data.volunteerSubmissionAdminList.filter((item) => item._id !== id);
      this.setData({
        volunteerSubmissionAdminList: nextList,
        pendingVolunteerSubmissionCount: nextList.length,
        showRejectSubmissionModal: false,
        rejectSubmissionId: ''
      });
      wx.showToast({ title: '已驳回', icon: 'success' });
    } catch (err) {
      console.error('[onSubmitRejectSubmission] 操作异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ rejectSubmissionSubmitting: false });
    }
  },

  // 🍚 门店餐饮与物资统计：即时查询，不缓存不预加载，每次打开都拿最新数字。
  // 🐛 超管专属：云函数 resolveReadStoreId 对 super_admin 强制要求显式传入
  // storeId（自身没有绑定门店，无法像店长/家长/义工那样落到 caller.storeId），
  // 这里按当前巡检门店（见 onSelectInspectStore）补上；全国总览态下尚未选定
  // 具体门店，直接引导先选店，不再对云函数发起注定失败的请求
  onOpenStoreStatsModal() {
    if (this.data.storeStatsLoading) return;
    if (this.data.isSuperAdmin && !this.data.currentInspectStoreId) {
      wx.showToast({ title: '请先选择巡检门店', icon: 'none' });
      return;
    }
    this.setData({ showStoreStatsModal: true, storeStatsLoading: true });

    const data: any = { action: 'statsSummary' };
    if (this.data.isSuperAdmin && this.data.currentInspectStoreId) {
      data.storeId = this.data.currentInspectStoreId;
    }

    wx.cloud.callFunction({
      name: 'manageVolunteerSubmission',
      data
    }).then((res: any) => {
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载失败', icon: 'none' });
        return;
      }
      const storeStats = normalizeStoreStats(result.data);
      const storeStatsAllZero = storeStats.mealTotals.totalCount === 0
        && storeStats.todayMaterialTotals.riceCount === 0
        && storeStats.todayMaterialTotals.flourCount === 0
        && storeStats.todayMaterialTotals.oilCount === 0
        && storeStats.todayMaterialTotals.vegetableCount === 0;
      this.setData({ storeStats, storeStatsAllZero });
    }).catch((err) => {
      console.error('[onOpenStoreStatsModal] 加载异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }).finally(() => {
      this.setData({ storeStatsLoading: false });
    });
  },

  onCloseStoreStatsModal() {
    this.setData({ showStoreStatsModal: false });
  },

  // 📖 查看消耗明细：跳去店长/财务日常就在用的正式台账历史页，不新建一套
  // "物资流水"专属页面——material_logs 的每一笔消耗本就是账本历史的一部分
  onGoToStoreStatsDetail() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    this.setData({ showStoreStatsModal: false });
    wx.navigateTo({
      url: '/pages/history/history',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // ✍️ 补报今日数据：菜单人数、物资消耗是两张独立表单，用 ActionSheet 让用户
  // 先选清楚要补哪一项，再复用 daily-menu-modal/material-usage-modal 现成的
  // resetForm() 全新登记入口（与首页金刚区 onTapToolDailyMenu 同一套调用方式）
  onGoToStoreStatsSupplement() {
    wx.showActionSheet({
      itemList: ['登记今日菜单人数', '登记物资消耗与报损'],
      success: (res) => {
        if (res.tapIndex === 0) {
          const modal = this.selectComponent('#dailyMenuModal') as any;
          if (modal) modal.resetForm();
          this.setData({ showStoreStatsModal: false, showDailyMenuModal: true });
        } else if (res.tapIndex === 1) {
          const modal = this.selectComponent('#materialUsageModal') as any;
          if (modal) modal.resetForm();
          this.setData({ showStoreStatsModal: false, showMaterialUsageModal: true });
        }
      }
    });
  },

  // 🌟 店长专属入口：本店数据明细（携带 shopName 预选中本店，与超管工具箱里
  // 不带 shopName、默认落到全国汇总视角的"全国多店大屏"区分开），复用同一个
  // 统计页面（/pages/statistics/statistics），不新建一套统计逻辑
  onGoToStoreOverview() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.currentStoreName || '')}`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 💰 财务专属【凭证快速复核】：跳去台账历史页并直接落在"待审批"筛选 Tab
  // （?statusTab=pending，见 history.ts onLoad 新增的这个查询参数），财务不用
  // 进页面后再自己点一次筛选，一步到位看到本店所有待复核的记录
  onGoToVoucherReview() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/history/history?statusTab=pending',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 💰 财务专属【门店账目明细】：与 onGoToStoreOverview 是同一个落地页，但这里
  // 额外携带 tab=ledger&viewMode=finance——statistics.ts onLoad 据此把 tab=ledger
  // 映射到"月报"（对财务而言最贴近"账目明细"的落地态：一天天摊开的收支流水），
  // viewMode=finance 标记financeEntryMode，收起营销 Banner、突出核心经营指标与
  // 账本稽核工具。不复用 onGoToStoreOverview 本体，因为那个方法同时也服务于
  // 店长「账目与凭证」等其他非财务入口，不该被这里的财务专属参数污染
  onGoToFinanceLedger() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.currentStoreName || '')}&tab=ledger&viewMode=finance`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 💰 财务专属【阳光账本核查】：此前复用 onGoToSunshineLedger（写交接标记 +
  // switchTab 到首页 tabBar，靠首页 onShow 自动弹出阳光账本理念/宣言 Modal）——
  // 财务点进来是要"核查"账目，不是看一段公益宣言文案，弹窗弹完无处可去，是典型
  // 的"只弹窗不落地"死胡同。改为直接跳转统计页并携带 tab=sunshine&viewMode=finance，
  // 落地到 statistics.wxml 新增的「☀️ 阳光大盘」真实数据区块（见该页
  // fetchSunshineBoardData），不再复用家人视角那个纯展示性质的 onGoToSunshineLedger
  onGoToSunshineLedgerAudit() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.currentStoreName || '')}&tab=sunshine&viewMode=finance`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 💰 财务专属【Excel 财务报表导出】：跳去统计页并携带 action=export&viewMode=finance，
  // statistics.ts onLoad 据此拉起与首页"Excel 账本导出"同一套自动唤起核对弹窗逻辑
  // （见 statistics.ts onLoad/_autoShowExportPending），不新建导出入口
  onExportFinanceExcel() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.currentStoreName || '')}&action=export&viewMode=finance`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onGoToStoreProfile() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/store-profile/store-profile',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🏪 门店状态静默刷新：onShow 每次切回个人页都调用，先用缓存秒显，再后台悄悄
  // 刷新最新值，失败不打扰用户（见 utils/storeManager.ts fetchAndSyncStoreStatus）
  refreshStoreStatus() {
    const cached = getCachedStoreStatus();
    if (cached) {
      this.setData({ currentStoreStatus: cached });
    }

    const store = getSelectedStore();
    if (store && store.storeId) {
      fetchAndSyncStoreStatus(store.storeId).then((label) => {
        if (label) {
          this.setData({ currentStoreStatus: label });
        }
      });
    }
  },

  // ☀️ 关于雨花斋与阳光账本：阳光账本弹窗唯一实现在首页 index.ts
  // （sunshineLedgerData/onOpenSunshineLedger），本页不重复一套数据管线——
  // 写交接标记后跳首页 tabBar，首页 onShow 的 checkPendingHandoffs 据此自动打开弹窗。
  // /pages/index/index 是 tabBar 页，必须用 switchTab，navigateTo 会直接报错
  onGoToAbout() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    requestOpenSunshineLedger();
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 💖 家人专属【我的爱心】· 阳光账本直达：与"关于与帮助"分组里的 onGoToAbout
  // 是完全同一个动作（写交接标记 + 跳首页 tabBar，由首页打开已有的阳光账本弹窗），
  // 这里只是家人视角下换了个更直白的入口文案，直接复用不重复实现
  onGoToSunshineLedger() {
    this.onGoToAbout();
  },

  // 📮 爱心意见箱：小程序原生半屏弹窗，替代微信官方 open-type="feedback"——
  // 那个入口去到微信平台通用反馈通道，不落在本项目自己的数据里，店长/运营看不到
  onOpenFeedbackModal() {
    this.setData({
      showFeedbackModal: true,
      feedbackModalTab: 'submit',
      feedbackSelectedType: 'meal',
      feedbackContent: ''
    });
  },

  onCloseFeedbackModal() {
    if (this.data.feedbackSubmitting) return;
    this.setData({ showFeedbackModal: false });
  },

  onSelectFeedbackType(e: any) {
    const type = e.currentTarget.dataset.type;
    this.setData({ feedbackSelectedType: type });
  },

  onFeedbackContentInput(e: any) {
    this.setData({ feedbackContent: e.detail.value });
  },

  // 💌 家人端 Tab 切换：切到"我的反馈与回复"时才去拉列表（不预加载，避免每次
  // 打开意见箱都多发一次云函数请求），并顺手把未读回复清空——这正是需求里
  // "打开该 Tab 后自动将未读回复标记为已读"的落地位置
  onSwitchFeedbackModalTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.feedbackModalTab) return;

    this.setData({ feedbackModalTab: tab });
    if (tab === 'mine') {
      this.fetchMySubmissions();
      this.markRepliedReplyAsRead();
    }
  },

  async fetchMySubmissions() {
    if (!isCloudAvailable()) return;
    this.setData({ myFeedbackLoading: true });

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'submitFeedback',
        data: { action: 'mySubmissions' }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载失败', icon: 'none' });
        return;
      }
      // 🛡️ 崩溃修复：此前 `result.data.list` 没有先判空就直接解构 result.data——
      // success 为 true 不保证 data 一定存在，data 为 undefined 时会直接抛出
      // "Cannot read property 'list' of undefined"，而不是走到 `|| []` 兜底
      this.setData({ myFeedbackList: Array.isArray(result.data?.list) ? result.data.list : [] });
    } catch (err) {
      console.error('[fetchMySubmissions] 加载我的反馈异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ myFeedbackLoading: false });
    }
  },

  async fetchUnreadReplyCount() {
    if (!isCloudAvailable()) return;
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'submitFeedback',
        data: { action: 'unreadReplyCount' }
      });
      const result = res.result;
      if (result && result.success) {
        this.setData({ unreadReplyCount: (result.data && result.data.count) || 0 });
      }
    } catch (err) {
      console.warn('[fetchUnreadReplyCount] 加载未读回复数量失败:', err);
    }
  },

  // 批量清已读：本地角标直接归零，不等云端返回——即使这次网络失败，下次
  // fetchUnreadReplyCount 重新加载也会自然收敛，不需要让家人等这个请求转圈
  async markRepliedReplyAsRead() {
    if (!isCloudAvailable() || this.data.unreadReplyCount === 0) return;
    this.setData({ unreadReplyCount: 0 });
    try {
      await wx.cloud.callFunction({
        name: 'submitFeedback',
        data: { action: 'markRepliedRead' }
      });
    } catch (err) {
      console.warn('[markRepliedReplyAsRead] 标记已读失败:', err);
    }
  },

  // 提交前先走一遍与 index.ts checkContentSafety 相同的 msgSecCheck 内容安全检测——
  // 意见箱是自由文本，同样需要这层兜底；检测服务本身异常时不阻塞提交（跳过检测）
  async checkFeedbackContentSafety(text: string): Promise<boolean> {
    try {
      if (!isCloudAvailable()) return true;
      const result = await wx.cloud.callFunction({ name: 'msgSecCheck', data: { text } });
      const r = result.result as any;
      if (r && !r.safe) {
        wx.showToast({ title: '内容包含违规信息，请修改后重试', icon: 'none' });
        return false;
      }
      return true;
    } catch (err) {
      console.warn('[checkFeedbackContentSafety] 内容安全检测调用失败，跳过检测:', err);
      return true;
    }
  },

  async onSubmitFeedback() {
    if (this.data.feedbackSubmitting) return;

    const content = (this.data.feedbackContent || '').trim();
    if (!content) {
      wx.showToast({ title: '请输入您的宝贵意见', icon: 'none' });
      return;
    }

    this.setData({ feedbackSubmitting: true });

    const safe = await this.checkFeedbackContentSafety(content);
    if (!safe) {
      this.setData({ feedbackSubmitting: false });
      return;
    }

    if (!isCloudAvailable()) {
      this.setData({ feedbackSubmitting: false });
      wx.showToast({ title: '云服务尚未就绪，请稍后重试', icon: 'none' });
      return;
    }

    let collectionMissing = false;
    try {
      // 🐛 家人提交的意见店长端看不到，根因：家人账号大多没有 user_roles 记录
      // （store_family 只是本地/客户端角色，从不写服务端），云函数原先靠
      // resolveCaller(OPENID).storeId 取门店，家人查出来是空字符串，意见就存成了
      // storeId: ''——而店长端 list/count 永远按自己的真实 storeId 查询，两边
      // 对不上，意见形同消失。这里改为把"当前正在浏览的门店"（getSelectedStore，
      // 与 fetchMeritStats 里同一个门店隔离修复用的是同一个数据源）显式传给云函数，
      // 云函数收到就优先用它，不再依赖对家人账号必然查不到的角色绑定门店
      const activeStore = getSelectedStore();
      const res: any = await wx.cloud.callFunction({
        name: 'submitFeedback',
        data: {
          action: 'submit',
          type: this.data.feedbackSelectedType,
          content,
          storeId: (activeStore && activeStore.storeId) || '',
          storeName: (activeStore && activeStore.storeName) || ''
        }
      });

      // 🛡️ 根因修复：此前这里只 await 了云函数调用、从不检查 result.success——
      // wx.cloud.callFunction 只要网络层面成功往返就会 resolve，即使云函数内部业务
      // 逻辑判定失败（最典型的是登录态失效时 handleSubmit 返回的"未登录，无法提交"）
      // 也不会走进 catch 分支。此前的代码在这种情况下会直接落到下面"感恩您的宝贵
      // 建议！"的成功提示，把一次实际上完全没有落库的提交伪装成已收到，家人的意见
      // 就这样悄无声息地丢失且毫无感知。现在与本文件其余所有云函数调用一致，显式
      // 检查 result.success，失败时如实提示、不清空已填内容，让用户能重试
      const result = res.result;
      if (!result || !result.success) {
        this.setData({ feedbackSubmitting: false });
        wx.showToast({ title: (result && result.error) || '提交失败，请重试', icon: 'none' });
        return;
      }
    } catch (err) {
      console.warn('[onSubmitFeedback] 提交云端失败:', err);
      // 🛡️ 云端 submitFeedback 已经会在集合不存在时自动建表重试一次，正常不会再
      // 抛到这里——命中说明底层确实没写进去，不能按"已收到"处理，否则家人会以为
      // 意见提交成功了，实际数据完全丢失。其余异常（真实网络故障等）此前会被当作
      // 成功静默吞掉，同样是数据丢失且用户毫无感知——统一改为如实告知"网络异常，
      // 请重试"，不清空已填内容，用户可以直接再点一次提交，摩擦成本很低
      collectionMissing = this.isCollectionNotExistError(err);
      if (!collectionMissing) {
        this.setData({ feedbackSubmitting: false });
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        return;
      }
    }

    this.setData({ feedbackSubmitting: false, showFeedbackModal: false, feedbackContent: '' });

    if (collectionMissing) {
      wx.showToast({ title: '意见箱数据库初始化中，请联系店长或重新尝试', icon: 'none', duration: 3000 });
    } else {
      wx.showToast({ title: '感恩您的宝贵建议！', icon: 'none' });
    }
  },

  // 💌 家人专属【我的爱心】· 爱心感谢卡 / 荣誉证书：与义工版护持证书共用同一个
  // 弹窗壳（showCertificateModal），正文按 isFamily 在 WXML 里分流成纯文本证书——
  // 不需要 Canvas 绘制、不需要二维码，直接打开即可，无需异步生成。
  // 落款日期按当前打开时间动态生成；certificateTempFilePath 顺手清空——理论上
  // 家人分支永远不会用到它，但如果之前这个账号切换过义工视角生成过证书图片，
  // 残留的 tempFilePath 不清掉的话，家人版的"保存"按钮会误保存到那张旧图
  onOpenCertificateModal() {
    const now = new Date();
    this.setData({
      showCertificateModal: true,
      certificateTempFilePath: '',
      certificateIssueDate: `${now.getFullYear()}年${now.getMonth() + 1}月`
    });
  },

  // 🏡 家人专属【雨花家园】· 门店日志（原"门店服务历程"）：家人没有个人打卡记录，
  // 直接跳门店整体大事记列表，不同于义工/店长版会先判断个人/门店两种口径
  onGoToActivityLog() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/activity-log/activity-log',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🏡 家人专属【雨花家园】· 我关注的雨花门店：与"文化与帮助"分组里的
  // onOpenFamilyStorePicker 是完全同一个动作，这里只是换了个更贴近家人视角的
  // 入口文案，直接复用不重复实现
  onGoToStorePicker() {
    this.onOpenFamilyStorePicker();
  },

  // 📖 家人专属【文化与帮助】· 雨花家训与文化全集：唯一实现在首页 index.ts
  // （onShowFamilyMottoModal，十大模块完整原文），本页不重复一套内容——写交接
  // 标记后跳首页 tabBar，首页 onShow 的 checkPendingHandoffs 据此自动打开弹窗
  onGoToCultureFull() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    requestOpenCultureFull();
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🔀 家人专属【文化与帮助】· 切换关注门店：门店选择器唯一可见实例在首页
  // index.wxml（id="storePicker"）。个人页此前隐藏挂载了自己的一份（width:0/
  // height:0 试图隐藏），结果因自定义组件宿主标签默认 display:inline、宽高
  // 不生效，导致底部露出一个失控的可见胶囊——已彻底移除该隐藏实例，改为写
  // 交接标记后跳首页 tabBar，由首页 checkPendingHandoffs 直接拉起它自己的面板
  onOpenFamilyStorePicker() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    requestOpenStorePicker();
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🍱🌾 登记今日菜单与人数 / 登记物资消耗与报损：入口已迁移到 Tab1 首页金刚区，
  // 这里只保留关闭方法——daily-menu-modal/material-usage-modal 组件仍挂载在本页
  // （见下方 wxml），供"我的提交与数据"里"重新修改并提交"通过 selectComponent
  // 调用 presetForm() 后复用同一套表单
  onCloseDailyMenuModal() {
    this.setData({ showDailyMenuModal: false });
  },

  onCloseMaterialUsageModal() {
    this.setData({ showMaterialUsageModal: false });
  },

  onTriggerGenCode() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.switchTab({
      url: '/pages/index/index',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onPatriarchGenCode() {
    this.setData({ showInviteModal: true, inviteTargetRole: 'VOLUNTEER', inviteResultCode: '', inviteResultQrFileId: '', inviteQrLoadFailed: false });
  },

  onCloseInviteModal() {
    this.setData({ showInviteModal: false });
  },

  onSelectInviteRole(e: any) {
    this.setData({ inviteTargetRole: e.currentTarget.dataset.role });
  },

  // 🐛 邀请二维码加载失败兜底：cloud fileID 拉取异常（如 500）时降级为文字提示，
  // 邀请码本身仍可通过下方"复制邀请码"按钮正常分享，不阻断核心流程
  onInviteQrLoadError(e: any) {
    console.warn('[onInviteQrLoadError] 邀请二维码加载失败:', e && e.detail);
    this.setData({ inviteQrLoadFailed: true });
  },

  async onGeneratePatriarchInviteCode() {
    if (this.data.inviteGenerating) return;
    if (!isCloudAvailable()) return;
    const roleInfo = AuthService.getCachedRoleInfo();
    const storeId = roleInfo && roleInfo.storeId;
    if (!storeId) {
      wx.showToast({ title: '无法获取门店信息，请重新进入', icon: 'none' });
      return;
    }
    const targetRole = this.data.inviteTargetRole || 'VOLUNTEER';
    this.setData({ inviteGenerating: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreInviteCode',
        data: { action: 'generate', storeId, targetRole }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: result?.error || '生成失败，请重试', icon: 'none', duration: 2500 });
        return;
      }
      const { code, storeName, qrFileID, expiresAt } = result.data;
      this.setData({
        showInviteModal: false,
        showInviteResultModal: true,
        inviteResultCode: code || '',
        inviteResultQrFileId: qrFileID || '',
        inviteResultStoreName: storeName || this.data.currentStoreName || '',
        inviteResultExpiresAt: expiresAt || 0,
        inviteQrLoadFailed: false
      });
    } catch (err) {
      console.error('[onGeneratePatriarchInviteCode]', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ inviteGenerating: false });
    }
  },

  onCloseInviteResultModal() {
    this.setData({ showInviteResultModal: false });
  },

  onCopyPatriarchInviteCode() {
    const code = this.data.inviteResultCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制邀请码', icon: 'success' })
    });
  },

  onOpenSecurityLogModal() {
    wx.showToast({ title: '安全日志功能即将上线', icon: 'none', duration: 2000 });
  },

  // 🆕 同步读取本地缓存占用，格式化为 "3.2MB" 供系统运维模块展示；wx.getStorageInfoSync
  // 是纯本地同步调用（无网络往返），initMinePage 与清理弹窗打开前各调用一次即可保持数值新鲜
  refreshCacheSize() {
    try {
      const info = wx.getStorageInfoSync();
      const mb = (info.currentSize || 0) / 1024;
      this.setData({ cacheSizeText: mb < 0.1 ? '<0.1MB' : `${mb.toFixed(1)}MB` });
    } catch (err) {
      this.setData({ cacheSizeText: '' });
    }
  },

  // 🆕 系统管理面板「更多系统工具」展开/收起：折叠一键加速系统/DEV 模拟开通
  // 这类低频运维项，默认不占地方
  onToggleAdminMoreTools() {
    this.setData({ showAdminMoreTools: !this.data.showAdminMoreTools });
  },

  // 🆕 大家长视角·爱心护持榜/核心荣誉折叠区展开/收起：管理任务优先，个人荣誉
  // 默认收起，按需展开查看
  onTogglePatriarchHonor() {
    this.setData({ patriarchHonorExpanded: !this.data.patriarchHonorExpanded });
  },

  onTriggerClearCache() {
    // 打开确认弹窗前重新读一次，避免展示上次 initMinePage 时留下的旧数值
    this.refreshCacheSize();
    const sizeLabel = this.data.cacheSizeText ? `（当前占用 ${this.data.cacheSizeText}）` : '';
    wx.showModal({
      title: '🗑️ 清理本地占用缓存',
      content: `这会清除手机上暂存的临时数据${sizeLabel}，释放存储空间、解决偶发的显示异常。云端数据和历史记录完全不受影响。`,
      confirmText: '立即清理',
      confirmColor: '#3B6FE8',
      cancelText: '再想想',
      success: (res) => {
        if (res.confirm) {
          try {
            wx.clearStorageSync();
            wx.showToast({ title: '缓存已清理', icon: 'success' });
            setTimeout(() => {
              this.isNavigating = true;
              wx.reLaunch({
                url: '/pages/index/index',
                fail: () => { this.isNavigating = false; }
              });
            }, 800);
          } catch (err) {
            wx.showToast({ title: '清理失败，请重试', icon: 'none' });
          }
        }
      }
    });
  },

  // ⚡ 一键加速系统：后台同步数据库查询优化配置（对用户完全无感知，仅超管可触发）
  async onTriggerCreateIndexes() {
    if (!this.data.isRealSuperAdmin || this.data.createIndexesRunning) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '⚡ 一键加速系统',
        content: '系统将在后台自动整理数据、优化查询速度，帮助小程序运行更流畅。\n\n此操作不影响任何数据安全，大约需要几秒钟。',
        confirmText: '开始加速',
        cancelText: '暂不优化',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    this.setData({ createIndexesRunning: true });
    wx.showLoading({ title: '加速优化中…', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({ name: 'createIndexes' });
      const result = res.result;
      wx.hideLoading();
      if (result && result.success) {
        // 将技术摘要转换为对用户友好的措辞
        const { created = 0, skipped = 0 } = parseIndexSummary(result.summary || '');
        const msg = created > 0
          ? `已新增 ${created} 项速度优化配置，系统加载会更流畅！`
          : '系统已处于最佳状态，无需重复优化。';
        wx.showModal({
          title: '✅ 加速完成',
          content: msg,
          showCancel: false,
          confirmText: '太好了'
        });
      } else {
        wx.showToast({ title: '本次优化未完全成功，可稍后重试', icon: 'none', duration: 3000 });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[onTriggerCreateIndexes]', err);
      wx.showToast({ title: '网络不稳定，请稍后重试', icon: 'none' });
    } finally {
      this.setData({ createIndexesRunning: false });
    }
  },

  onGoToStatistics() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/statistics/statistics',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 大家长专属：全国数据看板入口——直接跳转统计页并携带 view=national 参数。
  // 订阅校验移到统计页内部：未订阅时统计页展示"引导升级"预告卡片（含全机构门店总数），
  // 已订阅时直接展示完整大屏。前端不再提前拦截，让统计页按实际权限决定展示内容。
  // 🐛 根因修复：本方法同时服务 isPatriarch（顶部卡片 + 底部"全国数据看板"入口）
  // 与 isManager（顶部卡片，文案已改为"所在店铺历史数据看板"，见 WXML）——此前
  // 不分角色一律带 ?view=national 跳转，statistics.ts 只有 isPatriarch 才会真正
  // 触发 _triggerPatriarchNationalView() 切到全国聚合视图，isManager 点进去这个
  // 参数其实是死代码，落地页仍是自己门店的常规统计（这本身没错，店长不该有跨店
  // 权限），但显式带着一个对他们不生效的意图参数容易在排查问题时误导。这里按
  // 角色分流：大家长保留原有 ?view=national 跳转；店长改为与 onGoToStoreOverview
  // 一致的方式，直接带自己门店名跳转，不携带任何"全国"相关的意图参数
  async onPatriarchGoToNationalDashboard() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    const url = this.data.isPatriarch
      ? '/pages/statistics/statistics?view=national'
      : `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.currentStoreName || '')}`;

    wx.navigateTo({
      url,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🏢 会员开通/续费管理：按真实角色分流，不再无差别硬跳 pages/platform-admin。
  // 🐛 体验修复：此前不分角色一律跳转，该页面服务端权限（requirePlatformAdmin）
  // 只认 platform_admin——super_admin/store_patriarch（某个机构自己的最高权限
  // 角色，与"平台运维方"是两个完全不同的维度，详见 authService.ts UserRole
  // 定义处注释）点进去只会撞见硬拦截的"无权限访问"，体验极其突兀
  onGoToPlatformAdminTenants() {
    if (this.isNavigating) return;

    // 🏢 平台管理员：真正的租户管理职责在 pages/platform-admin，平滑跳转过去
    if (AuthService.isPlatformAdmin()) {
      this.isNavigating = true;
      wx.navigateTo({
        url: '/pages/platform-admin/platform-admin',
        fail: () => {
          this.isNavigating = false;
        }
      });
      return;
    }

    // super_admin / store_patriarch：不跳转硬拦截页面，直接在本页唤起自己的
    // "套餐升级/续费"半屏卡片
    this.onOpenSubscriptionModal();
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 🛡️ 超管强制解绑：从成员列表选择或手动粘贴 openId，将其角色重置为 volunteer
  // ──────────────────────────────────────────────────────────────────────────
  async onOpenForceUnbindModal() {
    if (!this.data.isRealSuperAdmin) return;
    this.setData({
      showForceUnbindModal: true,
      forceUnbindInput: '', forceUnbindResult: '',
      forceUnbindSearchQuery: '', forceUnbindSelectedMember: null,
      forceUnbindMemberList: [], forceUnbindFilteredList: [],
      forceUnbindMemberLoading: true
    });
    // 加载跨门店已授权成员（超管视角不传 storeId → 全机构）
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { action: 'listAuditQueue', tab: 'approved' }
      });
      const result = res.result;
      const ELEVATED = ['finance', 'store_manager', 'store_patriarch'];
      const maskPhone = (p: string) => {
        if (!p || p.length < 7) return p || '';
        return p.slice(0, 3) + '****' + p.slice(-4);
      };
      const all = (result && result.success && Array.isArray(result.data))
        ? result.data
            .filter((m: any) => ELEVATED.includes(m.role))
            .map((m: any) => ({ ...m, phoneMasked: maskPhone(m.phone || '') }))
        : [];
      this.setData({ forceUnbindMemberList: all, forceUnbindFilteredList: all });
    } catch (err) {
      console.warn('[onOpenForceUnbindModal] 加载成员列表失败:', err);
    } finally {
      this.setData({ forceUnbindMemberLoading: false });
    }
  },

  onCloseForceUnbindModal() {
    if (this.data.forceUnbindSaving) return;
    this.setData({
      showForceUnbindModal: false, forceUnbindInput: '', forceUnbindResult: '',
      forceUnbindSearchQuery: '', forceUnbindSelectedMember: null,
      forceUnbindMemberList: [], forceUnbindFilteredList: [],
      showForceUnbindManualInput: false
    });
  },

  onToggleForceUnbindManualInput() {
    this.setData({ showForceUnbindManualInput: !this.data.showForceUnbindManualInput });
  },

  onForceUnbindSearch(e: any) {
    const q = (e.detail.value || '').trim().toLowerCase();
    const all = this.data.forceUnbindMemberList;
    const filtered = q
      ? all.filter((m) =>
          (m.realName || '').toLowerCase().includes(q) ||
          (m.phone || '').includes(q) ||
          (m.storeName || '').toLowerCase().includes(q) ||
          (m.roleLabel || '').includes(q))
      : all;
    this.setData({ forceUnbindSearchQuery: e.detail.value, forceUnbindFilteredList: filtered });
  },

  onSelectForceUnbindMember(e: any) {
    const member = e.currentTarget.dataset.member;
    if (!member) return;
    // 从列表选中后收起手动输入兜底区
    this.setData({ forceUnbindSelectedMember: member, forceUnbindInput: '', showForceUnbindManualInput: false });
  },

  onClearForceUnbindSelection() {
    this.setData({ forceUnbindSelectedMember: null, forceUnbindInput: '' });
  },

  onForceUnbindInput(e: any) {
    this.setData({ forceUnbindInput: e.detail.value, forceUnbindSelectedMember: null });
  },

  onCopySelectedOpenId() {
    const openId = (this.data.forceUnbindSelectedMember && this.data.forceUnbindSelectedMember.openId)
      || this.data.forceUnbindInput || '';
    if (!openId) { wx.showToast({ title: '暂无 openId 可复制', icon: 'none' }); return; }
    wx.setClipboardData({ data: openId, success: () => wx.showToast({ title: '已复制 openId', icon: 'success' }) });
  },

  async onConfirmForceUnbind() {
    if (!this.data.isRealSuperAdmin || this.data.forceUnbindSaving) return;
    const selected = this.data.forceUnbindSelectedMember;
    const manualOpenId = (this.data.forceUnbindInput || '').trim();

    if (!selected && !manualOpenId) {
      wx.showToast({ title: '请先选择或输入目标用户', icon: 'none' });
      return;
    }

    const displayName = selected
      ? `${selected.storeName}-${selected.realName}`
      : `账号编号 ${manualOpenId.slice(0, 8)}...`;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '撤销管理权限确认',
        content: `⚠️ 确定要将 [${displayName}] 的管理权限撤销并降级为普通义工吗？撤销后该用户将立即失去管理权限，此操作无法撤回。`,
        confirmText: '确认撤销',
        confirmColor: '#C0392B',
        cancelText: '我再想想',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;

    this.setData({ forceUnbindSaving: true });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const callData: any = { action: 'superAdminForceUnbind' };
      if (selected && selected.applyId) {
        callData.targetDocId = selected.applyId;
      } else {
        callData.targetOpenId = manualOpenId;
      }
      const res: any = await wx.cloud.callFunction({ name: 'processRoleAudit', data: callData });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
        return;
      }
      const resultMsg = `✅ 权限已撤销 — 原角色：${result.prevRole || ''}，门店：${result.prevStoreName || '无'}`;
      this.setData({
        forceUnbindResult: resultMsg,
        forceUnbindSelectedMember: null,
        forceUnbindInput: '',
        // 从列表移除已解绑的成员
        forceUnbindMemberList: this.data.forceUnbindMemberList.filter(
          (m) => !(selected ? m.applyId === selected.applyId : m.openId === manualOpenId)
        ),
        forceUnbindFilteredList: this.data.forceUnbindFilteredList.filter(
          (m) => !(selected ? m.applyId === selected.applyId : m.openId === manualOpenId)
        )
      });
      wx.showToast({ title: '管理权限已撤销', icon: 'success' });
    } catch (err) {
      console.error('[onConfirmForceUnbind] 异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ forceUnbindSaving: false });
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 🌐 超管【门店选择与搜索】弹窗：与 activity-log.ts fetchSuperAdminStoreOptions
  // 复用同一个 getStoreList 云函数（已按 tenantId 收敛，不新建查询逻辑）。选中
  // 具体门店后调用 setSelectedStore() 写入全局已选门店——与 store-picker 组件/
  // activity-log.ts 超管切店同一套持久化机制，确保【门店档案】【门店日志】等
  // 二级页面（各自已有 getSelectedStore() 兜底解析）跳转过去后自动展示该门店数据，
  // 不需要额外改动那两个页面。
  // ──────────────────────────────────────────────────────────────────────────
  async onOpenStorePickerModal() {
    if (!this.data.isSuperAdmin) return;
    this.setData({
      showStorePickerModal: true,
      storePickerSearchText: '',
      storePickerLoading: true,
      storePickerAllStores: [],
      storePickerFilteredStores: []
    });

    try {
      const res: any = await wx.cloud.callFunction({ name: 'getStoreList' });
      const result = res.result;
      const list = (result && result.success && Array.isArray(result.list)) ? result.list : [];
      const stores = list
        .filter((s: any) => s && s.storeId && !isVirtualStoreName(s.storeName) && (s.status || 'active') !== 'inactive')
        .map((s: any) => ({
          storeId: s.storeId,
          storeName: s.storeName || '未命名门店',
          city: s.city || '',
          province: s.province || ''
        }));
      this.setData({ storePickerAllStores: stores, storePickerFilteredStores: stores });
    } catch (err) {
      console.warn('[onOpenStorePickerModal] 加载门店列表失败:', err);
      wx.showToast({ title: '门店列表加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ storePickerLoading: false });
    }
  },

  onCloseStorePickerModal() {
    this.setData({ showStorePickerModal: false, storePickerSearchText: '' });
  },

  // 🔍 实时搜索：支持按门店名称/拼音（见 matchStoreSearchKeyword）/城市匹配，
  // 全部在已拉取到的本地列表上过滤，不再重复打云函数
  onStorePickerSearchInput(e: any) {
    const raw = e.detail.value || '';
    const keyword = raw.trim().toLowerCase();
    const all = this.data.storePickerAllStores;
    const filtered = keyword ? all.filter((s) => matchStoreSearchKeyword(s, keyword)) : all;
    this.setData({ storePickerSearchText: raw, storePickerFilteredStores: filtered });
  },

  // ✅ 选择固定首项【🌐 全国总览】：清空巡检门店，恢复全局聚合视角。
  // 与 activity-log.ts onSuperAdminStoreChange 切到全国总览同一口径——不改动
  // 全局已选门店的持久化记录，只重置本页展示态
  onSelectNationalOverview() {
    this.setData({
      currentInspectStoreId: '',
      currentInspectStoreName: '',
      currentStoreName: '',
      showStorePickerModal: false,
      storePickerSearchText: ''
    });
    wx.showToast({ title: '已恢复全国总览', icon: 'none' });
  },

  // ✅ 选择具体门店，进入单店巡检视角
  onSelectInspectStore(e: any) {
    const { storeId, storeName } = e.currentTarget.dataset;
    if (!storeId) return;

    setSelectedStore({ storeId, storeName });
    this.setData({
      currentInspectStoreId: storeId,
      currentInspectStoreName: storeName,
      currentStoreName: storeName,
      showStorePickerModal: false,
      storePickerSearchText: ''
    });
    wx.showToast({ title: `已切换至「${storeName}」巡检视角`, icon: 'none' });
    this.refreshStoreStatus();
  },

  // 🔙 顶部合并提示条（.sa-status-bar）的唯一重置按钮：巡检门店
  // （currentInspectStoreId）与视角模拟（isImpersonating）是两套独立状态，
  // 可能同时激活，也可能只激活一个——这里各自按需重置，只展示一条汇总 Toast，
  // 不直接复用 onSelectNationalOverview()/applyViewModeSwitch()，避免两者
  // 同时激活时各自弹一次 Toast、重复触发两次 initMinePage()
  onResetSuperAdminTempViews() {
    const hadInspect = !!this.data.currentInspectStoreId;
    const hadImpersonation = this.data.isImpersonating;
    if (!hadInspect && !hadImpersonation) return;

    if (hadInspect) {
      this.setData({
        currentInspectStoreId: '',
        currentInspectStoreName: '',
        showStorePickerModal: false,
        storePickerSearchText: ''
      });
    }
    if (hadImpersonation) {
      setPreviewViewMode('SUPER_ADMIN');
      // 与 applyViewModeSwitch 同一套"清空手动切换记录，让预览重新拿回控制权"
      // 逻辑，见该方法处的详细注释
      wx.removeStorageSync('current_user_role');
      const app = getApp() as any;
      if (app && app.globalData && app.globalData.currentStore) {
        app.globalData.currentStore.role = 'ADMIN';
      }
    }

    wx.showToast({
      title: hadInspect && hadImpersonation ? '已重置巡检与模拟视角' : (hadInspect ? '已恢复全国总览' : '已还原超管视角'),
      icon: 'success'
    });
    this.initMinePage();
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 🔑 超管重置门店密钥：直接覆写指定门店的 adminKey，阻断恶意二次申请
  // ──────────────────────────────────────────────────────────────────────────
  async onOpenResetStoreKeyModal() {
    if (!this.data.isRealSuperAdmin) return;

    // 🏪 自动填入当前门店：优先读服务端缓存角色（最权威），降级到 getSelectedStore()。
    // 关键：必须过滤虚拟聚合门店名（"全国总览"/"全部门店"）——超管的 user_roles 文档
    // 里 storeName 可能残留 '全国总览' 历史脏值，直接拿来用会让选择框默认显示一个
    // 毫无意义的兜底文案，大家长完全不知道在操作哪家门店。
    const cachedRole  = AuthService.getCachedRoleInfo();
    const activeStore = getSelectedStore();

    const cacheIdOk   = !!(cachedRole && cachedRole.storeId && !isVirtualStoreName(cachedRole.storeName));
    const autoStoreId   = cacheIdOk
      ? cachedRole!.storeId
      : (activeStore && activeStore.storeId && !isVirtualStoreName(activeStore.storeName) ? activeStore.storeId : '');
    const autoStoreName = cacheIdOk
      ? (cachedRole!.storeName || '')
      : (activeStore && !isVirtualStoreName(activeStore.storeName) ? (activeStore.storeName || '') : '');

    this.setData({
      showResetStoreKeyModal: true,
      resetStoreKeyStoreId: autoStoreId,
      resetStoreKeyStoreName: autoStoreName,
      resetStoreKeyInput: '',
      resetStoreKeyIsClearMode: true,
      resetStoreKeyStoreList: [],
      resetStoreKeyStoreListLoading: true,
      resetStoreKeyShowList: false,
      resetStoreKeySearchText: '',
      resetStoreKeyFilteredList: []
    });
    try {
      const res: any = await wx.cloud.callFunction({ name: 'getStoreList' });
      // 过滤掉虚拟聚合门店（"全国总览"/"全部门店"），列表里只保留真实具体门店
      const list: Array<{ storeId: string; storeName: string }> =
        (Array.isArray(res.result?.stores) ? res.result.stores : []).filter(
          (s: any) => s && s.storeId && !isVirtualStoreName(s.storeName)
        );

      // 如果当前 storeId 仅填了 ID 但缺中文名，从列表补全 storeName
      const curId = this.data.resetStoreKeyStoreId;
      let resolvedName = this.data.resetStoreKeyStoreName;
      if (curId && !resolvedName) {
        const match = list.find(s => s.storeId === curId);
        if (match) resolvedName = match.storeName;
      }

      this.setData({
        resetStoreKeyStoreList: list,
        resetStoreKeyFilteredList: list,
        resetStoreKeyStoreName: resolvedName,
        // 单门店超管：若尚未选门店，自动选中列表唯一项
        ...((!curId && list.length === 1) ? {
          resetStoreKeyStoreId: list[0].storeId,
          resetStoreKeyStoreName: list[0].storeName,
          resetStoreKeyIsClearMode: true
        } : {})
      });
    } catch (err) {
      console.warn('[onOpenResetStoreKeyModal] 加载门店列表失败:', err);
    } finally {
      this.setData({ resetStoreKeyStoreListLoading: false });
    }
  },

  onCloseResetStoreKeyModal() {
    if (this.data.resetStoreKeySaving) return;
    this.setData({
      showResetStoreKeyModal: false,
      resetStoreKeyStoreId: '',
      resetStoreKeyStoreName: '',
      resetStoreKeyInput: '',
      resetStoreKeyIsClearMode: false,
      resetStoreKeyShowList: false,
      resetStoreKeySearchText: '',
      resetStoreKeyFilteredList: []
    });
  },

  // 🏪 展开/收起门店选择列表
  onToggleResetKeyStoreList() {
    if (this.data.resetStoreKeySaving) return;
    const show = !this.data.resetStoreKeyShowList;
    this.setData({
      resetStoreKeyShowList: show,
      resetStoreKeySearchText: '',
      resetStoreKeyFilteredList: show ? this.data.resetStoreKeyStoreList : []
    });
  },

  // 🔍 门店模糊搜索（仅按中文门店名匹配，storeId 不对用户可见）
  onResetStoreKeySearch(e: any) {
    const q = (e.detail.value || '').trim().toLowerCase();
    const all = this.data.resetStoreKeyStoreList;
    const filtered = q
      ? all.filter(s => s.storeName.toLowerCase().includes(q))
      : all;
    this.setData({ resetStoreKeySearchText: e.detail.value || '', resetStoreKeyFilteredList: filtered });
  },

  // ✅ 从列表选择目标门店
  onSelectResetKeyStore(e: any) {
    const { storeId, storeName } = e.currentTarget.dataset;
    const isClearMode = (this.data.resetStoreKeyInput || '').trim() === '';
    this.setData({
      resetStoreKeyStoreId: storeId,
      resetStoreKeyStoreName: storeName,
      resetStoreKeyShowList: false,
      resetStoreKeySearchText: '',
      resetStoreKeyFilteredList: [],
      resetStoreKeyIsClearMode: isClearMode
    });
  },

  onResetStoreKeyInput(e: any) {
    const val = e.detail.value || '';
    this.setData({ resetStoreKeyInput: val, resetStoreKeyIsClearMode: val.trim() === '' });
  },

  async onConfirmResetStoreKey() {
    if (!this.data.isRealSuperAdmin || this.data.resetStoreKeySaving) return;
    const storeId = (this.data.resetStoreKeyStoreId || '').trim();
    if (!storeId) {
      wx.showToast({ title: '请选择或输入目标门店', icon: 'none' });
      return;
    }
    const newKey = (this.data.resetStoreKeyInput || '').trim();

    // 🟡 清空密钥二次确认：留空会让任何人免密申请管理岗位，需明确用户认知
    if (!newKey) {
      const storeName = this.data.resetStoreKeyStoreName || storeId;
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '清空密钥确认',
          content: `确认清空「${storeName}」的管理员密钥吗？\n\n清空后，其他义工申请管理身份时将无需输入密码。如不确定，建议先设置一个新密钥。`,
          confirmText: '确认清空',
          confirmColor: '#F0A500',
          cancelText: '我再想想',
          success: (res) => resolve(res.confirm),
          fail: () => resolve(false)
        });
      });
      if (!confirmed) return;
    }

    this.setData({ resetStoreKeySaving: true });
    wx.showLoading({ title: '重置中...', mask: true });
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'update', storeId, adminKey: newKey }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '重置失败', icon: 'none' });
        return;
      }
      this.setData({
        showResetStoreKeyModal: false,
        resetStoreKeyStoreId: '',
        resetStoreKeyStoreName: '',
        resetStoreKeyInput: '',
        resetStoreKeyIsClearMode: false,
        resetStoreKeyShowList: false,
        resetStoreKeySearchText: '',
        resetStoreKeyFilteredList: []
      });
      wx.showToast({ title: newKey ? '密钥已重置' : '密钥已清除（无门槛申请）', icon: 'success', duration: 2500 });
    } catch (err) {
      console.error('[onConfirmResetStoreKey] 异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ resetStoreKeySaving: false });
    }
  },

  // 🔐 套餐升级/续费半屏卡片：复用 checkTenantPermission（与首页/统计页同一套
  // 租户订阅鉴权入口），拿到的 planType/isExpired/serviceExpireDate 就是本机构
  // 当前生效的套餐状态——传哪个 featureKey 不影响这几个字段的取值，任选一个即可。
  // 抽成独立方法是因为激活码兑换成功后也要重新拉一遍最新状态刷新这张卡片，
  // 与"打开弹窗时首次加载"共用同一段逻辑，不重复维护两份
  async fetchSubscriptionInfo() {
    // 🌟 checkTenantPermission 内部按调用者自己的 _openid 反查 user_roles.tenantId
    // 再查 tenant_subscriptions（云端数据库，唯一真源）——不读取任何本地
    // Storage 缓存的授权标记。这意味着换一台手机用同一个微信账号登录，这里
    // 依然会查到同一个 tenantId 名下云端保存的真实套餐状态，专业版权益天然
    // 跨设备保持有效，不需要额外做"迁移本地授权状态"这类操作
    const result = await checkTenantPermission(FEATURE_KEYS.MULTI_STORE_DASHBOARD, { skipCache: true });
    const expireDateStr = result.serviceExpireDate || '';
    // 🌟 7 天内到期同样标红提醒——与 pages/platform-admin 大盘"7 天内到期机构"
    // 预警口径保持一致（见 getPlatformOverview 的 soonExpiringTenants）
    const EXPIRING_SOON_MS = 7 * 24 * 3600 * 1000;
    const expireTime = expireDateStr ? new Date(expireDateStr).getTime() : NaN;
    const isExpiringSoon = !result.isExpired && !Number.isNaN(expireTime) && (expireTime - Date.now()) <= EXPIRING_SOON_MS;
    // 🆕 isActive：与 tenantPermission.ts 的 BASIC/ADVANCED 两档概念对齐——
    // ADVANCED 且未到期才算"已开通"。到期的 pro/enterprise 服务端本就会把
    // planType 提前改写回 basic（见 checkTenantPermission 云函数），这里再
    // 显式判一次 isExpired 是双重保险，不是重复逻辑
    const isActive = resolveTier(result.planType) === PERMISSION_TIER.ADVANCED && !result.isExpired;

    this.setData({
      subscriptionInfo: {
        planType: result.planType,
        planLabel: PLAN_LABELS[result.planType] || result.planType,
        isExpired: result.isExpired,
        isExpiringSoon,
        isActive,
        expireDateStr
      }
    });
  },

  // 🐛 防重锁：与 statistics.ts fetchStatistics 同一套 isLoading 式防抖，避免用户
  // 手快连点"会员开通/续费管理"打出重复的鉴权云调用
  async onOpenSubscriptionModal() {
    if (this.data.subscriptionLoading) return;
    this.setData({
      showSubscriptionModal: true,
      subscriptionLoading: true,
      activationCodeInput: ''
    });

    try {
      await this.fetchSubscriptionInfo();
    } catch (err) {
      console.warn('[onOpenSubscriptionModal] 加载套餐信息失败:', err);
    } finally {
      this.setData({ subscriptionLoading: false });
    }
  },

  // WXML 中 pro-service-card 按钮绑定此方法（与 onOpenSubscriptionModal 同义）
  onOpenProSubscriptionModal() {
    return this.onOpenSubscriptionModal();
  },

  onCloseSubscriptionModal() {
    this.setData({ showSubscriptionModal: false });
  },

  onActivationCodeInput(e: any) {
    // 🆕 自动去除前后空格：授权码通常是从聊天记录/短信里复制来的，前后经常
    // 带着换行/空格，这里在每次输入变化时就地清理，兑换时不会因为多余空白
    // 字符导致校验失败
    this.setData({ activationCodeInput: (e.detail.value || '').trim() });
  },


  // 🆕 粘贴：直接读取剪贴板填入输入框（并去除前后空格），授权码通常是从
  // 客服/购买渠道的聊天记录里复制来的，比手动长按输入框选择粘贴更省事
  onPasteActivationCode() {
    wx.getClipboardData({
      success: (res) => {
        const text = (res.data || '').trim();
        if (!text) {
          wx.showToast({ title: '剪贴板为空', icon: 'none' });
          return;
        }
        this.setData({ activationCodeInput: text });
      },
      fail: () => {
        wx.showToast({ title: '读取剪贴板失败', icon: 'none' });
      }
    });
  },

  // 🌸 激活码/授权码自助兑换：完全自动化，校验通过立即生效，全程无需联系
  // 管理员或等待人工审批——对接 cloudfunctions/activateTenantSubscription 的
  // redeem action，那边会直接写入 tenant_subscriptions（与 platform_admin 后台
  // 手工续费同一张表），本页只是多了一个自助入口
  async onRedeemActivationCode() {
    if (this.data.activationSubmitting) return;
    const code = (this.data.activationCodeInput || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入激活码', icon: 'none' });
      return;
    }

    this.setData({ activationSubmitting: true });
    wx.showLoading({ title: '正在兑换...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'activateTenantSubscription',
        data: { action: 'redeem', activationCode: code }
      });
      const result = res.result as any;
      wx.hideLoading();

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '兑换失败，请重试', icon: 'none', duration: 2500 });
        return;
      }

      // 🆕 兑换成功：清空 tenantPermission.ts 的 60s 内存缓存，避免用户兑换完
      // 当场跳去统计页/导出功能，还要再等缓存自然过期才看到解锁生效；同时
      clearTenantPermissionCache();
      this.setData({ activationCodeInput: '' });
      await this.fetchSubscriptionInfo();

      const planLabel = PLAN_LABELS[result.data.planType] || result.data.planType;
      wx.showToast({
        title: `兑换成功！已升级至${planLabel}，有效期至 ${result.data.serviceExpireDate}`,
        icon: 'none',
        duration: 3000
      });
    } catch (err) {
      wx.hideLoading();
      console.error('[onRedeemActivationCode] 兑换异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ activationSubmitting: false });
    }
  },

  // 🌟 在线订购：接入微信云开发原生支付（方案 B 终极形态）。
  // 完整流程：createSubscriptionOrder 云函数统一下单 → wx.requestPayment 拉起
  // 微信支付界面 → 支付成功后 payCallback 云函数自动更新 tenant_subscriptions
  // 与 tenants 集合（100% 自动无感，无需用户手动输入任何授权码）→ 前端清除
  // 权限缓存并刷新套餐展示状态。
  // 授权码/卡号输入框保留为备用/赠送激活入口（见上方 onRedeemActivationCode）。
  async onSubscribeAdvancedFeature() {
    if (this.data.subscriptionLoading) return;
    this.setData({ subscriptionLoading: true });
    wx.showLoading({ title: '正在生成订单...', mask: true });

    try {
      // Step 1: 调用云函数统一下单，获取支付参数
      const orderRes = await wx.cloud.callFunction({
        name: 'createSubscriptionOrder',
        data: { planType: 'ADVANCED_YEARLY' }
      });
      const orderResult = orderRes.result as any;
      wx.hideLoading();

      if (!orderResult || !orderResult.success || !orderResult.payment) {
        // 微信支付未配置时给出引导文案，其余错误原文展示
        const rawErr: string = (orderResult && orderResult.error) || '';
        const isPaymentUnconfigured =
          orderResult?.paymentNotConfigured ||
          rawErr.includes('未在云端开通') ||
          rawErr.includes('未开通微信支付') ||
          rawErr.includes('unifiedorder') ||
          rawErr.includes('payment');
        wx.showToast({
          title: isPaymentUnconfigured
            ? '当前环境暂未开通微信支付，请使用授权码兑换或联系大家长'
            : (rawErr || '生成订单失败，请重试'),
          icon: 'none',
          duration: 3000
        });
        return;
      }

      // Step 2: 拉起微信原生支付界面
      const payParams = orderResult.payment as {
        timeStamp: string;
        nonceStr: string;
        package: string;
        signType: string;
        paySign: string;
      };
      await new Promise<void>((resolve, reject) => {
        wx.requestPayment({
          timeStamp: payParams.timeStamp,
          nonceStr: payParams.nonceStr,
          package: payParams.package,
          signType: (payParams.signType || 'MD5') as 'MD5' | 'HMAC-SHA256' | 'RSA',
          paySign: payParams.paySign,
          success: () => resolve(),
          fail: (err) => reject(err)
        });
      });

      // Step 3: 支付成功 —— 清除权限缓存，刷新套餐展示
      // payCallback 云函数已在服务端自动更新 tenant_subscriptions，
      // clearTenantPermissionCache() 清除 60s 内存缓存，fetchSubscriptionInfo()
      // 强制重新从云端读取最新状态，两步合用保证前端立即看到解锁结果
      clearTenantPermissionCache();
      wx.showLoading({ title: '正在激活...', mask: true });
      try {
        await this.fetchSubscriptionInfo();
      } finally {
        wx.hideLoading();
      }

      wx.showToast({
        title: '激活成功！已为您开通专业版跨店大屏与数据导出权限',
        icon: 'success',
        duration: 3000
      });
    } catch (err: any) {
      wx.hideLoading();
      // wx.requestPayment 用户主动取消时 errMsg 包含 'cancel'
      if (err && typeof err.errMsg === 'string' && err.errMsg.indexOf('cancel') !== -1) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
      } else {
        console.error('[onSubscribeAdvancedFeature] 支付异常:', err);
        wx.showToast({ title: '支付失败，请重试', icon: 'none' });
      }
    } finally {
      this.setData({ subscriptionLoading: false });
    }
  },

  // ─────────────────────────────────────────────────────────────────────
  // 🎨 组织信息配置（大家长专属）
  // ─────────────────────────────────────────────────────────────────────

  // ── ✏️ 快捷修改门店名称 ────────────────────────────────────────────────
  onQuickEditStoreName() {
    // 解析目标 storeId：patriarch 在云函数侧自动取 caller.storeId，无需传；
    // super_admin 调用 resolveWriteTarget 时必须传 requestedStoreId，否则报
    // "请指定目标门店"。这里统一取一次，传参时两者都传，云函数自行按角色取舍。
    const storeId = (this.data.patriarchData && (this.data.patriarchData as any).currentStoreId as string)
      || (AuthService.getCachedRoleInfo() && (AuthService.getCachedRoleInfo() as any).storeId as string)
      || '';
    this.setData({
      showEditStoreNameModal: true,
      tempStoreName: this.data.currentStoreName || '',
      editingStoreId: storeId,
      editStoreNameSaving: false
    });
  },

  onCloseEditStoreNameModal() {
    this.setData({ showEditStoreNameModal: false });
  },

  onTempStoreNameInput(e: any) {
    this.setData({ tempStoreName: e.detail.value || '' });
  },

  async onConfirmEditStoreName() {
    if (this.data.editStoreNameSaving) return;
    const newName = (this.data.tempStoreName || '').trim();
    if (!newName) {
      wx.showToast({ title: '门店名称不能为空', icon: 'none' });
      return;
    }
    if (newName === this.data.currentStoreName) {
      this.setData({ showEditStoreNameModal: false });
      return;
    }
    this.setData({ editStoreNameSaving: true });
    try {
      // storeId 兜底：patriarch 不需要传（云函数取 caller.storeId），但 super_admin
      // 必须传，否则 resolveWriteTarget 返回"请指定目标门店"。两者都传安全，云函数
      // 对 patriarch 只读 caller.storeId，传多了不影响
      const storeId = (this.data.editingStoreId as string)
        || (AuthService.getCachedRoleInfo() && (AuthService.getCachedRoleInfo() as any).storeId as string)
        || '';
      const callData: Record<string, any> = { action: 'update', storeName: newName, registeredName: newName };
      if (storeId) callData.storeId = storeId;
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: callData
      });
      const result = res && res.result;
      if (!result || !result.success) {
        wx.showToast({ title: result && result.error || '保存失败，请重试', icon: 'none', duration: 3000 });
        return;
      }
      wx.showToast({ title: '门店名称修改成功', icon: 'success' });
      this.setData({ showEditStoreNameModal: false, currentStoreName: newName });
      // 同步本地缓存：auth_user_role + current_store_name，确保首页胶囊立即刷新
      try {
        const cached = wx.getStorageSync('auth_user_role');
        if (cached) {
          const roleInfo = JSON.parse(cached);
          roleInfo.storeName = newName;
          wx.setStorageSync('auth_user_role', JSON.stringify(roleInfo));
        }
        wx.setStorageSync('current_store_name', newName);
      } catch (e) { /* ignore */ }
    } catch (err: any) {
      console.error('[onConfirmEditStoreName]', err);
      wx.showToast({ title: err.message || '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ editStoreNameSaving: false });
    }
  },
  // ─────────────────────────────────────────────────────────────────────

  // 🆕 门店管理中心卡片头部的门店名 Pill 点击入口：与原先"✏️ 修改"单独占一整行、
  // 唤起快捷改名 Mini-Modal（onQuickEditStoreName/esn-mask，仅改门店名一个字段）
  // 不同——这里合并进大标题右侧后改走【组织信息配置】完整弹窗（门店名/机构类型/
  // 文化寄语/Logo 一次性维护），避免同一张卡片里出现两套"改门店信息"入口
  onEditStoreInfo() {
    this.onOpenOrgConfigModal();
  },

  async onOpenOrgConfigModal() {
    // 立即用本地缓存名称预填，避免用户看到空白输入框等待网络
    const cachedName = this.data.currentStoreName || '';
    // 🆕 机构类型：先用页面已有的 isYuhuazhai 信号起一个粗粒度 seed（避免打开弹窗
    // 瞬间选择器空白/闪烁），下方后台拉取到真实 orgType 后会立即覆盖为精确值
    const seedOrgType = this.data.isYuhuazhai ? 'yuhuazhai' : '';
    const seedIdx = ORG_CONFIG_TYPE_OPTIONS.findIndex(o => o.value === seedOrgType);
    this.setData({
      showOrgConfigModal: true,
      orgConfigName:    cachedName,
      orgConfigSlogan1: '',
      orgConfigSlogan2: '',
      orgConfigLogoUrl: '',
      orgConfigSaving:  false,
      orgLogoLoadFailed: false,
      orgConfigOrgTypeIndex: seedIdx,
      orgConfigOrgType: seedOrgType
    });
    // 后台拉取最新配置覆盖（slogan / logo 等本地缓存没有的字段）
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'get' }
      });
      const d = res && res.result && res.result.data;
      if (d) {
        // 🆕 机构类型：找不到匹配项（历史门店未设置/取值不在这 3 档内）时，index
        // 兜底为 -1（picker 展示待选提示，不会误显示成列表第一项"社区助餐"）
        const fetchedOrgType = d.orgType || '';
        const matchedIdx = ORG_CONFIG_TYPE_OPTIONS.findIndex(o => o.value === fetchedOrgType);
        this.setData({
          // 优先取 storeName（权威字段），回退 registeredName，再回退已预填的缓存值
          orgConfigName:    d.storeName || d.registeredName || cachedName,
          orgConfigSlogan1: d.slogan1 || '',
          orgConfigSlogan2: d.slogan2 || '',
          orgConfigLogoUrl: (Array.isArray(d.storefrontPhotos) && d.storefrontPhotos[0]) || '',
          orgLogoLoadFailed: false,
          orgConfigOrgTypeIndex: matchedIdx,
          orgConfigOrgType: fetchedOrgType
        });
      }
    } catch (err) {
      // 预填失败不阻断用户操作，当前已有缓存名称，静默忽略
    }
  },

  onCloseOrgConfigModal() {
    this.setData({ showOrgConfigModal: false });
  },

  onOrgConfigNameInput(e: any) {
    this.setData({ orgConfigName: (e.detail.value || '').trim() });
  },

  onOrgConfigSlogan1Input(e: any) {
    this.setData({ orgConfigSlogan1: e.detail.value || '' });
  },

  onOrgConfigSlogan2Input(e: any) {
    this.setData({ orgConfigSlogan2: e.detail.value || '' });
  },

  async onUploadOrgLogo() {
    try {
      const chooseRes = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });
      const tempPath = chooseRes.tempFiles[0].tempFilePath;
      wx.showLoading({ title: '上传中…', mask: true });
      const cloudPath = `org-logos/${Date.now()}_logo.jpg`;
      const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
      wx.hideLoading();
      this.setData({ orgConfigLogoUrl: uploadRes.fileID, orgLogoLoadFailed: false });
    } catch (err: any) {
      wx.hideLoading();
      if (err && typeof err.errMsg === 'string' && err.errMsg.indexOf('cancel') !== -1) return;
      wx.showToast({ title: '上传失败，请重试', icon: 'none' });
    }
  },

  // 🐛 组织 Logo 加载失败兜底：cloud fileID 可能因为文件被删除/权限变更等原因
  // 404/500，binderror 触发后降级回"点击上传"占位态，而不是留一个裂图
  onOrgLogoLoadError(e: any) {
    console.warn('[onOrgLogoLoadError] 组织 Logo 加载失败:', e && e.detail);
    this.setData({ orgLogoLoadFailed: true });
  },

  // 🆕 悬浮"清空"按钮：只清空本次表单里的预览态，退回"点击上传"占位——不主动
  // 调用任何删除云存储文件的接口（避免误删已被其它记录引用的历史图片），真正
  // 生效仍要点【保存配置】把 storefrontPhotos 落库覆盖
  onClearOrgLogo() {
    this.setData({ orgConfigLogoUrl: '', orgLogoLoadFailed: false });
  },

  async onSaveOrgConfig() {
    if (this.data.orgConfigSaving) return;
    const { orgConfigName, orgConfigSlogan1, orgConfigSlogan2, orgConfigLogoUrl } = this.data;
    if (!orgConfigName.trim()) {
      wx.showToast({ title: '组织名称不能为空', icon: 'none' });
      return;
    }
    // super_admin 没有自己绑定的门店（云函数 resolveWriteTarget 对 super_admin
    // 强制要求显式 storeId，见 manageStoreProfile 里"请指定目标门店"报错），必须
    // 先选定巡检门店才能保存——与 onOpenStoreStatsModal 同一套超管选店前置校验，
    // 不再对云函数发起注定失败的请求
    const orgCfgStoreId = ((this.data.patriarchData as any)?.currentStoreId as string)
      || this.data.currentInspectStoreId
      || (AuthService.getCachedRoleInfo() && (AuthService.getCachedRoleInfo() as any).storeId as string)
      || (getSelectedStore() && getSelectedStore().storeId)
      || '';
    if (this.data.isSuperAdmin && !orgCfgStoreId) {
      wx.showToast({ title: '请先选择巡检门店', icon: 'none' });
      return;
    }
    this.setData({ orgConfigSaving: true });
    try {
      const newName = orgConfigName.trim();
      const updateData: Record<string, any> = {
        // storeName 写入权限见云函数 manageStoreProfile：大家长/超管直接生效，
        // 店长传此字段会被静默忽略（仍走 registeredName → pendingProfileUpdate 审批流）
        storeName: newName,
        registeredName: newName,
        slogan1: orgConfigSlogan1,
        slogan2: orgConfigSlogan2
      };
      if (orgConfigLogoUrl) {
        updateData.storefrontPhotos = [orgConfigLogoUrl];
      }
      // 🆕 机构类型：不再由本弹窗写入——已改为进入首页时的工作空间选择一次性确定，
      // 此处只读展示（见 WXML），不下发 orgType 更新，避免覆盖首页选定的真实值
      // super_admin 必须传 storeId，patriarch/manager 传了也无害（云函数对非超管忽略此参数）
      if (orgCfgStoreId) updateData.storeId = orgCfgStoreId;
      const res = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'update', ...updateData }
      }) as any;
      const result = res && res.result;
      if (!result || !result.success) {
        wx.showToast({ title: result && result.error || '保存失败，请重试', icon: 'none', duration: 3000 });
        return;
      }
      wx.showToast({ title: '组织信息已更新', icon: 'success' });
      this.setData({ showOrgConfigModal: false });

      // 🔄 同步本地缓存：更新 auth_user_role 中的 storeName 与 current_store_name，
      // 确保返回首页后 store-picker 胶囊与导航栏名称立即生效，无需重新登录
      try {
        const cached = wx.getStorageSync('auth_user_role');
        if (cached) {
          const roleInfo = JSON.parse(cached);
          roleInfo.storeName = newName;
          wx.setStorageSync('auth_user_role', JSON.stringify(roleInfo));
        }
        wx.setStorageSync('current_store_name', newName);
      } catch (cacheErr) {
        console.warn('[onSaveOrgConfig] 缓存更新失败，不影响主流程:', cacheErr);
      }

      // 🐛 刷新门店状态缓存：此前只取 patriarchData.currentStoreId，注释称"本弹窗仅
      // 大家长可见"——但店长现在也能打开这个弹窗（见门店管理中心新增的组织信息配置
      // 入口），店长的 patriarchData 从不加载、永远是初始空值，导致这里静默失效。
      // 改用与上面 orgCfgStoreId 一致的口径，三种角色都能正确刷新
      if (orgCfgStoreId) setTimeout(() => fetchAndSyncStoreStatus(orgCfgStoreId), 600);
    } catch (err: any) {
      console.error('[onSaveOrgConfig]', err);
      wx.showToast({ title: err.message || '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ orgConfigSaving: false });
    }
  }
});
