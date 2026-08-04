import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService, ROLE_LABELS, getPermissionFlags, PermissionFlags } from '../../utils/authService';
import { parseDonorText, parseMaterials, formatDonationItemsToText, formatMaterialsToText } from '../../utils/parser';
import { generateReportText } from '../../utils/reportGenerator';
import { drawMeritPoster, drawStoryPoster, PosterData, StoryPosterData } from '../../utils/posterGenerator';
import { drawStoreInvitationPoster } from '../../utils/drawStorePoster';
import { saveToQueue, getQueue, removeFromQueue, getQueueCount } from '../../utils/offlineQueue';
import { getSafeSystemInfo } from '../../utils/util';
import { getPrevDayIsoString, formatDateToCnShort, isValidIsoDate, getTodayIsoString } from '../../utils/dateUtils';
import { getSelectedStore, setSelectedStore, getCachedStoreStatus, fetchAndSyncStoreStatus } from '../../utils/storeManager';
import { validateReportGuardrails, GuardrailResult, recordSuccessfulSubmit, recordWarningConfirmed, canSubmitNow, cleanExpiredFrequencyRecords } from '../../utils/validateReportGuardrails';
import { compressAndUploadImages } from '../../utils/imageCompress';
import { isCloudAvailable } from '../../utils/cloudGuard';
import { maskName } from '../../utils/privacy';
import { md5 } from '../../utils/md5';
import { applyRoleViewOverride, getPreviewViewMode, PreviewViewMode } from '../../utils/viewModePreview';
import { takeResumeDraftHandoff } from '../../utils/draftHandoff';
import { takeComplianceReviewRequest } from '../../utils/complianceHandoff';
import { takeGenCodeHandoff } from '../../utils/genCodeHandoff';
import { takeOpenSunshineLedgerRequest } from '../../utils/sunshineLedgerHandoff';
import { takeOpenCultureFullRequest } from '../../utils/cultureFullHandoff';
import { takeOpenStorePickerRequest } from '../../utils/storePickerHandoff';
import {
  getDailyCultureQuote, getRandomCultureQuote, FAMILY_MOTTO, SENIORS_CARE,
  CORE_VALUES, FAMOUS_QUOTES, RAIN_FLOWER_HOME, SIXTEEN_BESTS, GRATITUDE_TEXT, DAILY_SUMMARY, FAMILY_STYLE
} from '../../utils/cultureData';
import { computeMyCheckInStats } from '../../utils/checkinStats';

const HOME_COMPRESS_CANVAS_ID = 'imgCompressCanvas';
// 🌟 单日护持工时上限：打卡弹窗的实时预览与提交时的截断保护共用同一个值，避免两处写死后走偏
const DAILY_HOURS_CAP = 12.0;

// 🔑 特权邀请码身份词汇映射：本组件的本地胶囊角色词汇（PATRIARCH/MANAGER/FINANCE/
// FAMILY/VOLUNTEER）<-> cloudfunctions/manageStoreInviteCode 的服务端角色词汇
// （STORE_PATRIARCH/STORE_MANAGER/FINANCE/FAMILY/VOLUNTEER）。onGenerateInviteCode
// （发码）与 checkPendingInviteCode/confirmInviteCodeRedeem（扫码直达核销）两处
// 都要用同一套映射，提到模块级避免各自重复定义、口径走偏
const INVITE_ROLE_SERVER_MAP: Record<string, string> = {
  PATRIARCH: 'STORE_PATRIARCH', MANAGER: 'STORE_MANAGER', FINANCE: 'FINANCE', FAMILY: 'FAMILY', VOLUNTEER: 'VOLUNTEER'
};
const INVITE_ROLE_LABEL_MAP: Record<string, string> = {
  PATRIARCH: '大家长', MANAGER: '门店店长', FINANCE: '门店财务', FAMILY: '家人', VOLUNTEER: '志愿者'
};
// 服务端角色词汇 -> 本地胶囊词汇（大小写两种形式都兜底，落库后的 role 单值字段是
// 小写 snake_case，targetRole 邀请码字段本身是大写）
const INVITE_SERVER_ROLE_TO_LOCAL: Record<string, string> = {
  STORE_PATRIARCH: 'PATRIARCH', store_patriarch: 'PATRIARCH',
  STORE_MANAGER: 'MANAGER', store_manager: 'MANAGER',
  FINANCE: 'FINANCE', finance: 'FINANCE',
  FAMILY: 'FAMILY',
  VOLUNTEER: 'VOLUNTEER', volunteer: 'VOLUNTEER'
};

// 🧾 常用支出项目「一键预置模版」：仅覆盖两个分类各自语义相符的高频项，不混着塞——
// 食材类（daily）与水电/维修这类大额专项（fixed）本就不该出现在同一个分类下
const EXPENSE_TEMPLATE_PRESETS: Record<'daily' | 'fixed', string[]> = {
  daily: ['米面油', '蔬菜采买', '调味副食'],
  fixed: ['水电燃气', '厨房维修']
};

// 🐛 修复"喜讯通报：喜讯通报：..."套娃重复：title/content 本身不应再嵌入 tag 前缀，
// tag 已经在展示时单独加上【】/📢，重复嵌入会导致视觉上连续出现两次"喜讯通报"
const PRESET_NOTICES = {
  opening: {
    tag: '喜讯通报',
    title: '三源弘雨花敬老家园试营业',
    content: '三源弘雨花敬老家园，14号正式开启试营业。秉承敬老爱老、扶弱助困理念，为长者提供健康公益素食午餐。欢迎长辈们前来用餐，也欢迎爱心家人抽空回家做义工，一起践行敬老美德，传递关爱❤️。感恩大家支持！'
  },
  volunteer: {
    tag: '义工招募',
    title: '爱心义工招募',
    content: '【爱心义工招募】雨花斋的运转离不开义工家人的倾情护持！现急需择菜、洗碗、传菜义工数名，服务时间：每天上午 8:30 - 12:30。期待您的加入，一起传递温暖！❤️'
  },
  supplies: {
    tag: '物资呼吁',
    title: '爱心物资接力',
    content: '【爱心物资接力】感恩各位爱心人士的护持！当前小店大米/食用油储备临界，特向社会呼吁爱心物资接力。每一粒米、每一滴油都饱含满满的心意。衷心感谢您的倾心付出！❤️'
  },
  weather_closure: {
    tag: '暂停营业',
    title: '恶劣天气暂停开餐告示',
    content: '【暂停开餐通知】受恶劣天气影响，为保障各位长者及义工家人的出行安全，本斋将于明日暂停开餐一天。请大家互相转告，切勿空跑。待天气好转后恢复正常开餐。衷心感谢大家的理解与支持！❤️'
  },
  renovation_closure: {
    tag: '暂停营业',
    title: '内部整修/例行消杀停业通知',
    content: '【例行维护通知】为给长者们提供更加干净、卫生的用餐环境，本斋将于近期进行全店深度清洁消杀与设备整修，期间暂停开餐一天。恢复供餐后欢迎长辈们回家用餐。感恩大家的体谅与护持！❤️'
  },
  festival: {
    tag: '日常温馨提醒',
    title: '节日特别结缘活动通知',
    content: '【节日欢聚通知】值此佳节到来之际，本斋将于明天中午举办节日特别供餐活动，并为到店用餐的长者准备了一份心意。欢迎长辈们互相转告、欢喜回家用餐！祝大家吉祥安康！🏮'
  },
  thanks: {
    tag: '感恩致谢',
    title: '专项爱心致谢',
    content: '【感恩致谢】特别感谢爱心企业/爱心人士对本斋的慷慨支持，您的善举让更多长者感受到了社会的温暖。衷心感谢您的无私奉献，祝愿平安喜乐、好人一生平安！❤️'
  }
};

// 🐛 防御性去重：无论是预置文案还是店长自行编辑保存的通报，只要 title/content 开头
// 恰好又重复带了一遍 tag 前缀（如"喜讯通报：喜讯通报：..."），一律在这里剥离干净再落库/展示
function stripTagPrefix(text: string, tag: string): string {
  if (!text || !tag) return text || '';
  const prefixes = [`${tag}：`, `${tag}:`, `【${tag}】`];
  let result = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length).trim();
        changed = true;
      }
    }
  }
  return result;
}

// 🔗 跑马灯通知云端化：把 manageNotice 云函数返回的原始记录（tenantId/storeId/
// createdAt 等审计字段）映射成前端一直在用的展示形状（id/tag/title/content/
// create_time），公告详情弹窗/复制文案等既有逻辑完全不用改
function mapNoticeRecord(raw: any): any {
  let createTime = '';
  try {
    createTime = new Date(raw.createdAt).toISOString().split('T')[0];
  } catch (e) {
    createTime = '';
  }
  return {
    id: raw._id,
    tag: raw.tag || '',
    title: raw.title || '',
    content: raw.content || '',
    is_top: true,
    create_time: createTime
  };
}

const debounce = <T extends (...args: any[]) => any>(fn: T, delay: number): T => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
};

const DRAFT_KEY = 'REPORT_FORM_DRAFT';
const SETTINGS_KEY = 'SHOP_SETTINGS';

function getDraftKeyForDate(dateStr: string, shopName: string): string {
  const cleanShop = (shopName || 'default').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  return `DRAFT_${cleanShop}_${dateStr}`;
}

// 统一的两位小数四舍五入，避免浮点误差在多次加减后累积出细微偏差
function round2(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

// 📖 雨花文化全集【十个有没有/祈盼排比句】：把"只有他人，没有自己。"
// "祈盼公益餐桌无限延伸，让孝悌忠信走进千家万户!"这类首个逗号分句的原文
// 拆成左右两列，供弹窗内的双列网格逐行渲染。
// keepCommaOnLeft：十个有没有的既定展示是左右都不带逗号（默认 false）；
// 祈盼排比句要求左列保留逗号（如"祈盼公益餐桌无限延伸，"），传 true
function splitAtFirstComma(text: string, keepCommaOnLeft: boolean = false): { left: string; right: string } {
  const idx = text.indexOf('，');
  if (idx < 0) return { left: text, right: '' };
  return { left: text.slice(0, keepCommaOnLeft ? idx + 1 : idx), right: text.slice(idx + 1) };
}

// 📖 雨花文化全集【立志格言/雨花心字诀/雨花敬老核心理念】：把逗号/句号/分号收尾的
// 原文按标点切成一句一句的短句，再按 clausesPerLine 分组换行——立志格言/敬老核心
// 理念每句独立一行 (=1)，雨花心字诀是四言韵律短句，按四句一换行 (=4)。只做展示层
// 的换行分组，不改动任何文字，源头仍是 FAMILY_MOTTO/FAMOUS_QUOTES/SENIORS_CARE
// 里未经改写的权威原文
function splitIntoClauseLines(text: string, clausesPerLine: number): string[] {
  const clauses = text.match(/[^，。；]+[，。；]/g) || [text];
  const lines: string[] = [];
  for (let i = 0; i < clauses.length; i += clausesPerLine) {
    lines.push(clauses.slice(i, i + clausesPerLine).join(''));
  }
  return lines;
}


// 🌟 今日食谱动态卡片：后端 manageDailyMenu 存的是一整段自由文本 menuText
// （没有结构化的菜品数组字段），要在首页把它渲染成小网格/标签云，只能从这段文本里
// 尽力切出菜品名。
// 🐛 最初按"顿号/逗号/换行都算分隔符 + 每段够短"来判断，结果一句用逗号断句的说明文字
// （"今天食材紧张，暂时简化供应，具体以实际到货为准"）会被误判成三道"菜"——逗号在中文里
// 既是列表分隔符也是普通语句的分句符号，太不可靠。顿号"、"则不同：中文里它几乎专属于
// 并列列表项，很少出现在完整语句里。改为"文本里出现顿号才尝试按顿号/换行切分"，
// 没有顿号一律直接回退到纯文本——用真实场景测试过逗号分隔的说明句能正确返回空数组。
// 仍有极小概率的残余误判（有人偏偏用顿号写一整句话），但那是不符合中文标点习惯的
// 小概率写法，且这里只影响展示样式（标签云 vs 纯文本），不涉及任何金额/账目计算，
// 犯错代价很低，不值得为了这个再引入更复杂的分句判断逻辑。
function splitMenuTextToDishes(menuText: string): string[] {
  if (!menuText || !menuText.trim()) return [];
  const trimmed = menuText.trim();
  if (!trimmed.includes('、')) return [];

  const dishes = trimmed
    .split(/[、\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const looksLikeDishList = dishes.length >= 2 && dishes.every(d => d.length > 0 && d.length <= 12);
  return looksLikeDishList ? dishes : [];
}

function deriveDateString(reportDateValue: string, reportDate: string): string {
  if (reportDateValue && /^\d{4}-\d{2}-\d{2}$/.test(reportDateValue)) {
    return reportDateValue;
  }
  const m = reportDate.match(/(\d{2,4})年(\d{2})月(\d{2})日/);
  if (m) {
    let year = m[1];
    if (year.length === 2) year = '20' + year;
    return `${year}-${m[2]}-${m[3]}`;
  }
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toStandardIsoDate(dateStr: string): string {
  if (!dateStr) return '';
  let str = String(dateStr).trim();
  if (/^\d{2}年/.test(str)) str = '20' + str;
  const match = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  return str;
}

Page({
  isSubmitting: false,
  debouncedSaveDraft: null as any,
  _shopNameTimer: null as any,
  _balanceReqSeq: 0,
  isNavigating: false,
  _checkInSubmitting: false,
  // 任务C：待执行的锚点滚动目标（onLoad 解析后暂存，onShow 中触发滚动）
  _pendingScrollTarget: '' as string,
  _highlightTimer: null as any,
  // 🏪 门店选择器引导：因未选定具体门店而被拦截的操作，暂存回调，待用户选店后自动续跑
  _pendingStoreSelectAction: null as (() => void) | null,
  // 🐛 防抖锁：见 loadHomeDynamicData() 注释，避免 onLoad/onShow 前后脚触发导致
  // 同一批首页动态数据请求并发重复发起
  _homeDataFetchInFlight: false,

  data: {
    // 🐛 根因修复：小程序框架 onLoad/onShow 是背靠背同步触发的，onShow 几乎必然抢在
    // onLoad 里 await AuthService.ensureLogin()/initCurrentUserRole() 完成之前就跑完，
    // 此前 onShow 无条件重新发起 fetchTodayMenu/fetchTodayActivity/fetchNotices/
    // fetchLatestMaterialStatus 四个云函数请求，导致冷启动时用着角色/门店尚未解析出
    // 来的旧状态重复打一遍请求。hasInitedData 标记 onLoad 是否已在角色就绪后完整
    // 触发过一轮数据初始化——为 false 时 onShow 直接跳过这一批请求，交给 onLoad 自己
    // 触发唯一一次；后续真正的"切回页面"场景（hasInitedData 已为 true）照常刷新
    hasInitedData: false,
    reportDate: '',
    reportDateValue: '',
    prevBalance: '0.00',
    yesterdayBalance: '0.00',
    isBalanceLocked: true,
    isTodaySelected: true,
    isYesterdaySelected: false,
    balanceFocus: false,
    isEditMode: false,
    balanceMatchTip: '',
    parsedTotalIncome: 0,
    totalExpense: 0,
    computedTodayBalance: '0.00',
    inputMode: 'text',
    isScanningDonorList: false,
    showFrequentDonorModal: false,
    frequentDonorList: [] as { name: string; count: number }[],
    // 🌟 高频账目模板：门店常用支出项目速录（云端存储，店长/财务/超管维护，全员可用）
    showExpenseTemplateModal: false,
    expenseTemplateCategory: 'daily' as 'daily' | 'fixed',
    expenseTemplateTargetField: 'dailyExpenseText' as 'dailyExpenseText' | 'fixedExpenseText',
    expenseTemplateDailyList: [] as { _id: string; itemName: string; defaultAmount: number | null; usageCount?: number }[],
    expenseTemplateFixedList: [] as { _id: string; itemName: string; defaultAmount: number | null; usageCount?: number }[],
    expenseTemplateLoaded: false,
    expenseTemplateEditMode: false,
    expenseTemplateNewName: '',
    expenseTemplateNewAmount: '',
    expenseTemplateSaving: false,
    // ✏️ 管理态重命名：与新建共用同一个 name/amount 输入行为不同，重命名要先选中一条
    // 已有记录再改名，用独立的 id/name 字段承载，避免和"新建"的表单状态互相污染
    expenseTemplateRenamingId: '',
    expenseTemplateRenamingName: '',
    // ⚡ 极速记账：点击"开餐食材"分类的 Chip 后，不再静默拼接文本，改为弹出这个
    // 迷你金额确认框——项目名称已带入，金额输入框自动 focus，确认后才真正落到
    // dailyExpenseText。"大额专项"分类走另一条路（直接插入结构化 fixedExpenseItems
    // 并 focus 该条目自己的金额框），不需要这个弹窗
    showQuickAmountModal: false,
    quickAmountItemName: '',
    quickAmountValue: '',
    // 🌟 合规授权须知弹窗，见 checkComplianceNotice
    showComplianceModal: false,
    complianceModalScene: 'general' as 'general' | 'privileged' | 'review',
    // ☀️ 阳光账本轻量弹窗：见 onOpenSunshineLedger/fetchSunshineLedgerData，
    // 数据来自公开只读云函数 getSunshineLedger，支持按 selectedYearMonth 切月查看
    showSunshineLedgerModal: false,
    sunshineLedgerLoading: false,
    selectedYearMonth: '',
    isSunshineLedgerAtCurrentMonth: true,
    sunshineLedgerData: {
      storeName: '',
      periodLabel: '',
      auditedReportsCount: 0,
      totalDiners: 0,
      monthlyDiners: 0,
      takeawayMeals: 0,
      totalHours: 0,
      volunteerCount: 0,
      operatingDays: 0,
      ledgerPublicRate: null as string | null
    },
    // ☀️ 阳光账本 4x2 网格展示数组：从 sunshineLedgerData 派生，供 WXML wx:for
    // 渲染，避免 8 个统计格子手写重复结构；value 统一存字符串（账本公开率是
    // "100%"/"暂无数据"这类文本，与其余数字指标共用同一套渲染逻辑更简单）
    sunshineStatCards: [] as { label: string; value: string }[],
    yesterdayBalDisplay: '0.00',
    totalIncomeDisplay: '0.00',
    totalExpenseDisplay: '0.00',
    previewTodayBalanceDisplay: '0.00',
    singleName: '',
    singleAmount: '',
    allDonations: '',
    otherDonation: '',
    expenses: '',
    dailyExpenseText: '',
    dailyExpenseParseCount: 0,
    dailyExpenseParseAmount: '0.00',
    fixedExpenseText: '',
    // 🌟 大额专项支出：从 fixedExpenseText 自由文本改为「逐条添加」结构化列表，
    // 使每一条都能挂一个真实的独立凭证按钮（<textarea> 内部做不到按行挂按钮）。
    // fixedExpenseText 保留、继续由 fixedExpenseItems 自动派生，下游（结算/提交/
    // 草稿/历史编辑/海报）读到的仍是同一个字段，零改动。
    fixedExpenseItems: [] as {
      _key: string;
      name: string;
      amount: string;
      independent_image_urls: string[];
      expanded: boolean;
      // ⚡ 极速记账：从「常用支出项目」一键插入时短暂置 true，驱动金额输入框自动
      // focus 一次；其余来源（手动新建/OCR/草稿恢复）的条目均为 false
      _focusAmount?: boolean;
    }[],
    fixedExpenseNewName: '',
    fixedExpenseNewAmount: '',
    reportResult: '',
    showResult: false,
    isResultExpanded: false,
    showSettings: false,
    isSavingTemplate: false,
    templateStorePickerIndex: 0,
    templateFocusField: '',
    shopName: '海沧区雨花斋',
    mpAccount: '厦门海沧雨花斋！',
    thankText: '感谢各位爱心人士的鼎力支持，感恩默默付出的义工团队！',
    slogan1: '吃素一日  健康一天',
    slogan2: '清晰记账  透明运行',
    donationPlaceholder: '可以直接把所有支持名单一次性全部贴在这里。例如：\n黄玉珍 16\n周瑞德 2\n吴建平 3\n邢善积德 2\n',
    headerSafeTop: 85,
    modalSafeTop: 0,
    isSubmitting: false,
    hasDraft: false,
    parseResult: {
      items: [],
      unrecognizedLines: [],
      totalAmount: 0,
      totalCount: 0
    },
    totalParsedAmount: '0.00',
    calculationFormulaText: '',
    receiptImages: [] as string[],
    // 🛡️ 缩略图加载失败兜底：key 是图片路径本身，命中即代表这张图当前应该展示
    // "加载失败，点击重试"占位块而不是一个空白/裂图的 <image>。receiptImages/
    // independent_image_urls/activityImages 是纯字符串数组，recipeImages 是
    // {url,name}[]（取 .url 当 key），统一用一张按路径查表的 map 来标记
    imageLoadFailedMap: {} as Record<string, boolean>,
    // 🛡️ 首页"今日食谱"/"今日门店日志"预览卡缩略图加载失败兜底：这两张卡此前是
    // 全仓库唯一没有 binderror/失败占位保护的图片网格，云存储读权限异常等情况下
    // 会呈现小程序原生的裂图/空白（也就是"缩略图不显示，呈占位色块"），现补齐
    // 与 imageLoadFailedMap 同款的按 url 查表方案
    previewImagesFailedMap: {} as Record<string, boolean>,
    // 🍱 今日食谱照片（随餐报一并提交，最多 9 张）
    // 每个元素对应一道菜：{url: 本地临时路径/云端 fileID, name: 菜品名称}——
    // 与 daily-menu 页面 editForm.images 同构，提交时一并组装成 [{url,name}] 传给
    // manageDailyMenu 云函数，让首页随手拍的食谱也能落上菜名
    recipeImages: [] as Array<{ url: string; name: string }>,
    recipeUploading: false,
    // 📌 今日大事记照片 + 简短文字描述（随餐报一并提交，最多 18 张），同上纯字符串数组
    activityImages: [] as string[],
    activityUploading: false,
    activityText: '',
    // 物资赞助数据结构
    materials: [] as { donor: string; item: string; quantity: string; unit: string }[],
    materialsInput: '', // 自由文本输入（如："张三：大米50斤；李四：食用油2箱"）
    // 义工时间统计
    volunteerCount: '', // 今日到岗义工人数（自 dineInVolunteers+deliveryVolunteers 自动镜像，兼容统计大屏/海报/导出等下游）
    volunteerHours: '', // 今日义工总工时
    // 用餐人次
    diningCount: '', // 今日用餐人次（自 totalDineCount 自动镜像，同上）
    // 🍱 用餐/义工细分统计（堂食/送餐/打包场景区分）：totalDineCount/totalVolunteers
    // 由 recalcDiningStats() 实时算出，并同步镜像进 diningCount/volunteerCount，
    // 兼容统计大屏/海报生成/Excel 导出/风控校验等一切既有只认 diningCount/volunteerCount 的下游消费方
    dineInSeniors: '', // 堂食长者数
    deliverySeniors: '', // 送餐长者数
    dineInVolunteers: '', // 堂食/到岗志愿者数
    deliveryVolunteers: '', // 送餐志愿者数
    takeawayCount: '', // 打包份数
    totalDineCount: '0', // 用餐总数（自动计算：堂食长者+送餐长者+打包+堂食志愿者）
    totalVolunteers: '0', // 志愿者总人次（自动计算：送餐志愿者+堂食志愿者）
    // 📋 【一键复用昨日数据】：loadBalanceForDate 查昨日结余时顺手带出的细分统计快照，
    // 供用户点"复用昨日"按钮一键填充；全 0（老记录没有细分字段/无昨日记录）时按钮置灰不可用
    yesterdayStatsSnapshot: null as null | {
      dineInSeniors: number; deliverySeniors: number; takeawayCount: number;
      dineInVolunteers: number; deliveryVolunteers: number; volunteerHours: number;
    },
    hasYesterdayStats: false,
    // 主食物资储备状态
    stapleRiceStatus: 'normal', // 大米/面粉: sufficient/normal/urgent
    stapleOilStatus: 'sufficient', // 食用油: sufficient/normal/urgent
    systemBalance: 0,
    isManualAdjust: false,
    balanceDiff: 0,
    adjustReason: '',
    isGeneratingPoster: false,
    showPoster: false,
    posterImage: '',
    showPosterModal: false,
    // 🆕 财务公示版 (4:3) / 温馨故事版 (9:16) 切换：posterType 只影响 .poster-modal
    // （showPoster，展示 canvas 导出的真实图片）这一个预览弹窗，与 .modal-backdrop
    // （showPosterModal，纯 WXML 拼版预览）互不相关，不需要跟着切
    posterType: 'financial' as 'financial' | 'story',
    isSwitchingPosterType: false,
    // 🌸 财务公示版海报可选落款：雨花家风「仁·中·和」/ 感恩词，仅影响 drawMeritPoster
    // 财务公示版（温馨故事版 StoryPosterData 未接入此项，见 posterGenerator.ts 说明）
    posterShowFamilyStyleFooter: true,
    posterShowGratitudeFooter: true,
    // 🏛️ 护持家长/日常店长落款：姓名来自 stores 文档缓存字段（manageStoreProfile
    // 的 get action 顺带返回），未绑定家长/店长姓名时对应半句不画，两者都空则整行不画
    posterShowPeopleSignature: true,
    storePatriarchName: '',
    storeManagerName: '',
    // 🆕 海报右下角"扫码验真"用的真实小程序码本地临时路径（指向 pages/public-verify/index，
    // 携带 storeId+date）：每次生成/切版式共用同一份，生成失败时为空字符串，
    // 由 posterGenerator.ts 自行降级为占位框
    verifyQrLocalPath: '',
    // 🐛 修复"二维码显示为空白"：旧默认值是一个早期私人测试云环境的死链
    // （zeng-yuhua-cloud-123.tcb.qcloud.la），且项目里根本没有 /images/ 静态资源目录，
    // 兜底路径同样是空的。现改为状态机 + 动态生成，绝不再依赖任何写死的外部/本地图片路径。
    qrCodeUrl: '',
    qrCodeState: 'idle' as 'idle' | 'loading' | 'ready' | 'failed',
    todayInAmount: '0.00',
    todayOutAmount: '0.00',
    todayTotalBalance: '0.00',
    lastBalance: '0.00',
    donorCount: 0,
    riceStatus: '充足',
    oilStatus: '充足',
    offlineQueueCount: 0,
    // 任务C：锚点聚焦 - 控制打卡卡片的高亮动画
    highlightCheckInCard: false,
    // 档案弹窗
    showArchiveModal: false,
    // 🛠️ 义工现场服务工具金刚区：菜单人数/物资消耗两个填报弹窗（daily-menu-modal/
    // material-usage-modal 组件）的显隐，表单状态本身由组件内部持有
    showDailyMenuModal: false,
    showMaterialUsageModal: false,
    archiveUserInfo: {
      totalDays: 0,
      totalCheckInCount: 0,
      totalHours: 0,
      avatarUrl: '',
      nickName: ''
    },
    showAgreement: false,
    canvasHeight: 667,
    showAdjustModal: false,
    adjustInput: '',
    adjustModalInfo: {
      systemBalance: '0.00',
      adjustedBalance: '0.00',
      balanceDiff: '0.00',
      balanceDiffSign: '-'
    },
    showOcrConfirmModal: false,
    ocrReceiptList: [],
    ocrSuccessCount: 0,
    ocrFailCount: 0,
    ocrTotalAmount: '0.00',
    // 🌟 强制焦点定位：弹窗打开时自动聚焦第一张小票的第一个金额输入框并全选文本，
    // 方便店长直接键入修正，而不必先手动点击、再删除原有数字
    ocrFocusFirstPrice: false,
    ocrFocusSelectionEnd: 99,
    // 🌟 OCR 确认弹窗"确认后预计结余"实时预览，见 updateOcrConfirmPreview
    ocrPreviewExpense: '0.00',
    ocrPreviewBalance: '0.00',
    ocrPreviewFormula: '',
    showBalanceHistoryModal: false,
    recentBalanceHistoryList: [] as any[],
    // 🔗 跑马灯通知云端化：noticeList 是当前视角（总览级/具体门店，严格互斥）
    // 拉取到的全部有效通知，announcement 始终指向 noticeList[currentNoticeIndex]，
    // 供详情弹窗/复制文案等既有逻辑直接读，不用感知背后是数组还是单条
    noticeList: [] as any[],
    // 🌟 首屏优雅过渡：初始为 true，avoid 在 fetchNotices() 真正返回之前就先闪一下
    // "暂无通知"兜底提示——只有云端明确返回空列表之后，兜底提示才应该出现
    noticesLoading: true,
    currentNoticeIndex: 0,
    isNoticeBarHiddenToday: false,
    // 🌸 每日修身卡片：跑马灯下方的非宗教化传统文化/正能量微卡片，纯静态内容，
    // 不查云端；cultureQuote 由 onLoad/onShow 调 getDailyCultureQuote() 按自然日选取
    cultureQuote: { text: '', source: '' } as { text: string; source: string },
    showFamilyMottoModal: false,
    // 拆成结构化的三段（心字诀/家训正文各行/为学之方），而不是拼成一整段纯文本，
    // 是为了让弹窗里"雨花心字诀"/"为学之方"这类小标题能加粗独立展示，提升可读性
    familyMottoMindFormula: '',
    familyMottoMindFormulaLines: [] as string[],
    familyMottoCreedLines: [] as string[],
    familyMottoStudyMethod: '',
    // 🌸 为学之方拆成三段单列居中展示：开篇一句 / 中间六句分句 / 结语一句加粗
    familyMottoStudyIntro: '',
    familyMottoStudyMiddleLines: [] as string[],
    familyMottoStudyConclusion: '',
    // 📖 雨花文化全集弹窗：module 7（雨花家训）复用上面三个既有字段，
    // 这里补齐其余九大模块，随 onShowFamilyMottoModal 一次性填好，纯静态内容
    cultureFullData: {
      coreValuesNational: [] as string[],
      coreValuesSocial: [] as string[],
      coreValuesIndividual: [] as string[],
      famousQuotes: [] as string[],
      famousQuoteLines: [] as string[],
      homeCoreSpirit: '',
      homeSanYouTitle: '', homeSanYouItems: [] as string[],
      homeWuLeTitle: '', homeWuLeItems: [] as string[],
      homeLiuTongTitle: '', homeLiuTongItems: [] as string[],
      homeBaXinTitle: '', homeBaXinItems: [] as string[],
      seniorsCoreBelief: '',
      seniorsCoreBeliefLines: [] as string[],
      seniorsTenHaveYous: [] as string[],
      seniorsTenHaveYouPairs: [] as { left: string; right: string }[],
      sixteenBests: [] as string[],
      gratitudeText: [] as string[],
      dailySummaryTitle: '',
      dailySummaryGratitude: [] as string[],
      dailySummaryAspiration: [] as string[],
      dailySummaryAspirationLines: [] as string[],
      familyStyleTitle: '',
      familyStyleText: ''
    },
    // 🙏 打卡成功弹窗内展示的【敬老行为准则·十个有没有】，纯静态内容，无需查云端
    tenHaveYous: SENIORS_CARE.tenHaveYous as string[],
    announcement: null as {
      id: string;
      tag: string;
      title: string;
      content: string;
      is_top: boolean;
      create_time: string;
    } | null,
    showAnnouncementModal: false,
    showNoticeEditModal: false,
    noticeEditId: '',
    noticeEditTag: '喜讯通报',
    noticeEditTitle: '',
    noticeEditContent: '',
    // 🌟 公告模板库：与静态的 PRESET_NOTICES（本机内置 7 条示例文案）并列展示，
    // 云端拉取——isSystem:true 为全域公共模板（本机构任意门店可用），其余为
    // 当前门店自己保存的私有模板，两者互不越界（见 manageNotice getTemplates）
    noticeTemplates: [] as any[],
    noticeTemplatesLoading: false,
    // 仅超级管理员在"存为模板"时可勾选，决定新模板是私有（本店）还是全域公共
    saveAsSystemTemplate: false,
    mergeToReportText: false,
    showApplyModal: false,
    applyForm: {
      storeId: '',
      storeName: '',
      realName: '',
      phone: '',
      requestedRole: 'volunteer',
      // 🏢 门店选择双模式：existing=从本机构已有门店中选择，custom=手动填写新门店名称
      storeSelectionType: 'existing',
      customStoreName: '',
      // 🏪 新建门店档案补全：门店此刻还不存在，只能先收进申请表单本身，approve
      // 时由 processRoleAudit 一并写入新建的 stores 文档，见 submitRoleApply
      address: '',
      contactPhone: '',
      storePhotos: [] as string[]
    } as any,
    applyStorePhotoUploading: false,
    applyRoleTipText: '✅ 即刻生效，开始护持',
    applyRoleTipVariant: 'auto' as 'auto' | 'patriarch' | 'pending',
    showAuditModal: false,
    auditActiveTab: 'pending' as 'pending' | 'approved',
    auditIsNationalView: false,
    pendingApplyList: [] as any[],
    approvedVolunteerList: [] as any[],
    // 🐛 请求去重锁：切换 待审核/已审核 Tab 或角色 Filter 时手快连点，此前
    // fetchPendingAuditList/fetchApprovedVolunteerList 各自独立发起云函数请求，
    // 完全没有防抖，会打出并发/重复请求，返回顺序还可能乱序覆盖列表。
    // fetchAuditQueue() 统一用这把锁：已有请求在途时直接跳过，等它自己的
    // finally 解锁后由触发方自然收敛，与 statistics.ts fetchStatistics() 的
    // statisticsFetchLoading 防抖锁同一套写法
    pendingAuditRequest: false,
    // 🦴 骨架屏：弹窗刚拉起、云函数还没返回之前渲染占位骨架卡片，避免
    // "先闪一下空状态插画、数据到了才变成列表"这种视觉跳动
    auditListLoading: false,
    // 🔍 角色筛选（全部/义工/财务/大家长+店长合并为一档）与已通过列表的姓名/手机号搜索：
    // 两个 Tab 共用同一份筛选态，纯前端对已拉取的列表做二次过滤，无需为筛选组合再打云函数
    auditRoleFilter: 'all' as 'all' | 'volunteer' | 'finance' | 'leader',
    auditSearchKeyword: '',
    filteredPendingList: [] as any[],
    filteredApprovedList: [] as any[],
    // 🛡️ 拒绝角色/门店申请必须说明原因（processRoleAudit action:'reject' 服务端强制
    // 校验 rejectReason），点击"拒绝"先弹这个原因输入框，而不是直接调用云函数
    showAuditRejectModal: false,
    auditRejectId: '',
    auditRejectReason: '',
    auditRejectPreset: '',
    auditRejectSubmitting: false,
    currentUserRole: '' as string,
    permissions: {} as PermissionFlags,
    isVolunteer: false,
    isManager: false,
    isFinance: false,
    isSuperAdmin: false,
    // 🏛️ 大家长（store_patriarch）：批量解封/反封账等"大家长"专属操作的权限判定，
    // 与 isManager/isFinance 等"权限向下继承"标志并列，但精确指向该具体角色本身
    isPatriarch: false,
    // ❤️ 家人（服务对象）：新增于首页角色分流——store_family 真实身份，或新用户/
    // 未审核通过的默认 volunteer 账号（与 profile.ts isFamily 判定口径一致）。
    // 默认 false，避免角色数据到位前首页先闪一下"家人版"布局
    isFamily: false,
    // 🌟 视角切换预览：isRealSuperAdmin 恒等于真实身份，不受预览覆盖影响，用于门店切换器等
    // 处的"视角切换"入口自身的显隐判断；currentViewMode 是当前选中的预览视角
    isRealSuperAdmin: false,
    currentViewMode: 'SUPER_ADMIN' as PreviewViewMode,
    currentRole: 'VOLUNTEER' as 'VOLUNTEER' | 'MANAGER' | 'FINANCE',
    pendingAuditCount: 0,
    roleLabelMap: ROLE_LABELS,
    currentStoreName: '' as string,
    // 🏪 门店运营状态徽标：见 utils/storeManager.ts fetchAndSyncStoreStatus/
    // getCachedStoreStatus，全局态与 Storage 双写同步，与 profile.ts 共用同一份数据
    currentStoreStatus: '' as string,
    // 🌟 财务专属功能区：风控预警数量（首页角标）、封账弹窗、风控预警明细弹窗
    riskAlertCount: 0,
    showFinanceLockModal: false,
    // 🌟 稽核与封账：自定义起止日期区间（取代原先的单一月份 Picker），支持跨月批量封账/解封
    financeLockStartDate: '',
    financeLockEndDate: '',
    financeLockInFlight: false,
    financeUnlockInFlight: false,
    financeLockStatusLoading: false,
    lockStatusText: '',
    financeLockRangeLocked: false,
    showRiskAlertsModal: false,
    riskAlertsLoading: false,
    riskAlertsList: [] as any[],
    // 🌟 详情筛选：点击风控卡片后仅展示该类型的明细，'' 表示不筛选、展示全部
    riskAlertsFilterType: '' as '' | 'void' | 'missing_receipt' | 'balance',
    riskAlertsFilteredList: [] as any[],
    riskAlertsSummary: { voidCount: 0, missingReceiptCount: 0, balanceAnomalyCount: 0 },
    // 🌟 是否存在任意异常：驱动弹窗头部图标/配色在"绿色安全"与"橙红警示"之间联动
    riskAlertsHasAnomaly: false,
    // 🌟 统计区间文案，例如"近 60 天：2026-06-02 至 2026-08-01"
    riskAlertsRangeLabel: '',
    currentStoreId: '' as string,
    isAllStoresView: false,
    allStoresList: [] as any[],
    showStorePosterModal: false,
    storePosterTempFilePath: '',
    currentSponsorInfo: null as any,
    todayDateStr: '',
    // 🍱 今日食谱首页预览卡（只读展示，编辑/发布已合并至【食谱管理中心】pages/daily-menu 页面）
    todayMenu: null as any,
    todayMenuDishes: [] as string[],
    todayMenuLoaded: false,
    // 📌 今日大事记首页预览卡（只读展示，编辑/发布已合并至【大事记中心】pages/activity-log 页面）
    todayActivity: null as any,
    todayActivityLoaded: false,
    // 🔗 门店日志联动：记下当天已存在记录的 _id，提交报表时精准 update 这一条，
    // 而不是走 autoSyncFromReport 的按键查找（避免跟"门店日志"页手动发布的记录
    // 各自独立、堆出两条内容重复的大事记），见 publishRecipeAndActivityIfPresent
    todayActivitySourceId: '',

    isReadOnlyByLock: false,
    lockOwnerName: '',
    lockRemainingSec: 0,
    lockRemainingFormatted: '',
    _heartbeatTimer: null as any,
    _lockPollingTimer: null as any,
    _lockActiveKey: '',
    _heartbeatRetryCount: 0,
    showShiftSelectModal: false,
    selectedShift: 'LUNCH',
    selectedShiftHours: 3.0,
    willEatLunch: true,
    // 🍚 留店用餐细分餐别：勾选"今日留店用餐"后展开的早/午/晚 Chip 多选态，
    // 提交打卡时随 reservedMeals 一并写入后厨预留量数据（见 onConfirmShiftCheckIn）
    reservedMeals: ['lunch'] as string[],
    checkInLogs: [] as any[],
    todayAccumulatedHours: 0,
    // 🌟 打卡弹窗实时工时预览：勾选班次后即时预估"若提交这一笔，今日总工时会变成多少"，
    // 超限时禁用确认按钮，而不是等提交后才静默截断
    previewTotalHours: 0,
    isOverHoursLimit: false,
    checkInSubmitting: false,
    allShiftsCompleted: false,
    todayLogs: [] as any[],
    myCheckInDays: 0,
    myCheckInCount: 0,
    myServiceHours: 0,
    shiftDefinitions: [
      { shiftKey: 'EARLY_MORNING', name: '🌌 凌晨熬粥与备菜班', hours: 4.0, timeDesc: '04:00 - 08:00 · 蒸饭煲汤' },
      { shiftKey: 'MORNING', name: '🥗 早间准备与洗切班', hours: 2.5, timeDesc: '08:00 - 10:30 · 洗菜配菜' },
      { shiftKey: 'LUNCH', name: '🍲 午餐打饭与引导班', hours: 3.0, timeDesc: '10:30 - 13:30 · 堂食引导' },
      { shiftKey: 'CLEAN', name: '🧹 后厨洗碗与收尾班', hours: 1.5, timeDesc: '13:30 - 15:00 · 消毒整理' },
      { shiftKey: 'NIGHT', name: '🌙 夜间整理与盘点班', hours: 3.0, timeDesc: '18:00 - 21:00 · 物资盘点' }
    ] as any[],
    availableShifts: [] as any[],
    showGenCodeModal: false,
    isGeneratingInviteCode: false,
    genTargetRole: 'MANAGER' as 'PATRIARCH' | 'MANAGER' | 'FINANCE' | 'FAMILY' | 'VOLUNTEER',
    generatedCode: '',
    targetGenStoreId: '',
    targetGenStoreName: '',
    // 过滤掉"全国总览"等虚拟条目后的真实门店下拉选项
    genStoreOptions: [] as any[],
    // 🛡️ 发码防越权：非超管强制锁定为当前所属门店、禁用下拉切换，防止跨店发码
    genStoreSelectorDisabled: false,
    // 🛡️ 身份阶梯权限过滤：当前调用者实际可选的目标身份白名单，与
    // cloudfunctions/manageStoreInviteCode 的 checkGeneratePermission 口径一致——
    // 超管可选五种，店长/大家长只放开 [家人, 志愿者]（大家长/店长/财务三档
    // 与调用者自身同级或更高，严禁越权生成）
    genAvailableRoles: ['PATRIARCH', 'MANAGER', 'FINANCE', 'FAMILY', 'VOLUNTEER'] as string[],

    // 🔑 生成结果弹窗：展示 8 位邀请码 + 对应太阳码，与 gencode-modal 是两个独立弹窗——
    // 生成成功后立即关闭 gencode-modal、打开这个结果弹窗，不再像旧版那样自动复制关闭
    showInviteResultModal: false,
    inviteResultCode: '',
    inviteResultQrPath: '',
    inviteResultStoreName: '',
    inviteResultRoleLabel: ''
  },

  _adjustResolve: null as (() => void) | null,

  async onLoad(options: any) {
    this.debouncedSaveDraft = debounce(() => this.saveDraft(), 500);

    // 🐛 修复：todayDateStr 此前从未被赋值，义工视角"汇报日期"栏与首页快捷发布弹窗
    // 的日期提示一直渲染为空白
    this.setData({ todayDateStr: getTodayIsoString() });

    // 任务C：解析锚点聚焦参数
    // 支持 action=checkInCard 或 targetElement=checkInCard 两种参数名
    if (options) {
      const action = options.action || '';
      const target = options.targetElement || '';
      if (action === 'checkInCard' || target === 'checkInCard') {
        this._pendingScrollTarget = 'checkInCard';
      }
    }

    // 扫码进入时捕获 scene 参数 (支持格式: s=store_haicang)
    if (options && options.scene) {
      const sceneStr = decodeURIComponent(options.scene);
      let storeId = '';

      try {
        const params = new URLSearchParams(sceneStr);
        storeId = params.get('s') || '';
      } catch (e) {
        storeId = sceneStr.replace('s=', '');
      }

      if (storeId) {
        this.fetchStoreInfoAndPromptApply(storeId);
      }
    }

    const loginRes = await AuthService.ensureLogin();
    if (loginRes.isTemp) {
      console.warn('[Index] 使用临时 openid，数据将暂存本地');
    }

    try {
      const rect = wx.getMenuButtonBoundingClientRect();
      const capsuleBottom = rect.bottom;
      this.setData({
        headerSafeTop: capsuleBottom + 15
      });
    } catch (error) {
      this.setData({
        headerSafeTop: 85
      });
    }

    try {
      const sysInfo = getSafeSystemInfo();
      this.setData({
        modalSafeTop: sysInfo.statusBarHeight
      });
    } catch (error) {
      this.setData({
        modalSafeTop: 44
      });
    }

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    
    this.setData({
      reportDate: `${yyyy}年${mm}月${dd}日`,
      reportDateValue: `${yyyy}-${mm}-${dd}`,
      isTodaySelected: true,
      isYesterdaySelected: false
    });
    
    this.loadSettings();
    await this.loadLastBalance();
    DataService.syncLocalDataToCloud();
    await this.initCurrentUserRole();

    const storeId = this.data.currentStoreId || 'store_haicang_001';
    this.fetchStoreSponsor(storeId);
    // 🌟 店铺模板自定义（致谢词/宣传标语/公众号名称）：非阻塞式预取该门店云端最新保存值，
    // 确保当日餐报文本/公示海报生成时优先使用云端模板，而不是本地缓存或硬编码默认值
    this.loadStoreTemplateFromCloud(storeId);
    // 🔗 跑马灯通知云端化等首屏动态数据：必须等 initCurrentUserRole 解析出真实
    // tenantId/currentStoreId 之后才能按"当前视角"发起严格互斥查询，不能像旧的
    // 本机 loadAnnouncement 那样在角色未解析前就跑。统一收进 loadHomeDynamicData()
    // 触发（见 data.hasInitedData 注释），并标记 hasInitedData，供 onShow 判断
    // 是否需要再触发一轮刷新
    this.loadHomeDynamicData();
    this.setData({ hasInitedData: true });
    // 🏛️ 护持家长/日常店长姓名：海报落款用，非阻塞式预取，生成海报时大概率已就绪
    this.fetchStorePeopleNames();

    // 🌸 每日修身卡片：纯静态文化内容，不查云端，按自然日期确定性选取，
    // 同一天内多次进入首页展示同一条，跨天自动切换
    this.setData({ cultureQuote: getDailyCultureQuote() });

    const hasDraft = await this.loadDraft();
    if (hasDraft) {
      wx.showToast({ 
        title: '已为您自动恢复上次未提交的草稿 ✍️', 
        icon: 'none',
        duration: 3000 
      });
    }
  },

  async initCurrentUserRole() {
    const computeRoleState = (roleStr: string, status?: string) => {
      const rawRole = (roleStr || 'VOLUNTEER').toUpperCase();
      const isVolunteer = rawRole === 'VOLUNTEER';
      // 🏛️ 权限向下继承：大家长（store_patriarch/PATRIARCH）天然拥有店长 + 财务的全套
      // 日常管理权限（录入餐报/发布食谱/编写日志/管理工时等），无需再兼任多重角色
      // 🛡️ 全局排查修复：这里的输入既可能是服务端下发的 snake_case 值大写后的
      // 'STORE_PATRIARCH'，也可能是 store-picker 角色胶囊直接传来的裸值 'PATRIARCH'
      // （二者拼写不同，只对其中一种做判断会导致另一种静默漏判），两种拼法都要覆盖
      const isManager = ['MANAGER', 'STORE_MANAGER', 'PATRIARCH', 'STORE_PATRIARCH', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
      const isFinance = ['FINANCE', 'PATRIARCH', 'STORE_PATRIARCH', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
      const isSuperAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(rawRole);
      const roleMap: Record<string, string> = {
        'VOLUNTEER': 'volunteer',
        'MANAGER': 'store_manager',
        'STORE_MANAGER': 'store_manager',
        'PATRIARCH': 'store_patriarch',
        'STORE_PATRIARCH': 'store_patriarch',
        'FINANCE': 'finance',
        'ADMIN': 'super_admin',
        'SUPER_ADMIN': 'super_admin',
        'FAMILY': 'store_family',
        'STORE_FAMILY': 'store_family'
      };
      const normalizedRole = roleMap[rawRole] || 'volunteer';
      const flags = getPermissionFlags({ role: normalizedRole });

      // 🌟 视角切换预览：真实角色是 super_admin 且已选择非全景视角时，展示层降级模拟
      // 店长/财务视角；isRealSuperAdmin 保留真实值，供切换入口自身显隐判断
      const isRealSuperAdmin = isSuperAdmin;
      const overridden = applyRoleViewOverride(normalizedRole, {
        currentUserRole: normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin
      });

      // ❤️ 家人（服务对象）：normalizedRole 显式为 store_family 时直接判定；新用户/
      // 未审核通过的默认 volunteer 账号也按家人视角展示——与 profile.ts isFamily
      // 判定口径一致，避免未审核用户在首页看到打卡/计算工具等管理类模块。
      // 用未经 applyRoleViewOverride 覆盖的原始 isVolunteer，不受超管预览视角影响
      // （预览视角只在 SUPER_ADMIN/STORE_MANAGER/FINANCE 之间切换，不涉及家人）
      const isFamily = normalizedRole === 'store_family' || (isVolunteer && status !== 'approved');
      // 🏛️ 大家长：不受 applyRoleViewOverride 预览覆盖影响（预览仅针对 super_admin 本人），
      // 直接取规范化角色判定，供「解封/反封账」等大家长专属操作的权限校验使用
      const isPatriarch = normalizedRole === 'store_patriarch';

      return {
        rawRole, normalizedRole, flags,
        // 🛡️ isVolunteer/isFamily 互斥：与 profile.ts 同一口径——未审核默认账号
        // 两者按原始规则都会算出 true，这里显式排除，避免首页 wx:if/wx:elif
        // 角色分流链（!isFamily / isVolunteer / isFamily）同时命中两个分支
        isVolunteer: overridden.isVolunteer && !isFamily,
        isManager: overridden.isManager,
        isFinance: overridden.isFinance,
        isSuperAdmin: overridden.isSuperAdmin,
        isPatriarch,
        displayRole: overridden.currentUserRole,
        isRealSuperAdmin,
        isFamily
      };
    };

    const syncStorePicker = (storeId: string, storeName: string, rawRole: string) => {
      wx.nextTick(() => {
        const picker = this.selectComponent('#storePicker');
        if (picker && (picker as any).updateCurrentStore) {
          (picker as any).updateCurrentStore({ storeId, storeName, role: rawRole });
        }
      });
    };

    const cached = AuthService.getCachedRoleInfo();
    if (cached) {
      const { rawRole, isVolunteer, isManager, isFinance, isSuperAdmin, isPatriarch, flags, displayRole, isRealSuperAdmin, isFamily } = computeRoleState(cached.role, cached.status);
      const storeName = cached.storeName || this.data.shopName;
      const storeId = cached.storeId || '';

      this.setData({
        currentUserRole: displayRole,
        currentRole: rawRole,
        permissions: flags,
        isVolunteer: isVolunteer,
        isManager: isManager,
        isFinance: isFinance,
        isSuperAdmin: isSuperAdmin,
        isPatriarch: isPatriarch,
        isRealSuperAdmin: isRealSuperAdmin,
        isFamily: isFamily,
        currentViewMode: getPreviewViewMode(),
        currentStoreName: storeName,
        currentStoreId: storeId
      });
      this.checkComplianceNotice();

      syncStorePicker(storeId, storeName, rawRole);

      if (flags.canAuditUser && cached.storeId) {
        this.fetchPendingAuditCount(cached.storeId);
      }
      if (flags.canSwitchStore) {
        this.fetchAllStoresList();
      }
    }

    const result = await AuthService.fetchUserRole();
    if (result.success && result.roleInfo) {
      const info = result.roleInfo;
      const { rawRole, isVolunteer, isManager, isFinance, isSuperAdmin, isPatriarch, flags, displayRole, isRealSuperAdmin, isFamily } = computeRoleState(info.role, info.status);
      const storeName = info.storeName || this.data.shopName;
      const storeId = info.storeId || '';

      this.setData({
        currentUserRole: displayRole,
        currentRole: rawRole,
        permissions: flags,
        isVolunteer: isVolunteer,
        isManager: isManager,
        isFinance: isFinance,
        isSuperAdmin: isSuperAdmin,
        isPatriarch: isPatriarch,
        isRealSuperAdmin: isRealSuperAdmin,
        isFamily: isFamily,
        currentViewMode: getPreviewViewMode(),
        currentStoreName: storeName,
        currentStoreId: storeId
      });
      this.checkComplianceNotice();

      syncStorePicker(storeId, storeName, rawRole);

      if (flags.canAuditUser && info.storeId) {
        this.fetchPendingAuditCount(info.storeId);
      }
      if (flags.canSwitchStore) {
        this.fetchAllStoresList();
      }
    }

    const storeId = this.data.currentStoreId || '';
    const reportDate = this.data.reportDateRaw || '';
    if (storeId && reportDate && this.data.permissions && this.data.permissions.canEditBalance) {
      this.checkAndAcquireLock(storeId, reportDate);
    }

    this.refreshStoreStatus(storeId);
  },

  // 🏪 门店运营状态：先用缓存秒显（避免首页顶部徽标短暂空白/闪烁），再静默刷新
  // 最新值，失败不打扰用户（见 utils/storeManager.ts fetchAndSyncStoreStatus）
  refreshStoreStatus(storeId: string) {
    const cached = getCachedStoreStatus();
    if (cached) {
      this.setData({ currentStoreStatus: cached });
    }
    if (!storeId) return;
    fetchAndSyncStoreStatus(storeId).then((label) => {
      if (label) {
        this.setData({ currentStoreStatus: label });
      }
    });
  },

  async fetchPendingAuditCount(storeId: string) {
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const db = wx.cloud.database();
      const res = await db.collection('user_roles')
        .where({ storeId: storeId, status: 'pending' })
        .count();
      this.setData({ pendingAuditCount: res.total || 0 });
    } catch (e) {
      console.error('[fetchPendingAuditCount] 查询失败:', e);
    }
  },

  async fetchAllStoresList() {
    try {
      // 优先读取本地缓存（有效期5分钟）
      const cached = wx.getStorageSync('all_stores_list_cache');
      const cacheTime = wx.getStorageSync('all_stores_list_cache_time');
      if (cached && cacheTime && (Date.now() - cacheTime) < 300000) {
        this.setData({ allStoresList: JSON.parse(cached) });
        return;
      }

      // 🏢 多租户边界：门店列表通过云函数按调用者所属机构过滤后返回，
      // 不再由前端直接全表查询 stores 集合（避免跨机构看到彼此的门店名单）
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const cloudRes = await wx.cloud.callFunction({ name: 'getStoreList' });
      const cloudResult = cloudRes.result as any;
      const list = (cloudResult && cloudResult.success) ? (cloudResult.list || []) : [];
      this.setData({ allStoresList: list });

      // 缓存到本地
      wx.setStorageSync('all_stores_list_cache', JSON.stringify(list));
      wx.setStorageSync('all_stores_list_cache_time', Date.now());
    } catch (e) {
      console.error('[fetchAllStoresList] 查询失败:', e);
    }
  },

  async fetchStoreSponsor(storeId: string) {
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'getStoreSponsor',
        data: { storeId }
      });
      const result = res.result as any;
      if (result && result.success && result.data) {
        this.setData({ currentSponsorInfo: result.data });
      } else {
        this.setData({ currentSponsorInfo: null });
      }
    } catch (e) {
      console.error('[fetchStoreSponsor] 查询失败:', e);
      this.setData({ currentSponsorInfo: null });
    }
  },

  // 🍽️ 首页/工作台"今日菜单"预览卡：全国总览无具体门店时不展示
  async fetchTodayMenu() {
    const storeId = this.data.currentStoreId;
    if (!storeId || storeId === 'national_overview' || storeId === 'ALL_STORES') {
      this.setData({ todayMenu: null, todayMenuLoaded: true });
      return;
    }

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'manageDailyMenu',
        data: { action: 'getByDate', storeId, dateString: todayStr }
      });
      const result = res.result as any;
      const todayMenu = (result && result.success) ? result.data : null;
      this.setData({
        todayMenu,
        todayMenuDishes: splitMenuTextToDishes(todayMenu ? todayMenu.menuText : ''),
        todayMenuLoaded: true
      });
    } catch (e) {
      console.error('[fetchTodayMenu] 查询失败:', e);
      this.setData({ todayMenu: null, todayMenuDishes: [], todayMenuLoaded: true });
    }
  },

  // 📌 首页/工作台"今日大事记"预览卡：全国总览无具体门店时不展示。取当天最新一条（同日多条时只做预览摘要）
  // 🔗 门店日志联动：同一条记录也用来回填「今日大事记」的可编辑输入区默认值
  // （见下方 activityText/activityImages 回填），并记下 todayActivitySourceId
  // 供提交报表时精准 update 同一条，不重复新建。
  async fetchTodayActivity() {
    const storeId = this.data.currentStoreId;
    if (!storeId || storeId === 'national_overview' || storeId === 'ALL_STORES') {
      this.setData({ todayActivity: null, todayActivityLoaded: true, todayActivitySourceId: '' });
      return;
    }

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'manageActivityLog',
        data: { action: 'list', storeId, startDate: todayStr, endDate: todayStr, page: 1, pageSize: 1 }
      });
      const result = res.result as any;
      const existing = (result && result.success && result.data && result.data.length > 0) ? result.data[0] : null;
      this.setData({
        todayActivity: existing,
        todayActivityLoaded: true,
        todayActivitySourceId: (existing && existing._id) || ''
      });

      // 🌟 仅当用户还没开始编辑（两个字段都还是空的）才回填，避免每次页面 onShow
      // 重新拉取时覆盖掉用户正在编辑/已清空的内容——草稿箱本来就不持久化这两个
      // 字段，所以这个判断就是唯一的保护
      if (existing && !this.data.activityText && this.data.activityImages.length === 0) {
        // 🛡️ activityImages 现在是纯字符串数组，但数据库里已发布记录的 images 字段
        // 仍是 {url,thumbUrl} 对象（daily-menu/activity-log 页读它时还要用），回填时
        // 取 img.url 摘成字符串；顺带兼容极少数已经是字符串的历史脏数据（img.url || img）
        const rawImages = Array.isArray(existing.images) ? existing.images : [];
        this.setData({
          activityText: existing.content || '',
          activityImages: rawImages.map((img: any) => (img && img.url) || img).filter((u: any) => u && typeof u === 'string')
        });
      }
    } catch (e) {
      console.error('[fetchTodayActivity] 查询失败:', e);
      this.setData({ todayActivity: null, todayActivityLoaded: true, todayActivitySourceId: '' });
    }
  },

  // 🌟 大米/食用油库存状态单轨制改造：此前 stapleRiceStatus/stapleOilStatus 是
  // 店长在"填写今日明细"表单里手动勾选的"充足/一般/告急"，与"🌾 登记物资消耗与
  // 报损"弹窗提交的实际斤数是两条完全独立、经常互相矛盾的数据轨道（店长选了
  // "充足"，义工却刚提交了一条大米只剩几斤的消耗记录）。现在改为单一数据源：
  // 每次进页直接读取 manageVolunteerSubmission statsSummary 返回的最近一次物资
  // 消耗提交里录入的库存状态，this.data.stapleRiceStatus/stapleOilStatus 不再
  // 允许手动修改，其余下游（今日餐况卡片、报告文案、海报）无需改动，照常读取
  // 这两个字段即可自动跟着变
  async fetchLatestMaterialStatus() {
    const storeId = this.data.currentStoreId;
    if (!storeId || this.isNationalOverviewSelected()) return;

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'manageVolunteerSubmission',
        data: { action: 'statsSummary', storeId }
      });
      const result = res.result as any;
      if (result && result.success && result.data) {
        this.setData({
          stapleRiceStatus: result.data.latestRiceStatus || 'normal',
          stapleOilStatus: result.data.latestOilStatus || 'sufficient'
        });
      }
    } catch (e) {
      console.warn('[fetchLatestMaterialStatus] 查询最新物资库存状态失败，保留上次已知状态:', e);
    }
  },

  onGotoDailyMenu() {
    wx.navigateTo({ url: '/pages/daily-menu/daily-menu' });
  },

  onGotoActivityLog() {
    wx.navigateTo({ url: '/pages/activity-log/activity-log' });
  },

  onGotoStoreManagement() {
    wx.navigateTo({ url: '/pages/store-management/store-management' });
  },

  // ================= 🍽️ 首页快捷发布：今日菜单 =================

  // 🐛 修复"明明已选定具体门店却误触发 Toast"：this.data.currentStoreId 在角色初始化的
  // 缓存回填路径中（onLoad 里 cached.storeId || ''）可能滞后为空，而 currentStoreName 早已
  // 显示为具体门店名（如"海沧区雨花斋"，来自 shopName 的默认值），导致用户看着明明选了店却被拦。
  // 这里在页面 state 为空/national 时，再回退读取全局持久化的门店选择作为兜底，尽量还原真实选择。
  resolveEffectiveStoreId(): string {
    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];
    const stateId = this.data.currentStoreId;
    if (stateId && !NATIONAL_IDS.includes(stateId)) {
      return stateId;
    }

    const stored = wx.getStorageSync('current_store_id') || wx.getStorageSync('active_store_id') || '';
    if (stored && !NATIONAL_IDS.includes(stored)) {
      // 🔧 回填页面 state，避免后续图片上传路径/提交表单等仍引用滞后的空 currentStoreId
      this.setData({ currentStoreId: stored });
      return stored;
    }

    try {
      const selected = getSelectedStore();
      if (selected && selected.storeId && !NATIONAL_IDS.includes(selected.storeId)) {
        this.setData({
          currentStoreId: selected.storeId,
          currentStoreName: selected.storeName || this.data.currentStoreName
        });
        return selected.storeId;
      }
    } catch (e) {
      /* ignore */
    }

    return stateId || '';
  },

  // 当前是否处于"全部门店/全国总览"汇总视角（真正需要弹出门店选择器的场景）
  isNationalOverviewSelected(): boolean {
    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];
    const storeId = this.resolveEffectiveStoreId();
    return !storeId || NATIONAL_IDS.includes(storeId);
  },

  // 快捷发布类按钮共用的门店校验：已选定具体门店直接放行；处于全部门店/全国总览时自动拉起门店选择器。
  // resumeAction 可选：门店选定后（onStoreChanged 触发）自动续跑一次原本被拦截的操作，无需用户再点一次。
  ensureSpecificStoreSelected(resumeAction?: () => void): boolean {
    if (!this.isNationalOverviewSelected()) return true;

    wx.showToast({ title: '请先选择具体门店', icon: 'none' });
    if (resumeAction) {
      this._pendingStoreSelectAction = resumeAction;
    }
    const picker = this.selectComponent('#storePicker');
    if (picker && typeof picker.onOpenSheet === 'function') {
      picker.onOpenSheet();
    }
    return false;
  },

  _isAdminRole(): boolean {
    const role = this.data.currentUserRole || 'volunteer';
    return role === 'super_admin' || role === 'store_manager';
  },

  _lockKey(storeId: string, dateStr: string): string {
    return `${storeId}_${dateStr}`;
  },

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  _startHeartbeat(storeId: string, dateStr: string) {
    this._stopHeartbeat();
    this._lockActiveKey = this._lockKey(storeId, dateStr);
    this._heartbeatRetryCount = 0;
    this._heartbeatTimer = setInterval(() => {
      if (this._lockActiveKey !== this._lockKey(storeId, dateStr)) {
        this._stopHeartbeat();
        return;
      }
      this._doRenew(storeId, dateStr);
    }, 5 * 60 * 1000);
  },

  _doRenew(storeId: string, dateStr: string) {
    if (!isCloudAvailable()) return;
    wx.cloud.callFunction({
      name: 'manageDraftLock',
      data: {
        action: 'RENEW',
        storeId: storeId,
        reportDate: dateStr
      }
    }).then((res: any) => {
      if (res.result && res.result.success) {
        this._heartbeatRetryCount = 0;
        const remain = Math.floor((res.result.remainingMs || 0) / 1000);
        this.setData({
          lockRemainingSec: remain,
          lockRemainingFormatted: this._formatRemainTime(remain)
        });
      } else if (res.result && res.result.errMsg === '锁不存在') {
        // 锁被意外删除，重新获取
        this.checkAndAcquireLock(storeId, dateStr);
      }
    }).catch(() => {
      // 续期失败时重试（最多3次）
      this._heartbeatRetryCount++;
      if (this._heartbeatRetryCount <= 3) {
        setTimeout(() => this._doRenew(storeId, dateStr), 5000 * this._heartbeatRetryCount);
      }
    });
  },

  _stopLockPolling() {
    if (this._lockPollingTimer) {
      clearInterval(this._lockPollingTimer);
      this._lockPollingTimer = null;
    }
  },

  _startLockPolling(storeId: string, dateStr: string) {
    this._stopLockPolling();
    this._lockPollingTimer = setInterval(() => {
      if (!isCloudAvailable()) return;
      wx.cloud.callFunction({
        name: 'manageDraftLock',
        data: {
          action: 'QUERY',
          storeId: storeId,
          reportDate: dateStr
        }
      }).then((res: any) => {
        const r = res.result;
        if (r && !r.isLocked) {
          this._stopLockPolling();
          this.checkAndAcquireLock(storeId, dateStr);
        } else if (r && r.remainingMs) {
          const remain = Math.floor(r.remainingMs / 1000);
          this.setData({
            lockRemainingSec: remain,
            lockRemainingFormatted: this._formatRemainTime(remain)
          });
        }
      }).catch(() => {});
    }, 3000);
  },

  async checkAndAcquireLock(storeId: string, dateStr: string) {
    this._stopLockPolling();

    if (!storeId || !dateStr) {
      this.setData({ isReadOnlyByLock: false, lockOwnerName: '', lockRemainingSec: 0 });
      return;
    }

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'manageDraftLock',
        data: {
          action: 'ACQUIRE',
          storeId: storeId,
          reportDate: dateStr
        }
      });

      const result = res.result as any;
      if (result && !result.success && result.isLocked) {
        this._stopHeartbeat();
        const remainSec = Math.floor((result.remainingMs || 0) / 1000);
        this.setData({
          isReadOnlyByLock: true,
          lockOwnerName: result.lockedBy || '其他义工',
          lockRemainingSec: remainSec,
          lockRemainingFormatted: this._formatRemainTime(remainSec)
        });
        this._startLockPolling(storeId, dateStr);
      } else {
        this.setData({
          isReadOnlyByLock: false,
          lockOwnerName: '',
          lockRemainingSec: 0,
          lockRemainingFormatted: ''
        });
        this._startHeartbeat(storeId, dateStr);
      }
    } catch (e) {
      console.error('[checkAndAcquireLock] 加锁失败:', e);
      this.setData({ isReadOnlyByLock: false, lockOwnerName: '', lockRemainingSec: 0, lockRemainingFormatted: '' });
    }
  },

  // 🛡️ 内存泄漏修复：此前 _stopHeartbeat()/_stopLockPolling() 排在 storeId/reportDate
  // 判空 return 之后——一旦页面在这两个字段尚未就绪时（如角色/门店信息还在异步加载、
  // 或处于"全国总览"视角 storeId 为空）触发 onUnload/onHide，函数会直接提前返回，
  // 心跳续期（5 分钟一次）与锁轮询（3 秒一次）这两个 setInterval 定时器完全不会被清除，
  // 会绑定着已卸载页面的旧 this 引用持续在后台运行、无限期发起 wx.cloud.callFunction
  // 请求——这正是控制台报"内存泄漏"（残留定时器持续持有闭包引用）的根因。现在把两个
  // 定时器清理提到判空 return 之前，保证无论 storeId/reportDate 是否就绪，页面卸载/
  // 隐藏时定时器一定会被清除；storeId/reportDate 判空只用来决定要不要再打一次
  // RELEASE 云函数请求（没有门店/日期上下文也就没有锁可释放）
  releaseDraftLock() {
    this._stopHeartbeat();
    this._stopLockPolling();
    this._lockActiveKey = '';

    const storeId = this.data.currentStoreId || '';
    const reportDate = this.data.reportDateRaw || '';
    if (!storeId || !reportDate) return;

    if (!isCloudAvailable()) return;
    wx.cloud.callFunction({
      name: 'manageDraftLock',
      data: {
        action: 'RELEASE',
        storeId: storeId,
        reportDate: reportDate
      }
    }).catch(() => {});
  },

  onForceUnlock() {
    const storeId = this.data.currentStoreId || '';
    const reportDate = this.data.reportDateRaw || '';
    if (!this._isAdminRole()) {
      wx.showToast({ title: '仅管理员可强制解锁', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '强制解锁',
      content: `确定要强制释放【${this.data.lockOwnerName}】持有的编辑锁吗？`,
      confirmText: '强制解锁',
      confirmColor: '#E03131',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const result = await wx.cloud.callFunction({
            name: 'manageDraftLock',
            data: {
              action: 'FORCE_RELEASE',
              storeId: storeId,
              reportDate: reportDate
            }
          });
          if (result.result && result.result.success) {
            wx.showToast({ title: '已强制解锁', icon: 'success' });
            this.checkAndAcquireLock(storeId, reportDate);
          } else {
            wx.showToast({ title: '解锁失败', icon: 'none' });
          }
        } catch (e) {
          wx.showToast({ title: '解锁失败', icon: 'none' });
        }
      }
    });
  },

  _formatRemainTime(sec: number): string {
    if (sec <= 0) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  },

  // 门店列表变更（如超管刚新建了一家门店）：清缓存后重新拉取，确保列表包含新店
  onStoreListChanged() {
    wx.removeStorageSync('all_stores_list_cache');
    wx.removeStorageSync('all_stores_list_cache_time');
    this.fetchAllStoresList();
  },

  onStoreChanged(e: any) {
    const detail = e.detail || {};
    const rawRole = (detail.role || detail.currentRole || wx.getStorageSync('active_role') || 'VOLUNTEER').toUpperCase();
    const storeName = detail.storeName || detail.name || this.data.currentStoreName || '海沧区雨花斋';
    const storeId = detail.storeId || detail.id || this.data.currentStoreId || '';

    // 防循环：门店和角色均未改变则直接中断
    if (
      this.data.currentStoreId === storeId &&
      this.data.currentRole === rawRole
    ) {
      return;
    }

    const isVolunteer = rawRole === 'VOLUNTEER';
    // 🏛️ 权限向下继承：大家长（store_patriarch/PATRIARCH）天然拥有店长 + 财务的全套
    // 日常管理权限（录入餐报/发布食谱/编写日志/管理工时等），无需再兼任多重角色
    // 🛡️ 全局排查修复：store-picker 角色胶囊点击直接传来的是裸值 'PATRIARCH'（无下划线），
    // 不是 'STORE_PATRIARCH'——此前这里只认后者，导致点击【家长】胶囊时 isManager/
    // isFinance 当场判定为 false，且下面 roleMap 查不到键，静默降级写入 'volunteer'。
    // 两种拼法（裸值 / 服务端 snake_case 转大写）都必须覆盖，防止任一调用路径漏判
    const isManager = ['MANAGER', 'STORE_MANAGER', 'PATRIARCH', 'STORE_PATRIARCH', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    const isFinance = ['FINANCE', 'PATRIARCH', 'STORE_PATRIARCH', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    const isSuperAdmin = rawRole === 'ADMIN' || rawRole === 'SUPER_ADMIN';

    const roleMap: Record<string, string> = {
      'VOLUNTEER': 'volunteer',
      'MANAGER': 'store_manager',
      'STORE_MANAGER': 'store_manager',
      'PATRIARCH': 'store_patriarch',
      'STORE_PATRIARCH': 'store_patriarch',
      'FINANCE': 'finance',
      'ADMIN': 'super_admin',
      'SUPER_ADMIN': 'super_admin',
      // ❤️ 家人（服务对象）：store-picker 里与义工并列的自我声明式身份，必须显式映射，
      // 否则会落进下面的 || 'volunteer' 兜底，被悄悄降级回普通义工
      'FAMILY': 'store_family',
      'STORE_FAMILY': 'store_family'
    };
    const normalizedRole = roleMap[rawRole] || 'volunteer';
    const flags = getPermissionFlags({ role: normalizedRole });
    // ❤️ 家人：store-picker 角色胶囊点击直传的裸值 'FAMILY'，normalizedRole 已映射为
    // store_family——这里是用户主动切换身份的场景，不需要 initCurrentUserRole 里
    // "未审核默认按家人展示"那条兜底规则
    const isFamily = normalizedRole === 'store_family';
    const isPatriarch = normalizedRole === 'store_patriarch';

    // 🌟 切店全局持久化：同步 storeId / storeName / role 到本地存储。
    // 🛡️ 这里必须持久化真实的 normalizedRole，绝不能写入视角切换预览后的展示角色，
    // 否则下次启动会把"店长视角预览"误当成真实身份，永久丢失超管权限。
    wx.setStorageSync('current_store_id', storeId);
    wx.setStorageSync('current_store_name', storeName);
    wx.setStorageSync('current_user_role', normalizedRole);
    wx.setStorageSync('active_store_id', storeId);
    wx.setStorageSync('active_role', normalizedRole);

    const isAllStoresView = storeId === 'national_overview' || storeId === 'ALL_STORES';
    const isRealSuperAdmin = isSuperAdmin;
    const overridden = applyRoleViewOverride(normalizedRole, {
      currentUserRole: normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin
    });

    this.setData({
      currentStoreId: storeId,
      currentStoreName: storeName,
      // 🔑 关键修复：同步更新 shopName 字段，确保 loadBalanceForDate 等函数使用新门店名
      shopName: storeName,
      currentRole: rawRole,
      currentUserRole: overridden.currentUserRole,
      isRealSuperAdmin: isRealSuperAdmin,
      currentViewMode: getPreviewViewMode(),
      isAllStoresView: isAllStoresView,
      isVolunteer: overridden.isVolunteer,
      isManager: overridden.isManager,
      isFinance: overridden.isFinance,
      isSuperAdmin: overridden.isSuperAdmin,
      isPatriarch: isPatriarch,
      isFamily: isFamily,
      permissions: flags
    }, () => {

      // 🏪 门店选择器引导闭环：若此前有操作因"未选定具体门店"被拦截（如点击【发布今日食谱】），
      // 且刚选定的确实是具体门店（非全部门店/全国总览），自动续跑一次原操作，无需用户再点一次
      if (this._pendingStoreSelectAction && !this.isNationalOverviewSelected()) {
        const resumeAction = this._pendingStoreSelectAction;
        this._pendingStoreSelectAction = null;
        setTimeout(() => resumeAction(), 200);
      }
    });

    wx.showToast({
      title: `已切至 ${storeName} (${rawRole === 'FAMILY' ? '家人视角' : (isVolunteer ? '义工视角' : (isFinance ? '财务视角' : '店长视角'))})`,
      icon: 'none'
    });

    this.fetchStoreSponsor(storeId);
    this.fetchTodayMenu();
    this.fetchTodayActivity();
    this.fetchNotices();
    // 🌟 切店后同步刷新该门店云端保存的模板自定义内容，避免沿用切店前门店的致谢词/标语
    this.loadStoreTemplateFromCloud(storeId);

    // 🏪 切店后同步刷新门店运营状态徽标；"全国总览"等虚拟门店 ID 不对应真实门店记录，跳过
    if (!isAllStoresView) {
      this.refreshStoreStatus(storeId);
    } else {
      this.setData({ currentStoreStatus: '' });
    }

    // 🌟 切店后立即重新加载新门店的看板数据与义工统计
    this.loadBalanceForDate(this.data.reportDate || this.data.reportDateValue || '');
    if (typeof (this as any).loadVolunteerStats === 'function') {
      (this as any).loadVolunteerStats();
    }

    // 安全调用数据加载函数，防止 TypeError 崩溃
    const self = this as any;
    if (typeof self.loadPageDataByRole === 'function') {
      self.loadPageDataByRole();
    } else if (typeof self.loadBalanceForDate === 'function') {
      self.loadBalanceForDate(this.data.reportDate || this.data.reportDateValue || '');
    } else if (typeof self.loadPageData === 'function') {
      self.loadPageData();
    } else {
    }
  },

  switchStoreTarget(storeId: string, storeName: string) {
    this.setData({
      currentStoreId: storeId,
      currentStoreName: storeName,
      // 🔑 与 onStoreChanged 对齐：shopName 是餐报提交/余额查询实际读取的字段，
      // 必须跟随 currentStoreName 同步，否则会继续沿用切店前的门店名
      shopName: storeName
    });

    setSelectedStore({ storeId, storeName });

    if (typeof this.autoFetchPreviousBalance === 'function') {
      this.autoFetchPreviousBalance(this.data.reportDateRaw);
    }

    this.fetchStoreSponsor(storeId);
    // 🐛 门店切换后公告栏/今日食谱/大事记不刷新的根因修复（另一处）：这个入口此前
    // 只刷新了赞助商信息，没有一并刷新这三项同样按当前门店严格互斥查询的数据——
    // 与 onStoreChanged 里那组刷新调用对齐，确保这条切店路径也不会遗留上一个门店的
    // 公告/食谱/大事记内容
    this.fetchTodayMenu();
    this.fetchTodayActivity();
    this.fetchNotices();
    // 🌟 同步刷新该门店云端保存的模板自定义内容（致谢词/宣传标语/公众号名称）
    this.loadStoreTemplateFromCloud(storeId);

    wx.showToast({
      title: `当前门店：${storeName}`,
      icon: 'success'
    });
  },

  onNavigateToHelp() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    const role = this.data.currentUserRole || 'volunteer';
    let targetTab = 'volunteer';
    if (role === 'store_manager' || role === 'super_admin') {
      targetTab = 'manager';
    } else if (role === 'finance') {
      targetTab = 'finance';
    }
    wx.navigateTo({
      url: `/pages/help/help?tab=${targetTab}`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🌟 视角切换预览提示条的快捷入口：跳转个人中心切回超级管理员全景
  onNavigateToProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },

  // 左侧功能导航抽屉：打开
  onOpenSideDrawer() {
    const drawer = this.selectComponent('#sideDrawer');
    if (drawer && drawer.open) {
      drawer.open();
    }
  },

  // 左侧功能导航抽屉：点击项分发到已有的对应方法，抽屉组件本身不持有业务逻辑
  onSideDrawerAction(e: any) {
    const type = e.detail && e.detail.type;
    switch (type) {
      case 'record':
        wx.pageScrollTo({ scrollTop: 0, duration: 300 });
        break;
      case 'template':
        this._openExpenseTemplateModal('daily');
        break;
      case 'audit':
        this.onOpenAuditModal();
        break;
      case 'statistics':
        this.goToStatistics();
        break;
      case 'storeManagement':
        this.onGotoStoreManagement();
        break;
      default:
        break;
    }
  },

  // 🛡️ 义工绑定审核弹窗的空状态入口专用：全国总览视角下，海报若仍按 storeId='all' 生成，
  // 招募到的义工无法归属到具体门店，与"审核该门店义工绑定"的场景语义冲突，故此入口
  // 要求先切到具体门店。首页其余入口（qa-promo-item 通用邀请海报）保留原有全国海报能力，不受影响。
  onGenerateStorePosterFromAudit() {
    if (this.isNationalOverviewSelected()) {
      wx.showToast({ title: '请先选择具体的门店，再生成该门店的专属海报', icon: 'none', duration: 2500 });
      return;
    }
    this.onGenerateStorePoster();
  },

  // 🌟 工作台宫格第 4 格"门店推广与邀请"：合并原先并排的两个推广入口（海报/邀请码）为一个菜单
  onOpenPromoActionSheet() {
    wx.showActionSheet({
      itemList: ['🖼️ 生成门店邀请海报', '🔑 生成邀请码'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onGenerateStorePoster();
        } else if (res.tapIndex === 1) {
          this.onOpenGenCodeModal();
        }
      }
    });
  },

  // 🌟 财务视角的场景化邀请入口：复用同一套 generateInviteCode 弹窗（无需新建任何生成逻辑），
  // 但跳过"生成门店邀请海报"这个偏对外宣传的选项——直接打开邀请码弹窗。
  // 🛡️ 身份阶梯权限过滤：只有 super_admin 才允许生成"门店财务"邀请码——纯财务角色
  // 本身已被 onOpenGenCodeModal 的权限阶梯挡在门外（financer 不在
  // [super_admin, store_manager, store_patriarch] 名单内），能走到这里说明当前
  // 是店长/大家长/超管本人在用这个场景化入口；只有超管才把默认身份预填为 FINANCE，
  // 店长/大家长的可选身份里根本没有 FINANCE 这一档，不能无条件覆盖选中它
  onOpenFinanceInviteMenu() {
    this.onOpenGenCodeModal();
    if (this.data.isSuperAdmin) {
      this.setData({ genTargetRole: 'FINANCE' });
    }
  },

  async onGenerateStorePoster() {
    if (!this.data.permissions.canAuditUser) {
      wx.showToast({ title: '仅店长/管理员可生成', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在合成精美海报...', mask: true });

    try {
      // 🌐 全国总览视角：二维码扫码参数统一编码为规范化的 storeId=all（而非
      // 'national_overview'/'ALL_STORES' 等内部各处不一致的哨兵值），配合
      // fetchStoreInfoAndPromptApply 对 'all' 的专门识别逻辑；海报标题也改为
      // "全国雨花爱心团队邀请"，不再显示具体门店名
      const isNationalContext = this.isNationalOverviewSelected();
      const storeId = isNationalContext ? 'all' : (this.data.currentStoreId || 'store_haicang_001');
      const storeName = isNationalContext
        ? '全国雨花爱心团队邀请'
        : (this.data.currentStoreName || this.data.shopName || '海沧区雨花斋');

      let qrCodeLocalPath = '';
      try {
        if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
        const qrRes = await wx.cloud.callFunction({
          name: 'getStoreQRCode',
          data: { storeId, storeName }
        });
        const qrResult = qrRes.result as any;
        if (qrResult && qrResult.success && qrResult.fileID) {
          const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
          qrCodeLocalPath = downRes.tempFilePath;
        }
      } catch (qrErr) {
        console.warn('[onGenerateStorePoster] 二维码获取失败，使用占位:', qrErr);
      }

      this.setData({ showStorePosterModal: true, storePosterTempFilePath: '' });

      setTimeout(() => {
        const query = wx.createSelectorQuery();
        query.select('#storePosterCanvas')
          .fields({ node: true, size: true })
          .exec(async (res) => {
            if (!res[0] || !res[0].node) {
              wx.hideLoading();
              wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
              return;
            }
            const canvas = res[0].node;

            try {
              const sponsorInfo = this.data.currentSponsorInfo;
              await drawStoreInvitationPoster({
                canvas,
                storeName,
                sponsorInfo,
                qrCodeTempPath: qrCodeLocalPath,
                width: 320,
                height: 500
              });

              wx.canvasToTempFilePath({
                canvas,
                success: (tempRes) => {
                  this.setData({ storePosterTempFilePath: tempRes.tempFilePath });
                  wx.hideLoading();
                },
                fail: (err) => {
                  wx.hideLoading();
                  console.error('[onGenerateStorePoster] canvasToTempFilePath 失败:', err);
                  wx.showToast({ title: '海报生成失败', icon: 'none' });
                }
              });
            } catch (drawErr) {
              wx.hideLoading();
              console.error('[onGenerateStorePoster] 绘制失败:', drawErr);
              wx.showToast({ title: '海报绘制失败', icon: 'none' });
            }
          });
      }, 300);
    } catch (e) {
      wx.hideLoading();
      console.error('[onGenerateStorePoster] 异常:', e);
      wx.showToast({ title: '海报生成失败', icon: 'none' });
    }
  },

  onCloseStorePosterModal() {
    this.setData({ showStorePosterModal: false });
  },

  async loadLastBalance() {
    if (this.data.isEditMode) return;
    
    const result = await DataService.getLatestReport(this.data.shopName, this.data.mpAccount);
    
    if (result.success && result.data) {
      // 核心修复：优先取 todayBalance（今日结余），绝对不要取 yesterdayBalance！
      const balanceValue = result.data.todayBalance != null && result.data.todayBalance !== ''
        ? result.data.todayBalance
        : (result.data.adjustedBalance != null ? result.data.adjustedBalance : null);
      const balance = this.validateBalance(balanceValue);
      const systemBalanceNum = parseFloat(balanceValue) || 0;
      this.setData({
        prevBalance: balance,
        yesterdayBalance: balance,
        systemBalance: systemBalanceNum,
        isManualAdjust: false,
        balanceDiff: 0,
        adjustReason: '',
        yesterdayBalDisplay: systemBalanceNum.toFixed(2)
      });
      this.updateRealTimeBalance();
    } else {
      this.loadFromLocal();
    }
  },

  loadFromLocal() {
    const cachedBalance = wx.getStorageSync('yuhua_last_balance') || wx.getStorageSync('last_shop_balance');
    
    const balance = this.validateBalance(cachedBalance);
    const systemBalanceNum = parseFloat(cachedBalance) || 0;
    this.setData({
      prevBalance: balance,
      yesterdayBalance: balance,
      systemBalance: systemBalanceNum,
      isManualAdjust: false,
      balanceDiff: 0,
      adjustReason: '',
      yesterdayBalDisplay: systemBalanceNum.toFixed(2)
    });
    this.updateRealTimeBalance();
  },

  validateBalance(value: any): string {
    return formatMoney(value);
  },

  // 解析食材/支出文本框中的实际支出总额，自动过滤小票合计、总计、虚线等总结行，避免重复相加
  //
  // 🛡️ "锚点行"设计：一张有优惠/运费调整的小票，逐条商品原价加总（如 ¥69.79）天然会比
  // 实付金额（如 ¥57.30）偏高——如果不做处理，把商品明细行直接原样相加进「今日开餐支出」，
  // 就会把优惠前的原价当成真实支出，比店长实际付的钱还多。OCR 自动填单时（见 onOcrAutoFill
  // 等）会在每张小票的商品明细最后追加一行"实付合计：¥xx.xx"（数值来自云函数返回的、经过交叉
  // 核对的 actual_pay），本函数据此把"这一张小票"当成一个块：遇到锚点行前累加的商品行金额
  // 全部作废，改用锚点行的金额；没有锚点行的普通手动记账文本则完全不受影响，行为与之前一致。
  calculateTodayExpenseFromText(text: string): number {
    if (!text || !text.trim()) return 0;

    const ANCHOR_REGEX = /实付合计|实付金额|实付|在线支付/;
    const SKIP_REGEX = /小票合计|合计|总计|小计|加工费|优惠券|商品优惠|优惠|总金额/;

    const lines = text.split('\n');
    let total = 0;
    let blockSum = 0;
    let blockAnchored = false;

    const closeBlock = () => {
      total += blockSum;
      blockSum = 0;
      blockAnchored = false;
    };

    lines.forEach(line => {
      const trimmed = line.trim();

      if (!trimmed) {
        // 空行代表一张小票/一笔记录的分隔边界，当前块到此结束
        closeBlock();
        return;
      }

      if (ANCHOR_REGEX.test(trimmed)) {
        const match = trimmed.match(/[¥￥]\s*(\d+\.?\d*)|(\d+\.?\d*)\s*元/);
        if (match) {
          const amount = parseFloat(match[1] || match[2] || '0');
          if (!isNaN(amount)) {
            blockSum = amount; // 锚点值整体覆盖前面累加的商品行，而不是叠加
            blockAnchored = true;
          }
        }
        return;
      }

      // 🛡️ 核心防重守卫：跳过合计/汇总/费用类行，避免把"小票小计/加工费/优惠券"这类
      // 非菜品金额当成又一笔支出重复累加进去
      if (
        SKIP_REGEX.test(trimmed) ||
        trimmed.includes('----') ||
        trimmed.includes('====') ||
        trimmed.startsWith('----------------')
      ) {
        return;
      }

      // 锚点已经给出这张小票的权威实付金额，后面残留的商品行不再重复累加
      if (blockAnchored) return;

      // 匹配金额，优先提取 ¥ 或 元 后面的数字；每行只取第一个匹配，避免同一行内
      // 出现多个数字（如注释里的单价/数量说明）被误当成多笔独立支出重复累加
      const match = trimmed.match(/[¥￥]\s*(\d+\.?\d*)|(\d+\.?\d*)\s*元/);
      if (match) {
        const amount = parseFloat(match[1] || match[2] || '0');
        if (!isNaN(amount)) {
          blockSum += amount;
        }
      }
    });

    closeBlock();
    return parseFloat(total.toFixed(2));
  },

  // 🌟 大额专项支出：fixedExpenseItems -> fixedExpenseText 单向派生。fixedExpenseItems
  // 是本行的唯一编辑入口（逐条添加/改金额/删除/挂独立凭证），每次变动都调这个方法
  // 重新拼出 fixedExpenseText，格式与高频模板插入的格式一致（`名称：¥金额`），
  // 保证 calculateTodayExpenseFromText 能正确计入总额；下游（提交/草稿/历史/海报）
  // 继续只读 fixedExpenseText，不需要感知 fixedExpenseItems 的存在。
  regenerateFixedExpenseText() {
    const text = this.data.fixedExpenseItems
      .map(item => `${item.name}：¥${(parseFloat(item.amount) || 0).toFixed(2)}`)
      .join('\n');
    this.setData({ fixedExpenseText: text });
    this.updateRealTimeBalance();
    this.debouncedSaveDraft();
  },

  // 反向解析：仅用于从草稿/历史记录恢复出的旧 fixedExpenseText（用户手打或本功能上线前
  // 提交的记录）重建 fixedExpenseItems 列表用于展示；恢复出的条目天然没有独立凭证图片
  // （老数据本来就没有这个概念），这是预期行为，不是丢数据。
  parseFixedExpenseTextToItems(text: string): { _key: string; name: string; amount: string; independent_image_urls: string[]; expanded: boolean }[] {
    if (!text || !String(text).trim()) return [];

    return String(text)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map((line, idx) => {
        const match = line.match(/[¥￥]\s*(\d+\.?\d*)|(\d+\.?\d*)\s*元/);
        const amount = match ? parseFloat(match[1] || match[2] || '0') : 0;
        const name = match ? line.slice(0, line.indexOf(match[0])).replace(/[:：]\s*$/, '').trim() || line : line;
        return {
          _key: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
          name: name || `专项支出${idx + 1}`,
          amount: (amount || 0).toFixed(2),
          independent_image_urls: [] as string[],
          expanded: false
        };
      });
  },

  // 🌟 唯一权威的"今日财务"计算入口：yesterdayBalance / todayIncome / todayExpense / todayBalance
  // 全部由这一个函数统一算出，页面上任何展示这四个数字的地方（顶部算式校验、结果预览、
  // 海报预览的"今日实时总结余"等）都必须调用它，绝不允许各自维护一份相似但不同的计算逻辑——
  // 这正是此前"顶部算式校验 4027.83+0.00-61.71=3966.12"与"底部总结余 4027.83-77.69=3950.14"
  // 两套数字对不上的根因：updateRealTimeBalance 用 expenses+dailyExpenseText+fixedExpenseText
  // 三项相加，提交保存时用 dailyExpenseText+fixedExpenseText 两项，而海报生成 onGeneratePoster
  // 更是完全只读取从未在界面上暴露过输入框的旧字段 expenses、对 dailyExpenseText/fixedExpenseText
  // 视而不见——三处各算各的，自然三个数字互不相同。
  computeTodayFinancials(): { yesterdayBalance: number; todayIncome: number; todayExpense: number; todayBalance: number; formulaString: string } {
    const { yesterdayBalance, otherDonation, parseResult, dailyExpenseText, fixedExpenseText } = this.data;

    const yesterdayBalanceNum = parseFloat(yesterdayBalance) || 0;
    const otherDonationNum = parseFloat(otherDonation) || 0;
    const donationsTotal = (parseResult && parseResult.totalAmount) || 0;
    const todayIncome = round2(otherDonationNum + donationsTotal);

    const dailyExpenseNum = this.calculateTodayExpenseFromText(dailyExpenseText);
    const fixedExpenseNum = this.calculateTodayExpenseFromText(fixedExpenseText);
    const todayExpense = round2(dailyExpenseNum + fixedExpenseNum);

    const todayBalance = round2(yesterdayBalanceNum + todayIncome - todayExpense);

    // 🌟 算式校验文案也在这里统一生成，页面上任何展示"昨日结余+今日汇入-今日支出=今日结余"
    // 这行文字的地方都必须直接用这个 formulaString，禁止再各自用模板字符串手写一遍——
    // 数字口径统一了，如果拼接文案的地方各写各的，仍然可能因为四舍五入方式不同而对不上。
    const formulaString = `${yesterdayBalanceNum.toFixed(2)} + ${todayIncome.toFixed(2)} - ${todayExpense.toFixed(2)} = ${todayBalance.toFixed(2)}`;

    return { yesterdayBalance: yesterdayBalanceNum, todayIncome, todayExpense, todayBalance, formulaString };
  },

  // 🌟 OCR 确认弹窗里的"确认后预计结余"预览：弹窗里的小票金额此时还没合并进
  // dailyExpenseText/fixedExpenseText（要点击"自动填入"才会真正写入），所以不能直接读
  // computeTodayFinancials() 的结果——但计算口径必须完全复用它，只是在它算出的"已有支出"
  // 基础上，把这批还未确认的小票金额（ocrTotalAmount）加上去做一次假设性预览，
  // 绝不能自己另起一套 yesterdayBalance+todayIncome-todayExpense 的算式，
  // 否则又会变成本次要杜绝的"多处各算各的"问题。
  updateOcrConfirmPreview() {
    const { yesterdayBalance: yesterdayBalanceNum, todayIncome, todayExpense: existingExpense } = this.computeTodayFinancials();
    const pendingOcrTotal = parseFloat(this.data.ocrTotalAmount) || 0;
    const previewExpense = round2(existingExpense + pendingOcrTotal);
    const previewBalance = round2(yesterdayBalanceNum + todayIncome - previewExpense);
    const previewFormula = `${yesterdayBalanceNum.toFixed(2)} + ${todayIncome.toFixed(2)} - ${previewExpense.toFixed(2)} = ${previewBalance.toFixed(2)}`;

    this.setData({
      ocrPreviewExpense: previewExpense.toFixed(2),
      ocrPreviewBalance: previewBalance.toFixed(2),
      ocrPreviewFormula: previewFormula
    });
  },

  parseExpenseTextToItems(textStr: string, fallbackAmount: number, dateStr: string): any[] {
    if (!textStr || !String(textStr).trim()) {
      if (fallbackAmount > 0) {
        return [{ date: dateStr, title: '专项大额开支', amount: fallbackAmount.toFixed(2) }];
      }
      return [];
    }

    const rawLines = String(textStr)
      .split(/[\r\n;；,，、]+/)
      .map(s => s.trim())
      .filter(Boolean);

    let parsedResults: any[] = [];

    rawLines.forEach(line => {
      // 跳过合计/虚线等总结行，避免数据库明细重复
      if (/小票合计|合计|总计|----|====/.test(line)) return;

      const match = line.match(/^[\u4e00-\u9fa5a-zA-Z0-9\(\)\（\）\s]+?[\s:：等于=]*(\d+(?:\.\d+)?)\s*元?$/);

      if (match) {
        let titleName = match[1].replace(/[\d\s]/g, '').trim();
        let numVal = parseFloat(match[2]);

        if (titleName && !isNaN(numVal) && numVal > 0) {
          parsedResults.push({
            date: dateStr,
            title: titleName,
            amount: numVal.toFixed(2)
          });
        }
      } else {
        const innerRegex = /([\u4e00-\u9fa5a-zA-Z]+)[\s:：]*(\d+(?:\.\d+)?)/g;
        let innerMatch;
        let foundInner = false;
        while ((innerMatch = innerRegex.exec(line)) !== null) {
          let tName = innerMatch[1].trim();
          let nVal = parseFloat(innerMatch[2]);
          if (tName && !isNaN(nVal) && nVal > 0) {
            parsedResults.push({
              date: dateStr,
              title: tName,
              amount: nVal.toFixed(2)
            });
            foundInner = true;
          }
        }
        if (!foundInner && line.length > 0 && fallbackAmount > 0) {
          parsedResults.push({
            date: dateStr,
            title: line,
            amount: fallbackAmount.toFixed(2)
          });
        }
      }
    });

    if (parsedResults.length === 0 && fallbackAmount > 0) {
      parsedResults.push({
        date: dateStr,
        title: String(textStr).trim() || '专项大额开支',
        amount: fallbackAmount.toFixed(2)
      });
    }

    return parsedResults;
  },

  // 输入即解析：食材与杂购文本框下方的实时反馈条，复用 parseExpenseTextToItems
  // 的逐条解析逻辑，fallbackAmount 传 0 避免整段未匹配时被当成一条兜底记录，
  // 保证「已解析 X 项」如实反映能识别出金额的行数。
  updateDailyExpenseParsePreview(text: string) {
    const items = this.parseExpenseTextToItems(text, 0, '');
    const total = items.reduce((sum: number, item: any) => sum + (parseFloat(item.amount) || 0), 0);
    this.setData({
      dailyExpenseParseCount: items.length,
      dailyExpenseParseAmount: total.toFixed(2)
    });
  },

  saveDraft() {
    const { reportDate, reportDateValue, yesterdayBalance, allDonations, otherDonation, expenses, dailyExpenseText, fixedExpenseText, shopName, mpAccount, thankText, slogan1, slogan2, volunteerCount, volunteerHours, diningCount, materialsInput, dineInSeniors, deliverySeniors, dineInVolunteers, deliveryVolunteers, takeawayCount } = this.data;

    const draftData = {
      reportDate,
      reportDateValue,
      yesterdayBalance,
      allDonations,
      otherDonation,
      expenses,
      dailyExpenseText,
      fixedExpenseText,
      shopName,
      mpAccount,
      thankText,
      slogan1,
      slogan2,
      volunteerCount,
      volunteerHours,
      diningCount,
      // 🌟 stapleRiceStatus/stapleOilStatus 不再是草稿需要记住的"用户手动输入"，
      // 已改为 fetchLatestMaterialStatus() 每次进页自动读取最新物资消耗提交的
      // 库存状态——草稿箱不保存这两个字段，避免旧草稿里的过期值把刚拉取到的
      // 最新状态又覆盖回去
      materialsInput,
      dineInSeniors,
      deliverySeniors,
      dineInVolunteers,
      deliveryVolunteers,
      takeawayCount,
      saveTime: Date.now()
    };

    const draftKey = getDraftKeyForDate(reportDateValue, shopName);

    wx.setStorage({
      key: draftKey,
      data: draftData,
      success: () => {
      },
      fail: (err) => {
        console.error('[草稿箱] 草稿保存失败:', err);
      }
    });

    wx.setStorage({
      key: DRAFT_KEY,
      data: draftData,
      success: () => {},
      fail: () => {}
    });
  },

  async loadDraftByDate(dateStr: string, shopName: string): Promise<boolean> {
    try {
      const draftKey = getDraftKeyForDate(dateStr, shopName);
      const draftData = wx.getStorageSync(draftKey);
      if (!draftData) return false;

      const hasContent = draftData.allDonations || draftData.expenses || 
                        draftData.otherDonation || draftData.yesterdayBalance !== '0.00';
      
      if (!hasContent) return false;

      this.setData({
        reportDate: draftData.reportDate || this.data.reportDate,
        reportDateValue: draftData.reportDateValue || dateStr,
        allDonations: draftData.allDonations || '',
        otherDonation: draftData.otherDonation || '',
        expenses: draftData.expenses || '',
        dailyExpenseText: draftData.dailyExpenseText || '',
        fixedExpenseText: draftData.fixedExpenseText || '',
        shopName: draftData.shopName || shopName,
        mpAccount: draftData.mpAccount || this.data.mpAccount,
        thankText: draftData.thankText || this.data.thankText,
        slogan1: draftData.slogan1 || this.data.slogan1,
        slogan2: draftData.slogan2 || this.data.slogan2,
        volunteerCount: draftData.volunteerCount || '',
        volunteerHours: draftData.volunteerHours || '',
        diningCount: draftData.diningCount || '',
        materialsInput: draftData.materialsInput || '',
        dineInSeniors: draftData.dineInSeniors || '',
        deliverySeniors: draftData.deliverySeniors || '',
        dineInVolunteers: draftData.dineInVolunteers || '',
        deliveryVolunteers: draftData.deliveryVolunteers || '',
        takeawayCount: draftData.takeawayCount || '',
        hasDraft: true
      });

      // 🌟 老草稿没有细分字段时，diningCount/volunteerCount 已按上面原样恢复，
      // 不能在此重算覆盖成 0；只有草稿本身带细分字段时才需要重新对齐镜像值
      if (draftData.dineInSeniors || draftData.deliverySeniors || draftData.dineInVolunteers || draftData.deliveryVolunteers || draftData.takeawayCount) {
        this.recalcDiningStats();
      }

      // 🌟 大额专项：草稿只存了派生出的 fixedExpenseText（不含独立凭证图片，与
      // receiptImages 同样不进草稿的既有行为一致），恢复时反解析出条目供展示/继续编辑
      this.setData({ fixedExpenseItems: this.parseFixedExpenseTextToItems(draftData.fixedExpenseText || '') });

      if (draftData.allDonations) {
        this.updateParseResult(draftData.allDonations);
      }
      if (draftData.materialsInput) {
        this.updateMaterialsParse(draftData.materialsInput);
      }
      this.updateDailyExpenseParsePreview(draftData.dailyExpenseText || '');

      await this.loadBalanceForDate(dateStr);
      this.updateRealTimeBalance();

      wx.showToast({ title: `已载入 ${dateStr} 草稿`, icon: 'none', duration: 1200 });
      return true;
    } catch (error) {
      console.error('[草稿箱] 加载日期草稿失败:', error);
      return false;
    }
  },

  async loadDraft(): Promise<boolean> {
    try {
      const draftData = wx.getStorageSync(DRAFT_KEY);
      if (!draftData) return false;

      const hasContent = draftData.allDonations || draftData.expenses || 
                        draftData.otherDonation || draftData.yesterdayBalance !== '0.00';
      
      if (!hasContent) return false;

      const draftDate = draftData.reportDateValue || this.data.reportDateValue;
      const draftShop = draftData.shopName || this.data.shopName;

      if (draftDate && draftShop) {
        const loaded = await this.loadDraftByDate(draftDate, draftShop);
        if (loaded) return true;
      }

      this.setData({
        reportDate: draftData.reportDate || this.data.reportDate,
        reportDateValue: draftData.reportDateValue || this.data.reportDateValue,
        allDonations: draftData.allDonations || '',
        otherDonation: draftData.otherDonation || '',
        expenses: draftData.expenses || '',
        dailyExpenseText: draftData.dailyExpenseText || '',
        fixedExpenseText: draftData.fixedExpenseText || '',
        shopName: draftData.shopName || this.data.shopName,
        mpAccount: draftData.mpAccount || this.data.mpAccount,
        thankText: draftData.thankText || this.data.thankText,
        slogan1: draftData.slogan1 || this.data.slogan1,
        slogan2: draftData.slogan2 || this.data.slogan2,
        volunteerCount: draftData.volunteerCount || '',
        volunteerHours: draftData.volunteerHours || '',
        diningCount: draftData.diningCount || '',
        materialsInput: draftData.materialsInput || '',
        dineInSeniors: draftData.dineInSeniors || '',
        deliverySeniors: draftData.deliverySeniors || '',
        dineInVolunteers: draftData.dineInVolunteers || '',
        deliveryVolunteers: draftData.deliveryVolunteers || '',
        takeawayCount: draftData.takeawayCount || '',
        hasDraft: true
      });

      if (draftData.dineInSeniors || draftData.deliverySeniors || draftData.dineInVolunteers || draftData.deliveryVolunteers || draftData.takeawayCount) {
        this.recalcDiningStats();
      }

      this.setData({ fixedExpenseItems: this.parseFixedExpenseTextToItems(draftData.fixedExpenseText || '') });

      if (draftData.allDonations) {
        this.updateParseResult(draftData.allDonations);
      }
      if (draftData.materialsInput) {
        this.updateMaterialsParse(draftData.materialsInput);
      }

      await this.loadBalanceForDate(this.data.reportDateValue);
      this.updateRealTimeBalance();

      return true;
    } catch (error) {
      console.error('[草稿箱] 加载草稿失败:', error);
      return false;
    }
  },

  clearDraft() {
    try {
      const { reportDateValue, shopName } = this.data;
      const draftKey = getDraftKeyForDate(reportDateValue, shopName);
      wx.removeStorageSync(draftKey);
      wx.removeStorageSync(DRAFT_KEY);
      this.setData({ hasDraft: false });
    } catch (error) {
      console.error('[草稿箱] 清空草稿失败:', error);
    }
  },

  loadSettings() {
    try {
      const settingsData = wx.getStorageSync(SETTINGS_KEY);
      if (!settingsData) return;

      this.setData({
        shopName: settingsData.shopName || this.data.shopName,
        mpAccount: settingsData.mpAccount || this.data.mpAccount,
        thankText: settingsData.thankText || this.data.thankText,
        slogan1: settingsData.slogan1 || this.data.slogan1,
        slogan2: settingsData.slogan2 || this.data.slogan2
      });
    } catch (error) {
      console.error('[设置] 加载设置失败:', error);
    }
  },

  saveSettings() {
    try {
      const { shopName, mpAccount, thankText, slogan1, slogan2 } = this.data;
      const settingsData = {
        shopName,
        mpAccount,
        thankText,
        slogan1,
        slogan2,
        saveTime: Date.now()
      };
      wx.setStorageSync(SETTINGS_KEY, settingsData);
    } catch (error) {
      console.error('[设置] 保存设置失败:', error);
    }
  },

  discardDraft() {
    wx.showModal({
      title: '提示',
      content: '确定要丢弃当前草稿吗？',
      success: (res) => {
        if (res.confirm) {
          this.clearDraft();
          wx.showToast({ title: '已丢弃草稿', icon: 'none' });
        }
      }
    });
  },

  toggleSettings() {
    const next = !this.data.showSettings;
    this.setData({ showSettings: next });
    // 🌟 展开时才拉取，避免用户从未点开这张卡片也白白发一次云端请求；
    // 每次展开都重新拉取，保证展示的是该门店云端最新保存的模板（而非上次打开时的旧值）
    if (next) {
      this.syncTemplateStorePickerIndex();
      this.loadStoreTemplateFromCloud(this.data.currentStoreId);
    }
  },

  // 🌟 店铺模板自定义 - 超管专属店铺切换下拉框的选中项，与真实 allStoresList（含
  // 真实 storeId，来自 getStoreList 云函数）对齐，不再是与真实门店脱节的旧版硬编码预设
  syncTemplateStorePickerIndex() {
    const list = this.data.allStoresList || [];
    const idx = list.findIndex((s: any) => s.storeId === this.data.currentStoreId);
    this.setData({ templateStorePickerIndex: idx >= 0 ? idx : 0 });
  },

  // 🛡️ 数据硬卡口：拉取指定门店云端已保存的模板自定义内容（致谢词/宣传标语/公众号名称）。
  // "全国总览"等虚拟门店 ID 无对应真实门店记录，直接跳过
  async loadStoreTemplateFromCloud(storeId: string) {
    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];
    if (!storeId || NATIONAL_IDS.includes(storeId)) return;
    try {
      if (!isCloudAvailable()) return;
      const res = await wx.cloud.callFunction({ name: 'manageStoreProfile', data: { action: 'get', storeId } });
      const result = res.result as any;
      if (result && result.success && result.data) {
        const d = result.data;
        this.setData({
          thankText: d.thankText || this.data.thankText,
          slogan1: d.slogan1 || this.data.slogan1,
          slogan2: d.slogan2 || this.data.slogan2,
          mpAccount: d.mpAccount || this.data.mpAccount
        });
      }
    } catch (error) {
      console.error('[店铺模板] 拉取云端模板配置失败:', error);
    }
  },

  // 🛡️ 越权隔离：仅超级管理员可在此下拉框切换编辑目标门店；wxml 已按 isSuperAdmin
  // 隐藏该 picker，这里再做一次兜底拦截。选中后复用 switchStoreTarget（原本定义但
  // 从未被调用的既有方法）联动切换页面当前门店上下文，与顶部 store-picker 切店口径一致
  onTemplateStorePickerChange(e: any) {
    if (!this.data.isSuperAdmin) return;
    const index = parseInt(e.detail.value, 10);
    const target = (this.data.allStoresList || [])[index];
    if (!target || !target.storeId) return;
    this.setData({ templateStorePickerIndex: index });
    this.switchStoreTarget(target.storeId, target.storeName);
    this.loadStoreTemplateFromCloud(target.storeId);
  },

  onTemplateFieldFocus(e: any) {
    this.setData({ templateFocusField: e.currentTarget.dataset.field || '' });
  },

  onTemplateFieldBlur() {
    this.setData({ templateFocusField: '' });
  },

  async onSaveTemplateSettings() {
    if (this.data.isSavingTemplate) return;

    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];
    const storeId = this.data.currentStoreId;
    if (!storeId || NATIONAL_IDS.includes(storeId)) {
      wx.showToast({ title: '请先选择具体门店', icon: 'none' });
      return;
    }

    const { thankText, slogan1, slogan2, mpAccount } = this.data;
    this.setData({ isSavingTemplate: true });
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');
      // 🛡️ 数据硬卡口：storeId 固定取 currentStoreId（非超管在 wxml 里已被锁死无法更改；
      // 超管切店走 onTemplateStorePickerChange 会同步更新 currentStoreId）。云函数端
      // resolveWriteTarget 对店长/大家长还会再强制取其自身绑定 storeId，不信任任何客户端值
      const res = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'update', storeId, thankText, slogan1, slogan2, mpAccount }
      });
      const result = res.result as any;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
        return;
      }
      // 刷新本地缓存，离线/弱网时报表提交仍可读到最新模板
      this.saveSettings();
      wx.showToast({ title: result.pending ? '已提交家长/超管审批' : '模板已保存', icon: result.pending ? 'none' : 'success' });
    } catch (error) {
      console.error('[店铺模板] 保存失败:', error);
      wx.showToast({ title: '保存失败，请检查网络', icon: 'none' });
    } finally {
      this.setData({ isSavingTemplate: false });
    }
  },

  toggleBalanceLock() {
    const newLockState = !this.data.isBalanceLocked;
    this.setData({
      isBalanceLocked: newLockState,
      balanceFocus: !newLockState
    });
    
    if (!newLockState) {
      wx.vibrateShort && wx.vibrateShort({ type: 'light' });
      wx.showToast({ title: '已解锁，可手动修改余额', icon: 'none', duration: 1500 });
    } else {
      wx.showToast({ title: '余额已锁定', icon: 'none', duration: 1000 });
    }
  },

  onForceRefreshBalance() {
    this.setData({ isBalanceLocked: true });
    this.loadBalanceForDate(this.data.reportDateValue);
  },

  // === 扫码绑定与义工审核 ===

  async fetchStoreInfoAndPromptApply(storeId: string) {
    // 🐛 修复：扫描"全国总览"邀请码（scene=s=all）时，此前会去查 stores 表里
    // 一个根本不存在的 _id='all' 文档，查询必然失败落入 catch，再把"全国总览"
    // 当成一个真实门店预填进申请表单——用户可以直接提交一条 storeId='all' 的
    // 无效申请，审批时根本无法归属到任何真实门店。
    // 现在改为：识别到全国总览哨兵值就不预填任何门店，强制弹出门店选择器，
    // 用户必须在下拉列表里选定一个具体门店后（走 onSubmitRoleApply 已有的
    // "未选门店禁止提交"校验）才能提交申请。
    const NATIONAL_SCENE_IDS = ['all', 'ALL', 'national_overview', 'ALL_STORES'];
    const applyTip = this.computeApplyRoleTip(this.data.applyForm.requestedRole);
    if (NATIONAL_SCENE_IDS.includes(storeId)) {
      this.setData({
        'applyForm.storeId': '',
        'applyForm.storeName': '',
        'applyForm.storeSelectionType': 'existing',
        'applyForm.customStoreName': '',
        applyRoleTipText: applyTip.text,
        applyRoleTipVariant: applyTip.variant,
        showApplyModal: true
      });
      if (!this.data.allStoresList || this.data.allStoresList.length === 0) {
        this.fetchAllStoresList();
      }
      wx.showToast({ title: '该邀请码为全国通用邀请，请选择您所属的具体门店', icon: 'none', duration: 3000 });
      return;
    }

    wx.showLoading({ title: '正在获取门店信息...' });

    const storeNameMap: Record<string, string> = {
      'store_haicang': '海沧区雨花斋',
      'store_haicang_001': '海沧区雨花斋'
    };

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const db = wx.cloud.database();
      const res = await db.collection('stores').doc(storeId).get();
      wx.hideLoading();

      if (res.data) {
        this.setData({
          'applyForm.storeId': storeId,
          'applyForm.storeName': (res.data as any).storeName || '未知门店',
          'applyForm.storeSelectionType': 'existing',
          'applyForm.customStoreName': '',
          applyRoleTipText: applyTip.text,
          applyRoleTipVariant: applyTip.variant,
          showApplyModal: true
        });
      } else {
        throw new Error('store not found');
      }
    } catch (e) {
      wx.hideLoading();
      const fallbackName = storeNameMap[storeId] || '雨花斋';
      this.setData({
        'applyForm.storeId': storeId,
        'applyForm.storeName': fallbackName,
        'applyForm.storeSelectionType': 'existing',
        'applyForm.customStoreName': '',
        applyRoleTipText: applyTip.text,
        applyRoleTipVariant: applyTip.variant,
        showApplyModal: true
      });
    }
  },

  onApplyRealNameInput(e: any) {
    this.setData({ 'applyForm.realName': e.detail.value });
  },

  onApplyPhoneInput(e: any) {
    this.setData({ 'applyForm.phone': e.detail.value });
  },

  // 🏛️ 大家长/店长/财务/义工四种身份提交后的提示文案与视觉变体：
  // - 义工：免审即时生效
  // - 大家长：天然包含店长+财务全套权限，无需重复申请（若当前已是店长，
  //   提示改为"正在申请升级为大家长身份"）
  // - 店长/财务：常规待审批提示
  computeApplyRoleTip(requestedRole: string): { text: string; variant: 'auto' | 'patriarch' | 'pending' } {
    if (requestedRole === 'volunteer') {
      return { text: '✅ 即刻生效，开始护持', variant: 'auto' };
    }
    if (requestedRole === 'store_patriarch') {
      if (this.data.currentUserRole === 'store_manager') {
        return { text: '👑 正在申请升级为大家长身份', variant: 'patriarch' };
      }
      return { text: '💡 说明：大家长身份天然包含【店长】与【财务】的全套日常管理权限，无需重复申请。', variant: 'patriarch' };
    }
    return { text: '⏳ 提交申请，等待超管/大家长审批', variant: 'pending' };
  },

  onApplyRoleChange(e: any) {
    const requestedRole = e.detail.value;
    const tip = this.computeApplyRoleTip(requestedRole);
    this.setData({
      'applyForm.requestedRole': requestedRole,
      applyRoleTipText: tip.text,
      applyRoleTipVariant: tip.variant
    });
  },

  // 🏢 切换"选择已有门店" / "新建门店"两种申请模式
  onSwitchApplyStoreMode(e: any) {
    const mode = e.currentTarget.dataset.mode as 'existing' | 'custom';
    if (mode === this.data.applyForm.storeSelectionType) return;
    this.setData({
      'applyForm.storeSelectionType': mode,
      'applyForm.storeId': '',
      'applyForm.storeName': '',
      'applyForm.customStoreName': '',
      'applyForm.address': '',
      'applyForm.contactPhone': '',
      'applyForm.storePhotos': []
    });
  },

  onSelectApplyStore(e: any) {
    const index = parseInt(e.detail.value, 10);
    const store = (this.data.allStoresList || [])[index];
    if (!store) return;
    this.setData({
      'applyForm.storeId': store.storeId,
      'applyForm.storeName': store.storeName
    });
  },

  onCustomStoreNameInput(e: any) {
    this.setData({ 'applyForm.customStoreName': e.detail.value });
  },

  onApplyAddressInput(e: any) {
    this.setData({ 'applyForm.address': e.detail.value });
  },

  onApplyContactPhoneInput(e: any) {
    this.setData({ 'applyForm.contactPhone': e.detail.value });
  },

  // 🏪 新建门店档案照片：门店此刻还未创建，先以云存储 fileID 数组形式挂在申请表单上，
  // 与 activity-log.ts onChooseImage 同一套 chooseMedia + compressAndUploadImages 模式
  async onChooseApplyStorePhoto() {
    const MAX_PHOTOS = 9;
    const remaining = MAX_PHOTOS - this.data.applyForm.storePhotos.length;
    if (remaining <= 0) {
      wx.showToast({ title: `最多上传 ${MAX_PHOTOS} 张门店照片`, icon: 'none' });
      return;
    }

    try {
      const chooseRes = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });

      const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
      if (paths.length === 0) return;

      const insertStart = this.data.applyForm.storePhotos.length;
      this.setData({
        'applyForm.storePhotos': [...this.data.applyForm.storePhotos, ...paths],
        applyStorePhotoUploading: true
      });

      try {
        const uploaded = await compressAndUploadImages(HOME_COMPRESS_CANVAS_ID, paths, 'store_apply_photos/' + Date.now());
        const finalPhotos = [...this.data.applyForm.storePhotos];
        uploaded.forEach((u, i) => { finalPhotos[insertStart + i] = u.url; });
        this.setData({ 'applyForm.storePhotos': finalPhotos });
      } catch (uploadErr) {
        const rolledBack = this.data.applyForm.storePhotos.filter((_: string, i: number) => i < insertStart || i >= insertStart + paths.length);
        this.setData({ 'applyForm.storePhotos': rolledBack });
        throw uploadErr;
      }

      this.setData({ applyStorePhotoUploading: false });
    } catch (err) {
      this.setData({ applyStorePhotoUploading: false });
      console.error('[onChooseApplyStorePhoto] 异常:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  onDeleteApplyStorePhoto(e: any) {
    const index = e.currentTarget.dataset.index;
    const next = this.data.applyForm.storePhotos.filter((_: string, i: number) => i !== index);
    this.setData({ 'applyForm.storePhotos': next });
  },

  onCloseApplyModal() {
    this.setData({ showApplyModal: false });
  },

  async onSubmitRoleApply() {
    const { storeId, storeName, realName, phone, requestedRole, storeSelectionType, customStoreName, address, contactPhone, storePhotos } = this.data.applyForm;

    if (!realName || !realName.trim()) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' });
      return;
    }
    if (!phone || !phone.trim()) {
      wx.showToast({ title: '请填写手机号', icon: 'none' });
      return;
    }
    if (storeSelectionType === 'custom') {
      if (!customStoreName || !customStoreName.trim()) {
        wx.showToast({ title: '请填写新门店名称', icon: 'none' });
        return;
      }
      // 🛡️ 申请高阶角色/新建门店需先补全门店档案：新门店此刻还不存在，档案
      // 就收在这张申请表单里（与客户端拦截配套的服务端兜底见 processRoleAudit）
      if (!address || !address.trim() || !contactPhone || !contactPhone.trim() || !storePhotos || storePhotos.length === 0) {
        wx.showModal({
          title: '门店档案未补全',
          content: '申请高阶角色/新建门店需先补全门店档案（地址、联系电话、门店照片）',
          showCancel: false
        });
        return;
      }
    } else if (!storeId) {
      wx.showToast({ title: '请选择一个门店', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交申请中...', mask: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      // 🏢 多租户：随申请一并带上 tenantId，供审批云函数做机构边界校验与新建门店归属判定
      const cachedRoleInfoForTenant = AuthService.getCachedRoleInfo();
      const tenantId = (cachedRoleInfoForTenant && cachedRoleInfoForTenant.tenantId) || '';
      const displayStoreName = storeSelectionType === 'custom' ? customStoreName.trim() : storeName;

      // 🛡️ 提交改走 processRoleAudit 云函数（action:'apply'），不再由客户端直接写
      // status/role 字段——服务端统一决定是否自动通过（目前仅"义工 + 已有门店"
      // 免审即时生效），避免客户端能直接摆布这两个字段自我提权
      const res = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: {
          action: 'apply',
          storeId: storeSelectionType === 'custom' ? '' : storeId,
          storeName: displayStoreName,
          storeSelectionType,
          customStoreName: storeSelectionType === 'custom' ? customStoreName.trim() : '',
          address: storeSelectionType === 'custom' ? address.trim() : '',
          contactPhone: storeSelectionType === 'custom' ? contactPhone.trim() : '',
          storePhotos: storeSelectionType === 'custom' ? storePhotos : [],
          tenantId,
          requestedRole,
          realName: realName.trim(),
          phone: phone.trim()
        }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '提交失败，请重试', icon: 'none' });
        return;
      }

      this.setData({ showApplyModal: false });

      let content: string;
      if (result.autoApproved) {
        content = `您已成功加入【${displayStoreName}】，义工身份即刻生效，可以开始护持啦！`;
      } else if (storeSelectionType === 'custom') {
        content = `您已成功申请加入新门店【${displayStoreName}】，待超级管理员审核通过后将自动建店并完成身份审核！`;
      } else {
        content = `您已成功申请加入【${displayStoreName}】，请联系店长/大家长或超级管理员完成身份审核！`;
      }

      wx.showModal({
        title: result.autoApproved ? '🎉 加入成功' : '申请已提交',
        content,
        showCancel: false,
        confirmText: '我知道了'
      });
    } catch (e) {
      wx.hideLoading();
      console.error('[onSubmitRoleApply] 提交失败:', e);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
  },

  // === 店长审核管理 ===

  async onOpenAuditModal() {
    this.setData({
      showAuditModal: true,
      auditActiveTab: 'pending',
      auditRoleFilter: 'all',
      auditSearchKeyword: '',
      // 🌐 全国总览 vs 单店视角：决定底部按钮文案与空状态引导语
      auditIsNationalView: this.isNationalOverviewSelected(),
      // 🦴 清空上一次已加载的列表，避免骨架屏结束后短暂闪现旧门店/旧角色的残留数据
      pendingApplyList: [],
      filteredPendingList: []
    });
    await this.fetchAuditQueue('pending');
  },

  onCloseAuditModal() {
    this.setData({ showAuditModal: false });
  },

  // ================= 🔑 生成特权邀请码 =================
  //
  // 🛡️ 全链路重构：此前小程序端直接 wx.cloud.database().collection('store_invites')
  // .add()——真正的权限判定只停留在客户端 JS（this.data.isManager/isSuperAdmin），
  // 任何人打开开发者工具对同一个小程序会话直接调用 wx.cloud.database() API 就能绕过，
  // 生成任意门店/任意角色的邀请码。现改为服务端 cloudfunctions/manageStoreInviteCode
  // 统一收口生成与核销，客户端这里只负责收集参数 + 展示结果，不再直接触碰数据库。
  //
  // 🛡️ 身份阶梯权限过滤：仅超级管理员/店长/大家长可打开本弹窗——财务/义工/家人
  // 不在权限阶梯里，不能自我复制/越级授权（与云函数 checkGeneratePermission 同一口径，
  // 这里提前拦截只是避免用户填完表单才在最后一步被云函数拒绝，真正的强制点在服务端）
  onOpenGenCodeModal() {
    const canGenerate = this.data.isSuperAdmin || this.data.isManager || this.data.isPatriarch;
    if (!canGenerate) {
      wx.showToast({ title: '无权限：仅超级管理员/店长/大家长可生成邀请码', icon: 'none', duration: 2500 });
      return;
    }

    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];
    const isSuperAdmin = this.data.isSuperAdmin;

    let storeOptions: any[];
    let genStoreSelectorDisabled: boolean;
    let defaultStore: any;

    if (isSuperAdmin) {
      // 🏢 过滤掉"全国总览"等虚拟条目，picker 只应展示本机构下的真实门店
      storeOptions = (this.data.allStoresList || []).filter((s: any) =>
        s && s.storeName !== '全国总览' && !NATIONAL_IDS.includes(s.storeId)
      );
      genStoreSelectorDisabled = false;
      const currentIsRealStore = this.data.currentStoreId && !NATIONAL_IDS.includes(this.data.currentStoreId);
      const currentInOptions = currentIsRealStore
        ? storeOptions.find((s: any) => s.storeId === this.data.currentStoreId)
        : null;
      // 默认选中顶部选择器中的真实门店；不在选项里（如处于全国总览）就退回第一家，
      // 本机构压根没有门店时留空，由 UI 引导去正确的建店入口
      defaultStore = currentInOptions || storeOptions[0] || null;
    } else {
      // 🛡️ 发码防越权：非超管（店长/大家长）强制锁定为当前所属门店，禁用切换，
      // 从入口就杜绝跨店发码，而不只是依赖服务端事后拒绝
      const ownStoreId = this.data.currentStoreId && !NATIONAL_IDS.includes(this.data.currentStoreId) ? this.data.currentStoreId : '';
      storeOptions = ownStoreId ? [{ storeId: ownStoreId, storeName: this.data.currentStoreName }] : [];
      genStoreSelectorDisabled = true;
      defaultStore = storeOptions[0] || null;
    }

    // 🛡️ 身份阶梯权限过滤：超管可选五种；店长/大家长严格禁止生成"大家长"/
    // "门店财务"/"门店店长"（均与自身同级或更高），只放开低于自身权限的
    // [家人, 志愿者]，与云函数 checkGeneratePermission 的口径完全一致
    const genAvailableRoles = isSuperAdmin
      ? ['PATRIARCH', 'MANAGER', 'FINANCE', 'FAMILY', 'VOLUNTEER']
      : ['FAMILY', 'VOLUNTEER'];

    this.setData({
      showGenCodeModal: true,
      generatedCode: '',
      isGeneratingInviteCode: false,
      genTargetRole: genAvailableRoles[0] as any,
      genStoreOptions: storeOptions,
      genStoreSelectorDisabled,
      genAvailableRoles,
      targetGenStoreId: defaultStore ? defaultStore.storeId : '',
      targetGenStoreName: defaultStore ? defaultStore.storeName : ''
    });
  },

  onCloseGenCodeModal() {
    this.setData({ showGenCodeModal: false });
  },

  onSelectGenRole(e: any) {
    const role = e.currentTarget.dataset.role;
    // 🛡️ 二次拦截：即使 WXML 因某种极端时序渲染出了不该出现的选项，这里也兜底
    // 拒绝选中不在 genAvailableRoles 白名单内的角色
    if (!this.data.genAvailableRoles.includes(role)) return;
    this.setData({ genTargetRole: role, generatedCode: '' });
  },

  onSelectGenStore(e: any) {
    if (this.data.genStoreSelectorDisabled) return;
    const index = e.detail.value;
    const selected = (this.data.genStoreOptions || [])[index];
    if (selected) {
      this.setData({
        targetGenStoreId: selected.storeId,
        targetGenStoreName: selected.storeName,
        generatedCode: ''
      });
    }
  },

  async onGenerateInviteCode() {
    const storeId = this.data.targetGenStoreId;
    const storeName = this.data.targetGenStoreName;
    const role = this.data.genTargetRole;

    if (!storeId || !storeName) {
      wx.showToast({
        title: this.data.genStoreOptions.length === 0 ? '本机构暂无门店，请先创建门店' : '请先选择目标门店',
        icon: 'none'
      });
      return;
    }
    if (!this.data.genAvailableRoles.includes(role)) {
      wx.showToast({ title: '无权限：不能生成该身份的邀请码', icon: 'none' });
      return;
    }

    if (this.data.isGeneratingInviteCode) return;
    this.setData({ isGeneratingInviteCode: true });
    wx.showLoading({ title: '邀请码安全生成中...', mask: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreInviteCode',
        data: { action: 'generate', storeId, targetRole: INVITE_ROLE_SERVER_MAP[role] }
      });
      const result = res.result;
      wx.hideLoading();

      if (!result || !result.success) {
        this.setData({ isGeneratingInviteCode: false });
        wx.showToast({ title: (result && result.error) || '生成失败，请重试', icon: 'none', duration: 2500 });
        return;
      }

      const { code, qrFileID } = result.data;

      // 🌟 太阳码为可选增强：下载失败不阻断结果弹窗展示，邀请码本身仍可正常
      // 手动复制/核销，只是弹窗里不显示太阳码图片
      let qrTempPath = '';
      if (qrFileID) {
        try {
          const downRes = await wx.cloud.downloadFile({ fileID: qrFileID });
          qrTempPath = downRes.tempFilePath;
        } catch (qrErr) {
          console.warn('[onGenerateInviteCode] 太阳码下载失败:', qrErr);
        }
      }

      this.setData({
        isGeneratingInviteCode: false,
        showGenCodeModal: false,
        showInviteResultModal: true,
        inviteResultCode: code,
        inviteResultQrPath: qrTempPath,
        inviteResultStoreName: storeName,
        inviteResultRoleLabel: INVITE_ROLE_LABEL_MAP[role] || role
      });
    } catch (err) {
      wx.hideLoading();
      this.setData({ isGeneratingInviteCode: false });
      console.error('[onGenerateInviteCode] 异常:', err);
      wx.showToast({ title: '网络异常，生成失败，请重试', icon: 'none' });
    }
  },

  onCloseInviteResultModal() {
    this.setData({ showInviteResultModal: false, inviteResultCode: '', inviteResultQrPath: '' });
  },

  onCopyInviteResultCode() {
    wx.setClipboardData({
      data: this.data.inviteResultCode,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' })
    });
  },

  // 📥 保存太阳码图片到相册，便于直接发到朋友圈/群聊而不需要额外截图
  onSaveInviteResultQr() {
    const filePath = this.data.inviteResultQrPath;
    if (!filePath) {
      wx.showToast({ title: '太阳码尚未生成完成，请稍候', icon: 'none' });
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => wx.showToast({ title: '太阳码已保存至相册', icon: 'success' }),
      fail: (err: any) => {
        if (err.errMsg && err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许小程序访问相册，才能保存太阳码图片',
            confirmText: '去设置',
            success: (res) => { if (res.confirm) wx.openSetting(); }
          });
        } else {
          wx.showToast({ title: '保存失败，请重试', icon: 'none' });
        }
      }
    });
  },

  onShareInviteResultCode() {
    const roleLabel = this.data.inviteResultRoleLabel;
    const copyText = `🌸【雨花爱心餐报助手】\n诚邀您加入【${this.data.inviteResultStoreName || '雨花斋'}】！您的专属【${roleLabel}】邀请码为：${this.data.inviteResultCode}（24 小时内有效，仅限一次核销）。请打开小程序输入此码激活身份。感恩您的加入！`;
    wx.setClipboardData({
      data: copyText,
      success: () => wx.showToast({ title: '邀请文案已复制，快发送给TA吧', icon: 'none', duration: 2500 })
    });
  },

  onSwitchAuditTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    // 🐛 同一个 Tab 手快连点不该重复触发 setData/请求
    if (tab === this.data.auditActiveTab) return;
    this.setData({ auditActiveTab: tab });
    if (tab === 'approved' && this.data.approvedVolunteerList.length === 0) {
      // fetchAuditQueue 内部的 pendingAuditRequest 锁已经能防住并发重复调用，
      // 这里的"已加载过就不重新拉"只是额外的一层缓存优化，两者互不冲突
      this.fetchAuditQueue('approved');
    }
  },

  // 👥 角色筛选 Segment：[全部]/[义工]/[财务]/[大家长+店长]，两个 Tab 共用
  onSwitchAuditRoleFilter(e: any) {
    const filter = e.currentTarget.dataset.filter;
    if (filter === this.data.auditRoleFilter) return;
    this.setData({ auditRoleFilter: filter });
    this.recomputeAuditFilteredLists();
  },

  // 🔍 已通过列表的姓名/手机号模糊搜索：对已拉取的原始列表做前端过滤，不额外打云函数
  onAuditSearchInput(e: any) {
    this.setData({ auditSearchKeyword: e.detail.value });
    this.recomputeAuditFilteredLists();
  },

  onClearAuditSearch() {
    if (!this.data.auditSearchKeyword) return;
    this.setData({ auditSearchKeyword: '' });
    this.recomputeAuditFilteredLists();
  },

  // 依据当前角色筛选 + 搜索关键字，从原始的 pendingApplyList/approvedVolunteerList
  // 重新计算实际渲染用的 filteredPendingList/filteredApprovedList
  recomputeAuditFilteredLists() {
    const roleFilter = this.data.auditRoleFilter;
    const keyword = (this.data.auditSearchKeyword || '').trim();

    const matchesRoleFilter = (role: string) => {
      if (roleFilter === 'all') return true;
      if (roleFilter === 'leader') return role === 'store_manager' || role === 'store_patriarch';
      return role === roleFilter;
    };

    const filteredPending = (this.data.pendingApplyList || []).filter((item: any) =>
      matchesRoleFilter(item.role)
    );

    const filteredApproved = (this.data.approvedVolunteerList || []).filter((item: any) => {
      if (!matchesRoleFilter(item.role)) return false;
      if (!keyword) return true;
      const name = item.realName || '';
      const phone = item.phone || '';
      return name.includes(keyword) || phone.includes(keyword);
    });

    this.setData({ filteredPendingList: filteredPending, filteredApprovedList: filteredApproved });
  },

  // 🛡️ 统一的门店审核列表拉取：替代此前 fetchPendingAuditList/
  // fetchApprovedVolunteerList 各自直接 wx.cloud.database().collection('user_roles')
  // .where(...).get() 的客户端直连查询（门店/机构隔离完全依赖客户端缓存的
  // AuthService.getCachedRoleInfo() + 不可见的数据库安全规则）——现改为服务端
  // processRoleAudit 的 listAuditQueue 动作，按调用者真实角色重新推导数据范围，
  // 单店店长/大家长严格锁定自己的 storeId，超管按当前选中门店过滤或看全机构。
  //
  // 🐛 请求去重：pendingAuditRequest 锁在方法一开始就置位，已有请求在途时直接
  // 跳过本次调用，避免切换 Tab/角色 Filter 连点触发并发请求、返回顺序竞争覆盖列表
  async fetchAuditQueue(tab: 'pending' | 'approved') {
    if (this.data.pendingAuditRequest) {
      console.log('[fetchAuditQueue] 已有请求在途，跳过本次重复调用');
      return;
    }
    this.setData({ pendingAuditRequest: true, auditListLoading: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { action: 'listAuditQueue', tab, storeId: this.data.currentStoreId }
      });
      const result = res.result;

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || (tab === 'pending' ? '加载申请列表失败' : '加载已通过列表失败'), icon: 'none' });
        return;
      }

      if (tab === 'pending') {
        this.setData({ pendingApplyList: result.data || [] });
      } else {
        this.setData({ approvedVolunteerList: result.data || [] });
      }
      this.recomputeAuditFilteredLists();
    } catch (e) {
      console.error(`[fetchAuditQueue:${tab}] 加载失败:`, e);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ pendingAuditRequest: false, auditListLoading: false });
    }
  },

  // 🔒 高权限角色（财务/店长/大家长）授权前需二次强确认，避免店长手滑一点就把
  // 账本权限批给了非本意人选；义工无需二次确认，维持原有一键通过的体验
  async onProcessAudit(e: any) {
    const { id, action } = e.currentTarget.dataset;
    const applyItem = this.data.pendingApplyList.find((r: any) => r.applyId === id);

    if (!applyItem) {
      wx.showToast({ title: '申请记录不存在', icon: 'none' });
      return;
    }

    const SENSITIVE_ROLES = ['finance', 'store_manager', 'store_patriarch'];
    if (action === 'approve' && SENSITIVE_ROLES.includes(applyItem.role)) {
      const roleLabel = applyItem.role === 'finance'
        ? '财务'
        : (applyItem.role === 'store_patriarch' ? '大家长' : '店长');
      const displayName = maskName(applyItem.realName) || '该申请人';

      wx.showModal({
        title: '⚠️ 高权限角色确认',
        content: `授权后「${displayName}」将以【${roleLabel}】身份操作/查看门店账本，确认通过吗？`,
        confirmText: '确认通过',
        confirmColor: '#D32F2F',
        cancelText: '我再想想',
        success: (res) => {
          if (res.confirm) this.executeProcessAudit(id, action);
        }
      });
      return;
    }

    await this.executeProcessAudit(id, action);
  },

  async executeProcessAudit(id: string, action: string) {
    const loadingTitle = action === 'approve' ? '正在授权...' : '正在处理...';

    wx.showLoading({ title: loadingTitle, mask: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      // 🛡️ storeId/storeName 不再由客户端传入：云函数会重新拉取申请记录本身来确定
      // 目标门店（含"新建门店"申请的自动建店逻辑），避免信任客户端可篡改的字段
      const result = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { applyId: id, action }
      });

      const res = result.result as any;

      if (res && res.success) {
        wx.hideLoading();
        wx.showToast({
          title: action === 'approve' ? '已授权通过' : '已拒绝申请',
          icon: action === 'approve' ? 'success' : 'none'
        });

        const newList = this.data.pendingApplyList.filter((r: any) => r.applyId !== id);
        this.setData({ pendingApplyList: newList });
        this.recomputeAuditFilteredLists();
      } else {
        wx.hideLoading();
        wx.showToast({ title: (res && res.error) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[onProcessAudit] 审核失败:', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // 🛡️ 拒绝角色/门店申请必须先说明原因（processRoleAudit action:'reject' 服务端
  // 强制校验 rejectReason），点击"拒绝"先弹这个原因输入框，确认后才真正提交
  onOpenAuditRejectModal(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ showAuditRejectModal: true, auditRejectId: id, auditRejectReason: '', auditRejectPreset: '' });
  },

  onCloseAuditRejectModal() {
    if (this.data.auditRejectSubmitting) return;
    this.setData({ showAuditRejectModal: false, auditRejectId: '' });
  },

  onAuditRejectReasonInput(e: any) {
    // 手动改字后不再视为命中某个快捷选项，取消高亮，避免"选中态"与实际文案不符
    this.setData({ auditRejectReason: e.detail.value, auditRejectPreset: '' });
  },

  // ⚡ 快捷拒绝理由：非本店义工/信息不符/请重新填写，点击直接填入文本框，
  // 仍可在此基础上手动编辑补充，而不是强制二选一
  onSelectAuditRejectPreset(e: any) {
    const reason = e.currentTarget.dataset.reason;
    if (!reason) return;
    this.setData({ auditRejectReason: reason, auditRejectPreset: reason });
  },

  async onSubmitAuditReject() {
    if (this.data.auditRejectSubmitting) return;

    const id = this.data.auditRejectId;
    const rejectReason = (this.data.auditRejectReason || '').trim();
    if (!id) return;
    if (!rejectReason) {
      wx.showToast({ title: '请填写拒绝原因', icon: 'none' });
      return;
    }

    this.setData({ auditRejectSubmitting: true });
    wx.showLoading({ title: '正在处理...', mask: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const result = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { applyId: id, action: 'reject', rejectReason }
      });
      const res = result.result as any;
      wx.hideLoading();

      if (res && res.success) {
        wx.showToast({ title: '已拒绝申请', icon: 'none' });
        const newList = this.data.pendingApplyList.filter((r: any) => r.applyId !== id);
        this.setData({ pendingApplyList: newList, showAuditRejectModal: false, auditRejectId: '' });
        this.recomputeAuditFilteredLists();
      } else {
        wx.showToast({ title: (res && res.error) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[onSubmitAuditReject] 拒绝失败:', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      this.setData({ auditRejectSubmitting: false });
    }
  },

  // 🔄 修改已绑定义工的角色（财务记账 ↔ 现场奉献），需二次确认防止误触
  onChangeVolunteerRole(e: any) {
    const { id } = e.currentTarget.dataset;
    const item = this.data.approvedVolunteerList.find((r: any) => r.applyId === id);
    if (!item) return;

    const currentRole = item.role === 'finance' ? 'finance' : 'volunteer';
    const targetRole = currentRole === 'finance' ? 'volunteer' : 'finance';
    const currentLabel = currentRole === 'finance' ? '财务义工' : '现场义工';
    const targetLabel = targetRole === 'finance' ? '财务义工' : '现场义工';
    const displayName = maskName(item.realName) || '该义工';

    wx.showModal({
      title: '修改角色',
      content: `确认将「${displayName}」的角色从【${currentLabel}】切换为【${targetLabel}】吗？`,
      confirmText: '确认切换',
      cancelText: '我再想想',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '正在更新角色...', mask: true });
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const result = await wx.cloud.callFunction({
            name: 'manageVolunteerBinding',
            data: { targetId: id, action: 'changeRole', newRole: targetRole }
          });
          const res2 = result.result as any;
          wx.hideLoading();
          if (res2 && res2.success) {
            wx.showToast({ title: '角色已更新', icon: 'success' });
            const newList = this.data.approvedVolunteerList.map((r: any) =>
              r.applyId === id ? { ...r, role: targetRole } : r
            );
            this.setData({ approvedVolunteerList: newList });
            this.recomputeAuditFilteredLists();
          } else {
            wx.showModal({ title: '操作失败', content: (res2 && res2.error) || '未能更新角色', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[onChangeVolunteerRole] 异常:', err);
          wx.showModal({ title: '操作失败', content: '网络异常，请稍后重试', showCancel: false });
        }
      }
    });
  },

  // 🚨 解除义工绑定：二次 Confirm 防止误踢，解除后需重新申请/使用邀请码才能再次绑定
  onUnbindVolunteer(e: any) {
    const { id } = e.currentTarget.dataset;
    const item = this.data.approvedVolunteerList.find((r: any) => r.applyId === id);
    if (!item) return;

    const storeLabel = item.storeName || this.data.currentStoreName || '本门店';

    wx.showModal({
      title: '确认解除绑定？',
      content: `解除后该义工将无法继续为【${storeLabel}】提交账目与服务记录。`,
      confirmText: '确认解除',
      confirmColor: '#D32F2F',
      cancelText: '我再想想',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '正在解除绑定...', mask: true });
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const result = await wx.cloud.callFunction({
            name: 'manageVolunteerBinding',
            data: { targetId: id, action: 'unbind' }
          });
          const res2 = result.result as any;
          wx.hideLoading();
          if (res2 && res2.success) {
            wx.showToast({ title: '已解除绑定', icon: 'success' });
            const newList = this.data.approvedVolunteerList.filter((r: any) => r.applyId !== id);
            this.setData({ approvedVolunteerList: newList });
            this.recomputeAuditFilteredLists();
          } else {
            wx.showModal({ title: '操作失败', content: (res2 && res2.error) || '未能解除绑定', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[onUnbindVolunteer] 异常:', err);
          wx.showModal({ title: '操作失败', content: '网络异常，请稍后重试', showCancel: false });
        }
      }
    });
  },

  // 📞 申请人/已通过成员的手机号：屏幕上仍用 mask.maskPhone 脱敏展示（WXS 纯展示层
  // 转换，不影响底层数据），点击时用 dataset 里传入的真实号码发起拨打/复制——
  // 号码本就存在于 pendingApplyList/approvedVolunteerList 这份已授权可见的审核数据里，
  // 只是不在屏幕上明文常驻展示，点击后的操作动作使用真实号码不算额外泄露
  onTapApplicantPhone(e: any) {
    const phone = e.currentTarget.dataset.phone;
    if (!phone) return;

    wx.showActionSheet({
      itemList: ['拨打电话', '复制手机号'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.makePhoneCall({ phoneNumber: phone, fail: () => { /* 用户取消拨号，静默忽略 */ } });
        } else if (res.tapIndex === 1) {
          wx.setClipboardData({
            data: phone,
            success: () => wx.showToast({ title: '手机号已复制', icon: 'success' })
          });
        }
      }
    });
  },

  async onOpenBalanceHistoryModal() {
    wx.showLoading({ title: '正在调取账目流水...', mask: true });

    // 🛡️ 防死锁修复：原来 wx.hideLoading() 只写在函数末尾，依赖代码"正常走到那一行"
    // 才会执行——云端拉取失败时确实会被内层 try/catch 兜住转入本地缓存，但本地缓存的
    // filter/sort/map 处理链一旦遇到脏数据（例如 local_report_logs 里混入了 null 项，
    // r.dateString 会直接抛 TypeError），异常会全程无人捕获，hideLoading 那一行永远
    // 到不了，遮罩就此死锁。现在把整段处理逻辑（含本地兜底与格式化）都收进外层
    // try，hideLoading 移入 finally，无论云端成功/失败、本地兜底是否也异常，
    // 保证只执行一次、且一定会执行。
    try {
      let rawList: any[] = [];
      const currentDate = this.data.reportDateValue;
      const shopName = this.data.shopName;

      try {
        if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
        const db = wx.cloud.database();
        const _ = db.command;
        // 🔑 数据隔离修复：强带 storeId / shopName 过滤，防止跨门店数据混淆
        const currentStoreId = this.data.currentStoreId || wx.getStorageSync('current_store_id') || '';
        const balanceHistoryWhere: any = {
          dateString: _.lt(currentDate)
        };
        // 超管全国总览时不加门店过滤
        if (currentStoreId && currentStoreId !== 'national_overview' && currentStoreId !== 'ALL_STORES') {
          balanceHistoryWhere.storeId = currentStoreId;
        } else if (shopName && shopName !== '全部门店') {
          balanceHistoryWhere.shopName = shopName;
        } else {
          // 🏢 多租户边界：全国总览场景仍需收敛到调用者所属机构，绝不跨机构读取余额历史
          const cachedRoleInfoForTenant = AuthService.getCachedRoleInfo();
      const tenantId = (cachedRoleInfoForTenant && cachedRoleInfoForTenant.tenantId) || '';
          if (tenantId) {
            balanceHistoryWhere.tenantId = tenantId;
          }
        }
        // 🛡️ 真机弱网熔断：finally 只有在 await 的 Promise 真正落定（resolve 或
        // reject）后才会执行——真机弱网下请求可能既不成功也不报错，直接悬挂
        // 不 settle，这种情况下 try/catch/finally 本身无能为力，遮罩会一直卡住。
        // 用 Promise.race 叠加 4 秒强制超时保险丝，4 秒内请求仍未落定就主动放弃、
        // 转入下面的本地兜底，确保真机上无论网络多差都不会无限转圈。
        let timeoutId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => reject(new Error('TIMEOUT')), 4000);
        });
        const res: any = await Promise.race([
          db.collection('report_logs')
            .where(balanceHistoryWhere)
            .orderBy('dateString', 'desc')
            .limit(15)
            .get(),
          timeoutPromise
        ]);
        clearTimeout(timeoutId!);

        if (res.data && res.data.length > 0) {
          rawList = res.data;
        }
      } catch (err: any) {
        console.warn('云端调取失败，转入本地缓存:', err);
        wx.showToast({
          title: err && err.message === 'TIMEOUT' ? '请求超时，已加载本地缓存' : '网络异常，已加载本地数据',
          icon: 'none'
        });
      }

      if (rawList.length === 0) {
        const localRecords = wx.getStorageSync('local_report_logs') || [];
        rawList = localRecords.filter((r: any) => {
          if (!r) return false;
          const rDate = r.dateString || r.reportDate || r.date || '';
          return rDate && rDate < currentDate;
        }).sort((a: any, b: any) => {
          const da = a.dateString || a.reportDate || a.date || '';
          const db = b.dateString || b.reportDate || b.date || '';
          return db.localeCompare(da);
        }).slice(0, 15);
      }

      const currentBal = parseFloat(this.data.yesterdayBalance || 0).toFixed(2);

      const formattedList = rawList.map((item: any) => {
        const yBal = parseFloat(item.yesterdayBalance || item.prevBalance || 0);
        const inc = parseFloat(item.income || item.loveIncome || item.totalDonation || 0);
        const exp = parseFloat(item.expense || item.todayExpense || item.totalExpense || 0);
        const endBal = parseFloat(item.todayBalance || item.closingBalance || item.endBalance || (yBal + inc - exp));
        const endBalStr = endBal.toFixed(2);

        return {
          reportDate: item.dateString || item.reportDate || item.date || '未知日期',
          yesterdayBal: yBal.toFixed(2),
          income: inc.toFixed(2),
          expense: exp.toFixed(2),
          endingBalance: endBalStr,
          isCurrentMatched: endBalStr === currentBal
        };
      });

      this.setData({
        recentBalanceHistoryList: formattedList,
        showBalanceHistoryModal: true
      });
    } catch (err) {
      console.error('[onOpenBalanceHistoryModal] 拉取账目流水异常，本地兜底也失败:', err);
      wx.showToast({ title: '数据加载异常，请稍后重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onCloseBalanceHistoryModal() {
    this.setData({ showBalanceHistoryModal: false });
  },

  onApplyHistoryBalance(e: any) {
    const item = e.currentTarget.dataset.item;
    const selectedBal = item.endingBalance;
    const selectedDate = item.reportDate;

    let displayLabel = selectedDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
      displayLabel = `${selectedDate.substring(5, 7)}月${selectedDate.substring(8, 10)}日`;
    }

    this.setData({
      yesterdayBalance: selectedBal,
      isBalanceLocked: false,
      isManualAdjust: true,
      balanceDiff: parseFloat(selectedBal) - this.data.systemBalance,
      balanceMatchTip: `已一键代入 ${displayLabel} 期末结余 ¥${selectedBal}`,
      showBalanceHistoryModal: false
    });

    this.updateRealTimeBalance();

    wx.showToast({
      title: `已成功代入 ${displayLabel} 结余`,
      icon: 'success',
      duration: 1500
    });
  },

  onYesterdayBalanceInput(e: any) {
    const value = e.detail.value;
    const displayBalance = parseFloat(value) || 0;
    const { systemBalance } = this.data;
    
    const isManualAdjust = displayBalance !== systemBalance;
    const balanceDiff = isManualAdjust ? displayBalance - systemBalance : 0;
    
    this.setData({
      yesterdayBalance: value,
      isManualAdjust: isManualAdjust,
      balanceDiff: balanceDiff,
      adjustReason: isManualAdjust ? this.data.adjustReason : ''
    });

    this.updateRealTimeBalance();
    this.debouncedSaveDraft();
  },

  onDateChange(e: any) {
    const dateValue = e.detail.value;
    const parts = dateValue.split('-');
    const yy = parts[0];
    const mm = parts[1];
    const dd = parts[2];

    const todayStr = this.getFormattedDateStr(0);
    const yesterdayStr = this.getFormattedDateStr(-1);

    const storeId = this.data.currentStoreId || '';
    const hasEditPerm = this.data.permissions && this.data.permissions.canEditBalance;

    if (storeId && hasEditPerm) {
      this.releaseDraftLock();
    }

    this.setData({
      reportDateValue: dateValue,
      reportDate: `${yy}年${mm}月${dd}日`,
      isTodaySelected: dateValue === todayStr,
      isYesterdaySelected: dateValue === yesterdayStr
    });
    this.checkExistingRecord(dateValue);
    this.loadBalanceForDate(dateValue);
    this.loadDraftByDate(dateValue, this.data.shopName);
    this.debouncedSaveDraft();

    if (storeId && hasEditPerm) {
      this.checkAndAcquireLock(storeId, dateValue);
    }
  },

  onSelectQuickDate(e: any) {
    const type = e.currentTarget.dataset.type;
    const dateStr = this.getFormattedDateStr(type === 'today' ? 0 : -1);
    const parts = dateStr.split('-');
    const yy = parts[0];
    const mm = parts[1];
    const dd = parts[2];

    this.setData({
      reportDateValue: dateStr,
      reportDate: `${yy}年${mm}月${dd}日`,
      isTodaySelected: type === 'today',
      isYesterdaySelected: type === 'yesterday'
    });
    this.checkExistingRecord(dateStr);
    this.loadBalanceForDate(dateStr);
    this.debouncedSaveDraft();

    const storeId = this.data.currentStoreId || '';
    if (storeId && this.data.permissions && this.data.permissions.canEditBalance) {
      this.releaseDraftLock();
      this.checkAndAcquireLock(storeId, dateStr);
    }
  },

  async checkExistingRecord(dateString: string) {
    const allRecords = wx.getStorageSync('local_report_logs') || [];
    const normalizeStore = (str: string) => (str || '').replace(/[区市省店\s]/g, '').trim();
    const cleanCurrentStore = normalizeStore(this.data.shopName);

    const parseDateToTuple = (dateStr: string): { y: number; m: number; d: number } | null => {
      if (!dateStr) return null;
      let str = String(dateStr).trim();
      if (/^\d{2}年/.test(str)) str = '20' + str;
      const match = str.match(/(\d{4})[\-\/年\.](\d{1,2})[\-\/月\.](\d{1,2})/);
      if (match) {
        return {
          y: parseInt(match[1], 10),
          m: parseInt(match[2], 10),
          d: parseInt(match[3], 10)
        };
      }
      return null;
    };

    const curTuple = parseDateToTuple(dateString);
    if (!curTuple) return;

    const exactRecord = allRecords.find((item: any) => {
      const recordStore = normalizeStore(item.shopName);
      const isStoreMatch = recordStore.includes(cleanCurrentStore) || cleanCurrentStore.includes(recordStore);
      const recTuple = parseDateToTuple(item.dateString || item.reportDate);
      return isStoreMatch && recTuple && recTuple.y === curTuple.y && recTuple.m === curTuple.m && recTuple.d === curTuple.d;
    });

    if (exactRecord) {
      wx.showModal({
        title: '已存在当日餐报',
        content: `检测到【${this.data.shopName}】在 ${curTuple.m}月${curTuple.d}日 已有餐报记录，是否直接载入修改？`,
        confirmText: '载入修改',
        cancelText: '新建覆盖',
        success: (res) => {
          if (res.confirm) {
            this.loadRecordIntoForm(exactRecord);
          }
        }
      });
      return;
    }

    // 🌟 本地缓存查重未命中时（如他人/其他设备已提交、或本机缓存已清空），
    // 兜底向云端查询同门店+同日期是否已存在记录，避免造成资金流水断裂的重复录入
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const db = wx.cloud.database();
      const cloudWhere: any = { dateString: dateString, shopName: this.data.shopName };
      if (this.data.currentStoreId) {
        cloudWhere.storeId = this.data.currentStoreId;
      }
      const cloudRes = await db.collection('report_logs').where(cloudWhere).limit(1).get();

      if (cloudRes.data && cloudRes.data.length > 0) {
        wx.showModal({
          title: '⚠️ 重复录入提醒',
          content: '该日期已存在餐报记录，请直接在历史记录中编辑或修改，避免重复录入',
          confirmText: '去历史记录',
          cancelText: '我知道了',
          success: (res) => {
            if (res.confirm) {
              wx.navigateTo({ url: '/pages/history/history' });
            }
          }
        });
      }
    } catch (err) {
      console.warn('[checkExistingRecord] 云端查重失败，跳过:', err);
    }
  },

  getFormattedDateStr(offsetDays: number = 0): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  async loadBalanceForDate(dateString: string) {
    if (this.data.isEditMode) return;
    
    const shopName = this.data.shopName;
    const mpAccount = this.data.mpAccount;

    if (!shopName || !dateString || !isValidIsoDate(dateString)) {
      return;
    }

    const targetPrevDate = getPrevDayIsoString(dateString);
    const shortPrevLabel = formatDateToCnShort(targetPrevDate);

    const reqSeq = ++this._balanceReqSeq;

    try {
      const result = await DataService.getPreviousBalance(shopName, mpAccount, dateString);

      if (reqSeq !== this._balanceReqSeq) {
        return;
      }

      if (result.success && result.data && result.data.balance != null) {
        const balance = this.validateBalance(result.data.balance);
        const systemBalanceNum = parseFloat(result.data.balance) || 0;
        
        const matchedDate = result.data.dateString;
        let tipDate = shortPrevLabel;
        if (matchedDate && isValidIsoDate(matchedDate)) {
          tipDate = formatDateToCnShort(matchedDate);
        }

        const matchType = result.data.matchType || '';
        let tipMsg = '';
        
        if (matchType === 'exact' || matchType === 'exact_date') {
          tipMsg = `✓ 已自动匹配 ${tipDate} 结余`;
        } else {
          tipMsg = `✓ 已自动代入 ${tipDate} 结余`;
        }

        // 📋 【一键复用昨日数据】：与结余匹配同一次查询，顺手带出上一条记录的
        // 用餐/义工细分统计快照；全部为 0（老记录没有细分字段）时视为无可复用数据
        const snapshot = {
          dineInSeniors: parseFloat(result.data.dineInSeniors) || 0,
          deliverySeniors: parseFloat(result.data.deliverySeniors) || 0,
          takeawayCount: parseFloat(result.data.takeawayCount) || 0,
          dineInVolunteers: parseFloat(result.data.dineInVolunteers) || 0,
          deliveryVolunteers: parseFloat(result.data.deliveryVolunteers) || 0,
          volunteerHours: parseFloat(result.data.volunteerHours) || 0
        };
        const hasYesterdayStats = Object.values(snapshot).some((v) => v > 0);

        this.setData({
          prevBalance: balance,
          yesterdayBalance: balance,
          systemBalance: systemBalanceNum,
          isManualAdjust: false,
          balanceDiff: 0,
          adjustReason: '',
          balanceMatchTip: tipMsg,
          yesterdayBalDisplay: systemBalanceNum.toFixed(2),
          yesterdayStatsSnapshot: snapshot,
          hasYesterdayStats
        });
        this.updateRealTimeBalance();
      } else {
        this.setData({
          prevBalance: '0.00',
          yesterdayBalance: '0.00',
          systemBalance: 0,
          isManualAdjust: false,
          balanceDiff: 0,
          adjustReason: '',
          balanceMatchTip: `💡 首次记账，请输入初始余额`,
          yesterdayBalDisplay: '0.00',
          yesterdayStatsSnapshot: null,
          hasYesterdayStats: false
        });
        this.updateRealTimeBalance();
      }
    } catch (error) {
      console.error('[loadBalanceForDate] 查询失败:', error);
      if (reqSeq !== this._balanceReqSeq) return;
      this.setData({
        balanceMatchTip: `⚠️ 查询失败，请手动输入 ${shortPrevLabel} 余额`
      });
    }
  },

  loadRecordIntoForm(record: any) {
    this.setData({
      isEditMode: true,
      reportDate: record.reportDate || '',
      reportDateValue: record.dateString || '',
      yesterdayBalance: record.yesterdayBalance != null ? String(record.yesterdayBalance) : '',
      otherDonation: record.otherDonation != null ? String(record.otherDonation) : '',
      expenses: record.expenses || '',
      dailyExpenseText: record.dailyExpenseText || '',
      fixedExpenseText: record.fixedExpenseText || '',
      volunteerCount: record.volunteerCount != null ? String(record.volunteerCount) : '',
      volunteerHours: record.volunteerHours != null ? String(record.volunteerHours) : '',
      diningCount: record.diningCount != null ? String(record.diningCount) : '',
      dineInSeniors: record.dineInSeniors != null ? String(record.dineInSeniors) : '',
      deliverySeniors: record.deliverySeniors != null ? String(record.deliverySeniors) : '',
      dineInVolunteers: record.dineInVolunteers != null ? String(record.dineInVolunteers) : '',
      deliveryVolunteers: record.deliveryVolunteers != null ? String(record.deliveryVolunteers) : '',
      takeawayCount: record.takeawayCount != null ? String(record.takeawayCount) : '',
      materialsInput: record.materialsInput || '',
      balanceMatchTip: '已载入历史记录'
    });
    // 老记录没有细分字段时，上面已按原样恢复 diningCount/volunteerCount，不重算覆盖；
    // 只有记录本身带细分字段时才需要重新对齐 totalDineCount/totalVolunteers 展示
    if (record.dineInSeniors != null || record.deliverySeniors != null || record.dineInVolunteers != null || record.deliveryVolunteers != null || record.takeawayCount != null) {
      this.recalcDiningStats();
    }
    this.updateDailyExpenseParsePreview(record.dailyExpenseText || '');

    if (record.donationItems && record.donationItems.length > 0) {
      const text = record.donationItems.map((item: any) => `${item.name} ${item.amount}`).join('\n');
      this.setData({ allDonations: text });
      this.updateParseResult(text);
    }

    if (record.materials && record.materials.length > 0) {
      const text = record.materials.map((m: any) => `${m.donor}：${m.item}${m.quantity}${m.unit}`).join('；');
      this.setData({ materialsInput: text });
      this.updateMaterialsParse(text);
    }

    // 🌟 大额专项：优先用记录里已有的结构化 fixedExpenseItems（本功能上线后提交的
    // 新记录，能保留原来挂的独立凭证图片）；老记录没有这个字段时，从 fixedExpenseText
    // 反解析出条目展示（图片天然为空，老数据本来就没有独立凭证）。
    if (Array.isArray(record.fixedExpenseItems) && record.fixedExpenseItems.length > 0) {
      this.setData({
        fixedExpenseItems: record.fixedExpenseItems.map((item: any) => ({
          _key: item._key || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: item.name || '',
          amount: item.amount != null ? String(item.amount) : '0.00',
          independent_image_urls: Array.isArray(item.independent_image_urls) ? item.independent_image_urls : [],
          expanded: false
        }))
      });
    } else {
      this.setData({ fixedExpenseItems: this.parseFixedExpenseTextToItems(record.fixedExpenseText || '') });
    }
  },

  updateRealTimeBalance() {
    // 🌟 唯一权威计算入口，见 computeTodayFinancials 顶部注释；算式校验文案也直接取
    // computeTodayFinancials 生成好的 formulaString，不再在这里手写模板字符串
    const { yesterdayBalance: yesterdayBalanceNum, todayIncome: parsedTotalIncome, todayExpense: totalExpense, todayBalance, formulaString: calculationFormulaText } = this.computeTodayFinancials();
    const computedTodayBalance = todayBalance.toFixed(2);

    this.setData({
      parsedTotalIncome,
      totalExpense,
      computedTodayBalance,
      yesterdayBalDisplay: yesterdayBalanceNum.toFixed(2),
      totalIncomeDisplay: parsedTotalIncome.toFixed(2),
      totalExpenseDisplay: totalExpense.toFixed(2),
      previewTodayBalanceDisplay: computedTodayBalance,
      calculationFormulaText
    });
  },

  validateBeforeSubmit(): Promise<boolean> {
    const { yesterdayBalance, diningCount, expenses, dailyExpenseText, fixedExpenseText } = this.data;

    const totalExpense = (parseFloat(expenses) || 0) + 
                        (parseFloat(dailyExpenseText) || 0) + 
                        (parseFloat(fixedExpenseText) || 0);

    return new Promise((resolve) => {
      if (!yesterdayBalance || parseFloat(yesterdayBalance) === 0) {
        wx.showModal({
          title: '昨日余额未填写',
          content: '当前“昨日店铺余额”为 0 或为空，生成的报表结余可能会有误，确定要继续吗？',
          confirmText: '继续生成',
          cancelText: '去填写',
          success: (res) => {
            if (res.confirm) {
              if (totalExpense > 0 && (!diningCount || parseInt(diningCount) === 0)) {
                wx.showModal({
                  title: '用餐人数未填写',
                  content: '检测到今日有开餐支出，但“今日结缘用餐人次”为 0，是否补充？',
                  confirmText: '仍要生成',
                  cancelText: '补充人数',
                  success: (res2) => resolve(res2.confirm)
                });
              } else {
                resolve(true);
              }
            } else {
              resolve(false);
            }
          }
        });
      } else if (totalExpense > 0 && (!diningCount || parseInt(diningCount) === 0)) {
        wx.showModal({
          title: '用餐人数未填写',
          content: '检测到今日有开餐支出，但“今日结缘用餐人次”为 0，是否补充？',
          confirmText: '仍要生成',
          cancelText: '补充人数',
          success: (res) => resolve(res.confirm)
        });
      } else {
        resolve(true);
      }
    });
  },

  resetForm() {
    wx.showModal({
      title: '提示',
      content: '确定要清空当前输入的名单、赞助金额和支出说明吗？',
      success: (res) => {
        if (res.confirm) {
          const now = new Date();
          const yyyy = String(now.getFullYear());
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const dd = String(now.getDate()).padStart(2, '0');
          
          this.setData({
            allDonations: '',
            otherDonation: '',
            expenses: '',
            dailyExpenseText: '',
            dailyExpenseParseCount: 0,
            dailyExpenseParseAmount: '0.00',
            fixedExpenseText: '',
            fixedExpenseItems: [],
            reportResult: '',
            showResult: false,
            calculationFormulaText: '',
            reportDate: `${yyyy}年${mm}月${dd}日`,
            reportDateValue: `${yyyy}-${mm}-${dd}`,
            hasDraft: false
          });
          this.updateRealTimeBalance();
          
          this.clearDraft();
          wx.showToast({ title: '已清空', icon: 'success' });
        }
      }
    });
  },

  onInput(e: any) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    this.setData({ [field]: value });
    
    if (field === 'allDonations') {
      this.updateParseResult(value);
    }

    if (field === 'otherDonation' || field === 'expenses' || field === 'dailyExpenseText' || field === 'fixedExpenseText') {
      this.updateRealTimeBalance();
    }

    if (field === 'dailyExpenseText') {
      this.updateDailyExpenseParsePreview(value);
    }

    if (field === 'dineInSeniors' || field === 'deliverySeniors' || field === 'dineInVolunteers' || field === 'deliveryVolunteers' || field === 'takeawayCount') {
      this.recalcDiningStats();
    }

    if (field === 'shopName' || field === 'mpAccount') {
      this.saveSettings();
    }

    if ((field === 'shopName' || field === 'mpAccount') && value.trim()) {
      // 防抖：店铺名称或公众号名称变更后延迟查询余额
      if (this._shopNameTimer) clearTimeout(this._shopNameTimer);
      this._shopNameTimer = setTimeout(() => {
        this.loadBalanceForDate(this.data.reportDateValue);
      }, 800);
    }

    this.debouncedSaveDraft();
  },

  // 🍱 用餐/义工细分统计实时计算：用餐总数 = 堂食长者+送餐长者+打包+堂食志愿者；
  // 志愿者总人次 = 送餐志愿者+堂食志愿者。计算结果同时镜像进 diningCount/volunteerCount，
  // 使统计大屏、海报生成、Excel 导出、风控校验等一切既有下游无需感知本次细分字段改造
  recalcDiningStats() {
    const { dineInSeniors, deliverySeniors, dineInVolunteers, deliveryVolunteers, takeawayCount } = this.data;
    const nDineInSeniors = parseFloat(dineInSeniors) || 0;
    const nDeliverySeniors = parseFloat(deliverySeniors) || 0;
    const nDineInVolunteers = parseFloat(dineInVolunteers) || 0;
    const nDeliveryVolunteers = parseFloat(deliveryVolunteers) || 0;
    const nTakeaway = parseFloat(takeawayCount) || 0;

    const totalDineCount = nDineInSeniors + nDeliverySeniors + nTakeaway + nDineInVolunteers;
    const totalVolunteers = nDeliveryVolunteers + nDineInVolunteers;

    this.setData({
      totalDineCount: String(totalDineCount),
      totalVolunteers: String(totalVolunteers),
      diningCount: String(totalDineCount),
      volunteerCount: String(totalVolunteers)
    });
  },

  // 📋 【一键复用昨日数据】：把 loadBalanceForDate 时顺手带出的昨日细分统计快照
  // 填进当前表单的 6 个输入框，方便义工在昨日基础上快速微调而不用从零重填
  onReuseYesterdayStats() {
    const snapshot = this.data.yesterdayStatsSnapshot;
    if (!snapshot || !this.data.hasYesterdayStats) {
      wx.showToast({ title: '暂无昨日数据可复用', icon: 'none' });
      return;
    }

    this.setData({
      dineInSeniors: String(snapshot.dineInSeniors),
      deliverySeniors: String(snapshot.deliverySeniors),
      takeawayCount: String(snapshot.takeawayCount),
      dineInVolunteers: String(snapshot.dineInVolunteers),
      deliveryVolunteers: String(snapshot.deliveryVolunteers),
      volunteerHours: String(snapshot.volunteerHours)
    });
    this.recalcDiningStats();
    this.debouncedSaveDraft();
    wx.showToast({ title: '已复用昨日数据，可继续微调', icon: 'none' });
  },

  onMaterialsInput(e: any) {
    const value = e.detail.value;
    this.updateMaterialsParse(value);
    this.debouncedSaveDraft();
  },

  updateParseResult(text: string) {
    const result = parseDonorText(text);
    this.setData({
      parseResult: result,
      totalParsedAmount: result.totalAmount.toFixed(2)
    });
    this.updateRealTimeBalance();
  },

  // 🌟 第二道防线：文本行级去重。图片 MD5 只能拦住"完全相同的一张图片"，拦不住
  // "两张不同截图之间有重叠区域"（比如义工分两段截了同一个群收款列表，中间几条
  // 重复出现）。这里复用 parseDonorText（与"批量粘贴"栏同一套解析口径，不再另起
  // 一套判定逻辑）：把已经填在输入框里的旧文本、和这次 OCR 新识别出来的文本都各自
  // 解析成 {姓名, 金额} 结构，只要【姓名】和【金额】完全一致就判定为同一笔，
  // 新识别出来的那一行直接剔除，不追加进输入框——被剔除的这一条不进入任何计算，
  // 从根源上避免同一笔供养被计入两次。
  filterDuplicateDonorLines(existingText: string, newFormattedText: string): { keptText: string; removedCount: number } {
    const existingItems = parseDonorText(existingText).items;
    const existingKeys = new Set(existingItems.map(item => `${item.name}__${item.amount}`));

    const keptLines: string[] = [];
    let removedCount = 0;

    newFormattedText.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // 对单行文本复用同一个解析函数，取其识别出的姓名/金额做比对；
      // 解析不出有效条目（如格式异常的行）一律原样保留，不参与去重判定，
      // 避免把"识别不出来"误判成"重复"而静默丢弃真实数据
      const singleLineItems = parseDonorText(trimmed).items;
      if (singleLineItems.length === 1) {
        const key = `${singleLineItems[0].name}__${singleLineItems[0].amount}`;
        if (existingKeys.has(key)) {
          removedCount++;
          return;
        }
        // 同时纳入本次已保留的条目，防止这一次 OCR 结果内部自身就有重复
        existingKeys.add(key);
      }

      keptLines.push(trimmed);
    });

    return { keptText: keptLines.join('\n'), removedCount };
  },

  // 🌟 历史名单·本地高频常客记录：每次餐报保存成功后（见 saveReportAsync），
  // 把这一天的爱心支持名单里出现过的姓名各计一次，写进本地缓存 frequentDonorNames。
  // 只做"计数"，不记具体金额——同一位常客每天供养的金额未必相同，选择常客时
  // 只应该帮用户免打字把姓名填进去，金额还是要用户自己看着当天的实际数目填。
  recordDonorFrequency(items: any[]) {
    if (!items || items.length === 0) return;
    try {
      const map = wx.getStorageSync('frequentDonorNames') || {};
      items.forEach((item: any) => {
        const name = ((item && item.name) || '').trim();
        if (!name) return;
        map[name] = (map[name] || 0) + 1;
      });
      wx.setStorageSync('frequentDonorNames', map);
    } catch (e) {
      console.warn('[recordDonorFrequency] 写入本地常客名单失败:', e);
    }
  },

  onOpenFrequentDonorPicker() {
    let map: Record<string, number> = {};
    try {
      map = wx.getStorageSync('frequentDonorNames') || {};
    } catch (e) {
      console.warn('[onOpenFrequentDonorPicker] 读取本地常客名单失败:', e);
    }
    const list = Object.keys(map)
      .map(name => ({ name, count: map[name] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    this.setData({ showFrequentDonorModal: true, frequentDonorList: list });
  },

  onCloseFrequentDonorModal() {
    this.setData({ showFrequentDonorModal: false });
  },

  onSelectFrequentDonor(e: any) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;

    const current = (this.data.allDonations || '').trim();
    // 只插入姓名，另起一行等用户接着填当天的金额；不预填金额数字，
    // 避免用户漏改、把上一次的旧金额误当成这一次的实际供养额直接提交
    const merged = current ? (current + '\n' + name) : name;

    this.setData({
      allDonations: merged,
      inputMode: 'text',
      showFrequentDonorModal: false
    });
    this.updateParseResult(merged);
    this.debouncedSaveDraft();
  },

  // 🌟 高频账目模板：门店常用支出项目速录。云端存储（manageExpenseTemplate），
  // 店长/财务/超管可维护，全员可用——与「选择常客」（本地设备记忆）不同，这里
  // 是店铺共享配置，任何一台设备添加的模板，同店其他人打开都能看到。

  _openExpenseTemplateModal(category: 'daily' | 'fixed') {
    const targetField = category === 'fixed' ? 'fixedExpenseText' : 'dailyExpenseText';
    this.setData({
      showExpenseTemplateModal: true,
      expenseTemplateCategory: category,
      expenseTemplateTargetField: targetField,
      expenseTemplateEditMode: false,
      expenseTemplateNewName: '',
      expenseTemplateNewAmount: ''
    });
    if (!this.data.expenseTemplateLoaded) {
      this.fetchExpenseTemplateList();
    }
  },

  onOpenExpenseTemplateModal(e: any) {
    const category = (e.currentTarget.dataset.category === 'fixed') ? 'fixed' : 'daily';
    this._openExpenseTemplateModal(category);
  },

  onCloseExpenseTemplateModal() {
    this.setData({ showExpenseTemplateModal: false, expenseTemplateEditMode: false });
  },

  onSwitchExpenseTemplateCategory(e: any) {
    const category = (e.currentTarget.dataset.category === 'fixed') ? 'fixed' : 'daily';
    const targetField = category === 'fixed' ? 'fixedExpenseText' : 'dailyExpenseText';
    this.setData({ expenseTemplateCategory: category, expenseTemplateTargetField: targetField });
  },

  onToggleExpenseTemplateEditMode() {
    if (!(this.data.isManager || this.data.isFinance || this.data.isSuperAdmin)) return;
    this.setData({
      expenseTemplateEditMode: !this.data.expenseTemplateEditMode,
      expenseTemplateNewName: '',
      expenseTemplateNewAmount: ''
    });
  },

  async fetchExpenseTemplateList() {
    const storeId = this.data.currentStoreId;
    if (!storeId || storeId === 'national_overview' || storeId === 'ALL_STORES') {
      this.setData({ expenseTemplateDailyList: [], expenseTemplateFixedList: [], expenseTemplateLoaded: true });
      return;
    }

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'manageExpenseTemplate',
        data: { action: 'list', storeId }
      });
      const result = res.result as any;
      const list = (result && result.success && Array.isArray(result.data)) ? result.data : [];
      this.setData({
        expenseTemplateDailyList: list.filter((item: any) => item.category === 'daily'),
        expenseTemplateFixedList: list.filter((item: any) => item.category === 'fixed'),
        expenseTemplateLoaded: true
      });
    } catch (e) {
      console.error('[fetchExpenseTemplateList] 查询失败:', e);
      this.setData({ expenseTemplateLoaded: true });
    }
  },

  onSelectExpenseTemplateItem(e: any) {
    if (this.data.expenseTemplateEditMode) return; // 管理态下点击不触发插入，避免误触

    const { name, amount, id } = e.currentTarget.dataset;
    if (!name) return;

    // 🔥 使用频次埋点：点了就算一次，不阻塞主流程——失败静默，不影响记账本身
    this.bumpExpenseTemplateUsage(id);

    // 🌟 大额专项（fixed）已改为结构化 fixedExpenseItems（见 onAddFixedExpenseItem
    // 同款字段形状），一键插入 = 直接落一条新记录，而不是像 daily 分类那样拼文本——
    // 这样插入后立刻就能挂独立凭证，金额也仍可在列表里直接改。⚡ 插入后关掉常用项目
    // 弹窗，回到始终可见的记账表单，并把这条新记录的金额输入框自动 focus 一次，
    // 一步到位极速记账
    if (this.data.expenseTemplateCategory === 'fixed') {
      const newItem = {
        _key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        amount: ((amount !== '' && amount !== undefined) ? parseFloat(amount) : 0).toFixed(2),
        independent_image_urls: [] as string[],
        expanded: false,
        _focusAmount: true
      };
      this.setData({
        fixedExpenseItems: [...this.data.fixedExpenseItems.map((it: any) => ({ ...it, _focusAmount: false })), newItem],
        showExpenseTemplateModal: false
      });
      this.regenerateFixedExpenseText();
      return;
    }

    // ⚡ 开餐食材：不再静默拼接文本——关闭常用项目弹窗，弹出「金额确认」迷你框，
    // 项目名称已带入、金额输入框自动 focus，确认后才真正拼进 dailyExpenseText
    this.setData({
      showExpenseTemplateModal: false,
      showQuickAmountModal: true,
      quickAmountItemName: name,
      quickAmountValue: (amount !== '' && amount !== undefined) ? String(amount) : ''
    });
  },

  // 🔥 使用频次：静默调用，不 await、不提示成功/失败——这是次要的埋点动作，
  // 不该让用户感知到任何等待或干扰主流程（记账）本身
  bumpExpenseTemplateUsage(id: string) {
    if (!id || !isCloudAvailable()) return;
    wx.cloud.callFunction({
      name: 'manageExpenseTemplate',
      data: { action: 'incrementUsage', id }
    }).catch((err) => console.warn('[bumpExpenseTemplateUsage] 计数失败（不影响记账）:', err));
  },

  onCloseQuickAmountModal() {
    this.setData({ showQuickAmountModal: false, quickAmountItemName: '', quickAmountValue: '' });
  },

  onInputQuickAmountValue(e: any) {
    this.setData({ quickAmountValue: e.detail.value });
  },

  // ⚡ 确认金额：拼接格式与旧的静默插入路径完全一致（`名称：¥金额`，未填金额则只插
  // 名称），确保 calculateTodayExpenseFromText 仍能正确识别这一行计入今日支出总额
  onConfirmQuickAmount() {
    const name = this.data.quickAmountItemName;
    if (!name) return;

    const amountStr = (this.data.quickAmountValue || '').trim();
    if (amountStr && (isNaN(parseFloat(amountStr)) || parseFloat(amountStr) < 0)) {
      wx.showToast({ title: '请输入正确的金额', icon: 'none' });
      return;
    }

    const line = amountStr ? `${name}：¥${parseFloat(amountStr).toFixed(2)}` : name;
    const field = this.data.expenseTemplateTargetField;
    const current = (this.data as any)[field] || '';
    const merged = current ? (current + '\n\n' + line) : line;

    this.setData({
      [field]: merged,
      showQuickAmountModal: false,
      quickAmountItemName: '',
      quickAmountValue: ''
    } as any);

    // 代码直接 setData 绕过了真实的 <textarea> bindinput，需要手动补上
    // onInput 本该为这两个字段触发的副作用
    this.updateRealTimeBalance();
    this.debouncedSaveDraft();
  },

  // 🌟 新插入的大额专项条目金额框完成一次自动 focus 后，清掉标记——避免 WXML 里
  // 那个 <input focus="{{item._focusAmount}}"> 因为该字段一直是 true 而在下次
  // setData 时被判定为"值没变"从而不重新触发 focus（后续再插入新条目时，前一条
  // 也已被统一置回 false，这里只是双保险）
  onFixedExpenseAmountFocused(e: any) {
    const index = e.currentTarget.dataset.index;
    if (index === undefined || index === null) return;
    const key = `fixedExpenseItems[${index}]._focusAmount`;
    this.setData({ [key]: false } as any);
  },

  onInputExpenseTemplateNewName(e: any) {
    this.setData({ expenseTemplateNewName: e.detail.value });
  },

  onInputExpenseTemplateNewAmount(e: any) {
    this.setData({ expenseTemplateNewAmount: e.detail.value });
  },

  // 💡 空状态一键预置：降低首次配置成本，按当前分类批量导入几个高频项目，
  // 逐条调用既有的 create（而不是新开一个批量云函数），量级只有 2~3 条，
  // 已存在同名的会被服务端拒绝（"该分类下已存在同名项目"），静默跳过不中断整批
  async onQuickImportExpenseTemplates() {
    if (!(this.data.isManager || this.data.isFinance || this.data.isSuperAdmin)) {
      wx.showToast({ title: '仅店长/财务/超管可导入常用标签', icon: 'none' });
      return;
    }
    const storeId = this.data.currentStoreId;
    if (!storeId || storeId === 'national_overview' || storeId === 'ALL_STORES') {
      wx.showToast({ title: '请先选择具体门店', icon: 'none' });
      return;
    }
    if (this.data.expenseTemplateSaving) return;

    const category = this.data.expenseTemplateCategory;
    const presets = EXPENSE_TEMPLATE_PRESETS[category] || [];
    if (presets.length === 0) return;

    this.setData({ expenseTemplateSaving: true });
    wx.showLoading({ title: '正在导入...', mask: true });

    let importedCount = 0;
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      for (const name of presets) {
        try {
          const res = await wx.cloud.callFunction({
            name: 'manageExpenseTemplate',
            data: { action: 'create', storeId, category, itemName: name }
          });
          const result = res.result as any;
          if (result && result.success) importedCount++;
        } catch (err) {
          console.warn('[onQuickImportExpenseTemplates] 单条导入失败:', name, err);
        }
      }
      await this.fetchExpenseTemplateList();
      wx.hideLoading();
      wx.showToast({
        title: importedCount > 0 ? `已导入 ${importedCount} 个常用标签` : '常用标签已是最新，无需重复导入',
        icon: importedCount > 0 ? 'success' : 'none'
      });
    } catch (e) {
      wx.hideLoading();
      console.error('[onQuickImportExpenseTemplates] 导入失败:', e);
      wx.showToast({ title: '导入失败，请重试', icon: 'none' });
    } finally {
      this.setData({ expenseTemplateSaving: false });
    }
  },

  async onAddExpenseTemplateItem() {
    const name = (this.data.expenseTemplateNewName || '').trim();
    if (!name) {
      wx.showToast({ title: '请输入项目名称', icon: 'none' });
      return;
    }
    if (this.data.expenseTemplateSaving) return;

    const storeId = this.data.currentStoreId;
    if (!storeId || storeId === 'national_overview' || storeId === 'ALL_STORES') {
      wx.showToast({ title: '请先选择具体门店', icon: 'none' });
      return;
    }

    this.setData({ expenseTemplateSaving: true });
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');
      const res = await wx.cloud.callFunction({
        name: 'manageExpenseTemplate',
        data: {
          action: 'create',
          storeId,
          category: this.data.expenseTemplateCategory,
          itemName: name,
          defaultAmount: this.data.expenseTemplateNewAmount || undefined
        }
      });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ expenseTemplateNewName: '', expenseTemplateNewAmount: '' });
        await this.fetchExpenseTemplateList();
      } else {
        wx.showToast({ title: (result && result.error) || '添加失败', icon: 'none' });
      }
    } catch (e) {
      console.error('[onAddExpenseTemplateItem] 添加失败:', e);
      wx.showToast({ title: '添加失败，请重试', icon: 'none' });
    } finally {
      this.setData({ expenseTemplateSaving: false });
    }
  },

  onDeleteExpenseTemplateItem(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.showModal({
      title: '提示',
      content: '确定要删除这条常用项目吗？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');
          const cbRes = await wx.cloud.callFunction({
            name: 'manageExpenseTemplate',
            data: { action: 'delete', id }
          });
          const result = cbRes.result as any;
          if (result && result.success) {
            await this.fetchExpenseTemplateList();
          } else {
            wx.showToast({ title: (result && result.error) || '删除失败', icon: 'none' });
          }
        } catch (err) {
          console.error('[onDeleteExpenseTemplateItem] 删除失败:', err);
          wx.showToast({ title: '删除失败，请重试', icon: 'none' });
        }
      }
    });
  },

  // ✏️ 管理态重命名：复用 wx.showModal 的 editable 单行输入能力，不需要为此单独
  // 建一个自定义弹窗——与「删除」共用同一套 wx.showModal 确认交互语言
  onRenameExpenseTemplateItem(e: any) {
    const { id, name } = e.currentTarget.dataset;
    if (!id) return;

    wx.showModal({
      title: '重命名常用项目',
      editable: true,
      placeholderText: name || '请输入新名称',
      success: async (res) => {
        if (!res.confirm) return;
        const newName = (res.content || '').trim();
        if (!newName) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        if (newName === name) return;

        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');
          const cbRes = await wx.cloud.callFunction({
            name: 'manageExpenseTemplate',
            data: { action: 'update', id, itemName: newName }
          });
          const result = cbRes.result as any;
          if (result && result.success) {
            wx.showToast({ title: '已重命名', icon: 'success' });
            await this.fetchExpenseTemplateList();
          } else {
            wx.showToast({ title: (result && result.error) || '重命名失败', icon: 'none' });
          }
        } catch (err) {
          console.error('[onRenameExpenseTemplateItem] 重命名失败:', err);
          wx.showToast({ title: '重命名失败，请重试', icon: 'none' });
        }
      }
    });
  },

  onChangeInputMode(e: any) {
    const mode = e.currentTarget.dataset.mode;
    const { parseResult, allDonations } = this.data;
    if (mode === 'form' && allDonations) {
      this.updateParseResult(allDonations);
    }
    this.setData({ inputMode: mode });
  },

  onSelectQuickAmount(e: any) {
    const amount = e.currentTarget.dataset.amount;
    this.setData({ singleAmount: String(amount) });
  },

  onInputSingleName(e: any) {
    this.setData({ singleName: e.detail.value });
  },

  onInputSingleAmount(e: any) {
    this.setData({ singleAmount: e.detail.value });
  },

  onAddSingleSupportItem() {
    const { singleName, singleAmount, allDonations, parseResult } = this.data;
    if (!singleName.trim()) {
      wx.showToast({ title: '请输入姓名', icon: 'none' });
      return;
    }
    const parsedAmount = parseFloat(singleAmount) || 0;
    if (parsedAmount <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' });
      return;
    }

    const newLine = `${singleName.trim()} ${parsedAmount.toFixed(2)}`;
    const newText = allDonations ? `${allDonations}\n${newLine}` : newLine;
    
    this.setData({
      allDonations: newText,
      singleName: '',
      singleAmount: ''
    });
    this.updateParseResult(newText);
    this.debouncedSaveDraft();
  },

  onDeleteSupportItem(e: any) {
    const index = e.currentTarget.dataset.index;
    const { allDonations, parseResult } = this.data;
    
    if (parseResult.items && parseResult.items[index]) {
      const lines = allDonations.split('\n');
      const itemToDelete = parseResult.items[index];
      const targetAmount = parseFloat(itemToDelete.amount) || itemToDelete.amount;
      
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.includes(itemToDelete.name) && trimmed.includes(String(targetAmount))) {
          lines.splice(i, 1);
          break;
        }
      }
      
      const newText = lines.join('\n').replace(/\n{2,}/g, '\n').trim();
      this.setData({ allDonations: newText });
      this.updateParseResult(newText);
      this.debouncedSaveDraft();
    }
  },

  updateMaterialsParse(text: string) {
    const materials = parseMaterials(text);
    this.setData({ materials, materialsInput: text });
  },

  async chooseReceiptImages() {
    const remainingCount = 9 - this.data.receiptImages.length;
    if (remainingCount <= 0) {
      wx.showToast({ title: '已达 9 张上限，无法继续添加', icon: 'none' });
      return;
    }

    try {
      const res = await wx.chooseMedia({
        count: remainingCount,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });

      if (!res.tempFiles || res.tempFiles.length === 0) return;

      wx.showLoading({ title: '图片合规核验中...', mask: true });

      const fs = wx.getFileSystemManager();
      const canCheckImage = isCloudAvailable();

      for (const file of res.tempFiles) {
        if (!canCheckImage) break;
        try {
          const base64Data = fs.readFileSync(file.tempFilePath, 'base64');
          const checkRes = await wx.cloud.callFunction({
            name: 'checkImageContent',
            data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
          });
          const resultData = checkRes.result as any;

          if (resultData && !resultData.isSafe) {
            wx.hideLoading();
            wx.showModal({
              title: '⚠️ 违规内容拦截',
              content: '系统检测到您选择的小票图片包含不合规、敏感或非法广告内容，已被全量阻断，请重新拍摄上传真实合规小票！',
              showCancel: false,
              confirmColor: '#D32F2F'
            });
            return;
          }
        } catch (checkErr) {
          console.warn('🛡️ 图片安全预读失败，降级进入下一张校验:', checkErr);
        }
      }

      wx.hideLoading();

      const newImages = res.tempFiles.map(file => file.tempFilePath);
      const updatedImages = [...this.data.receiptImages, ...newImages];
      this.setData({ receiptImages: updatedImages });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '选择图片失败', icon: 'none' });
    }
  },

  previewReceipt(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = this.data.receiptImages;
    if (images.length === 0 || index >= images.length) return;

    // 🛡️ 防御性过滤：receiptImages 提交前存的是本机 tempFilePath，长时间填表/切页后
    // 有概率被系统回收失效；过滤掉空值/非字符串，避免用一个已失效的路径卡死预览，
    // 同时保证 current 仍能精确对应用户点的是过滤后数组里的哪一张
    const validImages = images.filter((u: any) => u && typeof u === 'string');
    const currentUrl = images[index];
    if (!currentUrl || typeof currentUrl !== 'string') {
      wx.showToast({ title: '该图片已失效，请重新选择', icon: 'none' });
      return;
    }

    wx.previewImage({
      current: currentUrl,
      urls: validImages
    });
  },

  deleteReceipt(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.receiptImages];
    images.splice(index, 1);
    this.setData({ receiptImages: images });
  },

  // ================= 🍱 今日食谱照片（随餐报表单一并提交，最多 9 张） =================

  async chooseRecipeImages() {
    const remaining = 9 - this.data.recipeImages.length;
    if (remaining <= 0) {
      wx.showToast({ title: '已达 9 张上限，无法继续添加', icon: 'none' });
      return;
    }

    try {
      const chooseRes = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });
      const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
      if (paths.length === 0) return;

      // 选完图立刻把本地 tempFilePath 塞进数组先渲染出来（name 先留空待用户填写），
      // 不等压缩上传跑完才显示——本地文件选完那一刻就是有效路径
      const insertStart = this.data.recipeImages.length;
      const placeholders = paths.map((p) => ({ url: p, name: '' }));
      this.setData({ recipeImages: [...this.data.recipeImages, ...placeholders], recipeUploading: true });

      try {
        const uploaded = await compressAndUploadImages(HOME_COMPRESS_CANVAS_ID, paths, `daily_menus/${this.data.currentStoreId}`);
        // 压缩上传跑完后，原地把每个条目的本地路径 url 替换成云端 fileID——数组
        // 顺序与 paths/uploaded 一一对应，按下标原地替换 url，保留用户此时已输入的 name
        const finalImages = [...this.data.recipeImages];
        uploaded.forEach((u, i) => {
          finalImages[insertStart + i] = { ...finalImages[insertStart + i], url: u.url };
        });
        this.setData({ recipeImages: finalImages });
      } catch (uploadErr) {
        // 🛡️ 上传失败：撤回本轮插入的本地占位条目，不留下没有对应云端文件的
        // 死路径；本地文件选择本身是成功的，只是后续压缩/上传这一步失败了
        const rolledBack = this.data.recipeImages.filter((_, i) => i < insertStart || i >= insertStart + paths.length);
        this.setData({ recipeImages: rolledBack });
        throw uploadErr;
      }

      this.setData({ recipeUploading: false });
    } catch (err) {
      this.setData({ recipeUploading: false });
      console.error('[chooseRecipeImages] 异常:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  // 🍱 每道菜的名称输入框：与其配图同一个 recipeImages[index] 对象，只改 name 字段
  onRecipeDishNameInput(e: any) {
    const index = e.currentTarget.dataset.index;
    this.setData({ [`recipeImages[${index}].name`]: e.detail.value });
  },

  // 🌟 统一大图预览入口：录入端的小图缩略图、以及【生成结果预览】里新增的照片墙，
  // 展示的都是同一份 recipeImages/activityImages 数据源（不是各自拷贝一份），
  // 用 data-source 区分点的是"食谱照片"还是"大事记照片"，一份逻辑同时服务两处入口，
  // 不需要再各写一套 previewXxxImage。
  onPreviewImage(e: any) {
    const source = e.currentTarget.dataset.source as 'recipe' | 'activity';
    const index = e.currentTarget.dataset.index;

    // 🛡️ recipeImages 是 {url,name}[]（每道菜一图一名），activityImages 仍是纯
    // 字符串数组（本机 tempFilePath 或云端 fileID）——两种数据源在这里统一先摘出
    // 一份纯字符串 url 列表，再走同一套预览逻辑
    const rawImages = source === 'activity' ? this.data.activityImages : this.data.recipeImages;
    if (!rawImages || rawImages.length === 0 || index >= rawImages.length) return;

    const images: string[] = source === 'recipe'
      ? rawImages.map((img: any) => img && img.url)
      : rawImages;

    const validUrls = images.filter((u: any) => u && typeof u === 'string');
    const currentUrl = images[index];
    if (!currentUrl || typeof currentUrl !== 'string') {
      wx.showToast({ title: '该图片已失效，请重新选择', icon: 'none' });
      return;
    }

    wx.previewImage({
      current: currentUrl,
      urls: validUrls
    });
  },

  // 🛡️ 缩略图加载失败：上报诊断日志（用于确认真机"图片空白"是云存储读权限问题——
  // 常见报错含 403/-1——还是别的原因，而不是盲猜），同时把这张图标记为"加载失败"，
  // 驱动 WXML 展示可点击重试的占位块，而不是放任小程序原生的裂图/空白晾在那里
  // （这就是"缩略图不显示，呈占位色块"最终呈现给用户的样子）。
  // receiptImages/independent_image_urls/activityImages 是纯字符串数组，
  // recipeImages 是 {url,name}[]，都没有合适的地方挂 loadFailed，统一用一张
  // "路径 -> 是否失败"的 map（recipeImages 取其 .url 当 key）。
  // 🛡️ 不能用 `imageLoadFailedMap.${url}` 这种 setData 点路径写法——url 本身
  // 大概率含点号（域名/文件后缀/cloud fileID），会被点路径解析器拆成好几段，直接写崩；
  // 改成整份 map 对象替换，规避这个坑
  onImageLoadError(e: any) {
    const url = e.currentTarget.dataset.url;
    console.warn('[index] 缩略图加载失败:', url, e.detail);
    if (!url) return;
    this.setData({ imageLoadFailedMap: { ...this.data.imageLoadFailedMap, [url]: true } });
  },

  // 点击"加载失败"占位块重试：从 map 里摘掉这张图的失败标记，wx:if/wx:else 会把
  // <image> 节点整个卸载重挂，从而强制小程序重新发起一次网络请求——不依赖改 src
  // 触发重试，因为 cloud:// fileID 不是普通 URL，拼接时间戳等缓存破坏参数可能
  // 直接导致解析失败
  onRetryImage(e: any) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    const next = { ...this.data.imageLoadFailedMap };
    delete next[url];
    this.setData({ imageLoadFailedMap: next });
  },

  // 🛡️ "今日食谱"/"今日门店日志"预览卡缩略图加载失败：todayMenu/todayActivity 是
  // 只读预览对象（不是可编辑的表单数组），没有地方挂 loadFailed 字段，同样改用
  // 按 url 查表的方案，与 imageLoadFailedMap 完全同款
  onPreviewCardImageLoadError(e: any) {
    const url = e.currentTarget.dataset.url;
    console.warn('[index] 预览卡缩略图加载失败:', url, e.detail);
    if (!url) return;
    this.setData({ previewImagesFailedMap: { ...this.data.previewImagesFailedMap, [url]: true } });
  },

  onRetryPreviewCardImage(e: any) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    const next = { ...this.data.previewImagesFailedMap };
    delete next[url];
    this.setData({ previewImagesFailedMap: next });
  },

  deleteRecipeImage(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.recipeImages];
    images.splice(index, 1);
    this.setData({ recipeImages: images });
  },

  // ================= 📌 今日大事记照片（随餐报表单一并提交，最多 18 张） =================

  async chooseActivityImages() {
    const remaining = 18 - this.data.activityImages.length;
    if (remaining <= 0) {
      wx.showToast({ title: '已达 18 张上限，无法继续添加', icon: 'none' });
      return;
    }

    try {
      const chooseRes = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sourceType: ['album', 'camera']
      });
      const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
      if (paths.length === 0) return;

      // 🌟 与支出凭证(receiptImages)100% 同构：纯字符串数组，选完图立刻把本地
      // tempFilePath 塞进数组先渲染出来，不等压缩上传跑完才显示
      const insertStart = this.data.activityImages.length;
      this.setData({ activityImages: [...this.data.activityImages, ...paths], activityUploading: true });

      try {
        const uploaded = await compressAndUploadImages(HOME_COMPRESS_CANVAS_ID, paths, `activity_logs/${this.data.currentStoreId}`);
        // 压缩上传跑完后，原地把本地路径字符串替换成云端 fileID 字符串
        const finalImages = [...this.data.activityImages];
        uploaded.forEach((u, i) => {
          finalImages[insertStart + i] = u.url;
        });
        this.setData({ activityImages: finalImages });
      } catch (uploadErr) {
        const rolledBack = this.data.activityImages.filter((_, i) => i < insertStart || i >= insertStart + paths.length);
        this.setData({ activityImages: rolledBack });
        throw uploadErr;
      }

      this.setData({ activityUploading: false });
    } catch (err) {
      this.setData({ activityUploading: false });
      console.error('[chooseActivityImages] 异常:', err);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    }
  },

  deleteActivityImage(e: any) {
    const index = e.currentTarget.dataset.index;
    const images = [...this.data.activityImages];
    images.splice(index, 1);
    this.setData({ activityImages: images });
  },

  onActivityTextInput(e: any) {
    this.setData({ activityText: e.detail.value });
  },

  // 📥 合并【凭证与账本】页在今日餐报尚未提交时暂存的凭证图片（拍照识别OCR/快捷补传凭证 提前存的）
  // 仅当填报日期就是今天、且尚未处于编辑模式时才合并，避免污染历史记录编辑或跨日草稿
  mergeStagedReceiptStash() {
    try {
      if (this.data.isEditMode) return;
      const todayStr = getTodayIsoString();
      if (this.data.reportDateValue !== todayStr) return;

      const storeId = this.data.currentStoreId || this.data.shopName || 'default';
      const stashKey = `pending_receipt_stash_${storeId}_${todayStr}`;
      const stash = wx.getStorageSync(stashKey);

      if (stash && Array.isArray(stash.images) && stash.images.length > 0) {
        const existing = this.data.receiptImages || [];
        const merged = [...existing, ...stash.images.filter((u: string) => existing.indexOf(u) === -1)];
        this.setData({ receiptImages: merged });
        wx.removeStorageSync(stashKey);
        wx.showToast({ title: `已自动带入 ${stash.images.length} 张暂存凭证`, icon: 'none', duration: 2500 });
      }
    } catch (err) {
      console.warn('[mergeStagedReceiptStash] 合并暂存凭证失败:', err);
    }
  },

  // ================= 🔒 大额专项支出：逐条添加 + 行级独立凭证 =================

  onInputFixedExpenseNewName(e: any) {
    this.setData({ fixedExpenseNewName: e.detail.value });
  },

  onInputFixedExpenseNewAmount(e: any) {
    this.setData({ fixedExpenseNewAmount: e.detail.value });
  },

  onAddFixedExpenseItem() {
    const name = (this.data.fixedExpenseNewName || '').trim();
    if (!name) {
      wx.showToast({ title: '请输入项目名称', icon: 'none' });
      return;
    }
    const amount = parseFloat(this.data.fixedExpenseNewAmount) || 0;

    const newItem = {
      _key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      amount: amount.toFixed(2),
      independent_image_urls: [] as string[],
      expanded: false
    };

    this.setData({
      fixedExpenseItems: [...this.data.fixedExpenseItems, newItem],
      fixedExpenseNewName: '',
      fixedExpenseNewAmount: ''
    });
    this.regenerateFixedExpenseText();
  },

  onInputFixedExpenseItemAmount(e: any) {
    const index = e.currentTarget.dataset.index;
    const items = [...this.data.fixedExpenseItems];
    if (!items[index]) return;
    items[index] = { ...items[index], amount: e.detail.value };
    this.setData({ fixedExpenseItems: items });
    this.regenerateFixedExpenseText();
  },

  onDeleteFixedExpenseItem(e: any) {
    const index = e.currentTarget.dataset.index;
    const items = [...this.data.fixedExpenseItems];
    if (!items[index]) return;
    items.splice(index, 1);
    this.setData({ fixedExpenseItems: items });
    this.regenerateFixedExpenseText();
  },

  onToggleIndependentVoucher(e: any) {
    const index = e.currentTarget.dataset.index;
    const items = [...this.data.fixedExpenseItems];
    if (!items[index]) return;
    items[index] = { ...items[index], expanded: !items[index].expanded };
    this.setData({ fixedExpenseItems: items });
  },

  async onChooseIndependentVoucher(e: any) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.fixedExpenseItems[index];
    if (!item) return;

    const remaining = 3 - item.independent_image_urls.length;
    if (remaining <= 0) {
      wx.showToast({ title: '每条最多上传 3 张独立凭证', icon: 'none' });
      return;
    }

    // 🛡️ 存储路径必须强制夹带 tenant_id：取不到就直接拦截上传，不落地到裸路径，
    // 与门店级多租户隔离的既有约定保持一致（见 DataService.saveReport 的 tenantId 写入）
    const cachedRoleInfo = AuthService.getCachedRoleInfo();
    const tenantId = (cachedRoleInfo && cachedRoleInfo.tenantId) || '';
    if (!tenantId) {
      wx.showToast({ title: '无法确认所属机构，暂时无法上传独立凭证', icon: 'none' });
      return;
    }

    try {
      const chooseRes = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });
      const paths = (chooseRes.tempFiles || []).map(f => f.tempFilePath);
      if (paths.length === 0) return;

      if (!isCloudAvailable()) {
        wx.showToast({ title: '云服务暂不可用，无法上传独立凭证', icon: 'none' });
        return;
      }

      wx.showLoading({ title: '图片压缩上传中...', mask: true });

      const now = new Date();
      const dateFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const cloudPathPrefix = `expenses_independent/${tenantId}/${this.data.currentStoreId}/${dateFolder}`;

      const uploaded = await compressAndUploadImages(HOME_COMPRESS_CANVAS_ID, paths, cloudPathPrefix);
      wx.hideLoading();

      const items = [...this.data.fixedExpenseItems];
      const target = items[index];
      if (!target) return; // 上传耗时期间该行可能已被删除
      items[index] = {
        ...target,
        independent_image_urls: [...target.independent_image_urls, ...uploaded.map(u => u.url)]
      };
      this.setData({ fixedExpenseItems: items });
      this.debouncedSaveDraft();
    } catch (err) {
      wx.hideLoading();
      console.error('[onChooseIndependentVoucher] 上传失败:', err);
      wx.showToast({ title: '独立凭证上传失败', icon: 'none' });
    }
  },

  onPreviewIndependentVoucher(e: any) {
    const { index, imgIndex } = e.currentTarget.dataset;
    const item = this.data.fixedExpenseItems[index];
    if (!item || !item.independent_image_urls.length) return;

    // 🛡️ 防御性过滤：过滤掉空值/非字符串，避免个别异常数据卡住整个预览
    const validUrls = item.independent_image_urls.filter((u: any) => u && typeof u === 'string');
    const currentUrl = item.independent_image_urls[imgIndex];
    if (!currentUrl || typeof currentUrl !== 'string') {
      wx.showToast({ title: '该图片已失效，请重新选择', icon: 'none' });
      return;
    }

    wx.previewImage({
      current: currentUrl,
      urls: validUrls
    });
  },

  onDeleteIndependentVoucher(e: any) {
    const { index, imgIndex } = e.currentTarget.dataset;
    const items = [...this.data.fixedExpenseItems];
    const target = items[index];
    if (!target) return;
    const urls = [...target.independent_image_urls];
    urls.splice(imgIndex, 1);
    items[index] = { ...target, independent_image_urls: urls };
    this.setData({ fixedExpenseItems: items });
  },

  async uploadReceiptImages(): Promise<string[]> {
    const { receiptImages } = this.data;
    if (receiptImages.length === 0) {
      return [];
    }

    if (!isCloudAvailable()) {
      console.warn('[uploadReceiptImages] 云服务不可用，跳过图片上传，凭证图片本次将不会随餐报保存');
      wx.showToast({ title: '云服务暂不可用，凭证图片本次未能上传', icon: 'none' });
      return [];
    }

    const now = new Date();
    const dateFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const fileIDs: string[] = [];

    for (let i = 0; i < receiptImages.length; i++) {
      const tempFilePath = receiptImages[i];

      // 已是云存储文件地址，无需重复上传
      if (tempFilePath.indexOf('cloud://') === 0 || tempFilePath.indexOf('https://') === 0) {
        fileIDs.push(tempFilePath);
        continue;
      }

      const fileName = `${Date.now()}_${i}.jpg`;
      const cloudPath = `expenses/${dateFolder}/${fileName}`;

      try {
        const uploadResult = await wx.cloud.uploadFile({
          cloudPath: cloudPath,
          filePath: tempFilePath
        });
        fileIDs.push(uploadResult.fileID);
      } catch (error) {
        console.error('[uploadReceiptImages] 上传图片失败:', error);
        wx.showToast({ title: `图片${i + 1}上传失败`, icon: 'none' });
      }
    }

    return fileIDs;
  },

  showAdjustReasonModal(systemBalance: number, adjustedBalance: number, balanceDiff: number): Promise<void> {
    return new Promise((resolve) => {
      this._adjustResolve = resolve;
      this.setData({
        showAdjustModal: true,
        adjustModalInfo: {
          systemBalance: systemBalance.toFixed(2),
          adjustedBalance: adjustedBalance.toFixed(2),
          balanceDiff: Math.abs(balanceDiff).toFixed(2),
          balanceDiffSign: balanceDiff >= 0 ? '+' : '-'
        },
        adjustInput: this.data.adjustReason || ''
      });
    });
  },

  onAdjustInput(e: any) {
    this.setData({ adjustInput: e.detail.value });
  },

  onAdjustConfirm() {
    const reason = this.data.adjustInput.trim();
    this.setData({ adjustReason: reason, showAdjustModal: false });
    if (this._adjustResolve) {
      this._adjustResolve();
      this._adjustResolve = null;
    }
  },

  onAdjustCancel() {
    this.setData({ adjustReason: '', showAdjustModal: false });
    if (this._adjustResolve) {
      this._adjustResolve();
      this._adjustResolve = null;
    }
  },

  async onScanReceiptPhoto() {
    try {
      if (!isCloudAvailable()) {
        wx.showToast({ title: '云服务暂不可用，无法使用拍照识别', icon: 'none' });
        return;
      }
      // #10 支持多张图片批量识别（最多5张）
      const chooseRes = await wx.chooseMedia({
        count: 5,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });

      if (!chooseRes.tempFiles || chooseRes.tempFiles.length === 0) {
        return;
      }

      const totalFiles = chooseRes.tempFiles.length;
      const results = [];
      const uploadedFileIds = [];

      wx.showLoading({ title: '图片合规核验中...', mask: true });

      const fs = wx.getFileSystemManager();

      for (let i = 0; i < totalFiles; i++) {
        try {
          const tempFilePath = chooseRes.tempFiles[i].tempFilePath;
          const base64Data = fs.readFileSync(tempFilePath, 'base64');
          const checkRes = await wx.cloud.callFunction({
            name: 'checkImageContent',
            data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
          });
          const resultData = checkRes.result as any;

          if (resultData && !resultData.isSafe) {
            wx.hideLoading();
            wx.showModal({
              title: '⚠️ 违规内容拦截',
              content: '系统检测到您选择的图片包含不合规、敏感或非法广告内容，已被全量阻断，请重新拍摄上传真实合规小票！',
              showCancel: false,
              confirmColor: '#D32F2F'
            });
            return;
          }
        } catch (checkErr) {
          console.warn('🛡️ 图片安全预读失败，降级进入下一张校验:', checkErr);
        }
      }

      wx.showLoading({ title: 'AI 识别中 0/' + totalFiles, mask: true });

      // 批量识别
      for (let i = 0; i < totalFiles; i++) {
        try {
          const tempFilePath = chooseRes.tempFiles[i].tempFilePath;

          // 更新进度
          wx.showLoading({ title: 'AI 识别中 ' + (i + 1) + '/' + totalFiles, mask: true });

          const fileName = 'receipts/' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '.jpg';
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: fileName,
            filePath: tempFilePath
          });
          uploadedFileIds.push(uploadRes.fileID);

          const ocrRes = await wx.cloud.callFunction({
            name: 'ocrExpenseReceipt',
            data: { fileID: uploadRes.fileID }
          });

          const result = ocrRes.result as any;
          if (result && result.success && (result.amount || result.totalAmount)) {
            const amount = parseFloat(result.amount || result.totalAmount || 0);
            results.push({ ...result, totalAmount: amount, fileID: uploadRes.fileID });
          } else {
            const realErrMsg = (result && result.errMsg) || (result && result.message) || (result && result.error) || '云函数返回数据异常';
            console.error('❌ [OCR] 单张识别失败:', realErrMsg);
            results.push({ success: false, errMsg: realErrMsg, fileID: uploadRes.fileID });
          }
        } catch (e: any) {
          console.error('❌ [onScanReceiptPhoto] 单张识别捕获到异常:', e);
          const errStr = e.message || JSON.stringify(e);
          results.push({ success: false, errMsg: '调用异常: ' + errStr });
        }
      }

      wx.hideLoading();

      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;

      if (successCount === 0) {
        // 全部失败
        const firstFail = results.find(r => !r.success);
        wx.showModal({
          title: '云函数返回错误诊断',
          content: '【诊断原因】:\n' + ((firstFail && firstFail.errMsg) || '未能识别票据信息') + '\n\n请手动填写或重新拍摄清晰的小票。',
          showCancel: false,
          confirmText: '知道了'
        });
        // 清理上传的图片
        this._cleanupReceiptImages(uploadedFileIds);
        return;
      }

      // 🛡️ 单张小票金额超过此阈值时，无论置信度如何，一律附加红色预警提示，
      // 提醒店长核对原图——日常食材采购通常不会单张小票超过这个量级
      const OCR_AMOUNT_WARNING_THRESHOLD = 500;

      // 构建展示列表
      const receiptList = [];
      let totalAmount = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.success) continue;
        const amt = parseFloat(r.amount || r.totalAmount || 0);
        totalAmount += amt;
        const isHighConfidence = r.isHighConfidence !== false;
        receiptList.push({
          merchantName: r.merchant || ('第' + (i + 1) + '张'),
          amount: amt.toFixed(2),
          itemList: r.itemList || [],
          formattedText: r.formattedText || `小票金额：¥${amt.toFixed(2)}`,
          fileID: r.fileID || '',
          isHighConfidence,
          // 🌟 图文同屏对比 + 高亮预警：低置信度或金额超阈值时展示红色提醒，
          // 强调"识别结果仅供参考"，交由店长核对小票原图后再确认
          showWarning: !isHighConfidence || amt > OCR_AMOUNT_WARNING_THRESHOLD,
          // 🌟 云函数（AI/OCR 节点）已经把原价小计/运费/优惠/实付拆成互相独立的结构化字段，
          // 这里原样透传给确认弹窗展示，让财务/店长核对时能看到"钱是怎么从原价变成实付的"，
          // 而不是只看到一个不可回溯的最终数字
          rawTotalAmount: r.raw_total_amount || '',
          shippingFee: r.shipping_fee || '',
          discountAmount: r.discount_amount || ''
        });
      }

      this._ocrPendingResults = results.filter(r => r.success);
      this._ocrPendingFileIds = uploadedFileIds;

      this.setData({
        showOcrConfirmModal: true,
        ocrReceiptList: receiptList,
        ocrSuccessCount: successCount,
        ocrFailCount: failCount,
        ocrTotalAmount: totalAmount.toFixed(2),
        // 弹窗每次都是 wx:if 重新挂载，focus 会随之重新触发，无需额外复位逻辑
        ocrFocusFirstPrice: receiptList.length > 0 && receiptList[0].itemList.length > 0
      });
      this.updateOcrConfirmPreview();
    } catch (e: any) {
      wx.hideLoading();
      console.error('❌ [Debug] 捕获到前端/网络异常:', e);
      
      const errMsg = e.message || JSON.stringify(e);
      if (errMsg && !errMsg.includes('cancel')) {
        wx.showModal({
          title: '调用过程崩溃',
          content: '【错误信息】:\n' + errMsg,
          showCancel: false,
          confirmText: '知道了'
        });
      }
    }
  },

  // 🌟 爱心支持明细·图片识别：上传微信群收款/接龙截图，OCR 识别"昵称+金额"明细，
  // 自动追加进【批量粘贴】文本框。识别只负责"认字配对"，绝不在云函数里求和/去重——
  // 结果统一交给前端唯一权威的 parseDonorText（经 updateParseResult 调用）解析汇总，
  // 与手动粘贴文本走的是完全相同的一条路径，不会另开一套计算逻辑。
  async onScanDonorScreenshot() {
    // 🌟 诊断日志：如果点击按钮后连这一行都没打印出来，说明问题根本不在这个函数内部
    // （大概率是小程序端跑的还不是最新编译产物），而不是这里的业务逻辑有 bug

    if (this.data.isScanningDonorList) {
      return;
    }

    try {
      if (!isCloudAvailable()) {
        console.warn('[onScanDonorScreenshot] isCloudAvailable() 返回 false，云能力不可用');
        wx.showToast({ title: '云服务暂不可用，无法使用图片识别', icon: 'none' });
        return;
      }

      const chooseRes = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });

      if (!chooseRes.tempFiles || chooseRes.tempFiles.length === 0) return;

      const tempFilePath = chooseRes.tempFiles[0].tempFilePath;

      // 🌟 第一道防线：图片 MD5 去重。在触发任何网络请求（内容安全检测/上传/OCR）之前，
      // 先读取本地临时文件的原始二进制内容算出 MD5——同一张图片（哪怕文件名不同，
      // chooseMedia 每次选择都会生成新的临时路径）字节内容完全一致，MD5 必然相同。
      // 命中即直接拦截，连内容安全检测的网络请求都不发，最大程度节省一次无意义的调用。
      const fs = wx.getFileSystemManager();
      const fileBuffer = fs.readFileSync(tempFilePath) as ArrayBuffer;
      const imageHash = md5(fileBuffer);

      if (this._uploadedImageHashes.includes(imageHash)) {
        wx.showModal({
          title: '系统提示',
          content: '您已上传过此图片，请勿重复提交相同截图。',
          showCancel: false
        });
        return;
      }
      this._uploadedImageHashes.push(imageHash);

      this.setData({ isScanningDonorList: true });
      wx.showLoading({ title: '图片合规核验中...', mask: true });

      let uploadedFileId = '';

      try {
        // 与小票拍照识别同一套合规校验：上传前先过内容安全检测，不合规直接拦截，不进入 OCR
        const base64Data = fs.readFileSync(tempFilePath, 'base64');
        const checkRes = await wx.cloud.callFunction({
          name: 'checkImageContent',
          data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
        });
        const checkResult = checkRes.result as any;
        if (checkResult && !checkResult.isSafe) {
          wx.hideLoading();
          wx.showModal({
            title: '⚠️ 违规内容拦截',
            content: checkResult.reason || '图片内容未通过安全校验，请更换图片',
            showCancel: false
          });
          return;
        }

        wx.showLoading({ title: 'AI 识别中...', mask: true });

        const fileName = 'donation_screenshots/' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '.jpg';
        const uploadRes = await wx.cloud.uploadFile({ cloudPath: fileName, filePath: tempFilePath });
        uploadedFileId = uploadRes.fileID;

        const ocrRes = await wx.cloud.callFunction({
          name: 'ocrDonationList',
          data: { fileID: uploadedFileId }
        });

        wx.hideLoading();

        const result = ocrRes.result as any;
        if (result && result.success && result.formattedText) {
          const current = (this.data.allDonations || '').trim();

          // 第二道防线：文本行级去重，见 filterDuplicateDonorLines 顶部注释——
          // 与已有文本【姓名+金额】完全一致的新识别行会被剔除，不追加进输入框
          const { keptText, removedCount } = this.filterDuplicateDonorLines(current, result.formattedText);

          if (!keptText) {
            // 这次识别出来的所有条目都是重复的，不需要追加任何内容
            wx.showModal({
              title: '系统提示',
              content: `本次识别出的 ${result.totalCount} 条支持数据与已录入内容完全重复，未新增任何记录。`,
              showCancel: false
            });
            return;
          }

          // 一行一条"姓名 金额"，与手动粘贴的格式完全一致，直接原样拼接即可，
          // 不需要也不应该在这里再做一次金额加总——那是 updateParseResult 的职责
          const merged = current ? (current + '\n' + keptText) : keptText;

          this.setData({ allDonations: merged, inputMode: 'text' });
          this.updateParseResult(merged);
          this.debouncedSaveDraft();

          const toastTitle = removedCount > 0
            ? `已识别并新增 ${result.totalCount - removedCount} 人（已自动过滤 ${removedCount} 条重复数据），请核对`
            : `已识别 ${result.totalCount} 人，请核对`;
          wx.showToast({ title: toastTitle, icon: 'none', duration: 2500 });
        } else {
          wx.showModal({
            title: '识别失败',
            content: (result && result.errMsg) || '未能从截图中识别出有效的爱心支持明细，请手动录入或换一张更清晰的截图',
            showCancel: false,
            confirmText: '知道了'
          });
        }
      } finally {
        // 截图本身不是财务凭证，不需要像小票一样长期保留，识别完清理云存储
        if (uploadedFileId) {
          wx.cloud.deleteFile({ fileList: [uploadedFileId] }).catch((err: any) => {
            console.warn('[onScanDonorScreenshot] 清理截图失败:', err);
          });
        }
      }
    } catch (e: any) {
      wx.hideLoading();
      const errMsg = e.errMsg || e.message || '';
      console.warn('[onScanDonorScreenshot] 捕获到异常:', e);
      if (errMsg.includes('cancel')) {
        // 用户在系统相册/相机选择框里点了取消，这是正常操作，不需要弹提示打扰——
        // 但控制台日志留着，方便和"点击后完全没反应"这类真正的 bug 区分开
        return;
      }
      wx.showToast({ title: '识别失败：' + (e.message || errMsg || '未知错误'), icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ isScanningDonorList: false });
    }
  },

  _pendingOcrResults: [],
  _pendingOcrFileIds: [],
  _ocrPendingResults: [],
  _ocrPendingFileIds: [],
  // 🌟 爱心支持明细·图片识别去重：本次页面会话内已上传过的截图 MD5，防止义工
  // 手滑重复选中/重复提交同一张截图导致支持数据加倍——只在当前页面实例存活期间
  // 有效（刷新/重进页面会清空），不做跨会话持久化，符合"当前会话去重"的定位
  _uploadedImageHashes: [] as string[],

  // 🌟 图文同屏对比：点击小票缩略图直接原生放大查看原图
  onPreviewOcrReceiptImage(e: any) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.previewImage({ current: url, urls: [url] });
  },

  onOcrConfirmCancel() {
    this.setData({ showOcrConfirmModal: false });
    this._cleanupReceiptImages(this._ocrPendingFileIds);
    this._ocrPendingResults = [];
    this._ocrPendingFileIds = [];
  },

  onOcrAdjustCategory() {
    const results = this._ocrPendingResults || [];
    if (results.length === 0) return;

    this._pendingOcrResults = results;
    this._pendingOcrFileIds = this._ocrPendingFileIds;
    this.setData({ showOcrConfirmModal: false });
    this._showCategoryAdjust();
  },

  onEditOcrItemName(e: any) {
    const receiptIdx = e.currentTarget.dataset.receiptIndex;
    const itemIdx = e.currentTarget.dataset.itemIndex;
    const val = e.detail.value;
    const list = [...this.data.ocrReceiptList];
    list[receiptIdx].itemList[itemIdx].name = val;
    // 店长已经亲手编辑过这个品名，视为"已核对/已修正"，红色警示不再需要停留
    list[receiptIdx].itemList[itemIdx].isSuspiciousName = false;
    this.setData({ ocrReceiptList: list });
  },

  // 🐛 修复"输入一个字符光标就被抢走"的严重交互 Bug：根因不是"bindinput 太频繁"本身，
  // 而是 ocrFocusFirstPrice（弹窗打开时用于自动聚焦第一件商品价格框的一次性标记）从未被
  // 重置——它在 this.data 里一直停留为 true。之前 onEditOcrItemPrice/onEditOcrReceiptAmount
  // 每敲一个字符就 setData 一次 ocrReceiptList，导致 wx:for 列表重渲染；只要重渲染，
  // WXML 里 input-item-price 上的 focus="{{ocrFocusFirstPrice && index===0 && subIdx===0}}"
  // 就会再次求值为 true，把光标从用户正在编辑的输入框"抢"回第一件商品的价格框。
  // 修复分两层：① bindinput 阶段只把值记进实例变量草稿，绝不 setData、绝不重渲染列表；
  // ② 真正的重算 + setData 延后到 bindblur（失焦）才执行，并在这次 setData 里顺手把
  // ocrFocusFirstPrice 永久置为 false——用户一旦真正开始编辑，这个"仅用于弹窗刚打开那一次"
  // 的自动聚焦标记就该失效，此后任何一次 setData 都不会再重新抢焦点。
  _ocrItemPriceDraft: {} as Record<string, string>,
  _ocrReceiptAmountDraft: {} as Record<string, string>,

  onEditOcrItemPriceInput(e: any) {
    const receiptIdx = e.currentTarget.dataset.receiptIndex;
    const itemIdx = e.currentTarget.dataset.itemIndex;
    this._ocrItemPriceDraft[`${receiptIdx}_${itemIdx}`] = e.detail.value;
  },

  onEditOcrItemPriceBlur(e: any) {
    const receiptIdx = e.currentTarget.dataset.receiptIndex;
    const itemIdx = e.currentTarget.dataset.itemIndex;
    const draftKey = `${receiptIdx}_${itemIdx}`;
    const val = this._ocrItemPriceDraft[draftKey] !== undefined ? this._ocrItemPriceDraft[draftKey] : e.detail.value;
    delete this._ocrItemPriceDraft[draftKey];

    const list = [...this.data.ocrReceiptList];
    list[receiptIdx].itemList[itemIdx].price = val;

    // 动态重新计算该小票总金额
    const newTotal = list[receiptIdx].itemList.reduce((sum: number, item: any) => sum + (parseFloat(item.price) || 0), 0);
    list[receiptIdx].amount = newTotal.toFixed(2);
    // 逐条商品价格重新触发了自动汇总，视为已回到"跟随识别结果"的状态，
    // 之前若手动改过总金额，这次编辑单价会覆盖它，不再保留手动覆盖标记
    list[receiptIdx].manualAmountOverride = false;

    // 重新计算所有小票合计
    const ocrTotalAmount = list.reduce((sum: number, r: any) => sum + parseFloat(r.amount || 0), 0).toFixed(2);

    this.setData({ ocrReceiptList: list, ocrTotalAmount, ocrFocusFirstPrice: false });
    this.updateOcrConfirmPreview();
  },

  // 🌟 实付金额人工覆盖机制：OCR/明细累加算出的总额可能因优惠、运费识别不全而偏高或偏低，
  // 财务志工核对小票原图后，可以直接在"实付合计"这里手动改成小票上真实的实付数字，
  // 不必逐条修改商品明细去"凑"出正确的总数。这里改的 amount 会在 onOcrAutoFill 里
  // 原样同步进 pending 结果，成为写入 dailyExpenseText/fixedExpenseText 的锚点金额，
  // 也就是最终写进数据库 todayExpense 字段的那个数字——全程不再经过任何二次相加。
  onEditOcrReceiptAmountInput(e: any) {
    const receiptIdx = e.currentTarget.dataset.receiptIndex;
    this._ocrReceiptAmountDraft[receiptIdx] = e.detail.value;
  },

  onEditOcrReceiptAmountBlur(e: any) {
    const receiptIdx = e.currentTarget.dataset.receiptIndex;
    const val = this._ocrReceiptAmountDraft[receiptIdx] !== undefined ? this._ocrReceiptAmountDraft[receiptIdx] : e.detail.value;
    delete this._ocrReceiptAmountDraft[receiptIdx];

    const list = [...this.data.ocrReceiptList];
    list[receiptIdx].amount = val;
    list[receiptIdx].manualAmountOverride = true;

    const ocrTotalAmount = list.reduce((sum: number, r: any) => sum + (parseFloat(r.amount) || 0), 0).toFixed(2);

    this.setData({ ocrReceiptList: list, ocrTotalAmount, ocrFocusFirstPrice: false });
    this.updateOcrConfirmPreview();
  },

  onOcrAutoFill() {
    const results = this._ocrPendingResults || [];
    if (results.length === 0) {
      this.setData({ showOcrConfirmModal: false });
      return;
    }

    // 用弹窗中编辑后的最新数据更新 pending results
    const editedList = this.data.ocrReceiptList || [];
    for (let i = 0; i < editedList.length; i++) {
      const edited = editedList[i];
      const pending = results.find((r: any) => r.success && (r.merchant || ('第' + (i + 1) + '张')) === edited.merchantName);
      if (!pending) continue;
      // 🐛 金额同步不能只在"有商品明细"时才生效：手动改总额（onEditOcrReceiptAmount）在
      // itemList 为空（OCR 没识别出任何商品行，只有一个整体金额）的小票上同样成立，
      // 之前把 pending.amount 的同步也一并锁在 edited.itemList 的判断里，会导致这种情况下
      // 手动改的实付金额被静默丢弃，最终填进表单的还是识别错的旧数字。
      pending.amount = edited.amount;
      pending.manualAmountOverride = !!edited.manualAmountOverride;
      if (edited.itemList) {
        pending.itemList = edited.itemList;
        pending.formattedText = edited.itemList.map((item: any) => `• ${item.name}：¥${item.price}`).join('\n');
      }
    }

    let dailyItemsText = '';
    let fixedItemsText = '';
    let otherItemsText = '';
    let dailyTotal = 0;
    let fixedTotal = 0;
    let otherTotal = 0;

    for (const r of results) {
      if (!r.success) continue;

      const cat = r.category || 'daily_food';
      const amount = parseFloat(r.amount || r.totalAmount || 0);

      let detailText = '';
      if (r.itemList && r.itemList.length > 0) {
        const lines = r.itemList.map((item: any) => `• ${item.name}：¥${item.price}`);
        // 🌟 商品明细行原样相加得到的是折前原价小计，可能比店长实际付的钱更多（有优惠/运费时）；
        // 追加这一行"实付合计"锚点，供 calculateTodayExpenseFromText 识别为这张小票的权威金额，
        // 忽略前面逐条商品行的原价加总，从根源避免"AI 识别出的原价被误当成今日支出"。
        lines.push(`实付合计：¥${amount.toFixed(2)}`);
        detailText = lines.join('\n');
      } else {
        detailText = r.formattedText || r.detailText || `食材采购小票：¥${amount.toFixed(2)}`;
      }

      if (cat === 'daily_food') {
        dailyItemsText += (dailyItemsText ? '\n\n' : '') + detailText;
        dailyTotal += amount;
      } else if (cat === 'major_expense') {
        fixedItemsText += (fixedItemsText ? '\n\n' : '') + detailText;
        fixedTotal += amount;
      } else {
        otherItemsText += (otherItemsText ? '\n\n' : '') + detailText;
        otherTotal += amount;
      }
    }

    if (dailyItemsText) {
      const current = this.data.dailyExpenseText || '';
      this.setData({ dailyExpenseText: current ? (current + '\n\n' + dailyItemsText) : dailyItemsText });
    }
    if (fixedItemsText) {
      const current = this.data.fixedExpenseText || '';
      this.setData({ fixedExpenseText: current ? (current + '\n\n' + fixedItemsText) : fixedItemsText });
    }
    if (otherItemsText) {
      const current = this.data.dailyExpenseText || '';
      this.setData({ dailyExpenseText: current ? (current + '\n\n' + otherItemsText) : current });
    }

    this._saveReceiptHistory(results.filter(r => r.success).map(r => ({
      amount: r.totalAmount,
      category: r.category,
      merchant: r.merchant || '',
      receiptDate: r.receiptDate || '',
      timestamp: Date.now()
    })));

    this.setData({ showOcrConfirmModal: false });

    wx.showToast({
      title: '已填入商品明细 ¥' + (dailyTotal + fixedTotal + otherTotal).toFixed(2),
      icon: 'success',
      duration: 2000
    });

    this.updateRealTimeBalance();

    this._ocrPendingResults = [];
    this._ocrPendingFileIds = [];
  },

  _showCategoryAdjust() {
    const results = this._pendingOcrResults || [];
    if (results.length === 0) return;

    wx.showActionSheet({
      itemList: ['全部归入食材餐饮', '全部归入大额专项', '手动逐张调整'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this._applyOcrCategory('daily_food');
        } else if (res.tapIndex === 1) {
          this._applyOcrCategory('major_expense');
        } else {
          this._adjustOcrCategoryOneByOne(0);
        }
      },
      fail: () => {
        this._cleanupReceiptImages(this._pendingOcrFileIds);
      }
    });
  },

  _applyOcrCategory(category) {
    const results = this._pendingOcrResults || [];
    let total = 0;
    let itemsText = '';

    for (const r of results) {
      let detail = '';
      if (r.itemList && r.itemList.length > 0) {
        const lines = r.itemList.map(item => `• ${item.name}：¥${item.price}`);
        // 见 calculateTodayExpenseFromText 顶部注释：追加锚点行，避免逐条商品原价被
        // 直接相加当成今日支出，与实付金额（可能因优惠/运费而不同）脱节
        const anchorAmount = parseFloat(r.amount || r.totalAmount || 0);
        lines.push(`实付合计：¥${anchorAmount.toFixed(2)}`);
        detail = lines.join('\n');
      } else {
        detail = r.formattedText || r.detailText || `食材采购小票：¥${r.totalAmount}`;
      }
      itemsText += (itemsText ? '\n\n' : '') + detail;
      total += r.totalAmount;
    }

    // 🐛 与追加锚点行配套：块与块之间必须用空行分隔，calculateTodayExpenseFromText 才能
    // 正确识别"上一张小票已经结束"，否则上一张的锚点行会把这一张的商品行也一并吞掉/覆盖
    if (category === 'daily_food') {
      const current = this.data.dailyExpenseText || '';
      this.setData({ dailyExpenseText: current ? (current + '\n\n' + itemsText) : itemsText });
    } else if (category === 'major_expense') {
      const current = this.data.fixedExpenseText || '';
      this.setData({ fixedExpenseText: current ? (current + '\n\n' + itemsText) : itemsText });
    }

    this._cleanupReceiptImages(this._pendingOcrFileIds);
    this._pendingOcrResults = [];
    this._pendingOcrFileIds = [];

    wx.showToast({ title: '已填入 ¥' + total.toFixed(2), icon: 'success', duration: 2000 });

    this.updateRealTimeBalance();
  },

  _adjustOcrCategoryOneByOne(index) {
    const results = this._pendingOcrResults || [];
    if (index >= results.length) {
      this._cleanupReceiptImages(this._pendingOcrFileIds);
      this._pendingOcrResults = [];
      this._pendingOcrFileIds = [];
      return;
    }

    const r = results[index];
    const title = (r.merchant || '第' + (index + 1) + '张') + ' ¥' + r.totalAmount;

    wx.showActionSheet({
      itemList: ['归入食材餐饮', '归入大额专项', '跳过不记录'],
      success: (res) => {
        let detail = '';
        if (r.itemList && r.itemList.length > 0) {
          const lines = r.itemList.map(item => item.name + ' ¥' + item.price);
          // 见 calculateTodayExpenseFromText 顶部注释：追加锚点行，避免逐条商品原价被
          // 直接相加当成今日支出，与实付金额（可能因优惠/运费而不同）脱节
          const anchorAmount = parseFloat(r.amount || r.totalAmount || 0);
          lines.push(`实付合计：¥${anchorAmount.toFixed(2)}`);
          detail = lines.join('\n');
        } else {
          detail = r.formattedText || r.detailText || (r.merchant || '小票') + r.totalAmount;
        }
        // 🐛 用单个空格拼接会把上一笔记录的最后一行与这张小票的第一行商品粘连成同一行文本，
        // 导致 calculateTodayExpenseFromText 按行取数时漏算被粘连的那一项；改用与其它入口
        // 一致的空行分隔，让每张小票单独成块
        if (res.tapIndex === 0) {
          const current = this.data.dailyExpenseText || '';
          this.setData({ dailyExpenseText: current ? (current + '\n\n' + detail) : detail });
        } else if (res.tapIndex === 1) {
          const current = this.data.fixedExpenseText || '';
          this.setData({ fixedExpenseText: current ? (current + '\n\n' + detail) : detail });
        }
        // 继续下一张
        this._adjustOcrCategoryOneByOne(index + 1);
      },
      fail: () => {
        // 用户取消，跳过
        this._adjustOcrCategoryOneByOne(index + 1);
      }
    });
  },

  _cleanupReceiptImages(fileIds) {
    // #5 清理上传的小票图片（避免占用云存储）
    if (!fileIds || fileIds.length === 0) return;
    try {
      wx.cloud.deleteFile({
        fileList: fileIds
      }).catch(e => console.warn('[清理小票图片失败:', e));
    } catch (e) {
      console.warn('[清理小票图片失败:', e);
    }
  },

  _saveReceiptHistory(items) {
    // #9 保存识别历史（最近20条）
    try {
      const key = 'receipt_ocr_history';
      const existing = wx.getStorageSync(key);
      const history = existing ? JSON.parse(existing) : [];
      history.push(...items);
      const trimmed = history.length > 20 ? history.slice(-20) : history;
      wx.setStorageSync(key, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('[保存识别历史失败:', e);
    }
  },

  async generateReport() {

    if (this.isSubmitting) {
      wx.showToast({ title: '请稍候...', icon: 'none', duration: 1000 });
      return;
    }

    const isValid = await this.validateBeforeSubmit();
    if (!isValid) {
      return;
    }

    try {
      const { isManualAdjust, systemBalance, yesterdayBalance, balanceDiff, parseResult, shopName } = this.data;

      // 检查 parseResult 是否存在
      if (!parseResult) {
        console.error('[generateReport] parseResult 未初始化');
        wx.showModal({
          title: '数据异常',
          content: '❌ 解析结果未初始化，请先输入捐款名单后重试。\n\n如问题持续请截图反馈。',
          showCancel: false
        });
        return;
      }

      // 允许空数据继续执行（用户可能只输入了其他支持或支出）
      const { items = [], totalAmount: donationsTotal = 0 } = parseResult;

      // 检查必要字段是否存在
      if (!shopName) {
        wx.showModal({
          title: '数据异常',
          content: '❌ 店铺名称未设置，请在设置中配置店铺名称。',
          showCancel: false
        });
        return;
      }

      if (isManualAdjust) {
        await this.showAdjustReasonModal(systemBalance, parseFloat(yesterdayBalance) || 0, balanceDiff);

        if (!this.data.adjustReason || this.data.adjustReason.trim() === '') {
          wx.showToast({ title: '平账原因不能为空，请如实填写', icon: 'none' });
          return;
        }
      }

      this.isSubmitting = true;
      this.setData({ isSubmitting: true });
      wx.showLoading({ title: '正在生成文本...', mask: true });

      try {
        // ====== 第一步：纯前端生成文本（不依赖云端，绝不阻塞） ======
        const { reportDate, otherDonation, expenses, dailyExpenseText, fixedExpenseText, fixedExpenseItems, shopName, mpAccount, adjustReason, receiptImages, reportDateValue, thankText, slogan1, slogan2, materials, activityText, volunteerCount, volunteerHours, diningCount, stapleRiceStatus, stapleOilStatus, mergeToReportText, announcement, dineInSeniors, deliverySeniors, dineInVolunteers, deliveryVolunteers, takeawayCount, totalDineCount, totalVolunteers } = this.data;
        const prevBalanceNum = parseFloat(yesterdayBalance) || 0;
        const b4_total = parseFloat(otherDonation) || 0;

        // 🌟 唯一权威计算入口：dailyExpenseTotal/fixedExpenseTotal 复用与顶部算式校验
        // 完全相同的 calculateTodayExpenseFromText，expenseTotal/todayTotalSum/newBalanceSum
        // 直接取 computeTodayFinancials 的结果，确保提交保存的数字与页面上展示的分毫不差。
        const dailyExpenseTotal = this.calculateTodayExpenseFromText(dailyExpenseText);
        const fixedExpenseTotal = this.calculateTodayExpenseFromText(fixedExpenseText);
        const { todayIncome: todayTotalSum, todayExpense: expenseTotal, todayBalance: newBalanceSum } = this.computeTodayFinancials();

        const dateString = deriveDateString(reportDateValue, reportDate);

        const report = generateReportText({
          shopName: shopName,
          dateString: dateString,
          reportDate: reportDate,
          items: items,
          totalAmount: donationsTotal,
          otherDonation: b4_total,
          yesterdayBalance: prevBalanceNum,
          expenseAmount: expenseTotal,
          dailyExpenseTotal: dailyExpenseTotal,
          fixedExpenseTotal: fixedExpenseTotal,
          todayBalance: newBalanceSum,
          expenses: expenses,
          dailyExpenseText: dailyExpenseText,
          fixedExpenseText: fixedExpenseText,
          mpAccount: mpAccount,
          thankText: thankText,
          slogan1: slogan1,
          slogan2: slogan2,
          materials: materials || [],
          activityText: activityText || '',
          volunteerCount: parseFloat(volunteerCount) || 0,
          volunteerHours: parseFloat(volunteerHours) || 0,
          diningCount: parseFloat(diningCount) || 0,
          stapleRiceStatus: stapleRiceStatus,
          stapleOilStatus: stapleOilStatus,
          noticeTag: announcement && announcement.tag,
          noticeTitle: announcement && announcement.title,
          noticeContent: announcement && announcement.content,
          mergeToReportText: mergeToReportText
        });

        // 内容安全检测 - 设置超时保护
        let isContentSafe = true;
        try {
          isContentSafe = await Promise.race([
            this.checkContentSafety(report),
            new Promise<boolean>((resolve) => {
              setTimeout(() => {
                console.warn('[checkContentSafety] 检测超时，跳过检测');
                resolve(true);
              }, 3000); // 3秒超时
            })
          ]);
        } catch (safeErr: any) {
          console.warn('[checkContentSafety] 检测异常，跳过检测:', safeErr);
          isContentSafe = true;
        }

        if (!isContentSafe) {
          wx.hideLoading();
          this.isSubmitting = false;
          this.setData({ isSubmitting: false });
          return;
        }

        // ====== 立即显示结果 + 复制到剪贴板（纯前端，不等待保存） ======
        this.setData({
          reportResult: report,
          showResult: true,
          isResultExpanded: true
        });

        wx.setClipboardData({
          data: report,
          success() {
            wx.showToast({ title: '餐报已复制，可直接发送至微信群', icon: 'none', duration: 2500 });
          },
          fail() {
            console.warn('[generateReport] 自动复制失败，用户可手动复制');
          }
        });

        wx.hideLoading();

        // ====== 第二步：异步保存到数据库（后台静默，失败不影响已生成的文本） ======
        const majorExpenseItems = this.parseExpenseTextToItems(fixedExpenseText, fixedExpenseTotal, dateString);
        const dailyIngredientItems = this.parseExpenseTextToItems(dailyExpenseText, dailyExpenseTotal, dateString);

        const submitData = {
          _id: this.data.editReportId || '',
          dateString: dateString,
          reportDate: reportDate,
          shopName: shopName,
          mpAccount: mpAccount,
          yesterdayBalance: prevBalanceNum,
          otherDonation: b4_total,
          listDonationTotal: donationsTotal,
          expenseAmount: expenseTotal,
          dailyExpenseTotal: dailyExpenseTotal,
          fixedExpenseTotal: fixedExpenseTotal,
          expenses: expenses,
          dailyExpenseText: dailyExpenseText,
          fixedExpenseText: fixedExpenseText,
          // 🔒 大额专项行级独立凭证：附加字段，随报表一并落库，不影响 fixedExpenseText/
          // majorExpenseItems 既有的金额结算与统计流转（那两个仍照旧只读派生文本）
          fixedExpenseItems: (fixedExpenseItems || []).map((item: any) => ({
            _key: item._key,
            name: item.name,
            amount: item.amount,
            independent_image_urls: item.independent_image_urls || []
          })),
          majorExpenseItems: majorExpenseItems,
          dailyIngredientItems: dailyIngredientItems,
          todayBalance: newBalanceSum,
          reportText: report,
          donationItems: items,
          receiptImages: receiptImages || [],
          isManualAdjust: isManualAdjust,
          systemBalance: systemBalance,
          adjustedBalance: prevBalanceNum,
          balanceDiff: balanceDiff,
          adjustReason: adjustReason || '',
          materials: materials || [],
          volunteerCount: parseFloat(volunteerCount) || 0,
          volunteerHours: parseFloat(volunteerHours) || 0,
          diningCount: parseFloat(diningCount) || 0,
          dineInSeniors: parseFloat(dineInSeniors) || 0,
          deliverySeniors: parseFloat(deliverySeniors) || 0,
          dineInVolunteers: parseFloat(dineInVolunteers) || 0,
          deliveryVolunteers: parseFloat(deliveryVolunteers) || 0,
          takeawayCount: parseFloat(takeawayCount) || 0,
          totalDineCount: parseFloat(totalDineCount) || 0,
          totalVolunteers: parseFloat(totalVolunteers) || 0,
          stapleRiceStatus: stapleRiceStatus,
          stapleOilStatus: stapleOilStatus
        };

        let guardPassed = true;
        try {
          guardPassed = await this.runGuardrailChecks(submitData);
        } catch (guardErr) {
          console.warn('[runGuardrailChecks] 风控校验异常，已降级放行:', guardErr);
          guardPassed = true;
        }

        if (!guardPassed) {
          wx.hideLoading();
          return;
        }

        await this.saveReportAsync(submitData);

        this.clearDraft();

      } catch (innerError: any) {
        wx.hideLoading();
        const errMsg = innerError instanceof Error ? innerError.message : String(innerError);
        console.error('[generateReport] 生成文本异常:', innerError);
        wx.showModal({
          title: '生成文本失败',
          content: `❌ 错误信息：${errMsg}\n\n请检查输入内容是否正确，或截图反馈给开发者。`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } catch (outerError: any) {
      wx.hideLoading();
      const errMsg = outerError instanceof Error ? outerError.message : String(outerError);
      console.error('[generateReport] 外层异常:', outerError);
      wx.showModal({
        title: '系统异常',
        content: `❌ 外层错误：${errMsg}`,
        showCancel: false
      });
    } finally {
      this.isSubmitting = false;
      this.setData({ isSubmitting: false });
    }
  },

  async saveReportAsync(submitData: any) {
    try {
      // 上传支出凭证图片（已上传的云地址会自动跳过）
      const uploadedReceiptImages = await this.uploadReceiptImages();
      submitData.receiptImages = uploadedReceiptImages;

      const saveResult = await DataService.saveReport(submitData);

      if (!saveResult.success) {
        const errDetail = saveResult.errorDetail || saveResult.message || '未知错误';
        const isCollectionMissing = errDetail.includes('-501000') || errDetail.includes('resource') || errDetail.includes('not exist');
        const isAllZero = errDetail === 'all_zero_skipped';
        const isDuplicateDate = errDetail === 'duplicate_date_blocked';

        if (isDuplicateDate) {
          // 🌟 重复录入拦截：不能走离线队列重试（会一直被拦截，甚至在极端时序下仍可能造成重复），
          // 直接引导用户去历史记录编辑/修改已存在的当日记录
          wx.showModal({
            title: '⚠️ 重复录入提醒',
            content: saveResult.message || '该日期已存在餐报记录，请直接在历史记录中编辑或修改，避免重复录入',
            confirmText: '去历史记录',
            cancelText: '我知道了',
            success: (res) => {
              if (res.confirm) {
                wx.navigateTo({ url: '/pages/history/history' });
              }
            }
          });
        } else if (!isAllZero) {
          wx.showModal({
            title: isCollectionMissing ? '云数据库集合未创建' : '保存到云端失败',
            content: isCollectionMissing
              ? `❌ 错误详情：${errDetail}\n\n💡 请在云开发控制台手动创建 report_logs 集合（权限建议：仅创建者可读写）。\n\n账目已安全暂存本地。`
              : `❌ 错误详情：${errDetail}\n\n账目已安全暂存本地，联网后将自动同步。`,
            showCancel: false,
            confirmText: '我知道了'
          });

          saveToQueue(submitData);
          this.updateOfflineQueueCount();
        } else {
        }
      } else {
        // 用上传后的云地址更新页面状态，避免重复上传和编辑丢失
        this.setData({ receiptImages: uploadedReceiptImages });
        this.updateOfflineQueueCount();
        // 🌟 记录今天出现过的爱心支持姓名，供【选择常客】快速点选入口使用
        this.recordDonorFrequency(submitData.donationItems);

        if (this.data.isEditMode) {
          await this.triggerAtomicCascadeUpdate(submitData);
        } else {
          await this.triggerCascadeRecalculation(submitData);
        }

        wx.showToast({ title: '保存成功', icon: 'success', duration: 1500 });
        recordSuccessfulSubmit(); // 记录提交成功（用于频率限制）

        // 🍱📌 餐报保存成功后，若随表单一并上传了食谱/大事记照片，则同步发布，
        // 失败不影响餐报本身已保存成功的事实，仅静默提示可稍后手动补发
        this.publishRecipeAndActivityIfPresent();

        if (this.data.isEditMode) {
          this.isNavigating = true;
          setTimeout(() => {
            wx.navigateBack({
              delta: 1,
              fail: () => {
                this.isNavigating = false;
              }
            });
          }, 1500);
        }
      }
    } catch (err: any) {
      console.error('[saveReportAsync] 保存异常:', err);
      const errMsg = err.errMsg || err.message || '未知错误';
      const isNetworkError = errMsg.includes('timeout') || errMsg.includes('Network') ||
                           errMsg.includes('网络') || errMsg.includes('fail') ||
                           errMsg.includes('connect') || errMsg.includes('abort');

      if (isNetworkError) {
        saveToQueue(submitData);
        this.updateOfflineQueueCount();
        wx.showToast({ title: '已暂存本地，联网后同步', icon: 'none', duration: 2000 });
      } else {
        wx.showModal({
          title: '保存失败（详细错误）',
          content: `❌ 错误码: ${err.errCode || 'N/A'}\n错误信息: ${errMsg}\n\n账目已暂存本地，请检查云开发环境。`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    }
  },

  // 🍱📌 餐报提交成功后，若随表单一并上传了"今日食谱照片"/"今日大事记照片+描述"，
  // 自动同步发布到 daily_menus / activity_logs，无需再手动跳去两个入口分别发布
  async publishRecipeAndActivityIfPresent() {
    const storeId = this.data.currentStoreId;
    if (!storeId || storeId === 'national_overview' || storeId === 'ALL_STORES') {
      return;
    }

    const { recipeImages, activityImages, activityText } = this.data;
    const hasRecipe = recipeImages.length > 0;
    const hasActivity = activityImages.length > 0 || !!activityText.trim();

    if (!hasRecipe && !hasActivity) return;

    if (!isCloudAvailable()) {
      wx.showToast({ title: '云服务暂不可用，食谱/大事记照片未同步，可稍后手动补发', icon: 'none', duration: 2500 });
      return;
    }

    const dateString = getTodayIsoString();
    let recipeFailed = false;
    let activityFailed = false;

    // 🛡️ recipeImages 页面内部状态是 {url,name}[]，提交前补上 manageDailyMenu 云函数
    // sanitizeImages 需要的 thumbUrl 字段（复用 url，与 daily-menu 页面同款做法）。
    // activityImages 仍是纯字符串数组，同样转换成 manageActivityLog 期待的对象形状
    const recipeImagesForSubmit = recipeImages.map((img: any) => ({ url: img.url, thumbUrl: img.url, name: (img.name || '').trim() }));
    const activityImagesForSubmit = activityImages.map((url: string) => ({ url, thumbUrl: url }));

    if (hasRecipe) {
      try {
        const res = await wx.cloud.callFunction({
          name: 'manageDailyMenu',
          data: { action: 'create', storeId, dateString, menuText: '', images: recipeImagesForSubmit }
        });
        const result = res.result as any;
        if (!result || !result.success) {
          recipeFailed = true;
          console.warn('[publishRecipeAndActivityIfPresent] 今日食谱同步失败:', result && result.error);
        } else {
          this.fetchTodayMenu();
        }
      } catch (e) {
        recipeFailed = true;
        console.warn('[publishRecipeAndActivityIfPresent] 今日食谱同步异常:', e);
      }
    }

    if (hasActivity) {
      try {
        // 🔗 门店日志联动：今天已经有一条记录（不管是"门店日志"页手动发布的，
        // 还是之前的自动同步）就精准 update 那一条；只有今天完全没有记录时才
        // 走 autoSyncFromReport 的新建流程。避免手动记录与自动同步记录各自
        // 独立、堆出两条内容重复的大事记。
        const sourceId = this.data.todayActivitySourceId;
        const activityPayload: any = sourceId
          ? {
              action: 'update',
              id: sourceId,
              storeId,
              title: `${this.data.currentStoreName || '门店'} · ${dateString} 门店日志`,
              eventTime: dateString,
              content: activityText.trim(),
              images: activityImagesForSubmit
            }
          : {
              action: 'create',
              autoSyncFromReport: true,
              storeId,
              title: `${this.data.currentStoreName || '门店'} · ${dateString} 门店日志`,
              eventTime: dateString,
              content: activityText.trim(),
              images: activityImagesForSubmit
            };

        const res = await wx.cloud.callFunction({
          name: 'manageActivityLog',
          data: activityPayload
        });
        const result = res.result as any;
        if (!result || !result.success) {
          activityFailed = true;
          console.warn('[publishRecipeAndActivityIfPresent] 大事记同步失败:', result && result.error);
        } else {
          this.fetchTodayActivity();
        }
      } catch (e) {
        activityFailed = true;
        console.warn('[publishRecipeAndActivityIfPresent] 大事记同步异常:', e);
      }
    }

    if (recipeFailed || activityFailed) {
      wx.showToast({
        title: '餐报已保存，但食谱/大事记照片同步失败，可稍后手动补发',
        icon: 'none',
        duration: 2500
      });
    }

    // 清空表单内这两块内容，避免下次编辑/重复提交时误重发同一批照片
    this.setData({ recipeImages: [], activityImages: [], activityText: '' });
  },

  async runGuardrailChecks(submitData: any): Promise<boolean> {
    try {
      // #11 前置快速频率检查
      const freqCheck = canSubmitNow();
      if (!freqCheck.canSubmit) {
        wx.showModal({
          title: '提交受限',
          content: freqCheck.reason,
          showCancel: false,
          confirmText: '知道了'
        });
        return false;
      }

      const allReports = wx.getStorageSync('local_report_logs') || [];
      const storeName = this.data.shopName || '';
      const storeReports = allReports.filter((r: any) => r.shopName === storeName);

      let avgDailyFoodExpense = 0;
      let avgDailyIncome = 0;
      let avgBalance = 0;
      let lastReportDate = '';
      let lastBalance = 0;

      if (storeReports.length > 0) {
        const sorted = [...storeReports].sort((a: any, b: any) =>
          (a.reportDate || '').localeCompare(b.reportDate || '')
        );

        const recentReports = sorted.slice(-14);

        // 平均食材支出
        const validFoodExpenses = recentReports
          .map((r: any) => parseFloat(r.dailyExpenseTotal || r.dailyExpense || 0))
          .filter((v: number) => v > 0);
        if (validFoodExpenses.length > 0) {
          avgDailyFoodExpense = validFoodExpenses.reduce((sum: number, v: number) => sum + v, 0) / validFoodExpenses.length;
        }

        // 平均收入
        const validIncomes = recentReports
          .map((r: any) => parseFloat(r.listDonationTotal || 0) + parseFloat(r.otherDonation || 0))
          .filter((v: number) => v > 0);
        if (validIncomes.length > 0) {
          avgDailyIncome = validIncomes.reduce((sum: number, v: number) => sum + v, 0) / validIncomes.length;
        }

        // 平均余额
        const validBalances = recentReports
          .map((r: any) => parseFloat(r.todayBalance || 0))
          .filter((v: number) => v > 0);
        if (validBalances.length > 0) {
          avgBalance = validBalances.reduce((sum: number, v: number) => sum + v, 0) / validBalances.length;
        }

        const lastItem = sorted[sorted.length - 1];
        lastReportDate = (lastItem && lastItem.reportDate) || '';
        lastBalance = parseFloat((lastItem && lastItem.todayBalance) || 0);
      }

      const guardResult: GuardrailResult = validateReportGuardrails(
        {
          yesterdayBalance: parseFloat(submitData.yesterdayBalance || 0),
          todayBalance: parseFloat(submitData.todayBalance || 0),
          income: parseFloat(submitData.listDonationTotal || 0) + parseFloat(submitData.otherDonation || 0),
          dailyExpense: parseFloat(submitData.dailyExpenseTotal || 0),
          totalDiners: parseFloat(submitData.diningCount || 0) + parseFloat(submitData.volunteerCount || 0),
          volunteerCount: parseFloat(submitData.volunteerCount || 0),
          volunteerHours: parseFloat(submitData.volunteerHours || 0),
          reportDate: submitData.reportDate || '',
          expenseFreeText: [submitData.dailyExpenseText, submitData.fixedExpenseText, submitData.materialsInput]
            .filter(Boolean)
            .join('\n')
        },
        {
          avgDailyFoodExpense,
          avgDailyIncome,
          avgBalance,
          lastReportDate,
          lastBalance
        }
      );

      if (!guardResult.canSubmit) {
        wx.showModal({
          title: '无法提交',
          content: guardResult.blockReason,
          showCancel: false,
          confirmText: '返回修改'
        });
        return false;
      }

      if (guardResult.hasWarning) {
        return new Promise<boolean>((resolve) => {
          wx.showModal({
            title: '数据异常提醒',
            content: guardResult.warningMessage,
            confirmText: '确认无误',
            cancelText: '重新检查',
            success: (res) => {
              if (res.confirm) {
                recordWarningConfirmed(); // 记录警告确认
              }
              resolve(res.confirm || false);
            }
          });
        });
      }

      // #12 gapDaysNotice 改为阻塞 modal，等待用户确认后再继续
      if (guardResult.gapDaysNotice) {
        return new Promise<boolean>((resolve) => {
          wx.showModal({
            title: '日期提醒',
            content: guardResult.gapDaysNotice,
            showCancel: false,
            confirmText: '继续提交',
            success: (res) => {
              resolve(res.confirm || false);
            }
          });
        });
      }

      return true;
    } catch (e) {
      // 风控校验异常时平滑降级放行，不阻塞用户正常使用
      console.warn('[runGuardrailChecks] 风控校验异常，已降级放行:', e);
      return true;
    }
  },

  // 🛡️ 紧急安全修复：此前调用的 recalculateLedgerChain 云函数在 storeId 为空/'all' 时
  // 会跳过门店过滤条件，把全部门店的历史记录当作同一条流水链混算，曾导致全库结余数据被
  // 串联污染。现改为调用经过门店/租户强校验、且明确限定只写 report_logs 集合内
  // yesterdayBalance/todayBalance 字段的 recalculateCascadeBalances，绝不触碰 storeId/storeName。
  async triggerCascadeRecalculation(submitData: any) {
    try {
      const shopName = submitData.shopName || this.data.shopName || '';
      const modifiedDate = submitData.dateString || '';

      if (!shopName || !modifiedDate) {
        return;
      }

      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'recalculateCascadeBalances',
        data: {
          shopName,
          modifiedDate
        }
      });

      const result = res.result as any;
      if (result && result.success && result.updatedCount && result.updatedCount > 0) {
        wx.showModal({
          title: '级联校正完成',
          content: `已为您自动重算并修正了 ${result.updatedCount} 条账目余额！`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } catch (err) {
      console.error('[triggerCascadeRecalculation] 级联重算失败:', err);
    }
  },

  async triggerAtomicCascadeUpdate(submitData: any) {
    try {
      const shopName = submitData.shopName || this.data.shopName || '';
      const modifiedDate = submitData.dateString || '';

      if (!modifiedDate) {
        await this.triggerCascadeRecalculation(submitData);
        return;
      }

      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'recalculateCascadeBalances',
        data: {
          shopName,
          modifiedDate
        }
      });

      const result = res.result as any;
      if (result && result.success && result.updatedCount && result.updatedCount > 0) {
        wx.showModal({
          title: '级联校正完成',
          content: `已为您自动重算并修正了 ${result.updatedCount} 条账目余额！`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } catch (err) {
      console.error('[triggerAtomicCascadeUpdate] 原子化级联更新失败，回退到普通级联重算:', err);
      await this.triggerCascadeRecalculation(submitData);
    }
  },

  copyText() {
    wx.setClipboardData({
      data: this.data.reportResult,
      success() {
        wx.showToast({ title: '复制成功', icon: 'success' });
      }
    });
  },

  onToggleResultExpand() {
    this.setData({
      isResultExpanded: !this.data.isResultExpanded
    });
  },

  updateOfflineQueueCount() {
    const count = getQueueCount();
    this.setData({ offlineQueueCount: count });
  },

  // 🐛 根因修复：统一首页动态数据（公告/今日食谱/大事记/物资状态）的唯一触发入口。
  // onLoad 在角色解析就绪（await initCurrentUserRole() 完成）后调用一次并标记
  // hasInitedData；onShow 只在 hasInitedData 已为 true（即真正的"切回本页"，
  // 而非与 onLoad 冷启动赛跑的那次）时才会再调用。_homeDataFetchInFlight 做
  // 进行中防抖，避免快速连续触发（如短时间内切换多次 Tab）导致并发重复请求
  loadHomeDynamicData() {
    if (this._homeDataFetchInFlight) {
      console.log('[Index][loadHomeDynamicData] 已有请求在途，跳过本次重复调用');
      return;
    }
    this._homeDataFetchInFlight = true;
    Promise.allSettled([
      this.fetchTodayMenu(),
      this.fetchTodayActivity(),
      this.fetchNotices(),
      this.fetchLatestMaterialStatus()
    ]).finally(() => {
      this._homeDataFetchInFlight = false;
    });
  },

  onShow() {
    // 重置路由防重锁
    this.isNavigating = false;

    // 🌟 同步自定义 TabBar 高亮态：custom-tab-bar 是框架在 tabBar.list 页面外层自动挂载的
    // 常驻组件，并非各页面自身 WXML 中声明的子组件，其 pageLifetimes.show 并不保证跟随
    // 每次 switchTab 可靠触发，官方文档明确要求各 Tab 页面自行在 onShow 中显式同步一次。
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }

    // #11 清理过期的频率记录和警告确认记录
    cleanExpiredFrequencyRecords();

    // 任务C：如果有待执行的锚点滚动，则在 onShow 中触发
    // （需等待 onShow 完成 setData 后再执行，确保 DOM 已渲染）
    if (this._pendingScrollTarget) {
      const target = this._pendingScrollTarget;
      // 清除暂存，避免下次 onShow 重复触发
      this._pendingScrollTarget = '';
      // 延迟 300ms 等待页面 setData 与 DOM 渲染完成
      setTimeout(() => {
        this.scrollToAnchorAndHighlight(target);
      }, 300);
    } else {
      // 兼容 navigateBack 场景：通过 globalData 传递的待滚动目标
      try {
        const app = getApp() as any;
        if (app.globalData && app.globalData.pendingScrollTarget) {
          const target = app.globalData.pendingScrollTarget;
          app.globalData.pendingScrollTarget = '';
          setTimeout(() => {
            this.scrollToAnchorAndHighlight(target);
          }, 300);
        }
      } catch (e) {
        /* ignore */
      }
    }

    this.refreshUserRoleView();

    // 🐛 门店切换后公告栏/今日食谱/大事记不刷新的根因修复：这几个请求都依赖
    // this.data.currentStoreId，但它们此前排在 refreshUserRoleView() 之前调用——
    // refreshUserRoleView() 才是真正把 storage 里最新的 current_store_id 同步进
    // this.data 的地方。如果切店发生在别的页面（或通过 storage 持久化，而不是本页
    // onStoreChanged/switchStoreTarget 这两个会自行 setData 的入口），仅靠 switchTab
    // 回到首页触发 onShow 时，这几个请求会先用着切店前的旧 currentStoreId 发起，
    // 稍后 refreshUserRoleView() 才把新门店 id 写进 this.data，为时已晚。
    // 现移到 refreshUserRoleView() 之后，确保总是用最新门店 id 发起请求。
    //
    // 🐛 根因修复：onLoad/onShow 是背靠背同步触发的，onShow 几乎必然抢在 onLoad 里
    // await initCurrentUserRole() 完成之前跑完——冷启动时 hasInitedData 还是 false，
    // 这里直接跳过，交给 onLoad 在角色就绪后触发 loadHomeDynamicData() 唯一一次；
    // 后续真正"切回本页"的场景（hasInitedData 已为 true）照常刷新，不改变现有的
    // 返回页面即刷新的产品行为
    if (this.data.hasInitedData) {
      this.loadHomeDynamicData();
    }
    this.setData({ cultureQuote: getDailyCultureQuote() });

    // ❤️ 家人首页第一模块【阳光账本核心大盘】：复用弹窗那套 fetchSunshineLedgerData/
    // sunshineStatCards 数据管线，只是这里直接内联展示在首页卡片上，不弹窗；
    // 卡片本身的"查看完整账本"入口仍点击 onOpenSunshineLedger 弹出详情
    if (this.data.isFamily && this.data.currentStoreId && !this.isNationalOverviewSelected()) {
      const now = new Date();
      const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      this.fetchSunshineLedgerData(currentYearMonth);
    }

    // 🌟 财务视角首页角标：预先拉取一次风控预警数量，避免用户必须先点开弹窗才知道有没有异常
    if ((this.data.isFinance || this.data.isSuperAdmin) && this.data.currentStoreId && !this.isNationalOverviewSelected()) {
      this.fetchRiskAlerts();
    }

    const activeStore = getSelectedStore();
    if (activeStore && activeStore.storeName !== this.data.shopName) {
      this.setData({
        shopName: activeStore.storeName
      });
      if (typeof this.autoFetchPreviousBalance === 'function') {
        this.autoFetchPreviousBalance(this.data.reportDateRaw);
      }
    }

    this.loadSettings();
    this.loadLastBalance();
    if (typeof (this as any).loadVolunteerStats === 'function') {
      (this as any).loadVolunteerStats();
    }
    DataService.syncLocalDataToCloud();
    this.updateOfflineQueueCount();
    this.autoSyncOfflineQueue();
    this.mergeStagedReceiptStash();

    const app = getApp();
    app.globalData.onNetworkReconnected = () => {
      this.autoSyncOfflineQueue();
    };

    this.loadEditReportData();

    // 切后台回来后重新获取编辑锁
    const storeId = this.data.currentStoreId || '';
    const reportDate = this.data.reportDateRaw || '';
    if (storeId && reportDate && this.data.permissions && this.data.permissions.canEditBalance) {
      this.checkAndAcquireLock(storeId, reportDate);
    }

    this.checkPendingHandoffs();
    this.checkPendingInviteContext();
    this.checkPendingInviteCode();
  },

  // 草稿箱 / 设置页 跳回首页后的"交接标记"检查：全部复用已有的加载/弹窗逻辑，
  // 本方法只负责识别标记并派发，不重写任何业务逻辑
  checkPendingHandoffs() {
    const resumeDraft = takeResumeDraftHandoff();
    if (resumeDraft) {
      this.loadDraftByDate(resumeDraft.dateValue, resumeDraft.shopName).then((hasDraft) => {
        if (hasDraft) {
          wx.showToast({ title: '已恢复所选草稿 ✍️', icon: 'none', duration: 2000 });
        } else {
          wx.showToast({ title: '该草稿已被清空或不存在', icon: 'none' });
        }
      });
      return;
    }

    if (takeComplianceReviewRequest()) {
      this.setData({ showComplianceModal: true, complianceModalScene: 'review' });
      return;
    }

    // 个人页「关于雨花斋与阳光账本」交接：阳光账本弹窗唯一实现在本页，
    // 个人页只标记意图，这里据此直接打开已有的弹窗（复用 onOpenSunshineLedger
    // 完整的数据拉取流程，不重复实现）
    if (takeOpenSunshineLedgerRequest()) {
      this.onOpenSunshineLedger();
      return;
    }

    // 个人页「雨花家训与文化全集」交接：文化全集弹窗唯一实现在本页，复用
    // onShowFamilyMottoModal 完整的十大模块数据装配逻辑，不重复实现
    if (takeOpenCultureFullRequest()) {
      this.onShowFamilyMottoModal();
      return;
    }

    // 个人页「切换关注门店」交接：门店选择器唯一可见实例挂载在本页
    // （id="storePicker"），个人页不再自己隐藏挂载一份，直接拉起本页已有的面板
    if (takeOpenStorePickerRequest()) {
      const picker = this.selectComponent('#storePicker');
      if (picker && typeof (picker as any).onOpenSheet === 'function') {
        (picker as any).onOpenSheet();
      }
      return;
    }

    // 门店管理页「生成邀请码」快捷按钮的交接：打开已有的邀请码弹窗后，直接覆盖预选为
    // 目标门店（不依赖 currentStoreId 的默认选中逻辑——那反映的是"当前用户自己绑定的门店"，
    // 超管在门店管理页点的可能是本机构下的任意一家门店，两者不一定相同）。
    // 🛡️ store-management.ts 本身已把整个页面访问收窄到仅 isSuperAdmin（见该页
    // checkedAccess 逻辑），这个交接触发点理论上只有超管能走到；这里再加一层
    // isSuperAdmin 防御，非超管（店长/大家长）即使因某种极端时序收到这个交接，
    // 也绝不允许用它覆盖 onOpenGenCodeModal 已经强制锁定的"仅本店"选择
    const genCodeTarget = takeGenCodeHandoff();
    if (genCodeTarget) {
      this.onOpenGenCodeModal();
      if (this.data.isSuperAdmin) {
        this.setData({
          targetGenStoreId: genCodeTarget.storeId,
          targetGenStoreName: genCodeTarget.storeName
        });
      }
    }
  },

  // 🌟 朋友圈证书扫码引流：app.ts 的 onLaunch/onShow 已经把 scene 解析成
  // globalData.inviteContext（referrerUserId/targetStoreId 均为 10 位前缀，见
  // getStoreQRCode 的证书 scene 简化编码）。这里只在真正需要时才弹窗——已绑定
  // 同一门店（当前 currentStoreId 命中该前缀）视为已加入，静默清空即可，
  // 不打扰用户
  async checkPendingInviteContext() {
    const app = getApp() as any;
    const inviteContext = app.globalData && app.globalData.inviteContext;
    if (!inviteContext || !inviteContext.targetStoreId) return;

    const currentStoreId = this.data.currentStoreId || '';
    if (currentStoreId && currentStoreId.startsWith(inviteContext.targetStoreId)) {
      app.globalData.inviteContext = null;
      return;
    }

    if (!isCloudAvailable()) return;

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'bindReferralStore',
        data: {
          action: 'resolve',
          storeIdPrefix: inviteContext.targetStoreId,
          referrerIdPrefix: inviteContext.referrerUserId
        }
      });
      const result = res.result;
      if (!result || !result.success) {
        app.globalData.inviteContext = null;
        return;
      }

      const { storeName, referrerNickName } = result.data;
      wx.showModal({
        title: '❤️ 爱心邀请',
        content: `来自 ${referrerNickName} 的邀请，是否加入 ${storeName}？`,
        confirmText: '加入',
        cancelText: '暂不',
        success: (modalRes) => {
          if (modalRes.confirm) {
            this.confirmInviteBind(inviteContext);
          } else {
            app.globalData.inviteContext = null;
          }
        },
        fail: () => {
          app.globalData.inviteContext = null;
        }
      });
    } catch (err) {
      console.warn('[checkPendingInviteContext] 解析邀请上下文失败:', err);
      app.globalData.inviteContext = null;
    }
  },

  async confirmInviteBind(inviteContext: { referrerUserId: string; targetStoreId: string }) {
    const app = getApp() as any;
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'bindReferralStore',
        data: {
          action: 'bind',
          storeIdPrefix: inviteContext.targetStoreId,
          referrerIdPrefix: inviteContext.referrerUserId
        }
      });
      const result = res.result;
      if (result && result.success) {
        wx.showToast({ title: `已加入${result.data.storeName}`, icon: 'success' });
        this.refreshUserRoleView();
      } else {
        wx.showToast({ title: (result && result.error) || '加入失败，请重试', icon: 'none' });
      }
    } catch (err) {
      console.warn('[confirmInviteBind] 绑定门店异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      app.globalData.inviteContext = null;
    }
  },

  // 🔑 特权邀请码扫码直达：app.ts 已把 scene 里的 code=<邀请码> 解析进
  // globalData.pendingInviteCode（见 cloudfunctions/manageStoreInviteCode 的
  // generate 动作、太阳码 scene 简化编码）。只对"未绑定新用户"（isFamily，即
  // 家人/服务对象的默认态）自动弹出确认框——已持有正式身份的账号不应被一次
  // 扫码悄悄改变角色，若确实想兑换别的邀请码，走 store-picker 手动输入邀请码
  // 的既有通道（那里有胶囊上下文可核对，不会被扫码环境悄悄替换身份）。
  // peek 动作只读查询、不消耗一次性口令，确认后才真正调用 redeem
  async checkPendingInviteCode() {
    const app = getApp() as any;
    const code = app.globalData && app.globalData.pendingInviteCode;
    if (!code) return;

    if (!this.data.isFamily) {
      app.globalData.pendingInviteCode = '';
      return;
    }

    if (!isCloudAvailable()) return;

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreInviteCode',
        data: { action: 'peek', code }
      });
      const result = res.result;
      if (!result || !result.success) {
        app.globalData.pendingInviteCode = '';
        if (result && result.error) {
          wx.showToast({ title: result.error, icon: 'none', duration: 2500 });
        }
        return;
      }

      const { storeName, targetRole } = result.data;
      const localRole = INVITE_SERVER_ROLE_TO_LOCAL[targetRole];
      const roleLabel = (localRole && INVITE_ROLE_LABEL_MAP[localRole]) || targetRole;

      wx.showModal({
        title: '❤️ 爱心邀请',
        content: `确认绑定并加入【${storeName}】，成为【${roleLabel}】吗？`,
        confirmText: '确认加入',
        cancelText: '暂不',
        success: (modalRes) => {
          if (modalRes.confirm) {
            this.confirmInviteCodeRedeem(code);
          } else {
            app.globalData.pendingInviteCode = '';
          }
        },
        fail: () => {
          app.globalData.pendingInviteCode = '';
        }
      });
    } catch (err) {
      console.warn('[checkPendingInviteCode] 邀请码预检异常:', err);
      app.globalData.pendingInviteCode = '';
    }
  },

  async confirmInviteCodeRedeem(code: string) {
    const app = getApp() as any;
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreInviteCode',
        data: { action: 'redeem', code }
      });
      const result = res.result;
      if (result && result.success) {
        // 🛡️ 核销是服务端真正的角色晋升（写入 user_roles.role/roles 数组），
        // 立即拉一次最新角色，让 AuthService 缓存与本页展示跟上服务端的真实结果
        await AuthService.fetchUserRole();
        wx.showToast({ title: `已加入${result.data.storeName}`, icon: 'success' });
        this.refreshUserRoleView();
      } else {
        wx.showToast({ title: (result && result.error) || '绑定失败，请重试', icon: 'none' });
      }
    } catch (err) {
      console.warn('[confirmInviteCodeRedeem] 核销异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      app.globalData.pendingInviteCode = '';
    }
  },

  /**
   * 任务C：锚点聚焦 + 高亮动画
   * 通过 wx.createSelectorQuery 计算目标元素位置，使用 wx.pageScrollTo 平滑滚动到屏幕中央，
   * 然后为目标元素添加 .highlight-pulse 动画类，2秒后自动移除。
   */
  scrollToAnchorAndHighlight(targetSelector: string) {
    const selector = `#${targetSelector}`;
    const query = wx.createSelectorQuery().in(this);
    query.select(selector).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((res) => {
      if (!res || !res[0] || !res[1]) {
        console.warn('[Index] 锚点元素未找到:', selector);
        return;
      }
      const rect: any = res[0];
      const scrollOffset: any = res[1];

      // 计算让目标元素居中所需的滚动距离
      // 屏幕高度通过 getSafeSystemInfo 获取
      let windowHeight = 667;
      try {
        windowHeight = getSafeSystemInfo().windowHeight;
      } catch (e) {
        /* ignore */
      }

      const targetScrollTop = scrollOffset.scrollTop + rect.top - windowHeight / 2 + rect.height / 2;

      // 平滑滚动到目标位置（duration 400ms 自然顺滑）
      wx.pageScrollTo({
        scrollTop: Math.max(0, targetScrollTop),
        duration: 400,
        complete: () => {
          // 滚动完成后触发高亮动画
          this.triggerHighlightPulse();
        }
      });
    });
  },

  /**
   * 触发 .highlight-pulse 高亮动画，2秒后自动移除
   */
  triggerHighlightPulse() {
    // 清理上一次的定时器，避免重复
    if (this._highlightTimer) {
      clearTimeout(this._highlightTimer);
    }

    this.setData({ highlightCheckInCard: true });

    this._highlightTimer = setTimeout(() => {
      this.setData({ highlightCheckInCard: false });
      this._highlightTimer = null;
    }, 2000);
  },

  refreshUserRoleView() {
    // 🛡️ 门店 Guard 纠偏：current_user_role/current_store_name/current_store_id 这三个
    // storage key 只应反映"已核验超管本人"主动发起的视角预览/门店切换（见 store-picker.ts
    // _applyRoleSwitch 与 isVerifiedSuperAdmin），不是任意登录者的身份真相来源。此前这里
    // 无条件信任这三个 key：只要设备上曾经预览过"全国总览"，或账号从未走过角色切换胶囊
    // 导致三个 key 从未写入（此时命中下面的 DEV_FALLBACK_ROLE 兜底），店长/义工等真实
    // 非超管账号每次 onShow（如切 Tab 再切回）都会被这里错误置换成超管视角、背景门店名
    // 被顶成"全国总览"或残留的其他门店——这是一次真实的越权展示 Bug。现在改为：先取
    // AuthService 缓存的服务端已核验角色作为权威依据；只有当权威角色确已核验为
    // super_admin 时，才允许 storage 里的预览/切换态接管展示；其余角色一律强制锁定为
    // 自己绑定的真实门店，绝不读取可能残留超管预览态的 storage 三件套。
    const cached = AuthService.getCachedRoleInfo();
    const isVerifiedSuperAdminAccount = !!(cached && cached.role === 'super_admin' && cached.status === 'approved');

    // 🌟 本地开发 / 无真实登录环境兜底：仅在压根没有任何已核验角色信息（cached 为空）
    // 时才生效，方便本地开发者/管理者在无真实登录环境下直接看到全量功能；真实非超管
    // 账号一旦完成登录（cached 有值），永远不会走到这条兜底
    const DEV_FALLBACK_ROLE = 'SUPER_ADMIN';

    let role: string;
    let storeName: string;
    let storeId: string;
    if (cached && !isVerifiedSuperAdminAccount) {
      // 🔒 真实非超管账号：强制锁定为服务端下发的真实绑定门店
      role = cached.role;
      storeName = cached.storeName || this.data.shopName || '海沧区雨花斋';
      storeId = cached.storeId || '';
    } else {
      role = wx.getStorageSync('current_user_role') || DEV_FALLBACK_ROLE;
      storeName = wx.getStorageSync('current_store_name') || this.data.shopName || '海沧区雨花斋';
      storeId = wx.getStorageSync('current_store_id') || '';
    }

    const rawRole = role.toUpperCase();
    const isVolunteer = rawRole === 'VOLUNTEER';
    // 🏛️ 权限向下继承：大家长（store_patriarch/PATRIARCH）天然拥有店长 + 财务的全套
    // 日常管理权限（录入餐报/发布食谱/编写日志/管理工时等），无需再兼任多重角色
    const isManager = ['MANAGER', 'STORE_MANAGER', 'STORE_PATRIARCH', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    const isFinance = ['FINANCE', 'STORE_PATRIARCH', 'ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    const isSuperAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(rawRole);
    // ❤️ 家人：role 这里已经是 storage 里存的规范化值（如 'store_family'），
    // rawRole 是它的大写形式 'STORE_FAMILY'
    const isFamily = rawRole === 'STORE_FAMILY';
    const isPatriarch = rawRole === 'STORE_PATRIARCH';
    const isAllStoresView = storeId === 'national_overview' || storeId === 'ALL_STORES';
    const isRealSuperAdmin = isSuperAdmin;
    const overridden = applyRoleViewOverride(role, {
      currentUserRole: role, isVolunteer, isManager, isFinance, isSuperAdmin
    });

    this.setData({
      currentUserRole: overridden.currentUserRole,
      currentRole: rawRole,
      currentStoreName: storeName,
      currentStoreId: storeId,
      isRealSuperAdmin: isRealSuperAdmin,
      currentViewMode: getPreviewViewMode(),
      isAllStoresView: isAllStoresView,
      isVolunteer: overridden.isVolunteer,
      isManager: overridden.isManager,
      isFinance: overridden.isFinance,
      isSuperAdmin: overridden.isSuperAdmin,
      isPatriarch: isPatriarch,
      isFamily: isFamily,
      permissions: getPermissionFlags({ role })
    });

    this.checkComplianceNotice();
  },

  // 🌟 合规授权须知：分两档独立记忆，互不覆盖——
  // 'general' 档：任何角色首次进入小程序都必须阅读一次「非官方属性 + 不提供募捐」声明；
  // 'privileged' 档：即使已经读过 general 版，一旦这个设备上的账号第一次具备财务/店长/
  // 超管权限（能看到/操作账目数据的角色），必须再单独确认一次——这类角色看到的是
  // 具体金额与账本，合规风险高于普通义工视角，需要更明确地二次确认知悉其非官方属性。
  // 两档各自的确认状态分别持久化在本地 storage，只弹一次，不会每次进入都打扰用户。
  checkComplianceNotice() {
    if (this.data.showComplianceModal) return;

    const generalAck = wx.getStorageSync('complianceNoticeAck_general');
    if (!generalAck) {
      this.setData({ showComplianceModal: true, complianceModalScene: 'general' });
      return;
    }

    const isPrivilegedView = this.data.isManager || this.data.isFinance || this.data.isSuperAdmin;
    const privilegedAck = wx.getStorageSync('complianceNoticeAck_privileged');
    if (isPrivilegedView && !privilegedAck) {
      this.setData({ showComplianceModal: true, complianceModalScene: 'privileged' });
    }
  },

  onAcknowledgeCompliance() {
    wx.setStorageSync('complianceNoticeAck_general', true);
    if (this.data.complianceModalScene === 'privileged') {
      wx.setStorageSync('complianceNoticeAck_privileged', true);
    }
    this.setData({ showComplianceModal: false });
  },

  onCloseComplianceReview() {
    if (this.data.complianceModalScene !== 'review') return; // 强制场景下不允许通过这个入口关闭
    this.setData({ showComplianceModal: false });
  },

  loadEditReportData() {
    try {
      const editData = wx.getStorageSync('editReportData');
      if (!editData) return;

      const report = JSON.parse(editData);
      this.populateFormWithReportData(report);
      wx.removeStorageSync('editReportData');

      wx.showToast({
        title: '已加载历史记录，可重新编辑',
        icon: 'none',
        duration: 2000
      });
    } catch (error) {
      console.error('[loadEditReportData] 加载编辑数据失败:', error);
      wx.removeStorageSync('editReportData');
    }
  },

  populateFormWithReportData(report: any) {
    const dateString = report.dateString || report.reportDateValue;
    let reportDate = report.reportDate;
    let reportDateValue = dateString;

    if (!reportDate && dateString) {
      const parts = dateString.split('-');
      if (parts.length === 3) {
        reportDate = `${parts[0]}年${parts[1]}月${parts[2]}日`;
      }
    }

    const allDonations = formatDonationItemsToText(report.donationItems || report.items || []);
    const materialsInput = formatMaterialsToText(report.materials || []);

    this.setData({
      reportDate: reportDate || this.data.reportDate,
      reportDateValue: reportDateValue || this.data.reportDateValue,
      yesterdayBalance: formatMoney(report.yesterdayBalance),
      prevBalance: formatMoney(report.yesterdayBalance),
      systemBalance: parseFloat(report.yesterdayBalance) || 0,
      isManualAdjust: false,
      isEditMode: true,
      balanceDiff: 0,
      adjustReason: '',
      allDonations: allDonations,
      otherDonation: formatMoney(report.otherDonation),
      expenses: report.expenses || '',
      materialsInput: materialsInput,
      materials: report.materials || [],
      volunteerCount: report.volunteerCount ? String(report.volunteerCount) : '',
      volunteerHours: report.volunteerHours ? String(report.volunteerHours) : '',
      diningCount: report.diningCount ? String(report.diningCount) : '',
      dineInSeniors: report.dineInSeniors != null ? String(report.dineInSeniors) : '',
      deliverySeniors: report.deliverySeniors != null ? String(report.deliverySeniors) : '',
      dineInVolunteers: report.dineInVolunteers != null ? String(report.dineInVolunteers) : '',
      deliveryVolunteers: report.deliveryVolunteers != null ? String(report.deliveryVolunteers) : '',
      takeawayCount: report.takeawayCount != null ? String(report.takeawayCount) : '',
      shopName: report.shopName || this.data.shopName,
      mpAccount: report.mpAccount || this.data.mpAccount,
      receiptImages: report.receiptImages || [],
      showResult: false,
      reportResult: '',
      hasDraft: true,
      editReportId: report._id || ''
    });
    if (report.dineInSeniors != null || report.deliverySeniors != null || report.dineInVolunteers != null || report.deliveryVolunteers != null || report.takeawayCount != null) {
      this.recalcDiningStats();
    }

    if (allDonations) {
      this.updateParseResult(allDonations);
    }
  },

  onUnload() {
    this.releaseDraftLock();
    // 🛡️ 与 onHide 同款清理：页面卸载时也要清掉全局单槽回调，避免已销毁页面的闭包
    // 继续被 app.ts 的网络恢复监听持有
    const app = getApp() as any;
    if (app && app.globalData) {
      app.globalData.onNetworkReconnected = null;
    }
  },

  onHide() {
    // 页面隐藏时解开路由锁，防止影响后续返回后的操作
    this.isNavigating = false;

    const app = getApp();
    app.globalData.onNetworkReconnected = null;
    this.releaseDraftLock();
  },

  async autoSyncOfflineQueue() {
    const queue = getQueue();
    if (queue.length === 0) {
      return;
    }

    const networkInfo = wx.getNetworkTypeSync();
    if (networkInfo.networkType === 'none') {
      return;
    }

    if (!isCloudAvailable()) {
      console.warn('[autoSyncOfflineQueue] 云服务不可用，跳过本轮离线队列同步');
      return;
    }

    let successCount = 0;
    for (const item of queue) {
      try {
        const uploadResults: string[] = [];
        
        for (let i = 0; i < item.receiptImages.length; i++) {
          const tempFilePath = item.receiptImages[i];
          const now = new Date();
          const dateFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
          const fileName = `${Date.now()}_${i}.jpg`;
          const cloudPath = `expenses/${dateFolder}/${fileName}`;
          
          const uploadResult = await wx.cloud.uploadFile({
            cloudPath: cloudPath,
            filePath: tempFilePath
          });
          uploadResults.push(uploadResult.fileID);
        }

        // 剔除系统保留字段 _openid（任务3修复）
        const { id, timestamp, _openid, ...restItem } = item as any;
        await DataService.saveReport({
          ...restItem,
          receiptImages: uploadResults
        });

        removeFromQueue(item.id);
        successCount++;
      } catch (error) {
        console.error('[autoSyncOfflineQueue] 同步失败:', error);
        break;
      }
    }

    if (successCount > 0) {
      this.updateOfflineQueueCount();
      wx.showToast({
        title: `已为您自动同步 ${successCount} 条离线保存的账目汇报！🎉`,
        icon: 'none',
        duration: 3000
      });
    }
  },

  async syncOfflineQueueManually() {
    const queue = getQueue();
    if (queue.length === 0) {
      wx.showToast({ title: '暂无待同步数据', icon: 'none' });
      return;
    }

    if (!isCloudAvailable()) {
      wx.showToast({ title: '云服务暂不可用，请稍后重试', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在同步...' });

    let successCount = 0;
    for (const item of queue) {
      try {
        const uploadResults: string[] = [];
        
        for (let i = 0; i < item.receiptImages.length; i++) {
          const tempFilePath = item.receiptImages[i];
          const now = new Date();
          const dateFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
          const fileName = `${Date.now()}_${i}.jpg`;
          const cloudPath = `expenses/${dateFolder}/${fileName}`;
          
          const uploadResult = await wx.cloud.uploadFile({
            cloudPath: cloudPath,
            filePath: tempFilePath
          });
          uploadResults.push(uploadResult.fileID);
        }

        // 剔除系统保留字段 _openid（任务3修复）
        const { id, timestamp, _openid, ...restItem } = item as any;
        await DataService.saveReport({
          ...restItem,
          receiptImages: uploadResults
        });

        removeFromQueue(item.id);
        successCount++;
      } catch (error) {
        console.error('[syncOfflineQueueManually] 同步失败:', error);
        break;
      }
    }

    wx.hideLoading();
    this.updateOfflineQueueCount();
    
    if (successCount > 0) {
      wx.showToast({ 
        title: `已成功同步 ${successCount} 条账目汇报！🎉`, 
        icon: 'success',
        duration: 3000
      });
    } else {
      wx.showToast({ title: '同步失败，请检查网络', icon: 'none' });
    }
  },

  // 🆕 财务公示版 (4:3) PosterData 组装：从 onGeneratePoster 内联代码抽出来，
  // 供首次生成和 onSwitchPosterType 切回财务版时共用——切版式只是换一种画法，
  // 不需要把校验/内容安全检测/二维码生成整套流程再跑一遍
  buildFinancialPosterData(): PosterData {
    const { reportDate, shopName, mpAccount, parseResult } = this.data;
    const b4_total = parseFloat(this.data.otherDonation) || 0;
    const { items, totalAmount: donationsTotal, totalCount } = parseResult;
    const { yesterdayBalance: prevBalanceNum, todayExpense: expenseTotal, todayBalance: newBalanceSum } = this.computeTodayFinancials();
    const dateString = deriveDateString(this.data.reportDateValue, reportDate);

    return {
      shopName,
      dateString,
      reportDate,
      items,
      totalCount,
      totalAmount: donationsTotal,
      otherDonation: b4_total,
      yesterdayBalance: prevBalanceNum,
      expenseAmount: expenseTotal,
      todayBalance: newBalanceSum,
      mpAccount,
      thankText: this.data.thankText,
      slogan1: this.data.slogan1,
      materials: this.data.materials,
      activityText: this.data.activityText,
      volunteerCount: parseFloat(this.data.volunteerCount) || 0,
      volunteerHours: parseFloat(this.data.volunteerHours) || 0,
      verifyQrLocalPath: this.data.verifyQrLocalPath,
      showFamilyStyleFooter: this.data.posterShowFamilyStyleFooter,
      showGratitudeFooter: this.data.posterShowGratitudeFooter,
      patriarchName: this.data.storePatriarchName,
      managerName: this.data.storeManagerName,
      showPeopleSignature: this.data.posterShowPeopleSignature
    };
  },

  // 🏛️ 拉取本店护持家长/日常店长姓名，供海报落款使用——复用 manageStoreProfile 的
  // get action（该函数已经在读整份 stores 文档，patriarch/manager 是其中的缓存字段，
  // 不需要额外查询）。失败时静默降级为空字符串，不阻断海报生成主流程
  async fetchStorePeopleNames() {
    try {
      if (!isCloudAvailable()) return;
      const res: any = await wx.cloud.callFunction({
        name: 'manageStoreProfile',
        data: { action: 'get', storeId: this.data.currentStoreId }
      });
      const result = res.result;
      if (result && result.success) {
        this.setData({
          storePatriarchName: result.data.patriarch || '',
          storeManagerName: result.data.manager || ''
        });
      }
    } catch (err) {
      console.warn('[fetchStorePeopleNames] 获取护持家长/日常店长姓名失败（不影响海报生成主流程）:', err);
    }
  },

  // 🆕 温馨故事版 (9:16) StoryPosterData 组装：门店日志首图 + 一句话感言 + 极简摘要，
  // "爱心菜单 Y 款"取自食材杂购的实时解析条数（dailyExpenseParseCount，见输入框下方
  // "已解析 X 项"同一份数据源），本项目没有单独的结构化"今日菜单"字段，这是最接近的真实口径
  buildStoryPosterData(): StoryPosterData {
    const { reportDate, shopName, activityText, activityImages, diningCount, dailyExpenseParseCount } = this.data;
    const dateString = deriveDateString(this.data.reportDateValue, reportDate);
    const heroImageUrl = (activityImages && activityImages.length > 0) ? activityImages[0] : '';

    return {
      shopName,
      dateString,
      heroImageUrl,
      storyText: activityText,
      diningCount: parseFloat(diningCount) || 0,
      menuItemCount: dailyExpenseParseCount || 0,
      verifyQrLocalPath: this.data.verifyQrLocalPath
    };
  },

  // 🆕 财务公示版 / 温馨故事版 切换：重新调用对应的 draw 函数覆盖同一个 posterImage，
  // canvasHeight 也要跟着换（故事版是固定 9:16，财务版按内容量动态算，与 onGeneratePoster
  // 首次生成时的估算口径保持一致）
  // 🌸 财务公示版海报可选落款开关：雨花家风「仁·中·和」/ 感恩词。仅在当前正展示
  // 财务公示版时才需要重新画一次预览图；温馨故事版未接入这两项落款，切换不触发重绘
  async onTogglePosterFamilyStyleFooter(e: any) {
    this.setData({ posterShowFamilyStyleFooter: !!e.detail.value });
    await this.regeneratePosterIfFinancialShown();
  },

  async onTogglePosterGratitudeFooter(e: any) {
    this.setData({ posterShowGratitudeFooter: !!e.detail.value });
    await this.regeneratePosterIfFinancialShown();
  },

  async onTogglePosterPeopleSignature(e: any) {
    this.setData({ posterShowPeopleSignature: !!e.detail.value });
    await this.regeneratePosterIfFinancialShown();
  },

  async regeneratePosterIfFinancialShown() {
    if (!this.data.showPoster || this.data.posterType !== 'financial' || this.data.isSwitchingPosterType) return;
    this.setData({ isSwitchingPosterType: true });
    try {
      const posterImagePath = await drawMeritPoster(this, this.buildFinancialPosterData());
      this.setData({ posterImage: posterImagePath });
    } catch (err: any) {
      console.error('[regeneratePosterIfFinancialShown] 重新生成海报失败:', err);
      wx.showToast({ title: err.message || '落款设置已保存，但预览刷新失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isSwitchingPosterType: false });
    }
  },

  async onSwitchPosterType(e: any) {
    const type = e.currentTarget.dataset.type as 'financial' | 'story';
    const previousType = this.data.posterType;
    if (type === previousType || this.data.isSwitchingPosterType) return;

    this.setData({ isSwitchingPosterType: true, posterType: type });

    try {
      let posterImagePath: string;

      if (type === 'story') {
        this.setData({ canvasHeight: 667 });
        posterImagePath = await drawStoryPoster(this, this.buildStoryPosterData());
      } else {
        const itemCount = (this.data.parseResult && this.data.parseResult.items.length) || 0;
        const listContentHeight = itemCount * 26;
        const dynamicHeight = Math.max(130 + 180 + 35 + 60 + listContentHeight + 24 + 70 + 20, 667);
        this.setData({ canvasHeight: dynamicHeight });
        posterImagePath = await drawMeritPoster(this, this.buildFinancialPosterData());
      }

      this.setData({ posterImage: posterImagePath });
    } catch (err: any) {
      console.error('[onSwitchPosterType] 切换海报版式失败:', err);
      wx.showToast({ title: err.message || '切换失败，请重试', icon: 'none' });
      // 切换失败时把 posterType 退回原样，避免 Tab 高亮和实际展示的图片对不上
      this.setData({ posterType: previousType });
    } finally {
      this.setData({ isSwitchingPosterType: false });
    }
  },

  async onGeneratePoster() {

    if (this.data.isGeneratingPoster) {
      return;
    }

    const isValid = await this.validateBeforeSubmit();
    if (!isValid) {
      return;
    }

    const { parseResult, otherDonation, showResult } = this.data;

    // 检查是否已生成文本
    if (!showResult) {
      wx.showModal({
        title: '提示',
        content: '请先点击「⚡ 生成文本」生成日报内容，再生成海报。',
        showCancel: false
      });
      return;
    }

    // 检查 parseResult 是否存在
    if (!parseResult || !parseResult.items) {
      console.error('[onGeneratePoster] parseResult 异常');
      wx.showModal({
        title: '数据异常',
        content: '❌ 数据解析结果异常，请重新生成文本后再试。',
        showCancel: false
      });
      return;
    }

    const itemCount = parseResult.items.length;
    const useTwoColumns = itemCount > 50;
    const itemsPerColumn = useTwoColumns ? Math.ceil(itemCount / 2) : itemCount;
    const listContentHeight = itemsPerColumn * 26;
    const dynamicHeight = Math.max(130 + 180 + 35 + 60 + listContentHeight + 24 + 70 + 20, 667);
    this.setData({ canvasHeight: dynamicHeight });

    wx.showLoading({ title: '正在生成海报...', mask: true });
    this.setData({ isGeneratingPoster: true });

    try {
      const { reportDate, expenses, shopName, mpAccount } = this.data;
      const b4_total = parseFloat(otherDonation) || 0;
      const { items, totalAmount: donationsTotal, totalCount } = parseResult;

      // 🌟 唯一权威计算入口，见 computeTodayFinancials 顶部注释：
      // 海报预览的"今日实时总结余"必须与顶部算式校验共享同一套计算结果，
      // 不能再用已废弃、未绑定任何输入框的 expenses 字段单独算一遍。
      const { yesterdayBalance: prevBalanceNum, todayIncome: todayTotalSum, todayExpense: expenseTotal, todayBalance: newBalanceSum } = this.computeTodayFinancials();

      const dateString = deriveDateString(this.data.reportDateValue, reportDate);

      const reportText = generateReportText({
        shopName: shopName,
        dateString: dateString,
        reportDate: reportDate,
        items: items,
        totalAmount: donationsTotal,
        otherDonation: b4_total,
        yesterdayBalance: prevBalanceNum,
        expenseAmount: expenseTotal,
        todayBalance: newBalanceSum,
        expenses: expenses,
        mpAccount: mpAccount,
        thankText: this.data.thankText,
        slogan1: this.data.slogan1,
        slogan2: this.data.slogan2,
        materials: this.data.materials,
        activityText: this.data.activityText,
        volunteerCount: parseFloat(this.data.volunteerCount) || 0,
        volunteerHours: parseFloat(this.data.volunteerHours) || 0,
        diningCount: parseFloat(this.data.diningCount) || 0,
        stapleRiceStatus: this.data.stapleRiceStatus,
        stapleOilStatus: this.data.stapleOilStatus,
        noticeTag: this.data.announcement && this.data.announcement.tag,
        noticeTitle: this.data.announcement && this.data.announcement.title,
        noticeContent: this.data.announcement && this.data.announcement.content,
        mergeToReportText: this.data.mergeToReportText
      });

      // 内容安全检测 - 设置超时保护
      let isContentSafe = true;
      try {
        isContentSafe = await Promise.race([
          this.checkContentSafety(reportText),
          new Promise<boolean>((resolve) => {
            setTimeout(() => {
              console.warn('[onGeneratePoster] 内容安全检测超时，跳过检测');
              resolve(true);
            }, 3000);
          })
        ]);
      } catch (safeErr: any) {
        console.warn('[onGeneratePoster] 内容安全检测异常，跳过检测:', safeErr);
        isContentSafe = true;
      }

      if (!isContentSafe) {
        this.setData({ isGeneratingPoster: false });
        wx.hideLoading();
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      // 验真二维码必须先于海报绘制完成并写入 this.data——drawMeritPoster 内部要用
      // ctx.drawImage 把它画进画布，不能和画布绘制并行（画布绘制读取 posterData 时
      // 二维码本地路径必须已经就绪，否则只能画到占位框，等下次切版式才补上）
      const verifyQrLocalPath = await this.resolveVerifyQrLocalPath();
      this.setData({ verifyQrLocalPath });

      // 海报画布绘制与门店推广二维码生成/下载并行进行；两者都是异步 IO，互不依赖，
      // 用 Promise.all 一起等待，确保二维码要么已下载到本地临时路径（ready），
      // 要么已明确进入 failed 占位态，弹窗渲染时绝不会出现"半下载/空白"的中间态
      const [posterImagePath] = await Promise.all([
        drawMeritPoster(this, this.buildFinancialPosterData()),
        this.generateQrCode()
      ]);

      this.setData({
        posterImage: posterImagePath,
        showPoster: true,
        // 🐛 不能带上 showPosterModal: true——.modal-backdrop/.poster-modal-card
        // 是打卡确认卡片复用的另一个弹窗组件（z-index: 99999，见 onConfirmShiftCheckIn），
        // 跟这里生成的真实 canvas 海报（.poster-modal，z-index: 1000）毫不相干；两个都为
        // true 时前者会整个盖住后者，用户完全看不到真实海报，也点不到"保存到相册"/
        // "分享给好友"按钮——这正是海报生成完却"什么都点不了"的根因
        // 🆕 每次重新生成都是全新的财务公示版海报，切换 Tab 状态归位，
        // 不能残留上一次预览时用户切到「温馨故事版」的状态
        posterType: 'financial',
        todayInAmount: todayTotalSum.toFixed(2),
        todayOutAmount: expenseTotal.toFixed(2),
        todayTotalBalance: newBalanceSum.toFixed(2),
        lastBalance: prevBalanceNum.toFixed(2),
        donorCount: (totalCount || 0) + (b4_total > 0 ? 1 : 0),
        riceStatus: this.data.stapleRiceStatus === 'urgent' ? '告急' : (this.data.stapleRiceStatus === 'sufficient' ? '充足' : '一般'),
        oilStatus: this.data.stapleOilStatus === 'urgent' ? '告急' : (this.data.stapleOilStatus === 'sufficient' ? '充足' : '一般')
      });
    } catch (err: any) {
      console.error('海报生成失败原因:', err);
      wx.showToast({
        title: err.message || '海报生成失败',
        icon: 'none',
        duration: 3000
      });
    } finally {
      wx.hideLoading();
      this.setData({ isGeneratingPoster: false });
    }
  },

  closePoster() {
    this.setData({ showPoster: false });
  },

  onClosePosterModal() {
    this.setData({ showPosterModal: false });
  },

  onPreviewQrCode() {
    if (this.data.qrCodeState !== 'ready' || !this.data.qrCodeUrl) {
      if (this.data.qrCodeState === 'failed') this.generateQrCode();
      return;
    }
    wx.previewImage({
      current: this.data.qrCodeUrl,
      urls: [this.data.qrCodeUrl]
    });
  },

  // 🐛 修复"二维码显示为空白"：动态生成门店小程序码并下载到本地临时路径后才切换为 ready 状态，
  // 生成/下载任一环节失败都会落到 failed 状态展示可重试的占位块，绝不出现空白方块
  async generateQrCode(): Promise<void> {
    this.setData({ qrCodeState: 'loading' });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');

      const storeId = this.data.currentStoreId || 'store_haicang_001';
      const storeName = this.data.currentStoreName || this.data.shopName || '海沧区雨花斋';

      const qrRes = await wx.cloud.callFunction({
        name: 'getStoreQRCode',
        data: { storeId, storeName }
      });
      const qrResult = qrRes.result as any;

      if (!qrResult || !qrResult.success || !qrResult.fileID) {
        throw new Error((qrResult && qrResult.errMsg) || '二维码生成失败');
      }

      // 必须等云存储文件真正下载到本地 wxfile:// 临时路径后，再切换为 ready 触发 <image> 渲染，
      // 避免直接把 cloud:// fileID 或半下载状态的路径丢给 <image>/canvas drawImage 导致空白
      const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
      if (!downRes || !downRes.tempFilePath) {
        throw new Error('二维码文件下载失败');
      }

      this.setData({ qrCodeUrl: downRes.tempFilePath, qrCodeState: 'ready' });
    } catch (err) {
      console.error('[generateQrCode] 二维码生成/加载失败:', err);
      this.setData({ qrCodeUrl: '', qrCodeState: 'failed' });
    }
  },

  // 🆕 海报「扫码验真」区域的真实二维码：指向 pages/public-verify/index，携带
  // 当前门店 storeId + 报告日期，与首页推广码（generateQrCode，指向 pages/index/index）
  // 是两个不同用途的码，各自独立生成/下载，互不影响。任何一步失败都返回空字符串，
  // 由 posterGenerator.ts 优雅降级为占位框，绝不阻断整张海报的生成
  async resolveVerifyQrLocalPath(): Promise<string> {
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');

      const storeId = this.data.currentStoreId || 'store_haicang_001';
      const storeName = this.data.currentStoreName || this.data.shopName || '海沧区雨花斋';
      const dateString = deriveDateString(this.data.reportDateValue, this.data.reportDate);

      const qrRes = await wx.cloud.callFunction({
        name: 'getStoreQRCode',
        data: { storeId, storeName, purpose: 'verify', date: dateString }
      });
      const qrResult = qrRes.result as any;

      if (!qrResult || !qrResult.success || !qrResult.fileID) {
        throw new Error((qrResult && qrResult.error) || '验真二维码生成失败');
      }

      const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
      if (!downRes || !downRes.tempFilePath) {
        throw new Error('验真二维码下载失败');
      }

      return downRes.tempFilePath;
    } catch (err) {
      console.warn('[resolveVerifyQrLocalPath] 验真二维码生成/下载失败，海报将回退为占位框:', err);
      return '';
    }
  },

  stopPropagation() {},

  // ☀️ 阳光账本：全角色/无登录门槛可查看，数据来自 getSunshineLedger 云函数
  // （不做任何 user_roles/OPENID 权限校验，与扫码验真 publicVerifyReport 同一套
  // 设计哲学——只接受调用方明确指定的当前门店 storeId，不支持跨店/全部门店聚合）
  async onOpenSunshineLedger() {
    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    this.setData({
      showSunshineLedgerModal: true,
      // 🗓️ 每次重新打开都回到当前月，不记忆上次关闭前切到的历史月份——
      // "阳光账本"首先应该展示的是最新数据，历史月份是用户当次打开后的临时探索
      selectedYearMonth: currentYearMonth,
      isSunshineLedgerAtCurrentMonth: true
    });

    await this.fetchSunshineLedgerData(currentYearMonth);
  },

  // ☀️ 阳光账本月份切换器：‹ 2026年07月 › 左右箭头，重新拉取 getSunshineLedger。
  // 不允许切到未来月份——阳光账本展示的是已发生的历史数据，未来月份必然是空的
  onSunshineLedgerPrevMonth() {
    this.shiftSunshineLedgerMonth(-1);
  },

  onSunshineLedgerNextMonth() {
    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (this.data.selectedYearMonth >= currentYearMonth) {
      wx.showToast({ title: '已经是最新月份啦', icon: 'none' });
      return;
    }
    this.shiftSunshineLedgerMonth(1);
  },

  shiftSunshineLedgerMonth(delta: number) {
    const [yearStr, monthStr] = (this.data.selectedYearMonth || '').split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (!year || !month) return;

    // Date 的月份参数是 0-11，先转换再加减，避免手写跨年进位/退位的边界判断
    const shifted = new Date(year, month - 1 + delta, 1);
    const nextYearMonth = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;

    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    this.setData({
      selectedYearMonth: nextYearMonth,
      isSunshineLedgerAtCurrentMonth: nextYearMonth >= currentYearMonth
    });
    this.fetchSunshineLedgerData(nextYearMonth);
  },

  async fetchSunshineLedgerData(yearMonth: string) {
    this.setData({ sunshineLedgerLoading: true });

    const storeId = this.data.currentStoreId;
    if (!storeId) {
      wx.showToast({ title: '请先选择门店', icon: 'none' });
      this.setData({ showSunshineLedgerModal: false, sunshineLedgerLoading: false });
      return;
    }

    try {
      const res: any = await wx.cloud.callFunction({
        name: 'getSunshineLedger',
        data: { storeId, yearMonth }
      });
      const result = res.result;
      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加载阳光账本失败', icon: 'none' });
        this.setData({ showSunshineLedgerModal: false });
        return;
      }

      const ledgerData = {
        storeName: result.storeName || '',
        periodLabel: result.periodLabel || '',
        auditedReportsCount: result.auditedReportsCount || 0,
        totalDiners: result.totalDiners || 0,
        monthlyDiners: result.monthlyDiners || 0,
        takeawayMeals: result.takeawayMeals || 0,
        totalHours: result.totalHours || 0,
        volunteerCount: result.volunteerCount || 0,
        operatingDays: result.operatingDays || 0,
        ledgerPublicRate: result.ledgerPublicRate || null
      };
      this.setData({
        sunshineLedgerData: ledgerData,
        // 📊 完美 4x2 网格：固定 8 项，缺数据时展示"暂无数据"而不是编造出的百分比
        sunshineStatCards: [
          { label: '累计就餐人次', value: String(ledgerData.totalDiners) },
          { label: '当月就餐人次', value: String(ledgerData.monthlyDiners) },
          { label: '爱心送餐份数', value: String(ledgerData.takeawayMeals) },
          { label: '累计护持工时', value: String(ledgerData.totalHours) },
          { label: '参与护持总人次', value: String(ledgerData.volunteerCount) },
          { label: '已核销餐报篇数', value: String(ledgerData.auditedReportsCount) },
          { label: '安全营运天数', value: String(ledgerData.operatingDays) },
          { label: '账本公开率', value: ledgerData.ledgerPublicRate || '暂无数据' }
        ]
      });
    } catch (err) {
      console.error('[fetchSunshineLedgerData] 加载阳光账本异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      this.setData({ showSunshineLedgerModal: false });
    } finally {
      this.setData({ sunshineLedgerLoading: false });
    }
  },

  onCloseSunshineLedgerModal() {
    this.setData({ showSunshineLedgerModal: false });
  },

  onThankTextInput(e: any) {
    const value = e.detail.value;
    this.setData({ thankText: value });
    this.saveSettings();
    this.debouncedSaveDraft();
  },

  onSlogan1Input(e: any) {
    const value = e.detail.value;
    this.setData({ slogan1: value });
    this.saveSettings();
    this.debouncedSaveDraft();
  },

  onSlogan2Input(e: any) {
    const value = e.detail.value;
    this.setData({ slogan2: value });
    this.saveSettings();
    this.debouncedSaveDraft();
  },

  savePoster() {
    const { posterImage } = this.data;
    if (!posterImage) {
      wx.showToast({ title: '海报图片为空', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath: posterImage,
      success: () => {
        wx.showToast({ title: '保存成功', icon: 'success' });
        this.closePoster();
      },
      fail: (err) => {
        console.error('[savePoster] 保存失败:', err);
        if (err.errMsg.includes('auth')) {
          wx.showModal({
            title: '提示',
            content: '请授权允许保存图片到相册',
            confirmText: '去授权',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  // 🆕 分享海报图片给微信好友：直接调起微信原生的图片分享面板（转发给好友/保存到相册/
  // 收藏均由系统面板自带），不同于 open-type="share" 触发的小程序卡片转发
  // （onShareAppMessage 分享的是小程序入口，不是这张具体的海报图片）
  onSharePosterImage() {
    const { posterImage } = this.data;
    if (!posterImage) {
      wx.showToast({ title: '海报图片为空', icon: 'none' });
      return;
    }

    wx.showShareImageMenu({
      path: posterImage,
      fail: (err) => {
        console.error('[onSharePosterImage] 分享失败:', err);
        wx.showToast({ title: '分享失败，请重试', icon: 'none' });
      }
    });
  },

  async checkContentSafety(text: string): Promise<boolean> {
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const result = await wx.cloud.callFunction({
        name: 'msgSecCheck',
        data: { text: text }
      });

      const r = result.result as any;
      if (r && !r.safe) {
        wx.showToast({ title: '所发布内容含违规信息', icon: 'none' });
        return false;
      }
      return true;
    } catch (error) {
      console.warn('[checkContentSafety] 内容安全检测调用失败，跳过检测:', error);
      return true;
    }
  },

  showServiceAgreement() {
    this.setData({ showAgreement: true });
  },

  // 🔗 跑马灯通知云端化：按"当前视角"严格互斥查询——总览视角只拿机构总览级
  // 通知，具体门店视角只拿该店专属通知，两者不叠加展示（见 manageNotice 云函数）。
  // 关闭状态（notice_bar_hidden_date）与查询结果分开判断：即使当天已关闭，也要
  // 先把数据拉回来存好，下一次视角切换/新的一天自然又能正常展示。
  // 🌸 每日修身卡片【换一换】：随机换一条，不查云端，纯本地静态内容
  onRefreshCultureQuote() {
    const current = this.data.cultureQuote && this.data.cultureQuote.text;
    this.setData({ cultureQuote: getRandomCultureQuote(current) });
  },

  // 📖 雨花文化全集：一次性把十大模块数据摆进 data，弹窗内 scroll-view 结构化分层
  // 展示全貌——module 7（雨花家训）沿用既有三个字段，不重复赋值
  onShowFamilyMottoModal() {
    this.setData({
      showFamilyMottoModal: true,
      familyMottoMindFormula: FAMILY_MOTTO.mindFormula,
      familyMottoMindFormulaLines: splitIntoClauseLines(FAMILY_MOTTO.mindFormula, 4),
      familyMottoCreedLines: FAMILY_MOTTO.creedLines,
      familyMottoStudyMethod: FAMILY_MOTTO.studyMethod,
      ...(() => {
        const lines = splitIntoClauseLines(FAMILY_MOTTO.studyMethod, 1);
        return {
          familyMottoStudyIntro: lines[0] || '',
          familyMottoStudyMiddleLines: lines.slice(1, lines.length - 1),
          familyMottoStudyConclusion: lines[lines.length - 1] || ''
        };
      })(),
      cultureFullData: {
        coreValuesNational: CORE_VALUES.national,
        coreValuesSocial: CORE_VALUES.social,
        coreValuesIndividual: CORE_VALUES.individual,
        famousQuotes: FAMOUS_QUOTES,
        famousQuoteLines: splitIntoClauseLines(FAMOUS_QUOTES.join(''), 1),
        homeCoreSpirit: RAIN_FLOWER_HOME.coreSpirit,
        homeSanYouTitle: RAIN_FLOWER_HOME.sanYou.title, homeSanYouItems: RAIN_FLOWER_HOME.sanYou.items,
        homeWuLeTitle: RAIN_FLOWER_HOME.wuLe.title, homeWuLeItems: RAIN_FLOWER_HOME.wuLe.items,
        homeLiuTongTitle: RAIN_FLOWER_HOME.liuTong.title, homeLiuTongItems: RAIN_FLOWER_HOME.liuTong.items,
        homeBaXinTitle: RAIN_FLOWER_HOME.baXin.title, homeBaXinItems: RAIN_FLOWER_HOME.baXin.items,
        seniorsCoreBelief: SENIORS_CARE.coreBelief,
        seniorsCoreBeliefLines: splitIntoClauseLines(SENIORS_CARE.coreBelief, 1),
        seniorsTenHaveYous: SENIORS_CARE.tenHaveYous,
        seniorsTenHaveYouPairs: SENIORS_CARE.tenHaveYous.map((s) => splitAtFirstComma(s)),
        sixteenBests: SIXTEEN_BESTS,
        gratitudeText: GRATITUDE_TEXT,
        dailySummaryTitle: DAILY_SUMMARY.title,
        dailySummaryGratitude: DAILY_SUMMARY.gratitude,
        // 🌸 感恩与祈盼：前 3 句是"让我们共同祈盼："式的引导铺垫，保持原单列展示；
        // 后 3 句"祈盼…，让…！"排比句，每句在首个逗号处拆成两行（祈盼.../让...），
        // 展开成 6 行单列居中展示，每两行为一组
        dailySummaryAspiration: DAILY_SUMMARY.aspiration.slice(0, 3),
        dailySummaryAspirationLines: DAILY_SUMMARY.aspiration.slice(3).reduce((lines: string[], s) => {
          const pair = splitAtFirstComma(s, true);
          lines.push(pair.left, pair.right);
          return lines;
        }, []),
        familyStyleTitle: FAMILY_STYLE.title,
        familyStyleText: FAMILY_STYLE.text
      }
    });
  },

  onCloseFamilyMottoModal() {
    this.setData({ showFamilyMottoModal: false });
  },

  async fetchNotices() {
    // 🐛 首页跑马灯不可见根因：currentStoreId 为空字符串是超管默认总览视角（尚未手动
    // 切换门店）的合法状态，不是"数据没准备好"——之前这里遇到空字符串直接提前返回、
    // 从不发起查询，导致超管一进首页跑马灯永远是空的。manageNotice 云函数已经把空
    // storeId 当总览级处理，这里不再拦截，一律发起查询。
    const storeId = this.data.currentStoreId || '';
    const todayStr = new Date().toISOString().split('T')[0];
    const hiddenDate = wx.getStorageSync('notice_bar_hidden_date');
    const isHiddenToday = hiddenDate === todayStr;

    this.setData({ noticesLoading: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: { action: 'list', storeId }
      });
      const result = res.result as any;
      const rawList = (result && result.success && Array.isArray(result.data)) ? result.data : [];
      const noticeList = rawList.map(mapNoticeRecord);

      this.setData({
        noticeList,
        currentNoticeIndex: 0,
        announcement: noticeList.length > 0 ? noticeList[0] : null,
        isNoticeBarHiddenToday: isHiddenToday,
        noticesLoading: false
      });
    } catch (e) {
      console.error('[fetchNotices] 查询失败:', e);
      this.setData({
        noticeList: [],
        currentNoticeIndex: 0,
        announcement: null,
        isNoticeBarHiddenToday: isHiddenToday,
        noticesLoading: false
      });
    }
  },

  // 轮播切换：记下当前滚动到第几条，点击时才知道该打开详情弹窗里的哪一条
  onSwiperNoticeChange(e: any) {
    const idx = e.detail.current;
    const item = this.data.noticeList[idx] || null;
    this.setData({ currentNoticeIndex: idx, announcement: item });
  },

  // 关闭通知栏：写入"今天"这个日期，整条隐藏不留空白；到了新的一天这个判断
  // 自然失效，不需要额外的清理逻辑
  onCloseNoticeBar() {
    const todayStr = new Date().toISOString().split('T')[0];
    wx.setStorageSync('notice_bar_hidden_date', todayStr);
    this.setData({ isNoticeBarHiddenToday: true });
  },

  openAnnouncement() {
    if (!this.data.announcement) return;
    this.setData({
      showAnnouncementModal: true
    });
  },

  closeAnnouncement() {
    this.setData({
      showAnnouncementModal: false
    });
  },

  copyAnnouncement() {
    const { announcement } = this.data;
    if (!announcement) return;

    const text = `${announcement.tag || '喜讯通报'}：${announcement.title}\n\n${announcement.content}\n\n发布时间：${announcement.create_time}`;
    
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'none' });
      }
    });
  },

  // 编辑当前正在看的这一条（更新）
  openNoticeEdit() {
    const { announcement, mergeToReportText } = this.data;
    if (!announcement) return;

    this.setData({
      showAnnouncementModal: false,
      showNoticeEditModal: true,
      noticeEditId: announcement.id || '',
      noticeEditTag: announcement.tag || '喜讯通报',
      noticeEditTitle: announcement.title || '',
      noticeEditContent: announcement.content || '',
      mergeToReportText: mergeToReportText,
      saveAsSystemTemplate: false
    });
    this.fetchNoticeTemplates();
  },

  // 新建一条通知（同一个编辑弹窗，只是清空并且不带 id）
  openNoticeCreate() {
    this.setData({
      showNoticeEditModal: true,
      noticeEditId: '',
      noticeEditTag: '喜讯通报',
      noticeEditTitle: '',
      noticeEditContent: '',
      saveAsSystemTemplate: false
    });
    this.fetchNoticeTemplates();
  },

  // 🌟 拉取当前视角可用的公告模板：全域公共模板 + 当前门店自己的私有模板，
  // 由云函数按 tenantId/storeId 严格隔离，不信任前端做二次过滤
  async fetchNoticeTemplates() {
    if (!isCloudAvailable()) {
      this.setData({ noticeTemplates: [] });
      return;
    }
    this.setData({ noticeTemplatesLoading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: { action: 'getTemplates', storeId: this.data.currentStoreId }
      });
      const result = res.result as any;
      const list = (result && result.success && Array.isArray(result.data)) ? result.data : [];
      this.setData({ noticeTemplates: list });
    } catch (e) {
      console.error('[fetchNoticeTemplates] 查询失败:', e);
      this.setData({ noticeTemplates: [] });
    } finally {
      this.setData({ noticeTemplatesLoading: false });
    }
  },

  // 套用云端模板（区别于 onApplyPreset 套用本机内置的 7 条示例文案）
  onApplyCloudTemplate(e: any) {
    const id = e.currentTarget.dataset.id;
    const tpl = this.data.noticeTemplates.find((t: any) => t._id === id);
    if (!tpl) return;

    this.setData({
      noticeEditTag: tpl.tag || '',
      noticeEditTitle: tpl.title || '',
      noticeEditContent: tpl.content || ''
    });
    wx.showToast({ title: '已导入模板', icon: 'success', duration: 1500 });
  },

  onToggleSaveAsSystemTemplate(e: any) {
    this.setData({ saveAsSystemTemplate: e.detail.value });
  },

  // 🌟 把当前编辑框里的标题/正文存成一条可复用模板：店长/财务恒为本店私有模板；
  // 仅超级管理员能通过 saveAsSystemTemplate 勾选存成全域公共模板——云函数会再次
  // 校验角色，不信任这里传的 isSystem 标志位
  async onSaveAsTemplate() {
    const { noticeEditTag, noticeEditTitle, noticeEditContent, currentStoreId, saveAsSystemTemplate, isSuperAdmin } = this.data;

    if (!noticeEditTitle.trim()) {
      wx.showToast({ title: '请先填写标题', icon: 'none' });
      return;
    }
    if (!noticeEditContent.trim()) {
      wx.showToast({ title: '请先填写正文', icon: 'none' });
      return;
    }

    const cleanTitle = stripTagPrefix(noticeEditTitle || noticeEditTag, noticeEditTag);
    const cleanContent = stripTagPrefix(noticeEditContent, noticeEditTag);

    wx.showLoading({ title: '保存模板中...', mask: true });
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');
      const res = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: {
          action: 'createTemplate',
          storeId: currentStoreId,
          tag: noticeEditTag,
          title: cleanTitle,
          content: cleanContent,
          isSystem: isSuperAdmin ? saveAsSystemTemplate : false
        }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (result && result.success) {
        wx.showToast({ title: result.message || '模板已保存', icon: 'success' });
        this.fetchNoticeTemplates();
      } else {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[onSaveAsTemplate] 保存失败:', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  closeNoticeEdit() {
    this.setData({
      showNoticeEditModal: false
    });
  },

  onNoticeTitleInput(e: any) {
    this.setData({
      noticeEditTitle: e.detail.value
    });
  },

  onNoticeContentInput(e: any) {
    this.setData({
      noticeEditContent: e.detail.value
    });
  },

  clearNoticeContent() {
    this.setData({
      noticeEditContent: ''
    });
  },

  onToggleMergeToReport(e: any) {
    const checked = e.detail.value;
    this.setData({ mergeToReportText: checked });
    wx.setStorageSync('notice_merge_to_report', checked);
  },

  // 🌟 物资护持交互联动：今日餐况卡片里的大米/食用油库存此前只是纯展示标签，
  // 义工看到"告急"也不知道能做什么。点击后按当前库存状态给出对应引导——
  // 充足时是一句感恩反馈，一般/告急时给出明确的护持指引，把"看到状态"和
  // "下一步行动"连起来，而不是让状态标签停留在纯信息层面。
  onTapMaterialStatus(e: any) {
    const type = e.currentTarget.dataset.type as 'rice' | 'oil';
    const status = type === 'rice' ? this.data.stapleRiceStatus : this.data.stapleOilStatus;
    const label = type === 'rice' ? '大米' : '食用油';

    if (status === 'sufficient') {
      wx.showToast({ title: `${label}库存充足，感恩各位义工与家人的护持 🙏`, icon: 'none', duration: 2000 });
      return;
    }

    const isUrgent = status === 'urgent';
    // 🛡️ 去宗教化合规要求："发心"/"随喜"均带有宗教色彩，统一替换为"善意"/"随时"等现代公益用语
    wx.showModal({
      title: isUrgent ? `⚠️ ${label}库存告急` : `${label}库存提醒`,
      content: isUrgent
        ? `当前门店${label}库存告急，如您方便，欢迎护持${label}或直接联系店长了解具体所需数量，感恩您的善意！`
        : `当前门店${label}库存为"一般"，仍有护持空间，欢迎随时护持，感恩您的关注！`,
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 🌟 智能物资引导跳转：库存不为"充足"时才会渲染的独立小胶囊入口（见 WXML wx:if 判断），
  // 复用 onTapMaterialStatus 同一套引导逻辑而不重写一遍——这里不会走到"充足"分支
  // （该按钮压根不会在充足状态下渲染），本质是给同一个引导流程再加一个更醒目的触发点。
  // 目前没有一个"义工物资捐赠登记"的独立页面/表单，暂以弹窗形式给出明确指引；
  // 未来若要接入真正的物资认领登记流程，替换这里的 wx.showModal 调用即可，
  // 入口位置和触发时机（库存非充足）不需要再变。
  navToSupport(e: any) {
    this.onTapMaterialStatus(e);
  },

  onApplyPreset(e: any) {
    const key = e.currentTarget.dataset.key;
    const preset = PRESET_NOTICES[key as keyof typeof PRESET_NOTICES];
    
    if (preset) {
      this.setData({
        noticeEditTag: preset.tag,
        noticeEditTitle: preset.title,
        noticeEditContent: preset.content
      });
      wx.showToast({
        title: '已导入预设文案',
        icon: 'success',
        duration: 1500
      });
    }
  },

  // 🔗 通知云端化：不再写本机 custom_notice，改成呼叫 manageNotice 云函数落库。
  // storeId 按当前视角自动带：总览视角下 super_admin 建的是机构总览级公告
  // （云函数里留空 storeId），其余情况（具体门店视角，或非超管角色）都是店级，
  // 云函数会按调用者角色再次强制校验，不信任前端传的 storeId。
  async onSaveNotice() {
    const { noticeEditId, noticeEditTag, noticeEditTitle, noticeEditContent, currentStoreId } = this.data;

    if (!noticeEditContent.trim()) {
      wx.showToast({
        title: '请输入通报内容',
        icon: 'none'
      });
      return;
    }

    const cleanTitle = stripTagPrefix(noticeEditTitle || noticeEditTag, noticeEditTag);
    const cleanContent = stripTagPrefix(noticeEditContent, noticeEditTag);

    wx.showLoading({ title: '保存中...', mask: true });
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用');
      const res = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: {
          action: noticeEditId ? 'update' : 'create',
          id: noticeEditId || undefined,
          storeId: currentStoreId,
          tag: noticeEditTag,
          title: cleanTitle,
          content: cleanContent,
          isActive: true
        }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (result && result.success) {
        this.setData({ showNoticeEditModal: false });
        wx.showToast({ title: noticeEditId ? '通知已更新' : '通知已发布', icon: 'success' });
        this.fetchNotices();
      } else {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[onSaveNotice] 保存失败:', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  closeAgreement() {
    this.setData({ showAgreement: false });
  },

  goToHistory() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/history/history',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  goToStatistics() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: `/pages/statistics/statistics?shopName=${encodeURIComponent(this.data.shopName)}`,
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  onVolunteerCheckIn() {
    this.refreshTodayShiftStatus();
    this.setData({ showShiftSelectModal: true });
  },

  // 🌟 全角色打卡卡片（omni-checkin-card）的次级跳转：不是导航去另一个页面，
  // 店务管理/财务稽核台本来就在同一页往下一点的位置（manager-home-card/finance-home-card），
  // 用 wx.pageScrollTo 按 id 平滑滚动过去即可，比再开一个页面更轻量、也不会丢失打卡卡片的上下文
  onScrollToManagerConsole() {
    wx.pageScrollTo({ selector: '#managerConsoleAnchor', duration: 300 });
  },

  onScrollToFinanceConsole() {
    wx.pageScrollTo({ selector: '#financeConsoleAnchor', duration: 300 });
  },

  // 🛠️ 义工现场服务工具金刚区：菜单人数/物资消耗两个填报弹窗是独立自定义组件
  // （daily-menu-modal/material-usage-modal），原地直弹，不再跨 Tab 跳转到
  // 个人页。打开前调用组件暴露的 resetForm() 清空表单（对齐此前 profile.ts
  // onOpenDailyMenuModal 的"每次打开都是全新登记"行为）
  onTapToolDailyMenu() {
    const modal = this.selectComponent('#dailyMenuModal') as any;
    if (modal) modal.resetForm();
    this.setData({ showDailyMenuModal: true });
  },

  onCloseDailyMenuModal() {
    this.setData({ showDailyMenuModal: false });
  },

  onTapToolMaterialUsage() {
    const modal = this.selectComponent('#materialUsageModal') as any;
    if (modal) modal.resetForm();
    this.setData({ showMaterialUsageModal: true });
  },

  onCloseMaterialUsageModal() {
    this.setData({ showMaterialUsageModal: false });
  },

  // 📷 记录今日护持动态：本来就是独立页面（活动日志），个人页的同名入口
  // （onOpenVolunteerJournalModal）也是直接 navigateTo 过去，这里跳同一个
  // 目标页面即可，不需要交接标记
  onTapToolVolunteerJournal() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/activity-log/activity-log',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  refreshTodayShiftStatus() {
    const todayStr = new Date().toISOString().split('T')[0];
    const logs = wx.getStorageSync('my_checkin_logs') || [];

    const todayLogs = logs.filter((log: any) => log.date === todayStr);
    const completedShiftKeys = new Set(todayLogs.map((log: any) => log.shiftKey));
    const todayHours = todayLogs.reduce((sum: number, log: any) => sum + (parseFloat(log.hours) || 0), 0);
    const todayAccumulatedHours = parseFloat(todayHours.toFixed(1));

    // ⏱️ 动态工时上限：勾选前就按"已录入工时 + 该班次工时"逐一算好是否会超过 12h 上限，
    // 供 WXML 单独禁用会超限的班次选项（而不是等选完了才在按钮上统一拦截）
    let firstAvailableShift = '';
    const updatedShifts = this.data.shiftDefinitions.map((item: any) => {
      const isCompleted = completedShiftKeys.has(item.shiftKey);
      const wouldExceedCap = !isCompleted && parseFloat((todayAccumulatedHours + item.hours).toFixed(1)) > DAILY_HOURS_CAP;
      if (!isCompleted && !wouldExceedCap && !firstAvailableShift) {
        firstAvailableShift = item.shiftKey;
      }
      return {
        ...item,
        isCompleted: isCompleted,
        wouldExceedCap: wouldExceedCap
      };
    });

    const allCompleted = updatedShifts.every((item: any) => item.isCompleted);
    const matchedShift = firstAvailableShift
      ? updatedShifts.find((s: any) => s.shiftKey === firstAvailableShift)
      : null;

    const selectedShiftHours = firstAvailableShift
      ? ((matchedShift && matchedShift.hours) || 3.0)
      : 0;

    this.setData({
      todayLogs: todayLogs,
      todayAccumulatedHours: todayAccumulatedHours,
      availableShifts: updatedShifts,
      allShiftsCompleted: allCompleted,
      selectedShift: firstAvailableShift || 'LUNCH',
      selectedShiftHours: selectedShiftHours
    });
    this.updateHoursPreview(todayAccumulatedHours, selectedShiftHours);
  },

  // 🌟 实时预览：勾选班次后即时算出"若提交这一笔，今日总工时会变成多少"，
  // 超过 DAILY_HOURS_CAP 就标红并让确认按钮直接禁用，而不是等提交后才截断
  updateHoursPreview(todayAccumulatedHours?: number, selectedShiftHours?: number) {
    const baseHours = todayAccumulatedHours != null ? todayAccumulatedHours : this.data.todayAccumulatedHours;
    const shiftHours = selectedShiftHours != null ? selectedShiftHours : this.data.selectedShiftHours;
    const previewTotalHours = parseFloat((baseHours + shiftHours).toFixed(1));

    this.setData({
      previewTotalHours: previewTotalHours,
      isOverHoursLimit: previewTotalHours > DAILY_HOURS_CAP
    });
  },

  onCloseShiftModal() {
    this.setData({
      showShiftSelectModal: false
    });
  },

  // ⏱️ 勾选会导致超出单日 12h 上限的班次：WXML 已按 item.wouldExceedCap 禁用其 tap
  // 路由到本方法而非 onSelectShift，这里只负责给出明确的提示文案，不做任何状态变更
  onSelectShiftBlocked() {
    wx.showToast({ title: '单日护持工时已达 12h 上限，请核对班次', icon: 'none', duration: 2500 });
  },

  onSelectShift(e: any) {
    const { shift, hours } = e.currentTarget.dataset;
    const selectedShiftHours = parseFloat(hours || '3.0');
    this.setData({
      selectedShift: shift,
      selectedShiftHours: selectedShiftHours
    });
    this.updateHoursPreview(undefined, selectedShiftHours);
  },

  onToggleMealReserve() {
    const next = !this.data.willEatLunch;
    // 🍚 关闭"留店用餐"时同步清空已选餐别；重新打开时默认勾选午餐（与此前
    // willEatLunch 单一开关的语义保持一致，避免用户还要多点一次）
    this.setData({
      willEatLunch: next,
      reservedMeals: next ? (this.data.reservedMeals.length ? this.data.reservedMeals : ['lunch']) : []
    });
  },

  // 🍚 留店用餐细分餐别 Chip 多选：早餐/午餐/晚餐可任意组合勾选
  onToggleReservedMeal(e: any) {
    const meal = e.currentTarget.dataset.meal;
    if (!meal) return;
    const current = this.data.reservedMeals || [];
    const next = current.includes(meal) ? current.filter((m: string) => m !== meal) : [...current, meal];
    this.setData({ reservedMeals: next });
  },

  async onConfirmShiftCheckIn() {
    // 🌟 防连点：双击/网络卡顿时同一次点击可能触发两次回调，读写 storage 之间存在竞态窗口，
    // 仅靠"当天+同工种已打卡"判断无法拦截几乎同时发生的两次提交。用 data 字段（而非纯实例
    // 属性）承载这个锁，好处是同一个值既能防重入，也能直接绑定按钮的 loading/disabled 态
    if (this.data.checkInSubmitting) return;

    if (this.data.allShiftsCompleted) {
      wx.showToast({ title: '您今日已完成所有班次护持，感恩您的无私付出！', icon: 'none' });
      return;
    }

    // 🌟 与按钮禁用态保持一致的服务端防线：前端已按 isOverHoursLimit 禁用按钮，
    // 这里再做一次拦截防止残留点击（如禁用态切换前的最后一次触摸事件）
    if (this.data.isOverHoursLimit) {
      wx.showToast({ title: '单日护持工时已达 12h 上限，请核对班次', icon: 'none', duration: 2500 });
      return;
    }

    // 🍚 勾选了"留店用餐"但没选具体餐别：后厨没法据此备餐，拦下来让用户至少选一个
    if (this.data.willEatLunch && (!this.data.reservedMeals || this.data.reservedMeals.length === 0)) {
      wx.showToast({ title: '请至少选择一个留餐时段', icon: 'none' });
      return;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const logs = wx.getStorageSync('my_checkin_logs') || [];
    const selectedShift = this.data.selectedShift;
    const now = Date.now();

    const isAlreadyChecked = logs.some((l: any) => l.date === todayStr && l.shiftKey === selectedShift);
    if (isAlreadyChecked) {
      wx.showToast({ title: '⚠️ 您今日已完成该班次打卡，请勿重复刷工时', icon: 'none' });
      return;
    }

    // 🌟 防刷去重：同工种 10 分钟内重复提交一律视为无效打卡（防止双击/网络重发产生重复记录）
    const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
    const recentDuplicate = logs.find((l: any) =>
      l.shiftKey === selectedShift && typeof l.timestamp === 'number' && (now - l.timestamp) < DUPLICATE_WINDOW_MS
    );
    if (recentDuplicate) {
      wx.showToast({ title: '⚠️ 检测到短时间内重复提交，请勿刷单', icon: 'none' });
      return;
    }

    // 🌟 单日工时上限：正常流程下前端已按 isOverHoursLimit 禁用按钮拦在前面，
    // 这里的截断逻辑作为服务端/极端时序下的兜底防线保留，不依赖前端状态
    const requestedHours = this.data.selectedShiftHours || 3.0;
    const remainingAllowance = parseFloat((DAILY_HOURS_CAP - this.data.todayAccumulatedHours).toFixed(1));

    if (remainingAllowance <= 0) {
      wx.showModal({
        title: '🌸 义工关怀提醒',
        content: `您今日已护持 ${this.data.todayAccumulatedHours} 小时，已达单日工时上限（${DAILY_HOURS_CAP}小时），今日暂无法继续打卡，雨花家人请注意劳逸结合！`,
        showCancel: false,
        confirmText: '我知道了',
        confirmColor: '#8C1D18'
      });
      return;
    }

    let wasTruncated = requestedHours > remainingAllowance;
    let addHours = wasTruncated ? remainingAllowance : requestedHours;

    this.setData({ checkInSubmitting: true });

    const shiftObj = this.data.shiftDefinitions.find((s: any) => s.shiftKey === selectedShift);
    const shiftLabel = shiftObj ? shiftObj.name : '爱心护持班';
    const currentStoreId = this.data.currentStoreId || '';
    const currentStoreName = this.data.currentStoreName || '海沧区雨花斋';
    const reservedMeals = this.data.willEatLunch ? this.data.reservedMeals.slice() : [];

    // ⚡️ 云端台账：manageVolunteerCheckIn 尽力而为同步一份到 volunteer_duty_logs
    // （服务端会按 {tenantId, storeId, _openid, dateString} 重新核算工时上限，比本地
    // storage 更权威），成功则采用服务端返回的 hours/wasTruncated 覆盖本地估算值，
    // 并记下 cloudLogId 供撤销时精确对应云端记录；云端不可用/失败时静默降级为
    // 纯本地打卡（与项目其余提交流程一致的离线兜底策略），不阻断打卡本身
    let cloudLogId = '';
    try {
      if (isCloudAvailable()) {
        const res: any = await wx.cloud.callFunction({
          name: 'manageVolunteerCheckIn',
          data: {
            action: 'checkin',
            storeId: currentStoreId,
            storeName: currentStoreName,
            shiftKey: selectedShift,
            shiftName: shiftLabel,
            hours: requestedHours,
            willEatLunch: this.data.willEatLunch,
            reservedMeals
          }
        });
        const result = res.result;
        if (result && result.success) {
          cloudLogId = result.logId || '';
          addHours = typeof result.hours === 'number' ? result.hours : addHours;
          wasTruncated = !!result.wasTruncated;
        } else if (result && result.error) {
          console.warn('[onConfirmShiftCheckIn] 云端打卡同步失败，已降级为本地记录:', result.error);
        }
      }
    } catch (err) {
      console.warn('[onConfirmShiftCheckIn] 云端打卡调用异常，已降级为本地记录:', err);
    }

    // 🛡️ 全局计数器：必须从 storage 里的旧值递增，不能读 this.data.myCheckInDays 等——
    // 这三个 data 字段现在展示的是"按当前门店过滤"后的结果（见下方 scopedStats），
    // 不再等于全局值，拿它们做递增会把错误的数字写回全局计数器
    const hasTodayLog = logs.some((l: any) => l.date === todayStr);
    const oldGlobalDays = wx.getStorageSync('my_checkin_days') || 0;
    const newDays = hasTodayLog ? oldGlobalDays : (oldGlobalDays + 1);

    const newCount = (wx.getStorageSync('my_checkin_count') || 0) + 1;
    const newHours = parseFloat(((wx.getStorageSync('my_service_hours') || 0) + addHours).toFixed(1));

    const timestamp = now;
    const newLog = {
      timestamp: timestamp,
      date: todayStr,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      shiftKey: selectedShift,
      shiftName: shiftLabel,
      hours: addHours,
      // 🏪 门店隔离：补上 storeId（此前只存 storeName），供 computeMyCheckInStats
      // 精确按门店过滤；storeName 继续保留，作为老记录（没有 storeId）的兜底匹配字段
      storeId: currentStoreId,
      storeName: currentStoreName,
      willEatLunch: this.data.willEatLunch,
      // 🍚 具体留餐餐别（早/午/晚 子集），随打卡记录一并落地，供后厨据此精确备餐
      reservedMeals,
      // ☁️ 对应 volunteer_duty_logs 云端文档 _id，撤销时用它调用 manageVolunteerCheckIn
      // action:'revoke'；云端同步失败时为空字符串，撤销会自动降级为仅本地删除
      cloudLogId
    };
    logs.unshift(newLog);

    // 🛡️ 全局计数器继续照常维护，不删除——journey.ts/statistics.ts 的个人看板仍在读
    // 这三个 key，本次门店隔离修复不改变它们的既有语义（全部门店/历史累计口径）
    wx.setStorageSync('my_checkin_days', newDays);
    wx.setStorageSync('my_checkin_count', newCount);
    wx.setStorageSync('my_service_hours', newHours);
    wx.setStorageSync('my_checkin_logs', logs);

    // 🐛 门店隔离修复：首页顶部展示的护持天数/工时/次数改为按当前门店动态过滤
    // 统计（见 computeMyCheckInStats），不再直接用上面刚写入的全局递增值——
    // 全国总览视角下仍汇总全部门店，与 loadVolunteerStats 的口径保持一致
    const isAllStoresView = this.data.isAllStoresView;
    const scopedStats = computeMyCheckInStats(currentStoreId, currentStoreName, isAllStoresView || !currentStoreName);

    this.setData({
      myCheckInDays: scopedStats.days,
      myCheckInCount: scopedStats.count,
      myServiceHours: scopedStats.hours,
      checkInLogs: logs,
      showShiftSelectModal: false,
      showPosterModal: true,
      checkInSubmitting: false
    });

    if (wasTruncated) {
      wx.showToast({ title: `已为您自动截断至 +${addHours}h（单日上限${DAILY_HOURS_CAP}h）`, icon: 'none', duration: 2500 });
    } else {
      wx.showToast({ title: `打卡成功！+${addHours}h`, icon: 'success' });
    }
  },

  // 🔒 撤销打卡：限当天（today-checked-section 本就只渲染 todayLogs，天然满足"限当天"）
  // 且当日门店账本未被财务稽核封账时才允许——封账前先查一次 report_logs，避免弹出
  // 确认框之后才告知用户无法撤销
  async onRevokeTodayCheckIn(e: any) {
    const { timestamp, hours, cloudLogId } = e.currentTarget.dataset;
    const revokeHours = parseFloat(hours || '0');
    const todayStr = new Date().toISOString().split('T')[0];
    const currentStoreId = this.data.currentStoreId || '';

    if (currentStoreId && isCloudAvailable()) {
      try {
        const db = wx.cloud.database();
        const lockRes = await db.collection('report_logs')
          .where({ storeId: currentStoreId, dateString: todayStr })
          .limit(1)
          .get();
        const report = lockRes.data && lockRes.data[0];
        if (report && report.approvalStatus === 'AUDITED_LOCKED') {
          wx.showModal({
            title: '无法撤销',
            content: '今日门店账本已被财务稽核封账，打卡记录无法撤销',
            showCancel: false
          });
          return;
        }
      } catch (err) {
        console.warn('[onRevokeTodayCheckIn] 封账状态查询失败，放行撤销:', err);
      }
    }

    wx.showModal({
      title: '↩️ 确认撤销打卡',
      content: `确定要撤销此笔打卡记录吗？将自动扣减 ${revokeHours} 小时贡献工时。`,
      confirmColor: '#D32F2F',
      success: async (res) => {
        if (!res.confirm) return;

        // ☁️ 云端台账同步撤销：仅当这笔打卡当初成功同步过云端（cloudLogId 非空）才调用，
        // 与 onConfirmShiftCheckIn 的云端失败降级策略对称——本地记录该字段为空时直接跳过
        if (cloudLogId) {
          try {
            const cloudRes: any = await wx.cloud.callFunction({
              name: 'manageVolunteerCheckIn',
              data: { action: 'revoke', logId: cloudLogId }
            });
            const result = cloudRes.result;
            if (result && !result.success) {
              wx.showModal({ title: '撤销失败', content: result.error || '云端撤销失败，请重试', showCancel: false });
              return;
            }
          } catch (err) {
            console.warn('[onRevokeTodayCheckIn] 云端撤销调用异常，仅执行本地撤销:', err);
          }
        }

        {
          let logs = wx.getStorageSync('my_checkin_logs') || [];

          const ts = typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10);
          logs = logs.filter((l: any) => l.timestamp !== ts);

          const stillHasTodayLog = logs.some((l: any) => l.date === todayStr);

          // 🛡️ 全局计数器：必须从 storage 里的旧值递减，不能读 this.data.myCheckInDays 等——
          // 这三个 data 字段现在展示的是"按当前门店过滤"后的结果（见下方 scopedStats），
          // 不再等于全局值，拿它们做递减会把错误的数字写回全局计数器
          const oldGlobalDays = wx.getStorageSync('my_checkin_days') || 0;
          const oldGlobalCount = wx.getStorageSync('my_checkin_count') || 0;
          const oldGlobalHours = wx.getStorageSync('my_service_hours') || 0;
          const newGlobalDays = stillHasTodayLog ? oldGlobalDays : Math.max(0, oldGlobalDays - 1);
          const newGlobalCount = Math.max(0, oldGlobalCount - 1);
          const newGlobalHours = parseFloat(Math.max(0, oldGlobalHours - revokeHours).toFixed(1));

          wx.setStorageSync('my_checkin_days', newGlobalDays);
          wx.setStorageSync('my_checkin_count', newGlobalCount);
          wx.setStorageSync('my_service_hours', newGlobalHours);
          wx.setStorageSync('my_checkin_logs', logs);

          // 🐛 门店隔离修复：撤销后同样按当前门店重新动态计算展示值，口径与
          // onConfirmShiftCheckIn/loadVolunteerStats 保持一致
          const currentStoreId = this.data.currentStoreId || '';
          const currentStoreName = this.data.currentStoreName || '';
          const isAllStoresView = this.data.isAllStoresView;
          const scopedStats = computeMyCheckInStats(currentStoreId, currentStoreName, isAllStoresView || !currentStoreName);

          this.setData({
            myCheckInDays: scopedStats.days,
            myCheckInCount: scopedStats.count,
            myServiceHours: scopedStats.hours,
            checkInLogs: logs
          });

          this.refreshTodayShiftStatus();
          wx.showToast({ title: '已成功撤销该笔记录', icon: 'none' });
        }
      }
    });
  },

  // 🏪 门店隔离：全国总览/未选定具体门店时展示全部历史汇总；切到具体门店时改为按
  // computeMyCheckInStats（my_checkin_logs 按 storeId 精确过滤，storeId 缺失的老
  // 记录退回 storeName 匹配）动态统计，只算"个人在该店"的打卡数据，与
  // onConfirmShiftCheckIn/onRevokeTodayCheckIn 用的是同一套口径
  loadVolunteerStats() {
    try {
      const isAllStoresView = this.data.isAllStoresView;
      const currentStoreId = this.data.currentStoreId || '';
      const currentStoreName = this.data.currentStoreName || this.data.shopName || '';

      const scopedStats = computeMyCheckInStats(currentStoreId, currentStoreName, isAllStoresView || !currentStoreName);

      this.setData({
        // 全国总览/未选定门店时沿用原有的演示态兜底值，避免空态直接显示 0
        myCheckInDays: scopedStats.days || (isAllStoresView || !currentStoreName ? 12 : 0),
        myCheckInCount: scopedStats.count || (isAllStoresView || !currentStoreName ? 15 : 0),
        myServiceHours: scopedStats.hours || (isAllStoresView || !currentStoreName ? 45 : 0)
      });
    } catch (err) {
      console.warn('⚠️ 读取护持统计数据失败:', err);
    }
  },

  async onOpenMyCheckInHistory() {
    const days = this.data.myCheckInDays || 0;
    const hours = this.data.myServiceHours || 0;
    const count = this.data.myCheckInCount || 0;

    // 🛡️ 合规修复：archive-modal 组件的 userInfo.avatarUrl/nickName 此前从未被真正赋值过——
    // 头像/昵称完全靠内部两个 <open-data> 标签自己展示，userInfo 里这两个字段一直是 undefined。
    // 现在改用 <image>/<text> 绑定真实数据后，必须在这里从 AuthService 缓存的角色信息里
    // 把头像/昵称一并传进去，否则头像会变成空白占位、昵称会一直显示兜底文案。
    const cachedRole = AuthService.getCachedRoleInfo();
    const rawAvatarUrl = (cachedRole && cachedRole.avatarUrl) || '';
    const nickName = (cachedRole && cachedRole.nickName) || '';
    const isCloudAvatar = rawAvatarUrl.indexOf('cloud://') === 0;

    // 🐛 修复"头像显示灰块/裂图"：cloud:// fileID 既不能直接喂给 archive-modal.wxml 的
    // <image src>，也不能喂给组件内 Canvas 合成海报时用的 wx.downloadFile（该接口只认
    // http(s) 地址，遇到 cloud:// 会直接下载失败）。先弹窗展示已有数据（头像留空更好过灰块），
    // 再异步换成临时 https 链接补上，与 profile.ts 的处理方式保持一致。
    this.setData({
      showArchiveModal: true,
      archiveUserInfo: {
        totalDays: days,
        totalCheckInCount: count,
        totalHours: hours,
        avatarUrl: isCloudAvatar ? '' : rawAvatarUrl,
        nickName
      }
    });

    if (isCloudAvatar) {
      try {
        const res: any = await wx.cloud.getTempFileURL({ fileList: [rawAvatarUrl] });
        const tempUrl = res && res.fileList && res.fileList[0] && res.fileList[0].tempFileURL;
        if (tempUrl) {
          this.setData({ 'archiveUserInfo.avatarUrl': tempUrl });
        }
      } catch (err) {
        console.warn('[onOpenMyCheckInHistory] 头像临时链接转换失败:', err);
      }
    }
  },

  onCloseArchiveModal() {
    this.setData({ showArchiveModal: false });
  },

  onViewJourneyFromArchive() {
    this.setData({ showArchiveModal: false });
    // 延迟 200ms 等弹窗关闭动画完成再跳转
    setTimeout(() => {
      wx.navigateTo({
        url: '/pages/journey/journey'
      });
    }, 200);
  },

  onOpenVolunteerAudit() {
    const count = this.data.pendingAuditCount || 0;
    wx.showModal({
      title: '👥 审核',
      content: count > 0 ? `当前有 ${count} 位提交了到岗打卡请求，是否进入审核？` : '当前暂无待审核的打卡记录，门店护持秩序良好！',
      confirmText: '查看列表',
      confirmColor: '#8C1D18',
      showCancel: false
    });
  },

  // 🐛 修复"假导出"：此前无论选哪个选项都只弹一个"导出指令已发送"的成功提示，
  // 没有调用任何真实导出逻辑（其中"区块链存证日志"更是纯虚构文案，项目里从未有过相关实现）。
  // 统计分析页（pages/statistics）已有基于 exportAccountExcel 云函数的完整可用导出流程
  // （含周/月/年/自定义周期选择 + 下载失败自动降级本地 CSV），直接复用而非在此重复实现。
  onExportExcelHistory() {
    this.onOpenFinanceExportMenu();
  },

  // 🌟 财务专属功能区「Excel 账本导出」：跳转到已有的、真实可用的统计导出页面
  onOpenFinanceExportMenu() {
    if (this.isNavigating) return;
    this.isNavigating = true;
    wx.navigateTo({
      url: '/pages/statistics/statistics?autoShowExport=true',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🌟 财务专属功能区「稽核与封账」：按自定义起止日期区间批量锁定/解封已通过店长确认的账本
  onOpenFinanceLockModal() {
    if (!this.data.isFinance && !this.data.isSuperAdmin && !this.data.isPatriarch) {
      wx.showToast({ title: '仅财务、大家长与超管可执行稽核封账', icon: 'none' });
      return;
    }
    if (this.isNationalOverviewSelected()) {
      wx.showToast({ title: '请先选择具体的门店再执行封账', icon: 'none', duration: 2500 });
      return;
    }
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const defaultEndDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const defaultStartDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    this.setData({
      showFinanceLockModal: true,
      financeLockStartDate: this.data.financeLockStartDate || defaultStartDate,
      financeLockEndDate: this.data.financeLockEndDate || defaultEndDate,
      lockStatusText: ''
    }, () => {
      this.checkRangeLockStatus();
    });
  },

  onCloseFinanceLockModal() {
    if (this.data.financeLockInFlight || this.data.financeUnlockInFlight) return;
    this.setData({ showFinanceLockModal: false });
  },

  onFinanceLockStartDateChange(e: any) {
    this.setData({ financeLockStartDate: e.detail.value }, () => {
      this.checkRangeLockStatus();
    });
  },

  onFinanceLockEndDateChange(e: any) {
    this.setData({ financeLockEndDate: e.detail.value }, () => {
      this.checkRangeLockStatus();
    });
  },

  // 🌟 实时查询当前选定区间的封账状态：区间是否已全部封账、封账人/时间，或区间内待审核笔数，
  // 用于驱动 lock-status-tip 提示文案与"确认封账/解封/反封账"按钮的显隐切换
  async checkRangeLockStatus() {
    const { financeLockStartDate: startDate, financeLockEndDate: endDate, currentStoreId: storeId } = this.data;
    if (!startDate || !endDate || !storeId) return;
    if (startDate > endDate) {
      this.setData({ lockStatusText: '⚠️ 开始日期不能晚于结束日期', financeLockRangeLocked: false });
      return;
    }

    this.setData({ financeLockStatusLoading: true, lockStatusText: '查询区间状态中...' });
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const result = await wx.cloud.callFunction({
        name: 'manageFinanceLock',
        data: { action: 'checkRangeStatus', storeId, startDate, endDate }
      });
      const res = result.result as any;
      if (res && res.success) {
        let tip = '';
        if (res.isLocked) {
          tip = `🔒 该区间已封账（共 ${res.lockedCount} 条${res.lockedBy ? `，由 ${res.lockedBy}` : ''}${res.lockedAt ? ` 于 ${res.lockedAt}` : ''}）`;
        } else if (res.pendingCount > 0) {
          tip = `⚠️ 区间内还有 ${res.pendingCount} 笔待审核，需全部审核或作废后才能封账`;
        } else if (res.approvedCount > 0) {
          tip = `已审核待封账 ${res.approvedCount} 笔`;
        } else {
          tip = '该区间暂无可封账的记录';
        }
        this.setData({
          lockStatusText: tip,
          financeLockRangeLocked: !!res.isLocked
        });
      } else {
        this.setData({ lockStatusText: (res && res.errMsg) || '查询区间状态失败', financeLockRangeLocked: false });
      }
    } catch (err) {
      console.error('[checkRangeLockStatus] 异常:', err);
      this.setData({ lockStatusText: '查询区间状态失败，请检查网络', financeLockRangeLocked: false });
    } finally {
      this.setData({ financeLockStatusLoading: false });
    }
  },

  async onConfirmFinanceLock() {
    if (this.data.financeLockInFlight) return;
    const { financeLockStartDate: startDate, financeLockEndDate: endDate } = this.data;
    if (!startDate || !endDate) {
      wx.showToast({ title: '请先选择要封账的起止日期', icon: 'none' });
      return;
    }
    if (startDate > endDate) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      return;
    }
    const storeId = this.data.currentStoreId;
    const storeLabel = this.data.currentStoreName || storeId;

    wx.showModal({
      title: '🔒 确认稽核封账？',
      content: `确定要封账【${storeLabel}】${startDate} 至 ${endDate} 的账目吗？锁定后店长将无法修改。`,
      confirmText: '确认封账',
      confirmColor: '#D32F2F',
      cancelText: '我再想想',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ financeLockInFlight: true });
        wx.showLoading({ title: '安全封账中...', mask: true });
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const result = await wx.cloud.callFunction({
            name: 'manageFinanceLock',
            data: { action: 'lockRange', storeId, startDate, endDate }
          });
          const res2 = result.result as any;
          wx.hideLoading();
          if (res2 && res2.success) {
            wx.showModal({
              title: '封账完成',
              content: res2.message || `已成功封账 ${res2.lockedCount || 0} 条记录`,
              showCancel: false
            });
            this.checkRangeLockStatus();
          } else if (res2 && res2.error === 'SELECTED_RANGE_HAS_PENDING_REPORTS') {
            wx.showModal({ title: '无法封账', content: res2.message || '选中区间内存在待审核数据，请全部审核或作废后再封账！', showCancel: false });
          } else {
            wx.showModal({ title: '封账失败', content: (res2 && (res2.message || res2.errMsg)) || '云函数未返回正确结果', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[onConfirmFinanceLock] 异常:', err);
          wx.showModal({ title: '调用失败', content: '未成功触发封账，请确认 manageFinanceLock 云函数已右键【上传并部署】', showCancel: false });
        } finally {
          this.setData({ financeLockInFlight: false });
        }
      }
    });
  },

  // 🌟 大家长专属「解封 / 反封账」：仅 isPatriarch || isSuperAdmin 可执行，finance 无权批量解封
  handleUnlockMonth() {
    if (this.data.financeUnlockInFlight) return;
    if (!this.data.isPatriarch && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅大家长与超级管理员可执行解封', icon: 'none' });
      return;
    }
    const { financeLockStartDate: startDate, financeLockEndDate: endDate, currentStoreId: storeId } = this.data;
    if (!startDate || !endDate) {
      wx.showToast({ title: '请先选择要解封的起止日期', icon: 'none' });
      return;
    }
    const storeLabel = this.data.currentStoreName || storeId;

    wx.showModal({
      title: '⚠️ 确认解除封账？',
      content: `仅限大家长权限操作，确定要解除【${storeLabel}】${startDate} 至 ${endDate} 的账目锁定吗？`,
      confirmText: '确认解封',
      confirmColor: '#E65100',
      cancelText: '我再想想',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ financeUnlockInFlight: true });
        wx.showLoading({ title: '解封处理中...', mask: true });
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const result = await wx.cloud.callFunction({
            name: 'manageFinanceLock',
            data: { action: 'unlockRange', storeId, startDate, endDate }
          });
          const res2 = result.result as any;
          wx.hideLoading();
          if (res2 && res2.success) {
            wx.showModal({
              title: '解封完成',
              content: res2.message || `已成功解封 ${res2.unlockedCount || 0} 条记录`,
              showCancel: false
            });
            this.checkRangeLockStatus();
          } else {
            wx.showModal({ title: '解封失败', content: (res2 && (res2.message || res2.errMsg)) || '云函数未返回正确结果', showCancel: false });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[handleUnlockMonth] 异常:', err);
          wx.showModal({ title: '调用失败', content: '未成功触发解封，请确认 manageFinanceLock 云函数已右键【上传并部署】', showCancel: false });
        } finally {
          this.setData({ financeUnlockInFlight: false });
        }
      }
    });
  },

  // 🌟 财务专属功能区「风控预警日志」：余额异常突变 / 红字冲销频次 / 小票缺失明细
  async onOpenRiskAlertsModal() {
    if (!this.data.isFinance && !this.data.isSuperAdmin) {
      wx.showToast({ title: '仅财务与超管可查看风控预警', icon: 'none' });
      return;
    }
    if (this.isNationalOverviewSelected()) {
      wx.showToast({ title: '请先选择具体的门店再查看风控预警', icon: 'none', duration: 2500 });
      return;
    }

    this.setData({ showRiskAlertsModal: true, riskAlertsLoading: true, riskAlertsFilterType: '' });
    await this.fetchRiskAlerts();
  },

  onCloseRiskAlertsModal() {
    this.setData({ showRiskAlertsModal: false });
  },

  // 🌟 统计区间文案："近 N 天：起始日期 至 结束日期"，N 取云函数实际返回的 scanRangeDays，
  // 不在前端硬编码天数，避免与后端扫描窗口（cloudfunctions/getRiskAlerts SCAN_DAYS）脱节
  buildRiskAlertsRangeLabel(scanRangeDays: number): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - scanRangeDays);
    return `近 ${scanRangeDays} 天：${fmt(start)} 至 ${fmt(end)}`;
  },

  // 🌟 按类型筛选明细：'balance' 同时覆盖余额链路断裂(balance_break)与单日净变动过大(balance_jump)，
  // 二者共同构成汇总卡片里的"余额异常"计数
  computeFilteredRiskAlerts(list: any[], filterType: string): any[] {
    if (!filterType) return list;
    if (filterType === 'balance') {
      return list.filter((item) => item.type === 'balance_break' || item.type === 'balance_jump');
    }
    return list.filter((item) => item.type === filterType);
  },

  // 🌟 点击汇总卡片：再次点击同一张卡片可取消筛选、回到全部明细
  onRiskCardTap(e: any) {
    const type = e.currentTarget.dataset.type as string;
    if (!type) return;
    const nextFilterType = this.data.riskAlertsFilterType === type ? '' : type;
    this.setData({
      riskAlertsFilterType: nextFilterType,
      riskAlertsFilteredList: this.computeFilteredRiskAlerts(this.data.riskAlertsList, nextFilterType)
    });
  },

  // 🌟 精准追溯：从当前筛选类型跳转到历史账本页，携带 anomalyType 参数，
  // history.ts 会按同一条判定口径（见其 filterByAnomalyType）自动预筛选明细
  onGoToHistoryAnomalyDetail() {
    const type = this.data.riskAlertsFilterType;
    if (!type) return;
    wx.navigateTo({ url: `/pages/history/history?anomalyType=${type}` });
  },

  onRefreshRiskAlerts() {
    if (this.data.riskAlertsLoading) return;
    this.setData({ riskAlertsLoading: true });
    this.fetchRiskAlerts();
  },

  async fetchRiskAlerts() {
    const storeId = this.data.currentStoreId;
    if (!storeId) {
      this.setData({ riskAlertsLoading: false });
      return;
    }
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const result = await wx.cloud.callFunction({
        name: 'getRiskAlerts',
        data: { storeId }
      });
      const res = result.result as any;
      if (res && res.success) {
        const alerts = res.alerts || [];
        const summary = res.summary || { voidCount: 0, missingReceiptCount: 0, balanceAnomalyCount: 0 };
        const filterType = this.data.riskAlertsFilterType;
        this.setData({
          riskAlertsList: alerts,
          riskAlertsFilteredList: this.computeFilteredRiskAlerts(alerts, filterType),
          riskAlertsSummary: summary,
          riskAlertsHasAnomaly: (summary.voidCount + summary.missingReceiptCount + summary.balanceAnomalyCount) > 0,
          riskAlertsRangeLabel: this.buildRiskAlertsRangeLabel(res.scanRangeDays || 60),
          riskAlertCount: alerts.length
        });
      } else {
        console.warn('[fetchRiskAlerts] 云函数返回失败:', res);
      }
    } catch (err) {
      console.error('[fetchRiskAlerts] 异常:', err);
    } finally {
      this.setData({ riskAlertsLoading: false });
    }
  },

  onShareAppMessage() {
    const store = this.data.currentStoreName || this.data.shopName || '雨花斋';
    const date = this.data.reportDate || this.data.reportDateValue || '今日';

    return {
      title: `🌸【${store}】${date}爱心餐报公示，请家人阅览！`,
      path: `/pages/index/index?storeName=${encodeURIComponent(store)}`,
      imageUrl: '/images/share_cover.png'
    };
  },

  onShareTimeline() {
    return {
      title: '用“餐报君”让爱心账目更透明！素食小店日常记账汇报的高效利器。',
      query: 'from=share'
    };
  }
});