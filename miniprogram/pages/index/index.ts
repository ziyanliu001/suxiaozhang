import { DataService, formatMoney } from '../../utils/dataService';
import { AuthService, ROLE_LABELS, getPermissionFlags, PermissionFlags } from '../../utils/authService';
import { parseDonorText, parseMaterials, formatDonationItemsToText, formatMaterialsToText } from '../../utils/parser';
import { generateReportText } from '../../utils/reportGenerator';
import { drawMeritPoster, drawStoryPoster, PosterData, StoryPosterData } from '../../utils/posterGenerator';
import { drawPrintList } from '../../utils/printRenderer';
import { drawStoreInvitationPoster } from '../../utils/drawStorePoster';
import { saveToQueue, getQueue, removeFromQueue, getQueueCount } from '../../utils/offlineQueue';
import { getSafeSystemInfo } from '../../utils/util';
import { safeNavigateTo } from '../../utils/navHelper';
import { getPrevDayIsoString, formatDateToCnShort, isValidIsoDate, getTodayIsoString } from '../../utils/dateUtils';
import { getSelectedStore, setCurrentActiveStore, clearSelectedStoreCache, getCachedStoreStatus, fetchAndSyncStoreStatus, clearAllStoresListCache } from '../../utils/storeManager';
import { validateReportGuardrails, GuardrailResult, recordSuccessfulSubmit, recordWarningConfirmed, canSubmitNow, cleanExpiredFrequencyRecords } from '../../utils/validateReportGuardrails';
import { compressAndUploadImages } from '../../utils/imageCompress';
import { isCloudAvailable, reportCloudSdkErrorIfCorrupted } from '../../utils/cloudGuard';
import { maskName } from '../../utils/privacy';
import { classifyNotice, stripTitlePrefixFromContent } from '../../utils/noticeDisplay';
import { md5 } from '../../utils/md5';
import { applyRoleViewOverride, getPreviewViewMode, resolveDisplayViewMode, PreviewViewMode, PREVIEW_VIEW_MODE_LABELS } from '../../utils/viewModePreview';
import { takeResumeDraftHandoff } from '../../utils/draftHandoff';
import { writeLocalFileSafe } from '../../utils/localFileCache';
import { withTimeout, callFunctionWithTimeout } from '../../utils/withTimeout';
import { takeComplianceReviewRequest } from '../../utils/complianceHandoff';
import {
  hasAgreedYuhuaGeneralDisclaimer,
  acknowledgeYuhuaGeneralDisclaimer,
  hasAgreedYuhuaPrivilegedDisclaimer,
  acknowledgeYuhuaPrivilegedDisclaimer
} from '../../utils/yuhuaDisclaimer';
import { takeGenCodeHandoff } from '../../utils/genCodeHandoff';
import { takeOpenSunshineLedgerRequest } from '../../utils/sunshineLedgerHandoff';
import { takeOpenCultureFullRequest } from '../../utils/cultureFullHandoff';
import { takeOpenStorePickerRequest } from '../../utils/storePickerHandoff';
import {
  getDailyCultureQuote, FAMILY_MOTTO, SENIORS_CARE,
  CORE_VALUES, FAMOUS_QUOTES, RAIN_FLOWER_HOME, SIXTEEN_BESTS, GRATITUDE_TEXT, DAILY_SUMMARY, FAMILY_STYLE
} from '../../utils/cultureData';
import { computeMyCheckInStats } from '../../utils/checkinStats';
import { setTabBarHidden } from '../../utils/tabBarVisibility';

const HOME_COMPRESS_CANVAS_ID = 'imgCompressCanvas';
// 🌟 单日护持工时上限：打卡弹窗的实时预览与提交时的截断保护共用同一个值，避免两处写死后走偏
const DAILY_HOURS_CAP = 12.0;

// 🏷️ 各业态默认服务受众标签：未配置自定义 serviceTargetConfig 时的兜底文案，
// 与 store-profile.ts 的 ORG_TYPE_DEFAULT_TARGET_LABELS 保持同一套语义，
// 独立定义避免跨页面模块导入循环依赖
const ORG_TYPE_DEFAULT_TARGET_LABELS: Record<string, {
  dineInLabel: string; deliveryLabel: string; listenLabel: string; takeoutLabel: string;
}> = {
  yuhuazhai:         { dineInLabel: '堂食长者',     deliveryLabel: '送餐长者',     listenLabel: '倾听陪伴',      takeoutLabel: '打包份数'   },
  elderly_canteen:   { dineInLabel: '堂食老人',     deliveryLabel: '送餐老人',     listenLabel: '倾听陪伴',      takeoutLabel: '打包份数'   },
  volunteer_station: { dineInLabel: '服务人次',     deliveryLabel: '上门服务',     listenLabel: '陪伴关怀',      takeoutLabel: '物资包'     },
  rescue_team:       { dineInLabel: '现场救援人次', deliveryLabel: '外出救援',     listenLabel: '心理疏导',      takeoutLabel: '物资包'     },
  tongxin_children:  { dineInLabel: '院内儿童用餐', deliveryLabel: '外送关爱儿童', listenLabel: '心理疏导/陪伴', takeoutLabel: '打包爱心餐' },
  other:             { dineInLabel: '堂食服务',     deliveryLabel: '送餐服务',     listenLabel: '关爱陪伴',      takeoutLabel: '打包份数'   },
};
const FALLBACK_TARGET_LABELS = { dineInLabel: '堂食服务人次', deliveryLabel: '送餐服务', listenLabel: '关爱陪伴', takeoutLabel: '打包份数' };

// 🔑 特权邀请码身份词汇映射：本组件的本地胶囊角色词汇（PATRIARCH/MANAGER/FINANCE/
// FAMILY/VOLUNTEER）<-> cloudfunctions/manageStoreInviteCode 的服务端角色词汇
// （STORE_PATRIARCH/STORE_MANAGER/FINANCE/FAMILY/VOLUNTEER）。onGenerateInviteCode
// （发码）与 checkPendingInviteCode/confirmInviteCodeRedeem（扫码直达核销）两处
// 都要用同一套映射，提到模块级避免各自重复定义、口径走偏
const INVITE_ROLE_SERVER_MAP: Record<string, string> = {
  PATRIARCH: 'STORE_PATRIARCH', MANAGER: 'STORE_MANAGER', FINANCE: 'FINANCE', FAMILY: 'FAMILY', VOLUNTEER: 'VOLUNTEER'
};
// 🐛 跨页面文案统一：与 profile.ts 的邀请码弹窗（showInviteModal）共用同一套
// 角色中文名——此前两处各自维护一份，"门店财务"/"财务记账"、"志愿者"/"普通
// 义工"两两不一致，用户在不同入口生成的邀请码展示文案对不上，误以为是两种
// 不同的身份
const INVITE_ROLE_LABEL_MAP: Record<string, string> = {
  PATRIARCH: '大家长', MANAGER: '门店店长', FINANCE: '财务记账', FAMILY: '爱心家人', VOLUNTEER: '普通义工'
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

// 🐛 重大隔离漏洞修复：这 7 条"常用场景一键套用"预设文案此前是写死的静态对象，
// opening 那条甚至直接硬编码了一个具体的雨花斋示例门店名"三源弘雨花敬老家园"——
// 不管当前门店真实 orgType 是什么，点一键套用永远塞进雨花斋专属文案（"本斋"/
// "义工家人"这类雨花斋专属称谓、乃至虚构的示例店名）。现改为按真实 orgType
// （yuhuazhai / elderly_canteen / 其余通用公益）+ 当前门店名动态生成，
// tag 分类本身与机构类型无关，不随 orgType 变化（喜讯通报/义工招募等仍是同一批
// tag，只是 title/content 的措辞与称谓随机构类型走）
type NoticePresetType = 'opening' | 'volunteer' | 'supplies' | 'weather_closure' | 'renovation_closure' | 'festival' | 'thanks';

function getNoticeTemplate(type: NoticePresetType, orgType: string, storeName: string): { tag: string; title: string; content: string } {
  const isYuhuazhai = orgType === 'yuhuazhai';
  const isElderlyCanteen = orgType === 'elderly_canteen';
  // 三档兜底称谓：yuhuazhai 沿用"雨花斋"，elderly_canteen 用"社区助餐点"，
  // 其余通用公益机构用"本公益服务站"——storeName 有值时优先用真实门店名
  const fallbackName = isYuhuazhai ? '雨花斋' : isElderlyCanteen ? '社区助餐点' : '本公益服务站';
  const name = storeName || fallbackName;

  switch (type) {
    case 'opening':
      if (isYuhuazhai) {
        return {
          tag: '喜讯通报',
          title: `${name}试营业`,
          content: `${name}正式开启试营业。秉承敬老爱老、扶弱助困理念，为长者提供健康公益素食午餐。欢迎长辈们前来用餐，也欢迎爱心家人抽空回家做义工，一起践行敬老美德，传递关爱❤️。感恩大家支持！`
        };
      }
      if (isElderlyCanteen) {
        return {
          tag: '喜讯通报',
          title: `${name}试营业喜讯`,
          content: `${name}正式开启试营业啦！用心为社区长者提供健康、卫生、实惠的助餐服务。欢迎长辈们前来用餐，也欢迎爱心义工加入我们，一起守护社区里的老人家❤️。感恩大家的支持！`
        };
      }
      return {
        tag: '喜讯通报',
        title: `${name}试营业喜讯`,
        content: `${name}正式开启试营业啦！我们将用心为社区提供公益服务。欢迎大家前来了解，也欢迎爱心志愿者加入我们，一起传递温暖❤️。感恩大家的支持！`
      };

    case 'volunteer':
      if (isYuhuazhai) {
        return {
          tag: '义工招募',
          title: '爱心义工招募',
          content: `【爱心义工招募】${name}的运转离不开义工家人的倾情护持！现急需择菜、洗碗、传菜义工数名，服务时间：每天上午 8:30 - 12:30。期待您的加入，一起传递温暖！❤️`
        };
      }
      if (isElderlyCanteen) {
        return {
          tag: '义工招募',
          title: '爱心义工招募',
          content: `【爱心义工招募】${name}的运转离不开爱心义工的无私奉献！急需择菜、洗碗、分餐义工数名，服务时间：每天上午 8:30 - 12:30。期待您的加入，一起传递温暖！❤️`
        };
      }
      return {
        tag: '志愿招募',
        title: '爱心志愿招募',
        content: `【爱心志愿招募】${name}的运转离不开志愿者的无私奉献！急需多名志愿者协助日常事务，具体服务时间可与我们联系沟通。期待您的加入，一起传递温暖！❤️`
      };

    case 'supplies':
      if (isYuhuazhai) {
        return {
          tag: '物资呼吁',
          title: '爱心物资接力',
          content: `【爱心物资接力】感恩各位爱心人士的护持！当前${name}大米/食用油储备临界，特向社会呼吁爱心物资接力。每一粒米、每一滴油都饱含满满的心意。衷心感谢您的倾心付出！❤️`
        };
      }
      if (isElderlyCanteen) {
        return {
          tag: '物资呼吁',
          title: '爱心物资接力',
          content: `【爱心物资接力】感恩各位爱心人士的关心与支持！当前${name}大米/食用油储备临界，特向社会呼吁爱心物资接力，助力长者们吃上热乎饭。每一粒米、每一滴油都饱含满满的心意。衷心感谢您的倾心付出！❤️`
        };
      }
      return {
        tag: '物资呼吁',
        title: '爱心物资接力',
        content: `【爱心物资接力】感恩各位爱心人士的关心与支持！当前${name}物资储备临界，特向社会呼吁爱心物资接力。每一份物资都饱含满满的心意。衷心感谢您的倾心付出！❤️`
      };

    case 'weather_closure':
      if (isYuhuazhai) {
        return {
          tag: '暂停营业',
          title: '恶劣天气暂停开餐告示',
          content: `【暂停开餐通知】受恶劣天气影响，为保障各位长者及义工家人的出行安全，${name}将于明日暂停开餐一天。请大家互相转告，切勿空跑。待天气好转后恢复正常开餐。衷心感谢大家的理解与支持！❤️`
        };
      }
      if (isElderlyCanteen) {
        return {
          tag: '暂停营业',
          title: '恶劣天气暂停开餐告示',
          content: `【暂停开餐通知】受恶劣天气影响，为保障各位长者及义工的出行安全，${name}将于明日暂停开餐一天。请大家互相转告，切勿空跑。待天气好转后恢复正常开餐。衷心感谢大家的理解与支持！❤️`
        };
      }
      return {
        tag: '暂停营业',
        title: '恶劣天气暂停服务告示',
        content: `【暂停服务通知】受恶劣天气影响，为保障大家的出行安全，${name}将于明日暂停服务一天。请大家互相转告，切勿空跑。待天气好转后恢复正常服务。衷心感谢大家的理解与支持！❤️`
      };

    case 'renovation_closure':
      if (isYuhuazhai) {
        return {
          tag: '暂停营业',
          title: '内部整修/例行消杀停业通知',
          content: `【例行维护通知】为给长者们提供更加干净、卫生的用餐环境，${name}将于近期进行全店深度清洁消杀与设备整修，期间暂停开餐一天。恢复供餐后欢迎长辈们回家用餐。感恩大家的体谅与护持！❤️`
        };
      }
      if (isElderlyCanteen) {
        return {
          tag: '暂停营业',
          title: '内部整修/例行消杀停业通知',
          content: `【例行维护通知】为给长者们提供更加干净、卫生的用餐环境，${name}将于近期进行全店深度清洁消杀与设备整修，期间暂停开餐一天。恢复供餐后欢迎长辈们前来用餐。感恩大家的体谅与支持！❤️`
        };
      }
      return {
        tag: '暂停营业',
        title: '内部整修/例行消杀停业通知',
        content: `【例行维护通知】为给大家提供更加干净、卫生的服务环境，${name}将于近期进行环境清洁与设施整修，期间暂停服务一天。恢复服务后欢迎大家继续前来。感恩大家的体谅与支持！❤️`
      };

    case 'festival':
      if (isYuhuazhai) {
        return {
          tag: '日常温馨提醒',
          title: '节日特别结缘活动通知',
          content: `【节日欢聚通知】值此佳节到来之际，${name}将于明天中午举办节日特别供餐活动，并为到店用餐的长者准备了一份心意。欢迎长辈们互相转告、欢喜回家用餐！祝大家吉祥安康！🏮`
        };
      }
      if (isElderlyCanteen) {
        return {
          tag: '日常温馨提醒',
          title: '节日特别活动通知',
          content: `【节日欢聚通知】值此佳节到来之际，${name}将于明天中午举办节日特别供餐活动，并为到店用餐的长者准备了一份心意。欢迎长辈们互相转告、欢喜前来用餐！祝大家节日快乐、身体健康！🏮`
        };
      }
      return {
        tag: '日常温馨提醒',
        title: '节日特别活动通知',
        content: `【节日活动通知】值此佳节到来之际，${name}将于明天举办节日特别活动。欢迎大家互相转告、欢喜参与！祝大家节日快乐！🏮`
      };

    case 'thanks':
    default:
      if (isYuhuazhai) {
        return {
          tag: '感恩致谢',
          title: '专项爱心致谢',
          content: `【感恩致谢】特别感谢爱心企业/爱心人士对${name}的慷慨支持，您的善举让更多长者感受到了社会的温暖。衷心感谢您的无私奉献，祝愿平安喜乐、好人一生平安！❤️`
        };
      }
      if (isElderlyCanteen) {
        return {
          tag: '感恩致谢',
          title: '专项爱心致谢',
          content: `【感恩致谢】特别感谢爱心企业/爱心人士对${name}的慷慨支持，您的善举让更多长者感受到了社会的温暖。衷心感谢您的无私奉献，祝愿平安喜乐、好人一生平安！❤️`
        };
      }
      return {
        tag: '感恩致谢',
        title: '专项爱心致谢',
        content: `【感恩致谢】特别感谢爱心企业/爱心人士对${name}的慷慨支持，您的善举让更多人感受到了社会的温暖。衷心感谢您的无私奉献，祝愿平安喜乐、好人一生平安！❤️`
      };
  }
}

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
//
// 🐛 分类规则/正文去重已收敛进 utils/noticeDisplay.ts 统一维护，与 notice.ts
// （通知页"系统通知"列表徽标）共用同一份数据字典，不再各自维护一份可能不一致
// 的分类逻辑（详见该文件顶部注释）

function mapNoticeRecord(raw: any): any {
  let createTime = '';
  try {
    createTime = new Date(raw.createdAt).toISOString().split('T')[0];
  } catch (e) {
    createTime = '';
  }
  const tag = raw.tag || '';
  const title = raw.title || '';
  const content = raw.content || '';
  const classified = classifyNotice(tag, title, content);
  return {
    id: raw._id,
    tag,
    title,
    // 🐛 正文展示去重：预置文案/店长自行编辑保存的通报，正文开头习惯性带一份
    // 与标题完全一致的"【标题】"前缀，弹窗已在标题位置单独展示过一次，这里
    // 渲染取值时剥离，避免"标题与正文首行重复"
    content: stripTitlePrefixFromContent(content, title),
    is_top: true,
    create_time: createTime,
    noticeType: classified.noticeType,
    typeIcon: classified.typeIcon,
    typeLabel: classified.typeLabel,
    modalHeaderTitle: classified.headerTitle,
    modalThemeClass: classified.themeClass
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

// 🐛 根因修复：autoSyncOfflineQueue/syncOfflineQueueManually 此前对
// DataService.saveReport() 的返回值完全不检查 success 字段——saveReport 对
// "全0跳过/重复日期/记录已锁定/门店已停用"这类业务规则拒绝走的是正常 resolve
// （success:false，不是 reject），队列循环的 try/catch 只拦得住真正抛异常的
// 情况（如图片上传失败），于是这几类被明确拒绝的提交也会被当成"已同步成功"
// 直接移出队列、计入成功数——数据其实根本没有写进云端，用户却看到"已同步"
// 的提示，且以后再也没有机会重新提交这条数据。这些失败原因都是规则性拒绝，
// 不是网络抖动，重试也不会变成功，所以仍应清出队列（留着只会一直卡住后面的
// 正常项），但不能计入成功数——与 saveReportAsync 里已经识别的这几类
// errorDetail 保持同一份清单
const NON_RETRYABLE_SAVE_ERROR_DETAILS = ['all_zero_skipped', 'duplicate_date_blocked', 'record_locked_for_upsert', 'store_inactive'];
function isNonRetryableSaveError(errorDetail: string | undefined): boolean {
  return !!errorDetail && NON_RETRYABLE_SAVE_ERROR_DETAILS.includes(errorDetail);
}

// ☀️ 阳光账本理念弹窗文案：按门店真实 orgType（getSunshineLedger 返回，来自
// stores.orgType 字段本身，不是靠 tenantId 前缀猜的那套粗粒度信号）区分——
// 雨花斋展示雨花精神，助老食堂展示助老理念，其余机构类型（义工服务站/救援队/
// 儿童院等）一律落到中性的通用公益宗旨兜底，绝不把雨花文案强加给非雨花机构
function computeConceptCopy(orgType: string, storeName: string): { title: string; label: string; content: string } {
  const displayStoreName = storeName || '本站点';
  if (orgType === 'yuhuazhai') {
    return {
      title: '☀️ 阳光账本与雨花理念',
      label: '雨花精神',
      content: '雨花无家，家在雨花。雨花斋致力于推广素食护生、恭敬生命与公益互助。'
    };
  }
  if (orgType === 'elderly_canteen') {
    return {
      title: '☀️ 阳光账本与助老理念',
      label: '助老理念',
      content: '爱心助餐，敬老护生。致力于为社区长者提供公开透明、温暖放心的助餐服务。'
    };
  }
  return {
    title: '☀️ 阳光账本与公益宣言',
    label: '公益宗旨',
    content: `阳光笃行，爱心同行。${displayStoreName}坚持以公益之心服务社区，守护每一份需要关爱的心意。`
  };
}


// 🐛 重大 Bug 修复：【机构文化与每日家训】弹窗此前无论 orgType 是什么都固定展示
// utils/cultureData.ts 里的雨花斋十大模块原文（该文件明确注明"内容来源：机构提供的
// 权威培训原文"，是雨花斋专属的授权素材，不能套用给其他机构）。现按真实 orgType
// 三档分流标题；elderly_canteen（社区助餐/敬老中心）与其余通用公益机构不再展示
// 雨花斋专属内容，改为展示门店自己配置的文化寄语（cultureStoreSlogan1/2，来自
// 「组织信息配置」弹窗，真实数据）+ 一段明确标注为通用占位的公益精神简述——
// 没有真实的机构专属文化全集素材前，绝不虚构一套看起来"权威"的十模块内容
function computeCultureModalTitle(orgType: string): string {
  if (orgType === 'yuhuazhai') return '机构文化和每日诵读';
  if (orgType === 'elderly_canteen') return '社区敬老文化与每日家训';
  return '公益文化与团队公约';
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
  // 🔗 打卡工时联动：同日内只拉取一次云端数据（force=true 时跳过缓存）
  _checkInHoursCachedDate: '' as string,
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
    // 🏢 平台/工作空间选择：首页默认落地在"工作空间选择"首页（两张平台卡片），
    // 只有用户主动点击某张卡片进入后，才会切到该模式下的原有工作台内容——
    // 与 onLoad/onShow 生命周期完全解耦，冷启动/onShow 都不会自动带入任何模式。
    // 'yuhua' 档在此基础上还叠加雨花专属合规声明的两级校验，见 enterYuhuaWorkspaceFlow
    currentPlatformMode: '' as '' | 'yuhua' | 'general',
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
    // 🆕 理念弹窗文案：按 getSunshineLedger 返回的真实门店 orgType 计算（见
    // computeConceptCopy），不再是 WXML 里硬编码的雨花斋专属文案 + 兜底二选一
    conceptTitle: '☀️ 阳光账本与公益宣言',
    conceptLabel: '公益宗旨',
    conceptContent: '',
    yesterdayBalDisplay: '0.00',
    totalIncomeDisplay: '0.00',
    totalExpenseDisplay: '0.00',
    previewTodayBalanceDisplay: '0.00',
    singleName: '',
    singleAmount: '',
    allDonations: '',
    // 🌸🌿 了凡四训·阳善与阴德：发心选择
    // 'yang'（阳善）：直接公示真实姓名，长养公信，感召更多善念
    // 'yin' （积阴德）：姓名统一展示为"爱心善士"，隐名护持，涵养深厚阴德，天报之
    meritType: 'yang' as 'yang' | 'yin',
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
    shopName: '',
    mpAccount: '',
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
    // 🔗 打卡工时联动：自动汇总云端打卡数据预填工时，大家长手动修改后切换为 manual 模式
    isManualHours: false,
    checkInHoursTip: '' as string,
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
    listeningSeniors: '', // 倾听/陪伴长者人次（独立关怀指标，不计入用餐总数）
    totalDineCount: '0', // 用餐总数（自动计算：堂食长者+送餐长者+打包+堂食志愿者）
    totalVolunteers: '0', // 志愿者总人次（自动计算：送餐志愿者+堂食志愿者）
    // 📋 【一键复用昨日数据】：loadBalanceForDate 查昨日结余时顺手带出的细分统计快照，
    // 供用户点"复用昨日"按钮一键填充；全 0（老记录没有细分字段/无昨日记录）时按钮置灰不可用
    yesterdayStatsSnapshot: null as null | {
      dineInSeniors: number; deliverySeniors: number; takeawayCount: number;
      dineInVolunteers: number; deliveryVolunteers: number; volunteerHours: number;
      listeningSeniors: number;
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
    // 🖨️ 高对比度打印清单：与生成海报同一套"canvas 渲染 → 导出临时图片"
    // 流程，但导出后直接走 wx.previewImage 原生长按保存，不额外起一个自定义
    // 预览弹窗（见 utils/printRenderer.ts 头部注释）
    isGeneratingPrintList: false,
    printCanvasHeight: 800,
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
    // 🆕 海报右下角"扫码验真"用的真实小程序码本地临时路径（指向 subpackages/admin/pages/public-verify/index，
    // 携带 storeId+date）：每次生成/切版式共用同一份，生成失败时为空字符串，
    // 由 posterGenerator.ts 自行降级为占位框
    verifyQrLocalPath: '',
    // 🐛 验真二维码重试兜底：resolveVerifyQrLocalPath 重试 MAX_ATTEMPTS 次仍
    // 失败时置为 true，驱动 .poster-modal 里的可点击重试提示条（见
    // onRetryVerifyQr），成功后复位为 false
    posterVerifyQrFailed: false,
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
    // 👵 长辈代报餐与签到弹窗（elder-checkin-modal 组件），显隐同上，表单
    // 状态在组件内部持有；提交后的人数合并见 onElderCheckinSubmitted
    showElderCheckinModal: false,
    // 🦻 关怀模式：onLoad 时从 app.globalData/本地存储回填，见 onToggleCareMode
    careMode: false,
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
    isNoticeBarClosing: false,
    // 🌟 混合跑马灯状态：noticeMarqueeActive 由 measureNoticeMarquee() 量出当前
    // 标题是否超出可视宽度决定，短标题恒为 false（保持静止展示）；激活期间
    // noticeSwiperAutoplay 联动置 false 暂停垂直轮播，避免标题还没滚完就被切
    // 走；noticeSwiperCurrent 绑定 swiper 的 current，供 onNoticeMarqueeCycle
    // 在一个跑马灯周期结束后主动推进到下一条，再交还给 measureNoticeMarquee
    // 判断是否恢复正常轮播
    noticeMarqueeActive: false,
    noticeSwiperAutoplay: true,
    noticeSwiperCurrent: 0,
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
      noticeType: string;
      typeIcon: string;
      typeLabel: string;
      modalHeaderTitle: string;
      modalThemeClass: string;
    } | null,
    showAnnouncementModal: false,
    showNoticeEditModal: false,
    noticeEditId: '',
    // 🐛 不再硬编码"喜讯通报"占位——openNoticeEdit/openNoticeCreate 打开弹窗时
    // 会各自算出正确的默认值（沿用已有 tag，或按标题+正文语义建议），这里只是
    // 弹窗展示前的初始态，留空即可，避免与真实分类语义无关的固定值有机可乘
    noticeEditTag: '',
    noticeEditTitle: '',
    noticeEditContent: '',
    // 🌟 公告模板库：与本机内置的 7 条按 orgType 动态生成的预设文案（见
    // getNoticeTemplate）并列展示，云端拉取——isSystem:true 为全域公共模板
    // （本机构任意门店可用），其余为当前门店自己保存的私有模板，两者互不越界
    // （见 manageNotice getTemplates）
    noticeTemplates: [] as any[],
    noticeTemplatesLoading: false,
    // 仅超级管理员在"存为模板"时可勾选，决定新模板是私有（本店）还是全域公共
    saveAsSystemTemplate: false,
    mergeToReportText: false,
    showApplyModal: false,
    // 🌸 弹窗标题覆盖：从【选择工作空间】页雨花/通用卡片、或空状态"加入现有爱心
    // 站点"引导卡唤起时，标题固定为"选择 XX 服务站点"（见 openStorePickerForJoin），
    // 优先于 WXML 原有的"申请加入门店/加入【XX】"动态标题；空字符串时不覆盖
    applyModalTitleOverride: '',
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
      region: [] as string[],
      address: '',
      contactPhone: '',
      storePhotos: [] as string[],
      // 🔐 已有门店 + 申请大家长/店长/财务这类管理岗位时，服务端
      // processRoleAudit 会校验目标门店是否设置了 adminKey（大家长在【门店安全
      // 密钥设置】里配置，见 profile.ts）；此前本表单完全没有这个输入框，
      // existing 路径永远把 adminKey 传空字符串，导致但凡目标门店真的配置了
      // 密钥，申请必然报"管理员密钥错误"且用户无从填写。是否必填由服务端按
      // 目标门店是否设了 key 决定——没设 key 的门店留空也能通过，这里不做
      // 客户端必填校验，只负责把用户填的值原样带上
      adminKeyInput: '',
      // 🌸 新建门店时的机构类型提示：从 openStorePickerForJoin 唤起时按当前专区
      // 预填（雨花专区='yuhuazhai'，通用专区留空退回服务端默认 'other'），确保
      // Bug 1 里"新建雨花门店"真的会给新店打上 orgType:'yuhuazhai' 标签，而不是
      // 静默落到 processRoleAudit 的 'other' 兜底值
      orgTypeHint: ''
    } as any,
    applyStorePhotoUploading: false,
    isSubmittingApply: false,
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
    // 🌐 多租户：新用户（isFamily + 无门店）引导卡，代替表单/家人视图展示创建/加入入口
    showNewUserGuide: false,
    // 🌐 多租户：组织类型，yuhuazhai 时显示文化卡片，其余通用。初始为 tenantId 前缀
    // 猜出的粗粒度值，loadStoreTargetConfig() 里会用 stores.orgType 真实值覆盖
    orgType: '' as string,
    // 🌟 机构类型短标签：与 profile.ts computeOrgDisplayCopy 同一套措辞口径
    // （雨花斋/社区助餐/其余机构留空），由 loadStoreTargetConfig() 按真实 orgType 计算
    orgTypeBadge: '' as string,
    // 🆕【机构文化与每日家训】弹窗：标题按真实 orgType 三档计算（见
    // computeCultureModalTitle），非雨花斋分支展示门店自己配置的文化寄语——
    // 中性默认，不臆造具体机构品牌
    cultureModalTitle: '公益文化与团队公约',
    cultureStoreSlogan1: '',
    cultureStoreSlogan2: '',
    // 🏷️ 服务受众标签：驱动首页填报表单文案自适应渲染，来自 serviceTargetConfig 自定义配置
    // 或 ORG_TYPE_DEFAULT_TARGET_LABELS 默认值，由 loadStoreTargetConfig() 在角色解析后更新
    storeTargetLabels: FALLBACK_TARGET_LABELS as { dineInLabel: string; deliveryLabel: string; listenLabel: string; takeoutLabel: string },
    // 📋 表单折叠：默认收起次要录入项（支出/凭证/照片/日志），首屏聚焦核心字段
    showFormExtra: false,
    // 🌟 视角切换预览：isRealSuperAdmin 恒等于真实身份，不受预览覆盖影响，用于门店切换器等
    // 处的"视角切换"入口自身的显隐判断；currentViewMode 是当前选中的预览视角
    isRealSuperAdmin: false,
    // 🏢 平台管理员（platform_admin）：与 isSuperAdmin/isRealSuperAdmin 是独立维度，
    // 仅供 isCurrentAccountSuperAdmin() 判断"是否可绕过工作空间选择页 orgType 校验"使用
    isPlatformAdmin: false,
    currentViewMode: 'SUPER_ADMIN' as PreviewViewMode,
    currentViewModeLabel: PREVIEW_VIEW_MODE_LABELS.SUPER_ADMIN as string,
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
    // 🐛 财务首页瘦身：默认收起"请填写当日明细"整条录入表单流水线（含爱心支持/
    // 物资明细、义工与用餐统计、生成结果预览、底部吸底生成按钮），首屏聚焦
    // 【财务稽核台】。财务仍保留亲自代填当日餐报的能力（见 onScrollToFinanceConsole
    // 旁的"临时代为填报"链接切换本字段），只是不再是默认呈现内容——不影响大家长/
    // 超管（他们靠角色继承拿到 isFinance，但 currentUserRole 不等于 'finance'）
    showFinanceFormOverride: false,
    // 🌟 账本锁定状态：finance-home-card 顶部指标，真实数据见 fetchFinanceLedgerStatus
    // （此前是写死的 "100%" 占位文案，未绑定任何数据源）
    financeLedgerStatusLoading: false,
    financeLedgerAuditedRate: null as number | null,
    currentStoreId: '' as string,
    isAllStoresView: false,
    allStoresList: [] as any[],
    showStorePosterModal: false,
    storePosterTempFilePath: '',
    // 🛡️ Canvas 白屏修复：绘制过程中盖一层 Loading 遮罩，避免绘制耗时期间用户
    // 看到的是一块空白画布（此前 wx.showLoading 只在全局顶层转圈，不覆盖弹窗内
    // 画布区域本身，观感上就是"白屏"）；生成失败时同样兜底收起弹窗，不留白屏残影
    isStorePosterDrawing: false,
    // 🐛 真机二维码重试兜底：_fetchStoreQrLocalPath 重试耗尽后海报仍会带着圆角
    // 占位卡正常生成（不阻断），但此时应该让用户能一键只重新拉二维码，而不是
    // 教他们去读那张卡片上的"请稍后重试"小字——这个标记驱动预览区底部的重试提示条
    storePosterQrFailed: false,
    // 🐛 长等待体感修复：callFunction 超时从 8s 提到 18s 后，第二次尝试最长可能
    // 要再等 18s——用户如果全程只看到一句不变的"正在合成精美海报..."，很容易
    // 以为卡死了。第一次尝试失败进入重试时置 true，切换文案告诉用户"确实在重试"
    storePosterQrRetrying: false,
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
    // 🏛️ 业务模型重构："服务餐次（时段）+ 护持岗位（工种）"组合选择，取代此前
    // shiftDefinitions 里"一个班次名字里死绑一个固定工时"的单选列表（如
    // "🍲 午餐打饭与引导班"=固定 3.0h，选了这一条就没法反映"我这次其实主要在
    // 洗菜、顺便打饭"这种真实的混合工种场景）。selectedShift 字段名保留不变
    // （仍然承担 shiftKey 语义，供 onConfirmShiftCheckIn/manageVolunteerCheckIn
    // 云函数/my_checkin_logs 本地台账三处沿用），取值从旧的 5 个固定班次 key
    // 改为 mealSlotDefinitions 里的时段 key（morning/lunch/dinner）——云函数与
    // 本地台账都只把 shiftKey 当不透明字符串做"当日+同 key 去重"，不做枚举校验，
    // 换取值域是安全的，不需要连带改动 cloudfunctions/manageVolunteerCheckIn
    selectedShift: 'lunch',
    // 工时不再从选中班次的固定值直接取，改由 recomputeShiftHours() 按
    // "selectedJobTypes 工种建议工时之和 + manualHoursAdjust 微调" 实时算出，
    // 这里只是初始占位值，真正生效值在 refreshTodayShiftStatus/onToggleJobType/
    // onAdjustShiftHours 里持续刷新
    selectedShiftHours: 0,
    willEatLunch: true,
    // 🍚 留店用餐细分餐别：勾选"今日留店用餐"后展开的早/午/晚 Chip 多选态，
    // 提交打卡时随 reservedMeals 一并写入后厨预留量数据（见 onConfirmShiftCheckIn）
    reservedMeals: ['lunch'] as string[],
    // 🍚 按门店配置供餐餐次：从 manageStoreProfile 的 mealConfig.supportedMeals 拉取
    // （见 loadStoreTargetConfig），默认单午餐档——打卡弹窗"今日留店用餐"Chip 行、
    // 供餐时段列表（availableMealSlots 按 mealSlotDefinitions[].relatedMeal 关联过滤）、
    // 餐报文本/公示海报的供餐人数汇总，均以这份数组为准动态适配
    supportedMeals: ['lunch'] as string[],
    // 🍚 后厨预留量统计：manageVolunteerCheckIn queryStoreHours 按餐别聚合的今日
    // 留店用餐人数（见 syncCheckInHoursToForm），供餐报/海报的"供餐人数汇总"引用
    mealReserveCounts: { breakfast: 0, lunch: 0, dinner: 0 } as Record<string, number>,
    checkInLogs: [] as any[],
    todayAccumulatedHours: 0,
    // 🌟 打卡弹窗实时工时预览：勾选班次后即时预估"若提交这一笔，今日总工时会变成多少"，
    // 超限时禁用确认按钮，而不是等提交后才静默截断
    previewTotalHours: 0,
    isOverHoursLimit: false,
    checkInSubmitting: false,
    allShiftsCompleted: false,
    // 🛡️ 确认打卡主按钮文案：由 computeConfirmButtonText() 统一算好，见该方法
    // 头部注释——不在 WXML 里用嵌套三元表达式拼接，规避表达式引擎解析风险
    confirmButtonText: '请先勾选护持工种',
    todayLogs: [] as any[],
    myCheckInDays: 0,
    myCheckInCount: 0,
    myServiceHours: 0,
    // 🍚 供餐时段（第一维）：单选（一次打卡对应一次实际到店服务的时间窗口，
    // 不支持同时勾选多个时段）。🐛 2026-08 修复：refreshTodayShiftStatus()
    // 此前按当前门店 supportedMeals 过滤这份列表，只供午餐的门店（多数雨花斋）
    // 只会看到"午市班次"一档，早/晚市自动隐藏——但打卡记录的是义工护持工时，
    // 跟门店"卖不卖这顿饭"无关（早市开餐前备菜、没有正式晚市供餐的门店做晚间
    // 收尾保洁，都是真实发生的工时），现在始终完整展示这里定义的全部 4 档，
    // 不再按 supportedMeals 收窄。relatedMeal 字段保留下来，只用于
    // getDefaultReservedMeal()——"留店用餐"细分餐别默认勾选值仍需要知道
    // 某个时段对应哪顿饭；"全天护持"档没有对应具体某一顿饭，relatedMeal 留空。
    // shiftType 是提交给 manageVolunteerCheckIn 的归档口径
    // （'BREAKFAST'|'LUNCH'|'DINNER'|'FULL_DAY'），与本地专用的 slotKey 分开管理，
    // slotKey 继续只做"当日+同 key 去重"的不透明字符串，不需要跟着改
    mealSlotDefinitions: [
      { slotKey: 'morning', name: '🌅 早市班次', timeDesc: '06:00 - 08:30', relatedMeal: 'breakfast', shiftType: 'BREAKFAST' },
      { slotKey: 'lunch', name: '☀️ 午市班次', timeDesc: '09:00 - 13:30', relatedMeal: 'lunch', shiftType: 'LUNCH' },
      { slotKey: 'dinner', name: '🌙 晚市班次', timeDesc: '16:30 - 19:30', relatedMeal: 'dinner', shiftType: 'DINNER' },
      { slotKey: 'full_day', name: '🌟 全天护持', timeDesc: '全天常驻', relatedMeal: '', shiftType: 'FULL_DAY' }
    ] as any[],
    availableMealSlots: [] as any[],
    // 🍳 护持岗位/工种分类（第二维）：多选，hours 是"午市班次"口径下的建议工时
    // 基准值——不同班次的合理工时天然不同（早市窗口比午市短、全天护持要覆盖
    // 多个窗口），真正展示/参与计算的是 displayJobTypes（见 refreshDisplayJobTypes/
    // getJobHoursForSlot），jobTypeDefinitions 本身只保留 icon/name/desc 等
    // 不随班次变化的静态信息 + 午市基准工时
    // 🆕 2026-08 新增两个外勤工种（送餐/上门关怀）：卡片标题沿用既有"A/B" 4 字
    // 紧凑命名惯例（与"主厨/面点"等保持同一视觉节奏，避免"上门倾听关怀服务"
    // 这类 8 字长名称在 job-card 固定宽度下换行/溢出），完整业务语义放在 desc
    // 里；jobKey 同样沿用短小写惯例（chef/prep/serve/clean），未采用需求里
    // 建议的 MEAL_DELIVERY/HOME_CARE_LISTENING 这类长命名，理由同上
    jobTypeDefinitions: [
      { jobKey: 'chef', icon: '👨‍🍳', name: '主厨/面点', desc: '掌勺烹饪、面点制作、后厨统筹', hours: 3.5 },
      { jobKey: 'prep', icon: '🥬', name: '洗菜/切配', desc: '食材挑选、清洗去杂、切配备料', hours: 2.5 },
      { jobKey: 'serve', icon: '🤝', name: '堂食/引导', desc: '行仪引导、打饭分餐、维持秩序', hours: 2.0 },
      { jobKey: 'clean', icon: '🧹', name: '保洁/洗消', desc: '洗碗消毒、餐桌擦拭、拖地清洁', hours: 2.0 },
      { jobKey: 'delivery', icon: '🛵', name: '送餐/配送', desc: '爱心便当上门派送、助老送餐、特殊群体关怀配送', hours: 1.5 },
      { jobKey: 'listen', icon: '👂', name: '倾听/关怀', desc: '入户走访、长者陪聊、心理慰藉与倾听关怀', hours: 2.0 }
    ] as any[],
    // 🎚️ 各班次工种建议工时覆盖表：只列出与"午市"（jobTypeDefinitions 基准值）
    // 不同的班次，lunch 本身不需要出现在这里——早市窗口短（2.5h）按各工种
    // 基准值统一打七折取整到 0.5h 台阶；晚市窗口（3h）介于早/午之间；全天护持
    // 覆盖早+午两段窗口，按基准值 1.7 倍估算，均取 0.5h 台阶，不是精确算出来的
    // 数字，是给义工一个合理参考起点，实际仍可用下方步进器 ±0.5h 手动修正。
    // delivery/listen 两个外勤工种延续同一套折算比例（delivery 对齐 serve/
    // clean 的 75%/175% 折算档；listen 与 serve/clean 基准值相同，直接复用
    // 同一组折算值）
    jobHoursOverrideBySlot: {
      morning: { chef: 2.5, prep: 2.0, serve: 1.5, clean: 1.5, delivery: 1.0, listen: 1.5 },
      dinner: { chef: 3.0, prep: 2.0, serve: 1.5, clean: 1.5, delivery: 1.0, listen: 1.5 },
      full_day: { chef: 6.0, prep: 4.5, serve: 3.5, clean: 3.5, delivery: 2.5, listen: 3.5 }
    } as Record<string, Record<string, number>>,
    // 🍳 按当前 selectedShift 换算过工时的工种卡片展示数据，WXML 的 job-grid-container
    // 实际迭代这份而不是静态的 jobTypeDefinitions——切换班次时随之刷新
    // （见 refreshDisplayJobTypes），"下方各工种的推荐预估工时动态刷新"落在这里
    displayJobTypes: [] as any[],
    selectedJobTypes: [] as string[],
    // 🍚 留餐提示文案：根据当前选中班次自适应（"今日留店用早/午/晚餐"），
    // 全天护持档不对应单一餐次，退回通用文案——见 getMealReserveTipText
    mealReserveTipText: '今日留店用餐 (方便后厨预留餐量)',
    // 🎚️ 工时微调：在"选中工种建议工时之和"基础上做 ±0.5h 的轻量调整（如实际
    // 比预估多干了半小时），范围裁剪在 recomputeShiftHours 里统一做，不单独立
    // 上下限校验分支
    manualHoursAdjust: 0,
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
    // 🏛️ 身份阶梯权限过滤：当前调用者实际可选的目标身份白名单，onOpenGenCodeModal
    // 每次打开弹窗时都会重新算一遍并覆盖这里的初始值，与 cloudfunctions/
    // manageStoreInviteCode 的 checkGeneratePermission 口径一致——超管/大家长
    // 可选全部五种（大家长是门店最高负责人），店长只放开 [门店财务, 家人, 志愿者]
    // （大家长/门店店长两档与调用者自身同级或更高，严禁越权生成）
    genAvailableRoles: ['PATRIARCH', 'MANAGER', 'FINANCE', 'FAMILY', 'VOLUNTEER'] as string[],
    // 🐛 排查加固：与 job-type 工种网格（refreshDisplayJobTypes）同一处历史
    // 修复思路——WXML {{}} 表达式引擎对"在模板里现场调用数组方法"（这里是
    // genAvailableRoles.includes(...)）的求值可靠性不完全可信任，且一旦
    // genAvailableRoles 的运行时形状意外不是数组（如被某次 setData 错误地
    // 赋成了字符串——字符串同样有 .includes() 方法，但语义变成子串匹配，
    // 只会让"恰好是子串"的那一项被误判为可用，其余全部被误判禁用，且不会
    // 抛出任何错误/警告，非常隐蔽），WXML 侧完全看不出问题出在哪。这里在
    // TS 侧把"每个角色是否禁用"预算成显式布尔字段，WXML 只读布尔值，不再
    // 现场调用任何数组方法，彻底消除这一整类不确定性
    genRolePatriarchDisabled: false,
    genRoleManagerDisabled: false,
    genRoleFinanceDisabled: false,
    genRoleFamilyDisabled: false,
    genRoleVolunteerDisabled: false,

    // 🔑 生成结果弹窗：展示 8 位邀请码 + 对应太阳码，与 gencode-modal 是两个独立弹窗——
    // 生成成功后立即关闭 gencode-modal、打开这个结果弹窗，不再像旧版那样自动复制关闭
    showInviteResultModal: false,
    inviteResultCode: '',
    inviteResultQrPath: '',
    inviteResultStoreName: '',
    inviteResultRoleLabel: ''
  },

  _adjustResolve: null as (() => void) | null,
  // 🛡️ 护持工种卡片防误触抖动：见 onToggleJobType 头部注释，按 jobKey 维度
  // 记录"上一次成功触发的 toggle 是哪张卡片、什么时候"，不是 data 字段（不需要
  // 驱动任何渲染），纯实例属性
  _lastJobToggleKey: '' as string,
  _lastJobToggleTime: 0 as number,
  // 🐛 根因修复（getStoreList 超时）：见 fetchAllStoresList 头部注释——
  // initCurrentUserRole 的 cached 分支与 fetchUserRole 权威分支在满足同一个
  // 条件时会各自独立调用一次 fetchAllStoresList，同一次 onLoad 里并发发起
  // 两次相同的云函数请求，互相抢占网络/云端并发资源。这里记录"当前是否有一次
  // 尚未完成的请求，以及是哪个专区（zoneKey）发起的"，用于去重，纯实例属性，
  // 不需要驱动任何渲染
  _fetchAllStoresListInFlight: null as { zoneKey: string; promise: Promise<void> } | null,

  async onLoad(options: any) {
    this.debouncedSaveDraft = debounce(() => this.saveDraft(), 500);

    // 🐛 修复：todayDateStr 此前从未被赋值，义工视角"汇报日期"栏与首页快捷发布弹窗
    // 的日期提示一直渲染为空白
    this.setData({ todayDateStr: getTodayIsoString() });

    // 🦻 关怀模式：app.ts onLaunch 已经从 wx.getStorageSync 回填过 globalData，
    // 这里直接读一次镜像到本页 data，不重复读存储
    const app = getApp() as any;
    this.setData({ careMode: !!(app && app.globalData && app.globalData.careMode) });

    // 任务C：解析锚点聚焦参数
    // 支持 action=checkInCard 或 targetElement=checkInCard 两种参数名
    if (options) {
      const action = options.action || '';
      const target = options.targetElement || '';
      if (action === 'checkInCard' || target === 'checkInCard') {
        this._pendingScrollTarget = 'checkInCard';
      }
    }

    // 🐛 scene 32 字符硬限制修复后（见 getStoreQRCode 云函数），门店主邀请码
    // 的 scene 格式已从 "s=<storeId>" 改成裸 storeId 字符串（不带 key=value
    // 前缀，省下来的 2 个字符正好用来装满 32 位云数据库自动 _id）。这里同时
    // 兼容两种格式：新码不含 "="，整段就是 storeId；已经印刷/分享出去的存量
    // 老码仍是 "s=<storeId>" 形式，按有没有等号区分，不影响已经在流通的海报。
    // 🛡️ 不用 URLSearchParams：项目 tsconfig 的 lib 未包含 DOM 类型（之前这里
    // 一直是个编译错误，try/catch 兜底也从没真正用上 URLSearchParams 分支），
    // 改成手动按 & 分段解析 key=value，与 app.ts _captureInviteContext 的
    // scene 解析保持同一种写法
    if (options && options.scene) {
      const sceneStr = decodeURIComponent(options.scene);
      let storeId = '';

      if (sceneStr.indexOf('=') === -1) {
        storeId = sceneStr;
      } else {
        sceneStr.split('&').forEach((pair) => {
          const idx = pair.indexOf('=');
          if (idx < 0) return;
          const key = pair.slice(0, idx);
          const value = pair.slice(idx + 1);
          if (key === 's') storeId = value;
        });
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

    const storeId = this.data.currentStoreId || '';
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
        'STORE_FAMILY': 'store_family',
        // 🐛 根因修复：此前 roleMap 没有 PLATFORM_ADMIN 分支，缺失的键会落到
        // 下面 `roleMap[rawRole] || 'volunteer'` 的默认兜底，把平台管理员静默
        // 降级显示成义工（isSuperAdminAccount 判定也随之失真）。platform_admin
        // 与业务角色是独立维度（不参与 isManager/isFinance/isSuperAdmin 的
        // 业务权限分层，见 authService.ts UserRole 注释），这里只补齐"角色字面量
        // 不能被悄悄丢弃"，不改变它与业务角色互不提升的既有约束
        'PLATFORM_ADMIN': 'platform_admin'
      };
      const normalizedRole = roleMap[rawRole] || 'volunteer';
      const flags = getPermissionFlags({ role: normalizedRole });
      // 🏢 平台管理员标志位：与 isSuperAdmin 是两个独立维度（互不包含），供
      // isCurrentAccountSuperAdmin() 等"是否可绕过门店类型限制"的 UI 判定使用
      const isPlatformAdmin = normalizedRole === 'platform_admin';

      // 🌟 视角切换预览：真实角色是 super_admin 且已选择非全景视角时，展示层降级模拟
      // 大家长/店长/财务/义工/家人视角；isRealSuperAdmin 保留真实值，供切换入口自身显隐判断
      const isRealSuperAdmin = isSuperAdmin;
      // ❤️ 家人（服务对象）：normalizedRole 显式为 store_family 时直接判定；新用户/
      // 未审核通过的默认 volunteer 账号也按家人视角展示——与 profile.ts isFamily
      // 判定口径一致，避免未审核用户在首页看到打卡/计算工具等管理类模块。这是
      // 预览覆盖前的"真实"家人判定，作为 applyRoleViewOverride 的入参之一
      const rawIsFamily = normalizedRole === 'store_family' || (isVolunteer && status !== 'approved');
      const overridden = applyRoleViewOverride(normalizedRole, {
        currentUserRole: normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin, isFamily: rawIsFamily
      });
      // 🌟 家人视角现已补齐进预览选项：非 super_admin 时 applyRoleViewOverride 原样
      // 透传 rawIsFamily；super_admin 预览为 FAMILY 档位时降级模拟为 isFamily=true
      const isFamily = overridden.isFamily;
      // 🏛️ 大家长：不受 applyRoleViewOverride 预览覆盖影响（预览仅针对 super_admin 本人），
      // 直接取规范化角色判定，供「解封/反封账」等大家长专属操作的权限校验使用
      const isPatriarch = normalizedRole === 'store_patriarch';

      return {
        rawRole, normalizedRole, flags,
        // 🛡️ isVolunteer/isFamily 互斥：与 profile.ts 同一口径，均已由
        // applyRoleViewOverride 统一降级模拟，无需再手动排除
        isVolunteer: overridden.isVolunteer,
        isManager: overridden.isManager,
        isFinance: overridden.isFinance,
        isSuperAdmin: overridden.isSuperAdmin,
        isPatriarch,
        displayRole: overridden.currentUserRole,
        isRealSuperAdmin,
        isPlatformAdmin,
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

    // 🐛 根因修复：cachedRole（AuthService 本地持久化的服务端角色缓存）与 storageRole
    // （store-picker 手动切换身份后写入 current_user_role 的生效角色）冲突时，此前
    // 这里完全没读过 current_user_role，永远以 cachedRole 为准——一旦用户手动切换
    // 视角（如 super_admin 切到 store_manager），刷新/重进首页时 initCurrentUserRole
    // 又会用服务端缓存把生效角色悄悄改回 super_admin，切换如同白切。现在收敛调用
    // AuthService.resolveEffectiveRole——与 profile.ts initMinePage() 共用同一份
    // 集中实现，不再各自维护一份几乎一样的判断逻辑（详见该方法定义处注释）
    const cached = AuthService.getCachedRoleInfo();
    if (cached) {
      const effectiveRawRole = AuthService.resolveEffectiveRole(cached.role);
      const { rawRole, normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin, isPatriarch, flags, displayRole, isRealSuperAdmin, isPlatformAdmin, isFamily } = computeRoleState(effectiveRawRole, cached.status);
      const storeName = cached.storeName || '';
      const storeId = cached.storeId || '';
      const tenantId = (cached as any).tenantId || '';
      // 🌸 工作空间过滤权威口径：orgType 直接取 checkUserRole 随身份下发的
      // stores.orgType 真实值（见该云函数同名字段注释），不再用 tenantId 前缀猜——
      // 猜测口径在"同一机构下混有非雨花斋门店"或"未来出现前缀不是 yuhuazhai 的
      // 第二个雨花斋机构"时会判错。loadStoreTargetConfig() 仍会在其后再查一次
      // manageStoreProfile 兜底纠正（如缓存的 orgType 尚未跟上门店最新编辑），
      // 但首屏这里已经是权威值，不再是"先猜后纠正"的临时态
      const orgType = (cached as any).orgType || '';
      // 🐛 根因修复：见 utils/viewModePreview.ts resolveDisplayViewMode 注释——
      // normalizedRole 是已经过 storageRole 融合后的最终生效角色，不是 getPreviewViewMode()
      // 那份独立、可能过期的预览态，两者对不上时 Banner/切换卡片会显示错误的视角文案
      const currentViewMode = resolveDisplayViewMode(normalizedRole);

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
        isPlatformAdmin: isPlatformAdmin,
        isFamily: isFamily,
        showNewUserGuide: isFamily && !storeId,
        orgType: orgType,
        currentViewMode,
        currentViewModeLabel: PREVIEW_VIEW_MODE_LABELS[currentViewMode],
        currentStoreName: storeName,
        currentStoreId: storeId
      });
      // 🌐 自动续接工作空间：账号已有明确归属（真实门店 orgType）时，跳过"工作
      // 空间选择"首页，直接落地到对应专区——见 autoResumeWorkspaceMode 注释
      this.autoResumeWorkspaceMode(orgType, isSuperAdmin, isPlatformAdmin);
      // 🏷️ 按 orgType 立即更新默认标签（无需等待云函数，让表单文案秒显）
      this.loadStoreTargetConfig();

      syncStorePicker(storeId, storeName, rawRole);

      if (flags.canAuditUser && cached.storeId) {
        this.fetchPendingAuditCount(cached.storeId);
      }
      // 🐛 二次修复：canSwitchStore 只对 super_admin 为 true，此前普通店长
      // （isManager 但不是 isSuperAdmin）尚未绑定具体门店时，"该机构已有 N 家门店"
      // 空态卡片依赖的 allStoresList 永远不会被拉取（一直是空数组），导致哪怕机构下
      // 其实已有门店，卡片也误判成"机构一家门店都没有"，错误引导去创建新店而不是
      // 选择已有门店。这里额外补上"isManager 且尚未绑定门店"这条路径，与
      // canSwitchStore 并列，确保空态卡片能看到真实的机构门店列表
      if (flags.canSwitchStore || (isManager && !storeId)) {
        this.fetchAllStoresList();
      }
    }

    const result = await AuthService.fetchUserRole();
    if (result.success && result.roleInfo) {
      const info = result.roleInfo;
      // 🐛 同一口径：checkUserRole 云函数返回的服务端权威角色也不能反过来把手动切换的
      // storageRole 冲掉——否则冷启动时先用 cachedRole 正确渲染了 store_manager 视角，
      // 几百毫秒后这个异步 fetchUserRole 结果一落地又会用服务端主角色把它悄悄改回
      // super_admin，形成竞态：谁最后 setData 谁说了算，而不是谁应该说了算
      const effectiveRawRole = AuthService.resolveEffectiveRole(info.role);
      const { rawRole, normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin, isPatriarch, flags, displayRole, isRealSuperAdmin, isPlatformAdmin, isFamily } = computeRoleState(effectiveRawRole, info.status);
      const storeName = info.storeName || '';
      const storeId = info.storeId || '';
      const tenantId = (info as any).tenantId || '';
      // 🌸 同上一处 cached 分支注释：orgType 权威口径来自 checkUserRole 下发的
      // stores.orgType 真实值，不再用 tenantId 前缀猜
      const orgType = (info as any).orgType || '';
      // 🐛 根因修复：同上一处 cached 分支，见 resolveDisplayViewMode 注释
      const currentViewMode = resolveDisplayViewMode(normalizedRole);

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
        isPlatformAdmin: isPlatformAdmin,
        isFamily: isFamily,
        showNewUserGuide: isFamily && !storeId,
        orgType: orgType,
        currentViewMode,
        currentViewModeLabel: PREVIEW_VIEW_MODE_LABELS[currentViewMode],
        currentStoreName: storeName,
        currentStoreId: storeId
      });
      // 🌐 自动续接工作空间：服务端权威角色落地后再校正一次——万一上面 cached
      // 分支用的是过期的本地角色缓存（orgType 与服务端最新值不一致），这里用
      // 权威值重新判定/纠正，见 autoResumeWorkspaceMode 注释
      this.autoResumeWorkspaceMode(orgType, isSuperAdmin, isPlatformAdmin);
      // 🏷️ 服务端权威角色落地后重新加载标签（含自定义 serviceTargetConfig 覆盖）
      this.loadStoreTargetConfig();

      syncStorePicker(storeId, storeName, rawRole);

      if (flags.canAuditUser && info.storeId) {
        this.fetchPendingAuditCount(info.storeId);
      }
      // 🐛 同上一处 cached 分支注释：服务端权威角色落地后同样要按这条并列条件补拉
      // allStoresList，否则店长账号首次冷启动（无本地 cached 角色，只有这条权威路径
      // 会执行）依旧看不到机构已有门店列表
      if (flags.canSwitchStore || (isManager && !storeId)) {
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

  // 🐛 根因修复（getStoreList 调用超时）：initCurrentUserRole() 里 cached
  // 分支（本地角色缓存，冷启动同步先行渲染一遍）与 fetchUserRole 权威分支
  // （服务端角色落地后再渲染一遍）在满足同一个条件（canSwitchStore ||
  // isManager && !storeId）时，各自独立调用了一次 fetchAllStoresList()——
  // 同一次 onLoad 里 getStoreList 云函数被并发触发两次，恰恰是页面刚冷启动、
  // 云函数容器最容易处于冷启动状态的时刻，两次并发请求互相抢占网络/云端
  // 并发资源，使原本单次调用能在 8s 超时阈值内跑完的请求因排队而更容易撞线，
  // 正是 "[fetchAllStoresList] 查询失败: ...getStoreList 调用超时" 的根因。
  // 用一个按专区（zoneKey）区分的进行中 Promise 做去重：同一专区的第二次
  // 调用直接复用第一次仍未完成的 Promise，不重复发起云函数调用；专区不同
  // （理论上可能发生，如两次调用之间 currentPlatformMode 被权威角色信息
  // 纠正过）则视为独立请求，各自正常发起
  async fetchAllStoresList() {
    const zoneKey = this.data.currentPlatformMode || 'default';
    const inFlight = this._fetchAllStoresListInFlight;
    if (inFlight && inFlight.zoneKey === zoneKey) {
      return inFlight.promise;
    }
    const promise = this._doFetchAllStoresList(zoneKey);
    this._fetchAllStoresListInFlight = { zoneKey, promise };
    try {
      await promise;
    } finally {
      if (this._fetchAllStoresListInFlight && this._fetchAllStoresListInFlight.promise === promise) {
        this._fetchAllStoresListInFlight = null;
      }
    }
  },

  async _doFetchAllStoresList(zoneKey: string) {
    try {
      // 🐛 Bug 修复：缓存 key 按当前专区（currentPlatformMode）区分——此前是
      // 一把全局共享的缓存，超管在雨花专区拉取过一次列表后，5 分钟内切到通用
      // 专区会直接复用这份缓存，展示的仍是雨花专区的门店（或反之）。现在两个
      // 专区各自独立缓存，互不覆盖，也就不存在"缓存跨专区污染"的窗口期
      const cacheKey = `all_stores_list_cache_${zoneKey}`;
      const cacheTimeKey = `all_stores_list_cache_time_${zoneKey}`;

      // 优先读取本地缓存（有效期5分钟）
      // 🐛 修复 WXML 层 "Cannot read property '0' of undefined" 崩溃根因：
      // allStoresList 直接绑定 <picker range="{{allStoresList}}">（超管切店下拉框），
      // 此前这里对本地缓存 JSON.parse 的结果没做 Array.isArray 校验就直接 setData——
      // 一旦缓存内容损坏/被旧版本写成非数组（如意外存成 "{}"/"null"），parse 本身
      // 不报错，但 picker 拿到非数组 range 就会在原生渲染层踩空索引崩溃。缓存非法时
      // 不 return，直接落到下面走云端查询重新校准
      const cached = wx.getStorageSync(cacheKey);
      const cacheTime = wx.getStorageSync(cacheTimeKey);
      if (cached && cacheTime && (Date.now() - cacheTime) < 300000) {
        try {
          const parsedCache = JSON.parse(cached);
          if (Array.isArray(parsedCache)) {
            this.setData({ allStoresList: parsedCache });
            this.maybeAutoSelectStore(parsedCache);
            return;
          }
          console.warn('[fetchAllStoresList] 本地缓存内容不是数组，丢弃并改走云端查询');
        } catch (parseErr) {
          console.warn('[fetchAllStoresList] 本地缓存解析失败，丢弃并改走云端查询:', parseErr);
        }
      }

      // 🏢 多租户边界：门店列表通过云函数按调用者所属机构过滤后返回，
      // 不再由前端直接全表查询 stores 集合（避免跨机构看到彼此的门店名单）。
      // 🐛 Bug 修复：按当前专区透传 orgType——在 tenantId 过滤基础上叠加
      // orgType 精确匹配，防止 tenantId 名下混入的跨专区历史脏数据（如
      // "嵩屿街道敬老中心助餐点"挂在雨花斋默认全国机构下）一起被带出来
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const orgTypeFilter = zoneKey === 'yuhua' ? 'yuhuazhai' : (zoneKey === 'general' ? 'general' : '');
      const callArgs = orgTypeFilter ? { orgType: orgTypeFilter } : {};
      // 🐛 冷启动兜底：即使上面的并发去重已经消灭了"同一次 onLoad 打两枪"这个
      // 主要诱因，页面首次冷启动时云函数容器本身仍可能恰好处于冷启动状态、
      // 单次调用就逼近甚至超过 8s——冷启动几乎总是"一次性税"，紧接着的第二次
      // 调用会打在已经预热好的容器上，通常几百毫秒内返回。超时后不直接放弃，
      // 静默重试一次，仍失败才落到下面的 catch 分支
      let cloudRes;
      try {
        cloudRes = await callFunctionWithTimeout({ name: 'getStoreList', data: callArgs });
      } catch (timeoutErr) {
        console.warn('[fetchAllStoresList] 首次调用超时/失败，重试一次:', timeoutErr);
        cloudRes = await callFunctionWithTimeout({ name: 'getStoreList', data: callArgs });
      }
      const cloudResult = cloudRes.result as any;
      // 🐛 与上面缓存读取路径同一处根因、对称补齐防护：这条云端查询路径此前只信
      // `cloudResult.list || []`，只挡了 list 缺失/为 null 的情况，没校验它"是
      // 数组"——一旦云函数在某些异常响应形状下把 list 返回成非数组的真值（例如
      // 对象），这里会原样 setData 进 allStoresList，而它直接绑定
      // `<picker range="{{allStoresList}}">`，原生渲染层拿到非数组 range 就会
      // 踩空索引崩溃，报错正是 "Cannot read property '0' of undefined"——与本文件
      // 上方缓存分支注释记录的历史崩溃是同一个根因、只是换了数据来源触发
      const rawList = (cloudResult && cloudResult.success) ? cloudResult.list : null;
      const list = Array.isArray(rawList) ? rawList : [];
      this.setData({ allStoresList: list });
      this.maybeAutoSelectStore(list);

      // 缓存到本地（按专区区分的 key）
      wx.setStorageSync(cacheKey, JSON.stringify(list));
      wx.setStorageSync(cacheTimeKey, Date.now());
    } catch (e) {
      console.error('[fetchAllStoresList] 查询失败:', e);
    }
  },

  // 🐛 根因修复："机构已有门店，账号自己没绑定"场景下，此前工作台会一直卡在
  // "该机构已有 N 家门店"空态卡片，必须用户手动点开选择器才能进入——机构下明明
  // 已有门店（甚至只有一家）时，这一步手动确认几乎总是多余的。这里在 allStoresList
  // 每次刷新后自动补一次默认选中：优先复用 getSelectedStore() 记录的"上次访问门店"
  // （前提是它仍在本次列表里，避免选中已被停用/跨专区的旧门店），否则退化为列表
  // 第一家。仅当账号尚未绑定具体门店（currentStoreId 为空）且视角是店长/超管
  // （isManager || isSuperAdmin，义工/家人的"全部门店"虚拟视图不受影响）时才生效，
  // 与手动点击"选择门店"复用同一条 switchStoreTarget 落地逻辑，不重复实现一遍。
  // 🐛 二次修复："启动自动弹 Toast 遮挡"+"专区选择状态污染"：
  // - 超管账号 autoResumeWorkspaceMode() 会显式跳过自动进专区（见该方法注释），
  //   刻意停留在中立的【选择工作空间】首页等用户手选雨花/通用专区——但此前这里
  //   不看 currentPlatformMode，一旦 fetchAllStoresList() 早于选专区触发（超管
  //   canSwitchStore 恒为 true），就会用尚未按专区收窄的全量跨专区门店列表
  //   （orgTypeFilter 此时是空字符串）自动选中第一家/上次访问门店（如"嵩屿"这类
  //   历史脏数据），在工作空间选择页正中央弹出阻塞式 Toast，还把不属于任何专区的
  //   门店提前污染进 currentStoreId。现在必须已经落地到具体专区
  //  （currentPlatformMode 非空）才允许自动选店。
  // - switchStoreTarget 改为静默调用（不弹全局 Toast）——当前选中站点名称本就会
  //   实时展示在工作台顶部 store-picker 胶囊里，不需要额外的阻塞式提示打断视线。
  maybeAutoSelectStore(list: any[]) {
    const { currentPlatformMode, currentStoreId, isVolunteer, isFamily, isManager, isSuperAdmin } = this.data;
    // 🛡️ 仍在【选择工作空间】中立首页（尚未点雨花/通用专区卡片）时，绝不自动
    // 选店/弹提示——门店激活必须下沉到用户实际进入的具体专区内才发生
    if (!currentPlatformMode) return;
    if (currentStoreId || isVolunteer || isFamily || !(isManager || isSuperAdmin)) return;
    if (!Array.isArray(list) || list.length === 0) return;

    const lastSelected = getSelectedStore();
    const lastStoreId = lastSelected && lastSelected.storeId;
    const matched = lastStoreId ? list.find((s: any) => s.storeId === lastStoreId) : null;
    // 🐛 专区状态污染清理：本地缓存的"上次访问门店"如果不在当前专区收窄后的
    // 列表里，说明它是切专区前（或旧版本遗留）的跨专区脏缓存，直接清掉，避免
    // 之后其它读取 getSelectedStore() 的地方继续展示这个已经不属于当前专区的
    // 门店名，而不是放任它悬在本地存储里"看似有效"
    if (lastStoreId && !matched) {
      clearSelectedStoreCache();
    }
    const target = matched || list[0];
    if (target && target.storeId) {
      this.switchStoreTarget(target.storeId, target.storeName, { silent: true });
    }
  },

  async fetchStoreSponsor(storeId: string) {
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      const res = await callFunctionWithTimeout({
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
      const res = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(e);
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
      const res = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(e);
      this.setData({ todayActivity: null, todayActivityLoaded: true, todayActivitySourceId: '' });
    }
  },

  // 🏷️ 服务受众标签：在角色与 storeId 解析完成后，从 manageStoreProfile 加载
  // serviceTargetConfig.targetLabels，用于驱动首页填报表单的文案自适应。
  // 优先使用 DB 中保存的自定义标签，退回 ORG_TYPE_DEFAULT_TARGET_LABELS 默认值，
  // 最终退回 FALLBACK_TARGET_LABELS 通用兜底，三层降级均在本地完成、不影响主流程
  async loadStoreTargetConfig() {
    const storeId = this.data.currentStoreId;
    const orgType = this.data.orgType;
    // 先用 orgType 默认值立即渲染（无需等待云函数）
    const defaultLabels = ORG_TYPE_DEFAULT_TARGET_LABELS[orgType] || FALLBACK_TARGET_LABELS;
    this.setData({ storeTargetLabels: defaultLabels });

    if (!storeId || !isCloudAvailable()) return;
    try {
      const res = await callFunctionWithTimeout({
        name: 'manageStoreProfile',
        data: { action: 'get', storeId }
      });
      const result = res.result as any;
      if (!result || !result.success) return;

      // 🌟 真实机构类型覆盖：initCurrentUserRole() 里只能靠 tenantId 前缀猜出粗粒度的
      // 'yuhuazhai'/'generic' 兜底值（见该方法内两处 orgType 赋值），这里复用同一次
      // manageStoreProfile 查询（不新增网络请求）拿到 stores.orgType 真实值后立即覆盖，
      // 才能精确识别 elderly_canteen（社区助餐）等具体机构类型，而不是笼统的"generic"。
      // orgTypeBadge 与 profile.ts computeOrgDisplayCopy 同一套措辞口径，不臆造新类型
      const realOrgType = result.data && result.data.orgType;
      if (realOrgType) {
        this.setData({
          orgType: realOrgType,
          orgTypeBadge: realOrgType === 'yuhuazhai' ? '雨花斋' : realOrgType === 'elderly_canteen' ? '社区助餐' : '',
          cultureModalTitle: computeCultureModalTitle(realOrgType)
        });
      }

      // 🆕 门店自定义文化寄语：与「组织信息配置」弹窗（profile.ts orgConfigSlogan1/2）
      // 写入的是同一对字段，供"机构文化与每日家训"弹窗在非雨花斋分支置顶展示——
      // 这是门店自己真实配置的内容，不是编造的通用文案
      this.setData({
        cultureStoreSlogan1: (result.data && result.data.slogan1) || '',
        cultureStoreSlogan2: (result.data && result.data.slogan2) || ''
      });

      // 🍚 按门店配置供餐餐次：复用同一次 manageStoreProfile 查询（不新增网络请求）
      // 拿到 mealConfig.supportedMeals 真实值，驱动打卡弹窗"今日留店用餐"Chip 行、
      // 岗位班次列表的动态适配。已勾选但不再受支持的餐别（如门店从"早午晚"改配置为
      // 仅"午"）要同步从 reservedMeals 里摘掉，避免提交一条门店当前并不支持的留餐记录
      const rawSupportedMeals = result.data && result.data.mealConfig && result.data.mealConfig.supportedMeals;
      const supportedMeals = Array.isArray(rawSupportedMeals) && rawSupportedMeals.length > 0
        ? rawSupportedMeals
        : ['lunch'];
      const reconciledReservedMeals = (this.data.reservedMeals || []).filter((m: string) => supportedMeals.includes(m));
      this.setData({
        supportedMeals,
        reservedMeals: reconciledReservedMeals
      });
      // 门店班次列表按新的 supportedMeals 重新过滤
      this.refreshTodayShiftStatus();

      const stc = result.data && result.data.serviceTargetConfig;
      if (stc && stc.targetLabels) {
        // 自定义标签与默认值合并：只覆盖非空项
        const tl = stc.targetLabels;
        this.setData({
          storeTargetLabels: {
            dineInLabel:   (tl.dineInLabel   && tl.dineInLabel.trim())   || defaultLabels.dineInLabel,
            deliveryLabel: (tl.deliveryLabel && tl.deliveryLabel.trim()) || defaultLabels.deliveryLabel,
            listenLabel:   (tl.listenLabel   && tl.listenLabel.trim())   || defaultLabels.listenLabel,
            takeoutLabel:  (tl.takeoutLabel  && tl.takeoutLabel.trim())  || defaultLabels.takeoutLabel
          }
        });
      }
    } catch (e) {
      console.warn('[loadStoreTargetConfig] 加载服务受众标签失败，使用默认值:', e);
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
      const res = await callFunctionWithTimeout({
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
      reportCloudSdkErrorIfCorrupted(e);
    }
  },

  onGotoDailyMenu() {
    safeNavigateTo({ url: '/subpackages/admin/pages/daily-menu/daily-menu' });
  },

  onGotoActivityLog() {
    safeNavigateTo({ url: '/subpackages/admin/pages/activity-log/activity-log' });
  },

  onGotoStoreManagement() {
    safeNavigateTo({ url: '/subpackages/admin/pages/store-management/store-management' });
  },

  // 🏢 空状态引导升级：机构其实已有门店（allStoresList.length > 0，只是当前
  // 账号自己还没绑定/选定其中一家）时，"创建首家门店"这个文案与操作都文不对
  // 题——用户要做的不是新建一家，而是从已有门店里挑一家。直接唤起 store-picker
  // 组件自带的选择弹窗，复用同一套"选择服务站点与身份"流程，不新增页面
  onOpenStorePickerFromEmptyState() {
    const picker = this.selectComponent('#storePicker');
    if (picker && typeof picker.onOpenSheet === 'function') {
      picker.onOpenSheet();
    }
  },

  // 🏢 空状态引导升级：机构确实一家门店都没有时，除了"创建首家门店"，也可能是
  // 用户点错了专区卡片（如以为自己是雨花斋，其实账号归属通用商户体系）——补上
  // "切换其它专区"按钮，一步直接跳到另一个专区（复用两张工作空间卡片各自
  // 已有的入口方法，超管无条件放行，不会被拦），而不是被晾在一个死胡同状态里
  onSwitchToOtherZoneFromEmptyState() {
    if (this.data.currentPlatformMode === 'yuhua') {
      this.onSelectGeneralPlatform();
    } else {
      this.onSelectYuhuaPlatform();
    }
  },

  // ================= 🍽️ 首页快捷发布：今日菜单 =================

  // 🐛 修复"明明已选定具体门店却误触发 Toast"：this.data.currentStoreId 在角色初始化的
  // 缓存回填路径中（onLoad 里 cached.storeId || ''）可能滞后为空，而 currentStoreName 早已
  // 显示为具体门店名（如"海沧区雨花斋"，来自 shopName 的默认值），导致用户看着明明选了店却被拦。
  // 这里在页面 state 为空/national 时，再回退读取全局持久化的门店选择作为兜底，尽量还原真实选择。
  // 🐛 真机防御：currentStoreId 理论上是 string，但历史缓存格式变更/组件事件透传
  // 不规范等情况下，真机上观察到过它被意外写成 { storeId: 'all', ... } 这样的
  // 对象、或 undefined/null——'{}' 之类的非法值直接参与 === 'all' / includes()
  // 比较时既不等于任何 NATIONAL_IDS 字符串，又是 truthy，会被 resolveEffectiveStoreId
  // 误判成"一个合法的具体门店 ID"直接放行，全国总览的拦截形同虚设。这里统一做
  // 字符串强转：字符串原样返回；对象类型尝试取其 storeId/id 字段；其余一律归空
  _coerceToStoreIdString(value: any): string {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
      if (typeof value.storeId === 'string') return value.storeId.trim();
      if (typeof value.id === 'string') return value.id.trim();
    }
    return '';
  },

  _coerceToStoreNameString(value: any): string {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && typeof value.storeName === 'string') {
      return value.storeName.trim();
    }
    return '';
  },

  resolveEffectiveStoreId(): string {
    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];
    const stateId = this._coerceToStoreIdString(this.data.currentStoreId);
    if (stateId && !NATIONAL_IDS.includes(stateId)) {
      return stateId;
    }

    const storedRaw = wx.getStorageSync('current_store_id') || wx.getStorageSync('active_store_id') || '';
    const stored = this._coerceToStoreIdString(storedRaw);
    if (stored && !NATIONAL_IDS.includes(stored)) {
      // 🔧 回填页面 state，避免后续图片上传路径/提交表单等仍引用滞后的空 currentStoreId
      this.setData({ currentStoreId: stored });
      return stored;
    }

    try {
      const selected = getSelectedStore();
      const selectedStoreId = selected ? this._coerceToStoreIdString(selected.storeId) : '';
      if (selectedStoreId && !NATIONAL_IDS.includes(selectedStoreId)) {
        this.setData({
          currentStoreId: selectedStoreId,
          currentStoreName: selected.storeName || this.data.currentStoreName
        });
        return selectedStoreId;
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
    callFunctionWithTimeout({
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
      callFunctionWithTimeout({
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
      const res = await callFunctionWithTimeout({
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
    callFunctionWithTimeout({
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
          const result = await callFunctionWithTimeout({
            name: 'manageDraftLock',
            data: {
              action: 'FORCE_RELEASE',
              storeId: storeId,
              reportDate: reportDate
            }
          });
          if ((result.result as any) && (result.result as any).success) {
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
    clearAllStoresListCache();
    this.fetchAllStoresList();
  },

  onStoreChanged(e: any) {
    const detail = e.detail || {};
    const rawRole = (detail.role || detail.currentRole || wx.getStorageSync('active_role') || 'VOLUNTEER').toUpperCase();
    const storeName = detail.storeName || detail.name || this.data.currentStoreName || '';
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

    // 🌟 切店全局持久化：同步 storeId / storeName / role 到本地存储，统一走
    // storeManager.ts 的 setCurrentActiveStore()——与 switchStoreTarget()/
    // store-picker.ts _persistStoreSelection 共用同一份 canonical key 写入逻辑，
    // 不再各自维护一份可能遗漏 key 的实现（见该函数注释）。
    // 🛡️ 这里必须持久化真实的 normalizedRole，绝不能写入视角切换预览后的展示角色，
    // 否则下次启动会把"店长视角预览"误当成真实身份，永久丢失超管权限。
    setCurrentActiveStore(storeId, storeName, normalizedRole);

    const isAllStoresView = storeId === 'national_overview' || storeId === 'ALL_STORES';
    // 🐛 根因修复：与 refreshUserRoleView 同一个坑——isSuperAdmin 这里是从"切换/预览
    // 目标角色"（store-picker 胶囊点击传来的 rawRole）算出来的，超管切到店长/义工
    // 视角时会被降级为 false，不能直接拿来当"真实身份"用。改用服务端已核验角色缓存
    // 直接判断，不受本次切店/切视角动作影响
    const cachedRoleForRealAdmin = AuthService.getCachedRoleInfo();
    const isRealSuperAdmin = !!(cachedRoleForRealAdmin && cachedRoleForRealAdmin.role === 'super_admin' && cachedRoleForRealAdmin.status === 'approved');
    const overridden = applyRoleViewOverride(normalizedRole, {
      currentUserRole: normalizedRole, isVolunteer, isManager, isFinance, isSuperAdmin, isFamily
    });
    // 🐛 根因修复：见 utils/viewModePreview.ts resolveDisplayViewMode 注释——本次是
    // store-picker 手动切换身份（normalizedRole 就是这次切换的目标角色），Banner/
    // 管理视角切换卡片的文案必须跟着这次切换走，而不是继续读一份跟这次操作无关的
    // 独立预览态
    const currentViewMode = resolveDisplayViewMode(normalizedRole);

    this.setData({
      currentStoreId: storeId,
      currentStoreName: storeName,
      // 🔑 关键修复：同步更新 shopName 字段，确保 loadBalanceForDate 等函数使用新门店名
      shopName: storeName,
      currentRole: rawRole,
      currentUserRole: overridden.currentUserRole,
      isRealSuperAdmin: isRealSuperAdmin,
      currentViewMode,
      currentViewModeLabel: PREVIEW_VIEW_MODE_LABELS[currentViewMode],
      isAllStoresView: isAllStoresView,
      isVolunteer: overridden.isVolunteer,
      isManager: overridden.isManager,
      isFinance: overridden.isFinance,
      isSuperAdmin: overridden.isSuperAdmin,
      isPatriarch: isPatriarch,
      isFamily: overridden.isFamily,
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
    // 🌸 切店后同步刷新真实 orgType（此前 onStoreChanged 完全没有重新解析这个字段，
    // 切店后 orgType/orgTypeBadge 会一直沿用切店前的旧值）；解析完成后顺带校准
    // currentPlatformMode——切店有可能跨平台（如超管从社区食堂门店切到雨花斋门店），
    // 避免"人已经在雨花门店里，模式牌子却还挂着通用"的错乱状态
    this.loadStoreTargetConfig().then(() => this.reconcilePlatformModeWithOrgType());

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

  // 🐛 新增 silent 选项：maybeAutoSelectStore() 的自动选店不是用户主动点击的操作，
  // 不该弹全局 Toast 打断视线（当前选中站点本就会实时展示在工作台顶部 store-picker
  // 胶囊里）——手动切店（如 onTemplateStorePickerChange 里的用户下拉选择）仍保留
  // Toast 反馈
  switchStoreTarget(storeId: string, storeName: string, options?: { silent?: boolean }) {
    this.setData({
      currentStoreId: storeId,
      currentStoreName: storeName,
      // 🔑 与 onStoreChanged 对齐：shopName 是餐报提交/余额查询实际读取的字段，
      // 必须跟随 currentStoreName 同步，否则会继续沿用切店前的门店名
      shopName: storeName
    });

    // 🐛 根因修复："首页显示门店 A，切到个人中心却显示门店 B"：此前这里只调用
    // setSelectedStore()，只写了 legacy 的 selectedStore key，没写
    // current_store_id/current_store_name/active_store_id 这三个 profile.ts
    // initMinePage() 真正按最高优先级读取的 canonical key——门店名 Storage 停留
    // 在上一次真正走过 onStoreChanged 的旧值，两个 Tab 各显示各的。改调用
    // setCurrentActiveStore()（不传 role，不动当前生效身份），一次性写全 canonical
    // key，与 onStoreChanged/store-picker.ts _persistStoreSelection 共用同一份
    // 持久化逻辑，见 storeManager.ts 注释
    setCurrentActiveStore(storeId, storeName);

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

    if (!options || !options.silent) {
      wx.showToast({
        title: `当前门店：${storeName}`,
        icon: 'success'
      });
    }
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
    safeNavigateTo({
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

  // 🌐 新用户引导：点击"创建组织"跳到个人页——profile.ts 的 initMinePage 会检测到
  // isFamily+无门店状态并自动弹出入驻弹窗（真正调用 createTenant 云函数创建全新
  // 机构的地方，与 showApplyModal 的"新建门店"Tab 是两回事：后者要求申请人已归属
  // 某个既有机构，全新用户走这条会被 submitRoleApply 拒绝并提示 needsOnboarding，
  // 见该云函数 isCustom 分支注释），本入口维持原有跳转，不接入 openStorePickerForJoin
  onNewUserGoCreate() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },
  // 🐛 UX 重构：「加入现有爱心站点」此前只是跳个人页等着 profile.ts 弹出邀请码
  // 输入框，用户没法直接从列表里挑选站点。现改为直接在首页唤起"选择服务站点"
  // 弹窗（与 Bug 1 的 onSelectYuhuaPlatform 共用 openStorePickerForJoin），按当前
  // 所在工作空间过滤门店范围——雨花专区内只看雨花斋门店，通用专区内只看非雨花
  // 斋门店，选中后走既有"选择已有门店"申请路径（以家人/义工身份打卡）
  onNewUserGoJoin() {
    const isYuhua = this.data.currentPlatformMode === 'yuhua';
    this.openStorePickerForJoin(isYuhua ? 'yuhuazhai' : 'general', isYuhua ? '选择雨花斋服务站点' : '选择服务站点');
  },

  // 📋 表单折叠：展开/收起次要录入项（支出/凭证/食谱照片/门店日志）
  onToggleFormExtra() {
    this.setData({ showFormExtra: !this.data.showFormExtra });
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
      case 'switchStore':
        this.onDrawerSwitchStore();
        break;
      case 'scan':
        this.onDrawerScanCode();
        break;
      case 'storeQrCode':
        this.onOpenPromoActionSheet();
        break;
      case 'sunshineLedger':
        this.onGoToSunshineBoard();
        break;
      case 'journey':
        safeNavigateTo({ url: '/subpackages/admin/pages/journey/journey' });
        break;
      case 'refreshCache':
        this.onDrawerRefreshStateCache();
        break;
      case 'feedback':
        safeNavigateTo({ url: '/pages/profile/profile?openFeedback=1' });
        break;
      default:
        break;
    }
  },

  // 🌟 抽屉「切换门店」：复用首页顶部 store-picker 组件自己的选店弹窗
  // （onOpenSheet 已经做好门店列表拉取/搜索/切换落地全套逻辑），不新造一套
  onDrawerSwitchStore() {
    const picker = this.selectComponent('#storePicker');
    if (picker && typeof picker.onOpenSheet === 'function') {
      picker.onOpenSheet();
    } else {
      wx.showToast({ title: '选店组件未就绪，请重试', icon: 'none' });
    }
  },

  // 🌟 抽屉「扫一扫」：用于扫本小程序自己生成的各类二维码（打卡分享码/验真码/
  // 门店邀请码等，见 getStoreQRCode 云函数）。这些码都是标准小程序码，
  // wx.scanCode 扫描后会在 res.path 里直接给出目标页面路径+参数，不需要
  // 自己解析 scene 编码规则——直接原样跳转即可，一套入口覆盖"核销/打卡"
  // 等各类场景。扫到非本小程序码（res.path 为空）时如实提示，不假装处理成功
  onDrawerScanCode() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res: any) => {
        if (res && res.path) {
          safeNavigateTo({
            url: '/' + res.path.replace(/^\/+/, ''),
            fail: () => {
              wx.showToast({ title: '无法打开扫码结果对应的页面', icon: 'none' });
            }
          });
        } else {
          wx.showModal({
            title: '扫码结果',
            content: (res && res.result) || '未识别到有效内容',
            showCancel: false
          });
        }
      },
      fail: (err: any) => {
        // 用户主动取消扫码不算错误，不弹提示打扰
        if (err && err.errMsg && err.errMsg.includes('cancel')) return;
        wx.showToast({ title: '扫码失败，请重试', icon: 'none' });
      }
    });
  },

  // 🌟 抽屉「刷新状态缓存」：一键重新拉取服务端权威角色/权限（AuthService.
  // fetchUserRole）+ 清空门店列表本地缓存 + 重新加载首页动态数据（今日食谱/
  // 动态/公告/物资状态等"流水"），用于账号权限刚被调整、或怀疑本地缓存与
  // 服务端不一致时手动兜底，不需要退出重登
  async onDrawerRefreshStateCache() {
    wx.showLoading({ title: '刷新中...', mask: true });
    try {
      await AuthService.fetchUserRole();
      clearAllStoresListCache();
      this.refreshUserRoleView();
      this.loadHomeDynamicData();
      wx.hideLoading();
      wx.showToast({ title: '已刷新最新状态', icon: 'success' });
    } catch (err) {
      console.warn('[onDrawerRefreshStateCache] 刷新失败:', err);
      wx.hideLoading();
      wx.showToast({ title: '刷新失败，请检查网络后重试', icon: 'none' });
    }
  },

  // 🦻 关怀模式开关：side-drawer 只负责 UI 呈现与事件转发（见该组件头部注释），
  // 实际持久化落在宿主页——写 app.globalData 供其余页面（阶段一暂未接入，但
  // 保留接口）读取，wx.setStorageSync 落本地供下次冷启动 onLaunch 回填
  onToggleCareMode(e: any) {
    const value = !!(e.detail && e.detail.value);
    const app = getApp() as any;
    if (app && app.globalData) {
      app.globalData.careMode = value;
    }
    wx.setStorageSync('care_mode', value);
    this.setData({ careMode: value });
  },

  // 🛡️ 义工绑定审核弹窗的空状态入口专用：全国总览视角下不允许生成海报（见
  // onGenerateStorePoster 内的统一拦截），这里单纯是个语义化别名，不用重复判断
  onGenerateStorePosterFromAudit() {
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
  // 🏛️ 权限层级重构后，超管/大家长/店长三档都能生成"门店财务"邀请码了（见
  // onOpenGenCodeModal 的 genAvailableRoles），不再是超管专属——这里直接按
  // onOpenGenCodeModal 刚算出来的 genAvailableRoles 判断能不能预填 FINANCE，
  // 而不是写死只认 isSuperAdmin，避免权限模型改了这里忘记同步
  onOpenFinanceInviteMenu() {
    this.onOpenGenCodeModal();
    if (this.data.genAvailableRoles.includes('FINANCE')) {
      this.setData({ genTargetRole: 'FINANCE' });
    }
  },

  // 🐛 门店二维码本地缓存 key：按 storeId 区分，同一门店的邀请二维码内容固定
  // 不变（getStoreQRCode 的 scene 固定编码为 s=storeId），没有随时间失效的必要
  _storeQrCacheKey(storeId: string): string {
    return `store_qr_cache_${storeId}`;
  },

  _readStoreQrCache(storeId: string): { fileID?: string; tempFilePath?: string } | null {
    try {
      const cache = wx.getStorageSync(this._storeQrCacheKey(storeId));
      return cache && typeof cache === 'object' ? cache : null;
    } catch (e) {
      return null;
    }
  },

  _writeStoreQrCache(storeId: string, data: { fileID?: string; tempFilePath?: string }) {
    try {
      wx.setStorageSync(this._storeQrCacheKey(storeId), { ...data, cachedAt: Date.now() });
    } catch (e) {
      // 本地存储写入失败（容量满/隐私模式）不影响本次已经拿到手的二维码，静默忽略
      console.warn('[onGenerateStorePoster] 二维码本地缓存写入失败:', e);
    }
  },

  // 🐛 兼容强化：正常路径是云函数返回 fileID（cloud:// 云存储路径），必须走
  // wx.cloud.downloadFile 换成本地 tempFilePath 才能喂给离屏 canvas 的
  // createImage()。这里额外兼容云函数未来改为直接返回 base64/dataURL 的情况，
  // 用 wx.getFileSystemManager().writeFileSync 落一份本地临时文件
  _writeBase64ToTempFile(base64OrDataUrl: string): string {
    const base64Data = base64OrDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const filePath = `${wx.env.USER_DATA_PATH}/store_qr_${Date.now()}.png`;
    // 🐛 根因修复：此前每次调用都用 Date.now() 拼一个全新文件名、从不清理，
    // 长期累积会写满 USER_DATA_PATH 配额。writeLocalFileSafe 内部会在写入
    // 失败时先清理 store_qr_ 前缀的历史临时图再重试一次；调用方（见上方
    // _fetchStoreQrLocalPath）本就套了 try/catch + 重试循环，这里失败时继续
    // 抛出，交由既有的降级链路处理，不需要在这里另外兜底
    const ok = writeLocalFileSafe(filePath, base64Data, 'base64', 'store_qr_');
    if (!ok) throw new Error('本地二维码临时文件写入失败');
    return filePath;
  },

  // 🐛 真机 Bug 修复 + 重试兜底：getStoreQRCode 云函数返回的 fileID 是 cloud://
  // 路径，必须走 wx.cloud.downloadFile 换成本地 tempFilePath 才能喂给离屏 canvas
  // 的 createImage()——开发者工具模拟器对 cloud:// 有一定兼容降级容易掩盖问题，
  // 真机上 downloadFile 缺失/网络抖动会直接导致二维码区域空白。
  //
  // 🐛 超时阈值：callFunction 内部要串行跑「查 user_roles 鉴权 → 调用微信
  // openapi wxacode.getUnlimited 生成码 → cloud.uploadFile 上传」，其中
  // wxacode.getUnlimited 是跨公众平台服务器的调用，真机移动网络下叠加云函数
  // 冷启动，10s+ 都是正常范围，单次超时给 15s；downloadFile 原先只给 6s，
  // 实测开发者工具模拟器 + 弱网真机下云存储文件下载偶尔要到 8~10s 才回调，
  // 6s 经常被误判成超时，提到 12s 留足余量；保留 2 次重试，每次尝试的真实
  // 耗时打进日志
  //
  // 🐛 Cache-First：门店二维码内容固定不变，没必要每次打开海报都重新走一遍
  // 最贵的"云函数鉴权 + openapi 生成码 + 上传"全链路。优先读本地缓存的
  // tempFilePath，文件还在（accessSync 不抛）直接秒开；文件被系统回收了但
  // fileID 还在，就跳过最贵的生成步骤，只用 fileID 重新 downloadFile 一次；
  // 两条捷径都走不通才落回完整生成流程
  async _fetchStoreQrLocalPath(storeId: string, storeName: string): Promise<string> {
    // 🐛 【海报调试】真机排查专用：确认传到这一层的 storeId/storeName 是否
    // 仍然是调用方（onGenerateStorePoster）已经强转、校验过的合法字符串
    console.log('【海报调试】当前 storeId:', storeId, 'storeName:', storeName);

    const MAX_ATTEMPTS = 2;
    const CALL_FUNCTION_TIMEOUT_MS = 15000;
    // 🐛 6s 对开发者工具模拟器 + 弱网真机不够用：downloadFile 报过
    // "downloadFile 超时（>6000ms）"，云存储文件下载在这些环境下偶尔要
    // 到 8~10s 才回调，提到 12s 留足余量
    const DOWNLOAD_FILE_TIMEOUT_MS = 12000;
    const cachedRoleInfo = AuthService.getCachedRoleInfo();
    const tenantId = (cachedRoleInfo && cachedRoleInfo.tenantId) || '';

    const cache = this._readStoreQrCache(storeId);
    if (cache && cache.tempFilePath) {
      try {
        wx.getFileSystemManager().accessSync(cache.tempFilePath);
        return cache.tempFilePath;
      } catch (e) {
        console.warn('[onGenerateStorePoster] 二维码本地缓存文件已失效（大概率被系统回收），尝试用缓存 fileID 重新下载:', e);
      }
    }
    if (cache && cache.fileID) {
      try {
        const downRes: any = await withTimeout(
          wx.cloud.downloadFile({ fileID: cache.fileID }),
          DOWNLOAD_FILE_TIMEOUT_MS,
          `downloadFile 超时（>${DOWNLOAD_FILE_TIMEOUT_MS}ms）`
        );
        if (downRes && downRes.tempFilePath) {
          this._writeStoreQrCache(storeId, { fileID: cache.fileID, tempFilePath: downRes.tempFilePath });
          return downRes.tempFilePath;
        }
      } catch (e) {
        console.warn('[onGenerateStorePoster] 用缓存 fileID 重新下载失败，回退到完整生成流程:', e);
      }
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
        const qrRes: any = await callFunctionWithTimeout(
          { name: 'getStoreQRCode', data: { storeId, storeName, tenantId } },
          CALL_FUNCTION_TIMEOUT_MS,
          `getStoreQRCode 调用超时（>${CALL_FUNCTION_TIMEOUT_MS}ms）`
        );
        const qrResult = qrRes && qrRes.result;
        if (!qrResult || !qrResult.success) {
          throw new Error((qrResult && qrResult.error) || 'getStoreQRCode 返回失败');
        }

        let tempFilePath = '';
        if (qrResult.fileID) {
          const downRes: any = await withTimeout(
            wx.cloud.downloadFile({ fileID: qrResult.fileID }),
            DOWNLOAD_FILE_TIMEOUT_MS,
            `downloadFile 超时（>${DOWNLOAD_FILE_TIMEOUT_MS}ms）`
          );
          if (!downRes || !downRes.tempFilePath) {
            throw new Error('downloadFile 未返回 tempFilePath');
          }
          tempFilePath = downRes.tempFilePath;
        } else if (qrResult.base64 || qrResult.dataURL) {
          tempFilePath = this._writeBase64ToTempFile(qrResult.base64 || qrResult.dataURL);
        } else {
          throw new Error('getStoreQRCode 未返回有效的 fileID/base64');
        }

        this._writeStoreQrCache(storeId, { fileID: qrResult.fileID || '', tempFilePath });
        return tempFilePath;
      } catch (err) {
        const elapsedMs = Date.now() - attemptStartedAt;
        console.warn(`[onGenerateStorePoster] 二维码获取失败（第${attempt}/${MAX_ATTEMPTS}次，耗时${elapsedMs}ms）:`, err);
        if (attempt < MAX_ATTEMPTS) {
          this.setData({ storePosterQrRetrying: true });
          await new Promise(resolve => setTimeout(resolve, 600 * attempt));
        }
      }
    }
    // 🛡️ 重试耗尽后返回空字符串，交由 drawStoreInvitationPoster 的圆角占位卡
    // 兜底，不阻断海报其余内容的生成
    return '';
  },

  async onGenerateStorePoster() {
    // 🐛 【海报调试】真机排查专用：无条件打在最前面，不受任何早退分支影响，
    // 方便对照 vConsole 里权限拦截/全国总览拦截到底是哪一步触发的
    console.log('【海报调试】当前 storeId:', this.data.currentStoreId, 'storeName:', this.data.currentStoreName);

    if (!this.data.permissions.canAuditUser) {
      wx.showToast({ title: '仅店长/管理员可生成', icon: 'none' });
      return;
    }

    // 🚨 全国总览强卡口：此前只调用 isNationalOverviewSelected()，而它内部的
    // resolveEffectiveStoreId() 对 this.data.currentStoreId 直接做 === 'all' /
    // NATIONAL_IDS.includes() 比较——真机上如果 currentStoreId 因为历史缓存
    // 格式变更、组件事件透传等原因意外变成 { storeId: 'all' } 这样的对象，
    // 它既不严格等于任何字符串哨兵值，本身又是 truthy，会被直接当成"一个合法
    // 具体门店 ID"放行，全国总览拦截形同虚设。这里不再单纯依赖那一条判断，
    // 而是先把 storeId/storeName 强制转成字符串，再显式枚举所有已知的
    // "全国总览"信号（空值/三个哨兵 ID/门店名精确匹配/门店名包含"全国"），
    // 任意一条命中就立即拦截；最后仍然 OR 上 isNationalOverviewSelected()
    // 的结果兜底，双重保险
    const normalizedStoreId = this._coerceToStoreIdString(this.data.currentStoreId);
    const normalizedStoreName = this._coerceToStoreNameString(this.data.currentStoreName) || this.data.shopName || '';
    const isNationalScope = !normalizedStoreId
      || normalizedStoreId === 'all'
      || normalizedStoreId === 'national_overview'
      || normalizedStoreId === 'ALL_STORES'
      || normalizedStoreName === '全国总览'
      || normalizedStoreName.includes('全国')
      || this.isNationalOverviewSelected();

    if (isNationalScope) {
      console.warn('【海报调试】全国总览拦截命中，终止生成:', { normalizedStoreId, normalizedStoreName });
      wx.showToast({ title: '请先选择具体门店', icon: 'none' });
      return;
    }

    // 🛡️ 防抖：入口按钮无重入守卫时，快速连点会并发跑多份绘制流程，
    // 后一次的 finishDrawing 会把前一次还没画完的状态提前复位，
    // 界面就停在半张画布的"白屏"状态
    if (this.data.isStorePosterDrawing) return;

    // 🐛 此前这里直接写 this.data.currentStoreId || 'store_haicang_001'，一旦
    // currentStoreId 是个 truthy 的非法对象，会绕过上面的拦截把对象原样传下去
    // （拼进云函数 data、拼进本地缓存 key 都会变成 "[object Object]"）。
    // 改用上面已经强制转成字符串、且已确认不是全国总览的 normalizedStoreId
    const storeId = normalizedStoreId || '';
    const storeName = normalizedStoreName || this.data.currentStoreName || this.data.shopName || '';

    // 🐛 体验修复：此前用全局 wx.showLoading 盖住"二维码拉取 + Canvas 绘制"整个
    // 耗时过程，弹窗本身要等二维码拉取完才打开——真机网络慢时用户盯着一个通用
    // 转圈看好几秒（叠加新增的重试逻辑，最长可能到十几秒），看不出到底在做什么。
    // 现在弹窗立即打开，isStorePosterDrawing 驱动的品牌色 Loading 遮罩（同时覆盖
    // 二维码拉取 + Canvas 绘制两个阶段）取代全局 loading
    this.setData({ isStorePosterDrawing: true, showStorePosterModal: true, storePosterTempFilePath: '', storePosterQrFailed: false, storePosterQrRetrying: false });

    // 🐛 根因修复：此前 loading/isStorePosterDrawing 复位分散写在四五个成功/失败
    // 分支里，只要漏掉一条新增的失败路径就会导致 loading 卡死。统一收口到这一个
    // finishDrawing 里，所有分支只负责调用它 + return
    const finishDrawing = (failToastTitle?: string) => {
      this.setData({ isStorePosterDrawing: false });
      if (failToastTitle) {
        // 生成失败时收起弹窗，不留一块空白区域杵在屏幕中间
        this.setData({ showStorePosterModal: false, storePosterTempFilePath: '' });
        wx.showToast({ title: failToastTitle, icon: 'none' });
      }
    };

    try {
      const qrCodeLocalPath = await this._fetchStoreQrLocalPath(storeId, storeName);
      // 🐛 重试兜底 UI：拉取彻底失败（重试耗尽）时先标记出来，海报仍会正常生成
      // （drawStoreInvitationPoster 内部会画圆角占位卡兜底），标记只用于驱动预览
      // 区底部"重新生成二维码"提示条的显隐，不影响本次绘制流程
      this.setData({ storePosterQrFailed: !qrCodeLocalPath });

      setTimeout(() => {
        const query = wx.createSelectorQuery();
        query.select('#storePosterCanvas')
          .fields({ node: true, size: true })
          .exec(async (res) => {
            if (!res[0] || !res[0].node) {
              finishDrawing('Canvas 初始化失败，请重试');
              return;
            }
            const canvas = res[0].node;
            const ctx = canvas.getContext && canvas.getContext('2d');
            if (!ctx) {
              finishDrawing('当前环境不支持海报绘制');
              return;
            }

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

              // 🐛 真机导出空图修复：drawStoreInvitationPoster resolve 只代表最后一条
              // 绘制指令已经发出，不代表原生渲染层已经把整个绘制队列真正刷进 canvas
              // 缓冲区——部分 Android 真机上 wx.canvasToTempFilePath 紧跟着调用会读到
              // 还没刷完的半帧，导出结果是空白或缺角的图。等一个 100ms 宏任务，
              // 给原生层留出把绘制队列落盘到缓冲区的时间，再执行导出
              await new Promise(resolve => setTimeout(resolve, 100));

              wx.canvasToTempFilePath({
                canvas,
                success: (tempRes) => {
                  this.setData({ storePosterTempFilePath: tempRes.tempFilePath });
                  finishDrawing();
                },
                fail: (err) => {
                  console.error('[onGenerateStorePoster] canvasToTempFilePath 失败:', err);
                  finishDrawing('海报生成失败，请重试');
                }
              });
            } catch (drawErr) {
              console.error('[onGenerateStorePoster] 绘制失败:', drawErr);
              finishDrawing('海报绘制失败，请重试');
            }
          });
      }, 300);
    } catch (e) {
      console.error('[onGenerateStorePoster] 异常:', e);
      finishDrawing('海报生成失败，请重试');
    }
  },

  // 🛡️ 防抖：关闭动作本身不发起网络请求，但弹窗关闭瞬间会与仍在进行中的绘制/
  // canvasToTempFilePath 竞态——连续快点关闭按钮可能在 setData 尚未生效前重复
  // 触发，这里用 isStorePosterDrawing 之外单独的时间戳兜底，避免动效重叠
  _lastCloseStorePosterModalAt: 0,
  onCloseStorePosterModal() {
    const now = Date.now();
    if (now - (this._lastCloseStorePosterModalAt || 0) < 400) return;
    this._lastCloseStorePosterModalAt = now;
    this.setData({ showStorePosterModal: false });
  },

  // 🛡️ 门店邀请海报加载失败兜底：storePosterTempFilePath 是本地临时文件路径，
  // 清空后退回 Loading 遮罩态，提示用户重新生成
  onStorePosterLoadError(e: any) {
    console.warn('[onStorePosterLoadError] 门店邀请海报加载失败:', e && e.detail);
    this.setData({ storePosterTempFilePath: '' });
    wx.showToast({ title: '海报加载失败，请重新生成', icon: 'none' });
  },

  // 🆕 分享给微信群和朋友：按钮本身已声明 open-type="share"，点击时小程序会
  // 自动调起 onShareAppMessage 生成转发卡片（见该函数对 showStorePosterModal
  // 场景的专门分支，转发封面直接用刚生成的 storePosterTempFilePath，而不是通用
  // 的 share_cover.png）。这里只做轻量防抖 + 埋点占位，避免快速连点在
  // onShareAppMessage 尚未返回前重复弹出系统转发面板
  _lastSharePosterTapAt: 0,
  onSharePosterToFriends() {
    const now = Date.now();
    if (now - (this._lastSharePosterTapAt || 0) < 800) return;
    this._lastSharePosterTapAt = now;
  },

  // 🐛 二维码重试兜底：_fetchStoreQrLocalPath 重试耗尽（storePosterQrFailed）后，
  // 预览区会露出一条"重新生成二维码"提示条——不单独实现只重画二维码的分支，
  // 直接整张海报重新走一遍 onGenerateStorePoster（本身就带门店/loading 状态判断，
  // 重新生成的成本很低，不值得为这一个失败分支多维护一套局部重绘逻辑）
  _lastRetryStoreQrAt: 0,
  onRetryStoreQr() {
    const now = Date.now();
    if (now - (this._lastRetryStoreQrAt || 0) < 800) return;
    this._lastRetryStoreQrAt = now;
    this.onGenerateStorePoster();
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
    const { reportDate, reportDateValue, yesterdayBalance, allDonations, meritType, otherDonation, expenses, dailyExpenseText, fixedExpenseText, shopName, mpAccount, thankText, slogan1, slogan2, volunteerCount, volunteerHours, diningCount, materialsInput, dineInSeniors, deliverySeniors, dineInVolunteers, deliveryVolunteers, takeawayCount, listeningSeniors } = this.data;

    const draftData = {
      reportDate,
      reportDateValue,
      yesterdayBalance,
      allDonations,
      meritType,
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
      listeningSeniors,
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
        listeningSeniors: draftData.listeningSeniors || '',
        meritType: ((draftData.meritType || (draftData.reportIsAnonymous ? 'yin' : 'yang')) as 'yang' | 'yin'),
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
        listeningSeniors: draftData.listeningSeniors || '',
        meritType: ((draftData.meritType || (draftData.reportIsAnonymous ? 'yin' : 'yang')) as 'yang' | 'yin'),
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
      const res = await callFunctionWithTimeout({ name: 'manageStoreProfile', data: { action: 'get', storeId } });
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
      const res = await callFunctionWithTimeout({
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
    // 🌸 扫码/邀请码这条路径走的是常规"申请加入门店"标题逻辑，清掉可能残留自
    // openStorePickerForJoin（雨花/通用专区选站点）的标题覆盖与 orgType 提示，避免串场
    this.setData({ applyModalTitleOverride: '', 'applyForm.orgTypeHint': '' });
    // 🐛 根因修复：本方法下面三个分支（全国总览哨兵值 / 查询成功 / 查询失败
    // 兜底）殊途同归都会把 showApplyModal 置为 true，统一在分支之前隐藏一次
    // 自定义 tabBar（见 utils/tabBarVisibility.ts 头部注释），不需要在每个
    // setData({showApplyModal:true}) 前各自重复调用
    setTabBarHidden(this, true);
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

    // 🌐 多租户：storeId → storeName 静态映射已移除，云端始终有最新数据
    const storeNameMap: Record<string, string> = {};

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
      const fallbackName = storeNameMap[storeId] || this.data.currentStoreName || this.data.shopName || '';
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

  onApplyAdminKeyInput(e: any) {
    this.setData({ 'applyForm.adminKeyInput': e.detail.value });
  },

  onApplyRegionChange(e: any) {
    this.setData({ 'applyForm.region': e.detail.value });
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

  // 身份卡片点击（apply-role-grid 已从 radio-group/label/radio 改为纯
  // view + bindtap，见 index.wxml 同处注释），从 dataset 读角色而不是
  // e.detail.value
  onApplyRoleCardTap(e: any) {
    const requestedRole = e.currentTarget.dataset.role;
    if (!requestedRole) return;
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
    this.setData({ showApplyModal: false, applyModalTitleOverride: '' });
    setTabBarHidden(this, false);
  },

  async onSubmitRoleApply() {
    if (this.data.isSubmittingApply) return;

    const { storeId, storeName, realName, phone, requestedRole, storeSelectionType, customStoreName, region, address, contactPhone, storePhotos, orgTypeHint, adminKeyInput } = this.data.applyForm;

    // ——— 必填校验（按展示顺序逐项拦截）———
    if (storeSelectionType === 'custom') {
      if (!customStoreName || !customStoreName.trim()) {
        wx.showToast({ title: '请输入门店名称', icon: 'none' });
        return;
      }
      if (!region || !region.length) {
        wx.showToast({ title: '请选择所属地区', icon: 'none' });
        return;
      }
    } else if (!storeId) {
      wx.showToast({ title: '请选择一个门店', icon: 'none' });
      return;
    }
    if (!requestedRole) {
      wx.showToast({ title: '请选择申请身份', icon: 'none' });
      return;
    }
    if (!realName || !realName.trim()) {
      wx.showToast({ title: '请输入真实姓名', icon: 'none' });
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }

    // 🔑 未显式设置密钥时，默认取手机号后 6 位作为门店管理员密钥
    const adminKey = phone.slice(-6);

    this.setData({ isSubmittingApply: true });
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
      const res = await callFunctionWithTimeout({
        name: 'processRoleAudit',
        data: {
          action: 'apply',
          storeId: storeSelectionType === 'custom' ? '' : storeId,
          storeName: displayStoreName,
          storeSelectionType,
          customStoreName: storeSelectionType === 'custom' ? customStoreName.trim() : '',
          region: storeSelectionType === 'custom' ? region : [],
          address: storeSelectionType === 'custom' ? address.trim() : '',
          contactPhone: storeSelectionType === 'custom' ? contactPhone.trim() : '',
          storePhotos: storeSelectionType === 'custom' ? storePhotos : [],
          // 🔐 custom（新建门店）路径沿用手机号后6位自动生成的 adminKey（成为
          // 新店的初始管理密钥）；existing（已有门店）路径改传用户在
          // adminKeyInput 里填的值——目标门店若配置了安全密钥，服务端会据此
          // 校验；未配置则服务端直接跳过校验，空字符串也能通过
          adminKey: storeSelectionType === 'custom' ? adminKey : String(adminKeyInput || '').trim(),
          orgType: storeSelectionType === 'custom' ? (orgTypeHint || '') : '',
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

      this.setData({ showApplyModal: false, applyModalTitleOverride: '' });
      setTabBarHidden(this, false);

      // 🐛 根因修复：义工免审即时生效（result.autoApproved）后，服务端角色/
      // orgType 已经变了，但 this.data.orgType 仍是提交前那份旧值（首屏
      // initCurrentUserRole() 之后再没人刷新过）——onSelectYuhuaPlatform 等
      // 入口只认 this.data.orgType，不认何 wx.setStorageSync 的缓存 key，
      // 用户提交成功后原地再点一次"雨花公益食堂专区"会因为这份过期数据被
      // 误判成"尚未绑定"，重复弹出选站点/申请弹窗。这里复用页面已有的
      // initCurrentUserRole()（内部会先落一次本地缓存、再 await 服务端权威
      // fetchUserRole 校正 orgType 并联动 autoResumeWorkspaceMode），不需要
      // 额外发新的云函数请求或手搓一套本地缓存
      if (result.autoApproved) {
        this.initCurrentUserRole();
      }

      let content: string;
      if (result.autoApproved) {
        content = `您已成功加入【${displayStoreName}】，义工身份即刻生效，可以开始护持啦！`;
      } else if (storeSelectionType === 'custom') {
        const adminKeyHint = requestedRole === 'store_patriarch' ? `\n\n🔑 您的门店管理密钥默认为手机号后6位：${adminKey}，请妥善保管。` : '';
        content = `您已成功申请加入新门店【${displayStoreName}】，待超级管理员审核通过后将自动建店并完成身份审核！${adminKeyHint}`;
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
    } finally {
      this.setData({ isSubmittingApply: false });
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
  // 🐛 根因修复（预览视角污染真实发码权限）：canGenerate/genAvailableRoles/门店
  // 选择器分支此前统一读 this.data.isSuperAdmin——但这个字段会被"视角切换预览"
  // （applyRoleViewOverride，见 utils/viewModePreview.ts）降级模拟，真实身份是
  // super_admin、只是正在预览【店长/义工/家人/财务视角】时，isSuperAdmin 会被
  // 置为 false，导致：① 预览义工/家人/财务视角时 isManager 也一并被置为 false，
  // canGenerate 三个条件全部落空，整个弹窗直接被"无权限"拦死；② 预览店长视角时
  // isManager 恰好仍是 true 能进入弹窗，但 genAvailableRoles 会误判成"店长权限"，
  // 【大家长】【门店店长】两档被错误禁用。这与页面顶部 Banner"实际操作仍以超级
  // 管理员权限执行"的承诺自相矛盾。isRealSuperAdmin 是本文件专门为此设计、不受
  // 预览覆盖影响的真实身份标志位（同一类历史修复见 initCurrentUserRole/
  // onStoreChanged 注释），发码权限判定统一改用它，而不是会被预览污染的 isSuperAdmin
  onOpenGenCodeModal() {
    const isRealSuperAdmin = this.data.isRealSuperAdmin;
    const canGenerate = isRealSuperAdmin || this.data.isManager || this.data.isPatriarch;
    if (!canGenerate) {
      wx.showToast({ title: '无权限：仅超级管理员/店长/大家长可生成邀请码', icon: 'none', duration: 2500 });
      return;
    }

    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];

    let storeOptions: any[];
    let genStoreSelectorDisabled: boolean;
    let defaultStore: any;

    if (isRealSuperAdmin) {
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

    // 🏛️ 权限层级重构：大家长确立为门店最高负责人，与超管一样解锁全部五种
    // 身份（含继任大家长/门店店长），不再需要"超级管理员授权"这道额外关卡；
    // 店长次一级，可任命门店财务/家人/志愿者，但不能任命大家长/门店店长——
    // 这两档与店长自身同级或更高，只有大家长本人或超管能任命。
    // 与云函数 checkGeneratePermission 的口径完全一致
    const genAvailableRoles = (isRealSuperAdmin || this.data.isPatriarch)
      ? ['PATRIARCH', 'MANAGER', 'FINANCE', 'FAMILY', 'VOLUNTEER']
      : ['FINANCE', 'FAMILY', 'VOLUNTEER'];

    // 🐛 排查加固：见 genRolePatriarchDisabled 等字段声明处注释——预算好每个
    // 角色的禁用态，WXML 不再现场调用 genAvailableRoles.includes(...)
    const genRolePatriarchDisabled = !genAvailableRoles.includes('PATRIARCH');
    const genRoleManagerDisabled = !genAvailableRoles.includes('MANAGER');
    const genRoleFinanceDisabled = !genAvailableRoles.includes('FINANCE');
    const genRoleFamilyDisabled = !genAvailableRoles.includes('FAMILY');
    const genRoleVolunteerDisabled = !genAvailableRoles.includes('VOLUNTEER');

    // 🐛 排查诊断日志：临时保留，用于确认"除大家长外全部禁用"这类异常究竟是
    // isRealSuperAdmin/isPatriarch 本身取值有问题，还是 genAvailableRoles
    // 计算/渲染环节的问题——复现问题时请把这几行日志一并截图反馈
    console.log('[onOpenGenCodeModal] 权限诊断：', {
      isRealSuperAdmin,
      isPatriarch: this.data.isPatriarch,
      isManager: this.data.isManager,
      isSuperAdmin: this.data.isSuperAdmin,
      currentViewMode: this.data.currentViewMode,
      genAvailableRoles
    });

    this.setData({
      showGenCodeModal: true,
      generatedCode: '',
      isGeneratingInviteCode: false,
      genTargetRole: genAvailableRoles[0] as any,
      genStoreOptions: storeOptions,
      genStoreSelectorDisabled,
      genAvailableRoles,
      genRolePatriarchDisabled,
      genRoleManagerDisabled,
      genRoleFinanceDisabled,
      genRoleFamilyDisabled,
      genRoleVolunteerDisabled,
      targetGenStoreId: defaultStore ? defaultStore.storeId : '',
      targetGenStoreName: defaultStore ? defaultStore.storeName : ''
    });
    // 🐛 根因修复（上一版用错 API，未生效）：app.json 的 tabBar.custom 为
    // true，本项目走的是 custom-tab-bar 自定义组件方案，不是原生 tabBar——
    // wx.hideTabBar()/wx.showTabBar() 只对原生 tabBar 生效，对自定义组件是
    // 纯粹的空调用，之前这里调用它完全没有效果，弹窗底部按钮依旧被遮挡。
    // 该组件是微信客户端框架在 tabBar.custom=true 时自动挂载到页面上的
    // 特殊图层组件，不在页面自己的 WXML 层叠上下文里，任何 CSS z-index 都
    // 盖不住它（见 utils/tabBarVisibility.ts 头部注释，微信官方确认过的平台
    // 限制）。正确做法是调用该文件导出的 setTabBarHidden()，直接操作
    // custom-tab-bar 组件自身的 hide 状态——本文件其它弹窗（如 3595/8198 行）
    // 已经在用这个方法，这里统一改为同一套
    setTabBarHidden(this, true);
  },

  onCloseGenCodeModal() {
    this.setData({ showGenCodeModal: false });
    setTabBarHidden(this, false);
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
      const res: any = await callFunctionWithTimeout({
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
    // 生成成功后 showGenCodeModal→showInviteResultModal 是同一次沉浸式流程的
    // 延续（中途未调用过 setTabBarHidden(this, false)），custom-tab-bar 一直
    // 保持隐藏，这里才是真正的流程终点，在此统一恢复
    setTabBarHidden(this, false);
  },

  onCopyInviteResultCode() {
    wx.setClipboardData({
      data: this.data.inviteResultCode,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' })
    });
  },

  // 🛡️ 邀请太阳码加载失败兜底：inviteResultQrPath 是本地临时文件路径，加载失败时
  // 清空并提示重新生成——邀请码文本本身仍可通过上方"一键复制邀请码"正常分享
  onInviteResultQrLoadError(e: any) {
    console.warn('[onInviteResultQrLoadError] 邀请太阳码加载失败:', e && e.detail);
    this.setData({ inviteResultQrPath: '' });
    wx.showToast({ title: '太阳码加载失败，可先复制邀请码', icon: 'none' });
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
    const storeName = this.data.inviteResultStoreName || this.data.currentStoreName || this.data.shopName || '本门店';
    const copyText = `【素小账】公益爱心助手\n诚邀您加入【${storeName}】！您的专属【${roleLabel}】邀请码为：${this.data.inviteResultCode}（24 小时内有效，仅限一次核销）。请打开小程序输入此码激活身份。感恩您的加入！`;
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
      const res: any = await callFunctionWithTimeout({
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
      const result = await callFunctionWithTimeout({
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
      const result = await callFunctionWithTimeout({
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
          const result = await callFunctionWithTimeout({
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
          const result = await callFunctionWithTimeout({
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
              safeNavigateTo({ url: '/pages/history/history' });
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
          volunteerHours: parseFloat(result.data.volunteerHours) || 0,
          listeningSeniors: parseFloat(result.data.listeningSeniors) || 0
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
      listeningSeniors: record.listeningSeniors != null ? String(record.listeningSeniors) : '',
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

    // 🔗 大家长手动修改服务总工时 → 标记为手动模式，后续自动汇总不再覆盖
    if (field === 'volunteerHours') {
      this.setData({ isManualHours: true, checkInHoursTip: '' });
    }

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
  // 使统计大屏、海报生成、Excel 导出、风控校验等一切既有下游无需感知本次细分字段改造。
  // 🔗 自动计算服务总工时：志愿者总人次 × 4h（默认每人4小时），仅当 !isManualHours 时生效
  recalcDiningStats() {
    const { dineInSeniors, deliverySeniors, dineInVolunteers, deliveryVolunteers, takeawayCount, isManualHours } = this.data;
    const nDineInSeniors = parseFloat(dineInSeniors) || 0;
    const nDeliverySeniors = parseFloat(deliverySeniors) || 0;
    const nDineInVolunteers = parseFloat(dineInVolunteers) || 0;
    const nDeliveryVolunteers = parseFloat(deliveryVolunteers) || 0;
    const nTakeaway = parseFloat(takeawayCount) || 0;

    const totalDineCount = nDineInSeniors + nDeliverySeniors + nTakeaway + nDineInVolunteers;
    const totalVolunteers = nDeliveryVolunteers + nDineInVolunteers;

    const patch: Record<string, any> = {
      totalDineCount: String(totalDineCount),
      totalVolunteers: String(totalVolunteers),
      diningCount: String(totalDineCount),
      volunteerCount: String(totalVolunteers)
    };

    // 自动估算服务工时：未手动覆盖 且 有志愿者人次时才计算
    if (!isManualHours && totalVolunteers > 0) {
      patch.volunteerHours = String(parseFloat((totalVolunteers * 4).toFixed(1)));
    }

    this.setData(patch);
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
      listeningSeniors: String(snapshot.listeningSeniors || 0),
      isManualHours: false,
      checkInHoursTip: ''
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
      const res = await callFunctionWithTimeout({
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
    callFunctionWithTimeout({
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
          const res = await callFunctionWithTimeout({
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
      const res = await callFunctionWithTimeout({
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
          const cbRes = await callFunctionWithTimeout({
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
          const cbRes = await callFunctionWithTimeout({
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

  // 🌸🌿 了凡四训·阳善与阴德：发心选择切换
  // data-type="yang" → 阳善（公示真实姓名）；data-type="yin" → 积阴德（匿名）
  onSelectMerit(e: any) {
    const t = e.currentTarget.dataset.type;
    this.setData({ meritType: t === 'yin' ? 'yin' : 'yang' });
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
          const checkRes = await callFunctionWithTimeout({
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
    // 🛡️ 防重提交：上一批还在压缩/上传时，insertStart 是基于当时的数组长度算出的
    // 快照——若此时再次触发选图，两批异步任务并发结束时会用各自过时的下标原地
    // 写回 recipeImages，导致互相覆盖或漏写。上传态期间直接拦掉，等上一批收尾
    // （recipeUploading 复位）后再允许下一次选图
    if (this.data.recipeUploading) return;

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
    // 🛡️ 防重提交：与 chooseRecipeImages 同一处根因，上一批上传未收尾前拦截新的选图
    if (this.data.activityUploading) return;

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
          const checkRes = await callFunctionWithTimeout({
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

          const ocrRes = await callFunctionWithTimeout({
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

  // 🐛 根因修复（"点击已触发但拉不起选图界面"）：此前直接 `await wx.chooseMedia(...)`
  // （不带 success/fail 回调时走的是小程序官方的隐式 Promise 包装）。真正的问题
  // 不是回调写法，而是 wx.chooseMedia 在部分环境（开发者工具模拟器的某些版本、
  // 低基础库真机）下会既不 resolve 也不 reject——原生选图面板根本没有被拉起，
  // 整个 await 静默挂起，没有任何后续日志、也不会走到下面的 try/catch，与本次
  // 反馈"点击触发日志打印了，之后再没有任何动静"完全吻合，纯粹的 setTimeout/
  // Promise 层面等不到结果，光靠 fail 回调兜底完全没用——因为 fail 压根不会
  // 触发。用 withTimeout（本文件已引入的全局超时封装）给 chooseMedia 设一个
  // 超时上限：超时或 chooseMedia 本身不存在（wx.canIUse 返回 false）就自动
  // 回退到兼容性更好、几乎所有环境都支持的 wx.chooseImage（虽是旧 API 但选图
  // 这个基础能力上落地更早、更稳）。
  // 🐛 二次订正：这个超时的性质与 callFunctionWithTimeout 那类"网络/云函数
  // 耗时"完全不同——chooseMedia 的等待时长取决于用户本人的操作节奏（在相册里
  // 翻找照片、临时改主意切到拍照、拍完还要预览确认），不是一个可预期的固定
  // 区间，5s 对这类"人在交互，不是接口在耗时"的等待完全不够，实测会在用户
  // 还没选完图时就被判定超时，转而弹出第二个 wx.chooseImage 面板打断用户，
  // 表现为"选图选到一半突然被打断/换了一个面板"。改为 60s——这个超时的唯一
  // 目的是兜底"chooseMedia 在这个环境下彻底坏掉、回调永远不会来"这一种极端
  // 情况，不是给用户的选图操作设一道时限，60s 已经远超正常人挑图/改用拍照的
  // 合理耗时，不会再误伤真实交互
  chooseDonorScreenshotSafe(): Promise<string> {
    const viaChooseMedia = new Promise<string>((resolve, reject) => {
      if (!wx.canIUse('chooseMedia')) {
        reject(new Error('chooseMedia not available'));
        return;
      }
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success: (res) => {
          const tempFilePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
          if (tempFilePath) {
            resolve(tempFilePath);
          } else {
            reject(new Error('chooseMedia 未返回图片路径'));
          }
        },
        fail: (err) => reject(err)
      });
    });

    return withTimeout(viaChooseMedia, 60000, 'chooseMedia 超时未响应').catch((err) => {
      // 🛡️ 用户主动在原生面板里点取消，errMsg 会明确带 cancel，这类"正常放弃
      // 选图"不该被当成"chooseMedia 坏了"再弹一个 chooseImage 面板出来干扰用户，
      // 直接把原始取消错误继续抛给调用方（外层 catch 已有 cancel 静默处理）
      const errMsg = (err && (err.errMsg || err.message)) || '';
      if (errMsg.includes('cancel')) {
        throw err;
      }
      console.warn('[chooseDonorScreenshotSafe] chooseMedia 不可用/超时，回退到 wx.chooseImage:', err);
      return new Promise<string>((resolve, reject) => {
        wx.chooseImage({
          count: 1,
          sourceType: ['album', 'camera'],
          success: (res) => resolve(res.tempFilePaths[0]),
          fail: (fallbackErr) => reject(fallbackErr)
        });
      });
    });
  },

  // 🌟 爱心支持明细·图片识别：上传微信群收款/接龙截图，OCR 识别"昵称+金额"明细，
  // 自动追加进【批量粘贴】文本框。识别只负责"认字配对"，绝不在云函数里求和/去重——
  // 结果统一交给前端唯一权威的 parseDonorText（经 updateParseResult 调用）解析汇总，
  // 与手动粘贴文本走的是完全相同的一条路径，不会另开一套计算逻辑。
  async onScanDonorScreenshot() {
    // 🌟 诊断日志：如果点击按钮后连这一行都没打印出来，说明问题根本不在这个函数内部
    // （大概率是小程序端跑的还不是最新编译产物，或点击事件被祖先节点拦截/未走到
    // 这里），而不是这里的业务逻辑有 bug——之前这里只留了注释、漏了真正打印的
    // 那一行，排查"点击无反应"时完全看不出函数到底有没有被调用，这次补上
    console.log('[onScanDonorScreenshot] 点击触发，isScanningDonorList=', this.data.isScanningDonorList);

    if (this.data.isScanningDonorList) {
      // 🐛 卡死态兜底：正常流程下 isScanningDonorList 只会在下方 finally 里被
      // 复位，理论上不会长时间卡在 true。但 pages/index/index 是 tabBar 页面，
      // 若用户在系统相册/相机选择器弹出期间切到其它 Tab 或短暂锁屏，小程序端
      // 偶发场景下（如 App 被系统临时挂起）chooseMedia 的回调可能迟迟不触发，
      // 导致这个标志位被"孤儿态"卡住——此后再点识图按钮会一直静默 return，
      // 表现和"点击完全无反应"一模一样，且没有任何日志/报错可循，与本次
      // 排查的现象吻合。用一个时间戳判断"卡住"是否已经超过合理时长
      // （20s，远超一次真实识别流程的耗时），超过就视为孤儿态，打印警告并
      // 强制复位后继续本次点击，而不是无限期地静默拦死后续所有点击；未超时
      // 则说明识别确实正在进行中，弹出提示而不是什么反馈都不给
      const stuckDuration = Date.now() - (this._scanDonorStartedAt || 0);
      if (stuckDuration > 20000) {
        console.warn('[onScanDonorScreenshot] 检测到孤儿态（isScanningDonorList 卡住超过', stuckDuration, 'ms），强制复位后继续本次点击');
        wx.hideLoading();
        this.setData({ isScanningDonorList: false });
      } else {
        wx.showToast({ title: '识别中，请稍候', icon: 'none' });
        return;
      }
    }
    this._scanDonorStartedAt = Date.now();

    try {
      if (!isCloudAvailable()) {
        console.warn('[onScanDonorScreenshot] isCloudAvailable() 返回 false，云能力不可用');
        wx.showToast({ title: '云服务暂不可用，无法使用图片识别', icon: 'none' });
        return;
      }

      const tempFilePath = await this.chooseDonorScreenshotSafe();
      if (!tempFilePath) return;

      // 🌟 第一道防线：图片 MD5 去重。在触发任何网络请求（内容安全检测/上传/OCR）之前，
      // 先读取本地临时文件的原始二进制内容算出 MD5——同一张图片（哪怕文件名不同，
      // chooseMedia 每次选择都会生成新的临时路径）字节内容完全一致，MD5 必然相同。
      // 命中即直接拦截，连内容安全检测的网络请求都不发，最大程度节省一次无意义的调用。
      const fs = wx.getFileSystemManager();
      const fileBuffer = fs.readFileSync(tempFilePath) as ArrayBuffer;
      const imageHash = md5(fileBuffer);

      // 🐛 根因修复（TypeError: Cannot read property 'includes' of undefined）：
      // _uploadedImageHashes 是在 Page({...}) 对象字面量里以纯实例属性形式声明
      // 的 `[] as string[]`（不在 data 里，不经过 setData），本该在页面每次
      // onLoad 创建新实例时随之初始化好。实测在反复编辑/热重载调试期间会
      // 出现该属性读到 undefined 的情况——与本文件其它所有"本地状态形状不
      // 可尽信"的历史 bug 同一个教训（见 fetchAllStoresList 对 allStoresList
      // 缓存的 Array.isArray 校验注释），这里同样不能假设它一定是数组，用之
      // 前先校验/兜底成空数组，而不是在真正崩溃后才发现
      if (!Array.isArray(this._uploadedImageHashes)) {
        console.warn('[onScanDonorScreenshot] _uploadedImageHashes 不是数组，重置为空数组');
        this._uploadedImageHashes = [];
      }

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
        const checkRes = await callFunctionWithTimeout({
          name: 'checkImageContent',
          data: { imgBuffer: base64Data, contentType: 'image/jpeg' }
        });
        const checkResult = checkRes.result as any;
        if (checkResult && !checkResult.isSafe) {
          // 🐛 showLoading/hideLoading 配对修复：这里曾经额外调用过一次 wx.hideLoading()，
          // 但函数末尾的外层 finally（见下方）已经保证无论走哪条分支都会且只会隐藏一次
          // loading——这里再调一次会导致 hideLoading 调用次数多于 showLoading，触发调试器
          // "showLoading 与 hideLoading 必须配对使用"的告警。统一收口到外层 finally。
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

        const ocrRes = await callFunctionWithTimeout({
          name: 'ocrDonationList',
          data: { fileID: uploadedFileId }
        });

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
      const errMsg = e.errMsg || e.message || '';
      console.warn('[onScanDonorScreenshot] 捕获到异常:', e);
      if (errMsg.includes('cancel')) {
        // 用户在系统相册/相机选择框里点了取消，这是正常操作，不需要弹提示打扰——
        // 但控制台日志留着，方便和"点击后完全没反应"这类真正的 bug 区分开
        return;
      }
      wx.showToast({ title: '识别失败：' + (e.message || errMsg || '未知错误'), icon: 'none' });
    } finally {
      // 🐛 唯一的 hideLoading 出口：无论成功/提前 return/异常，finally 都保证恰好
      // 执行一次，与函数内唯一一次进入循环前的 wx.showLoading() 严格配对
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
  // 🛡️ 见 onScanDonorScreenshot 头部"孤儿态兜底"注释：记录本次识别发起的时间戳，
  // 用于判断 isScanningDonorList 卡住是否已经超出合理时长，纯实例属性
  _scanDonorStartedAt: 0 as number,

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
        const { reportDate, otherDonation, expenses, dailyExpenseText, fixedExpenseText, fixedExpenseItems, shopName, mpAccount, adjustReason, receiptImages, reportDateValue, thankText, slogan1, slogan2, materials, activityText, volunteerCount, volunteerHours, diningCount, stapleRiceStatus, stapleOilStatus, mergeToReportText, announcement, dineInSeniors, deliverySeniors, dineInVolunteers, deliveryVolunteers, takeawayCount, listeningSeniors, totalDineCount, totalVolunteers, meritType } = this.data;
        const isAnonymous = meritType === 'yin';
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
          mealBreakdown: this.buildMealBreakdown(),
          stapleRiceStatus: stapleRiceStatus,
          stapleOilStatus: stapleOilStatus,
          noticeTag: announcement && announcement.tag,
          noticeTitle: announcement && announcement.title,
          noticeContent: announcement && announcement.content,
          mergeToReportText: mergeToReportText,
          isAnonymous: isAnonymous
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
          listeningSeniors: parseFloat(listeningSeniors) || 0,
          totalDineCount: parseFloat(totalDineCount) || 0,
          totalVolunteers: parseFloat(totalVolunteers) || 0,
          stapleRiceStatus: stapleRiceStatus,
          stapleOilStatus: stapleOilStatus,
          isAnonymous: isAnonymous
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
        const isStoreInactive = errDetail === 'store_inactive';

        if (isStoreInactive) {
          // 🔐 停用门店禁止新增记账：这是明确的业务规则拒绝，不是网络/云端故障——
          // 不能像下面通用分支那样 saveToQueue() 塞进离线重试队列，否则会在门店
          // 重新启用后的某个不确定时间点，静默把这条早已过期的旧提交重新写进去，
          // 与用户当时的真实操作意图脱节
          wx.showModal({
            title: '门店已停用',
            content: saveResult.message || '该门店已被停用，暂不支持提交新的记账数据，请联系超级管理员重新启用',
            showCancel: false,
            confirmText: '我知道了'
          });
        } else if (isDuplicateDate) {
          // 🌟 重复录入拦截：不能走离线队列重试（会一直被拦截，甚至在极端时序下仍可能造成重复），
          // 直接引导用户去历史记录编辑/修改已存在的当日记录
          wx.showModal({
            title: '⚠️ 重复录入提醒',
            content: saveResult.message || '该日期已存在餐报记录，请直接在历史记录中编辑或修改，避免重复录入',
            confirmText: '去历史记录',
            cancelText: '我知道了',
            success: (res) => {
              if (res.confirm) {
                safeNavigateTo({ url: '/pages/history/history' });
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
        const res = await callFunctionWithTimeout({
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

        const res = await callFunctionWithTimeout({
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
      const res = await callFunctionWithTimeout({
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
      const res = await callFunctionWithTimeout({
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

    // 🔗 管理岗位：非阻塞式预取今日打卡工时，自动预填【服务总工时】字段
    // isManager/isPatriarch 在 initCurrentUserRole() 就绪后才有值，
    // loadHomeDynamicData 每次都在角色解析完成后调用，此处可安全读取
    if (this.data.isManager || this.data.isPatriarch) {
      this.syncCheckInHoursToForm();
    }
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
      // ☀️ 账本锁定状态：与风控预警同一时机拉取，替换 finance-home-card 顶部
      // 此前写死的 "100%" 占位文案
      this.fetchFinanceLedgerStatus();
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
      const res: any = await callFunctionWithTimeout({
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
      const res: any = await callFunctionWithTimeout({
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
      const res: any = await callFunctionWithTimeout({
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
      const res: any = await callFunctionWithTimeout({
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
      storeName = cached.storeName || this.data.shopName || '';
      storeId = cached.storeId || '';
    } else {
      role = wx.getStorageSync('current_user_role') || DEV_FALLBACK_ROLE;
      storeName = wx.getStorageSync('current_store_name') || this.data.shopName || '';
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
    // 🐛 根因修复：这里原来写的是 `const isRealSuperAdmin = isSuperAdmin`，而这个
    // isSuperAdmin 是从上面被 current_user_role 存储值（可能是超管之前预览/切换过的
    // 店长/义工等角色）替换过的 rawRole 算出来的——超管只要用过一次"视角切换"或
    // store-picker 预览成别的角色，这里就会被污染成 false，之后即便回到超管本人
    // 视角，isRealSuperAdmin 也会一直错误地是 false（因为 rawRole 读的是那个残留的
    // storage 值）。真正"不受预览覆盖影响"的真实身份，是本函数开头已经算好的
    // isVerifiedSuperAdminAccount（直接来自服务端已核验角色缓存，不经过 storage
    // 预览态中转），这里改用它，而不是被 rawRole 污染过的局部变量
    const overridden = applyRoleViewOverride(role, {
      currentUserRole: role, isVolunteer, isManager, isFinance, isSuperAdmin, isFamily
    });
    // 🐛 根因修复：见 utils/viewModePreview.ts resolveDisplayViewMode 注释。role 这里
    // 大小写不统一（正常路径是 setStorageSync 写入的小写值，DEV_FALLBACK_ROLE 兜底是
    // 大写 'SUPER_ADMIN'），resolveDisplayViewMode 的映射表按小写 key，显式 toLowerCase()
    const currentViewMode = resolveDisplayViewMode(role.toLowerCase());

    this.setData({
      currentUserRole: overridden.currentUserRole,
      currentRole: rawRole,
      currentStoreName: storeName,
      currentStoreId: storeId,
      isRealSuperAdmin: isVerifiedSuperAdminAccount,
      currentViewMode,
      currentViewModeLabel: PREVIEW_VIEW_MODE_LABELS[currentViewMode],
      isAllStoresView: isAllStoresView,
      isVolunteer: overridden.isVolunteer,
      isManager: overridden.isManager,
      isFinance: overridden.isFinance,
      isSuperAdmin: overridden.isSuperAdmin,
      isPatriarch: isPatriarch,
      isFamily: overridden.isFamily,
      permissions: getPermissionFlags({ role })
    });
  },

  // 🐛 根因排查记录：之前超管点【通用素食/门店记账】仍被拦"暂不支持"，真正原因不是
  // 这里的判断条件写少了字段，而是 refreshUserRoleView()/onStoreChanged() 里
  // isRealSuperAdmin 被"当前预览/切换到的角色"污染——超管只要用过一次视角切换或
  // store-picker 预览成店长/义工，isRealSuperAdmin 就会被错误算成 false，且此后
  // 一直带着这个错误值，与本函数里判断条件本身无关。已在那两处改为直接读服务端
  // 已核验角色缓存（不经过会被预览态覆盖的 storage 中转）来修复根因。
  // 这里保留一层兜底：isCurrentAccountSuperAdmin() 在 this.data 两个标记都不可信时
  // 再直接查一次 AuthService 缓存，双保险
  //
  // 🌐 自动续接工作空间：账号已有明确归属（真实门店 orgType）时，跳过"工作空间
  // 选择"首页，直接落地到对应专区，不需要用户在每次冷启动时都手动点一次卡片。
  //
  // 🛡️ 不引入任何持久化缓存（不写 wx.setStorageSync，"lastSelectedPlatform"
  // 这类 key 在本项目里从未存在过）——currentPlatformMode 本身只是页面内存态，
  // 每次调用本方法都用【当次从服务端/缓存角色现算出的 orgType】直接决定落地
  // 专区，天然不存在"缓存了上次选择、但账号真实归属已经变了"这种跨专区污染
  // 风险。initCurrentUserRole() 的 cached 分支（本地缓存，可能过期）与
  // fetchUserRole 分支（服务端权威）都会各调用一次本方法：前者先落地一个初步
  // 专区，后者若发现权威 orgType 与之前不一致会立即纠正，不会停留在错误专区。
  //
  // 🛡️ 超管/平台管理员：orgType 对他们没有确定性意义（不隶属单一门店/机构，
  // 或需要自由预览两个专区），不做自动跳转，保留工作空间选择首页作为固定入口，
  // 与 onSelectYuhuaPlatform/onSelectGeneralPlatform 里"超级管理员无条件放行"
  // 的既有设计保持一致。
  //
  // 🛡️ 全新未绑定账号（orgType===''）：没有可依据的归属信息，同样留在选择首页，
  // 引导其通过下方 showNewUserGuide（进入某个专区后）创建/加入站点。
  autoResumeWorkspaceMode(orgType: string, isSuperAdminAccount: boolean, isPlatformAdminAccount: boolean) {
    if (isSuperAdminAccount || isPlatformAdminAccount || !orgType) return;

    const targetMode = orgType === 'yuhuazhai' ? 'yuhua' : 'general';
    if (this.data.currentPlatformMode === targetMode) return;

    if (targetMode === 'yuhua') {
      // 内部含合规声明校验：未同意过声明时只会先弹声明弹窗，不会绕过
      this.enterYuhuaWorkspaceFlow();
    } else {
      this.setData({ currentPlatformMode: 'general' });
    }
  },

  // 🏢 工作空间选择首页：点击【雨花公益食堂专区】卡片。
  // 🐛 Bug 1 修复：此前账号真实 orgType 不是 'yuhuazhai' 时会被"暂不支持"弹窗
  // 死锁拦截，新用户/义工/其余机构账号永远进不了雨花专区——但这张卡片本就是
  // 给"还没绑定雨花门店、想加入一家雨花斋"的人准备的入口，拦住他们等于自我
  // 矛盾。现在改为：已绑定雨花门店（或超管）直接进入工作台；否则唤起"选择雨花
  // 斋服务站点"弹窗（复用申请加入门店的 showApplyModal，见 openStorePickerForJoin），
  // 允许其选择要服务的雨花斋门店（以家人/义工身份打卡）或申请加入/新建雨花门店
  // （新建走 storeSelectionType==='custom' 分支，弹窗内自带切换 Tab）。
  // 🛡️ 超级管理员无条件放行：入口处优先判断，直接进入，绝不弹选站点弹窗。
  // 雨花声明仍照走（见 enterYuhuaWorkspaceFlow 内 isPrivilegedView 已含 isSuperAdmin）
  onSelectYuhuaPlatform() {
    console.log('[YuhuaPlatform] onSelectYuhuaPlatform 点击雨花公益食堂专区，orgType:', this.data.orgType);
    const isSuperAdminAccount = this.isCurrentAccountSuperAdmin();
    console.log('[YuhuaPlatform] 权限检查结果，isSuperAdminAccount:', isSuperAdminAccount, 'orgType===yuhuazhai:', this.data.orgType === 'yuhuazhai');
    if (isSuperAdminAccount || this.data.orgType === 'yuhuazhai') {
      console.log('[YuhuaPlatform] 已绑定雨花门店/超管，进入 enterYuhuaWorkspaceFlow');
      this.enterYuhuaWorkspaceFlow();
      return;
    }
    console.log('[YuhuaPlatform] 尚未绑定雨花门店，唤起选择服务站点弹窗');
    this.openStorePickerForJoin('yuhuazhai', '选择雨花斋服务站点');
  },

  // 🌸 唤起"选择服务站点"弹窗：复用既有的 showApplyModal（申请加入门店），
  // 与 fetchStoreInfoAndPromptApply 等场景的区别只是门店列表的拉取方式——这里
  // 调用者尚未归属任何机构（或归属的机构类型不匹配），改走 getStoreList 的
  // 发现模式（显式传 orgType，见该云函数注释），跨机构拉取指定专区下的门店，
  // 而不是 fetchAllStoresList() 那套按调用者自身 tenantId 过滤的"我的门店"列表。
  // 供 Bug 1（工作空间选择页点雨花专区未绑店时）与空状态"加入现有爱心站点"
  // 引导卡（onNewUserGoJoin）共用
  async openStorePickerForJoin(orgTypeFilter: string, title: string) {
    console.log('[openStorePickerForJoin] 唤起站点选择弹窗，orgTypeFilter:', orgTypeFilter, 'title:', title);
    const volunteerTip = this.computeApplyRoleTip('volunteer');
    this.setData({
      applyModalTitleOverride: title,
      'applyForm.storeSelectionType': 'existing',
      'applyForm.storeId': '',
      'applyForm.storeName': '',
      'applyForm.requestedRole': 'volunteer',
      // 🌸 仅雨花专区有明确的 orgType 取值可预填；通用专区涵盖多种机构类型，
      // 留空退回 processRoleAudit 的 'other' 默认值，不能替用户瞎猜
      'applyForm.orgTypeHint': orgTypeFilter === 'yuhuazhai' ? 'yuhuazhai' : '',
      applyRoleTipText: volunteerTip.text,
      applyRoleTipVariant: volunteerTip.variant,
      allStoresList: [],
      showApplyModal: true
    });
    // 🐛 根因修复：见 utils/tabBarVisibility.ts 头部注释——自定义 tabBar 是
    // 框架自动挂载的原生层组件，本弹窗的 z-index 再高也盖不住它，必须显式
    // 隐藏；onCloseApplyModal / 提交成功分支会负责恢复
    setTabBarHidden(this, true);
    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
      // 🛡️ crossTenant:true 显式声明这是一次跨机构发现请求（getStoreList 云函数
      // 现在要求显式声明才会跨机构查询，不再仅凭传了 orgType 就自动判定，见该
      // 云函数注释）——这里调用者可能已经归属其他机构（如社区食堂义工点了雨花
      // 专区卡片想额外找一家雨花斋加入），必须显式声明才能跨出自己的 tenantId
      const res = await callFunctionWithTimeout({ name: 'getStoreList', data: { orgType: orgTypeFilter, crossTenant: true } });
      const result = res.result as any;
      // 🐛 与 fetchAllStoresList 同一处防护：这里同样直接 setData 进
      // allStoresList，同一个 `<picker range="{{allStoresList}}">` 绑定，
      // 必须校验 result.list 真的是数组，不能只信"非空即可用"
      const rawList = (result && result.success) ? result.list : null;
      const list = Array.isArray(rawList) ? rawList : [];
      console.log('[openStorePickerForJoin] 站点列表加载完成，success:', !!(result && result.success), '数量:', list.length);
      this.setData({ allStoresList: list });
    } catch (e) {
      console.error('[openStorePickerForJoin] 站点列表加载失败:', e);
      wx.showToast({ title: '站点列表加载失败，请重试', icon: 'none' });
    }
  },

  // 🏢 工作空间选择首页：点击【通用素食/门店记账】卡片。不涉及雨花声明，orgType
  // 只要不是 'yuhuazhai' 就直接放行——elderly_canteen/volunteer_station/rescue_team/
  // tongxin_children/other 等其余机构类型统一归入这张"通用"卡片。
  // 🛡️ 超级管理员无条件放行：同上，确保绑定了雨花斋门店的超管账号（或正预览雨花斋
  // 店内某角色的超管）不会被误判成"普通雨花门店用户"而拦在通用卡片外
  onSelectGeneralPlatform() {
    console.log('[PlatformSelect] onSelectGeneralPlatform this.data:', this.data);
    const isSuperAdminAccount = this.isCurrentAccountSuperAdmin();
    console.log('[PlatformSelect] onSelectGeneralPlatform isSuperAdminAccount:', isSuperAdminAccount, 'orgType:', this.data.orgType);
    if (!isSuperAdminAccount && this.data.orgType === 'yuhuazhai') {
      wx.showModal({
        title: '暂不支持',
        content: '您的账号当前绑定的是雨花斋门店，请从「雨花公益食堂专区」进入。',
        showCancel: false
      });
      return;
    }
    this.setData({ currentPlatformMode: 'general' });
    this.syncStoresForZoneEntry();
  },

  // 🧺 素食直播产销工坊卡片：与上面两张"记账工作台"卡片架构上不是同一类东西——
  // 雨花/通用两张卡片是同一个首页内容区的两种 currentPlatformMode，工坊卡片
  // 点击后是真正 navigateTo 到 live_factory 自己独立的页面树（tenant_members
  // 角色体系，与本页 orgType/currentPlatformMode 判断完全无关，见
  // createProductionSpace/index.js 头部注释），所以不复用 setData
  // currentPlatformMode 那套模式切换写法。
  //
  // "是否已有所属工坊"这里选择在点击时现查（getMyProductionSpaces），而不是
  // 像 orgType 那样在页面初始化阶段预先算好缓存——一是这张卡片、这套角色体系
  // 与本页其余大量 onLoad/onShow 初始化逻辑完全无关联，不想为了这一张新卡片
  // 往那段已经踩过不少坑的初始化流程里插东西（见 autoResumeWorkspaceMode 附近
  // 的历史 bug 注释）；二是点击后有一次简短 loading 是完全可接受的成本，不值得
  // 为了省这一次云函数调用去冒改动初始化时序的风险。
  async onSelectFactoryPlatform() {
    wx.showLoading({ title: '加载中...', mask: true });
    let spaces: Array<{ tenantId: string; tenantName: string; role: string }> = [];
    try {
      const res = await callFunctionWithTimeout({ name: 'getMyProductionSpaces', data: {} });
      const result = res.result as any;
      spaces = (result && result.success && result.spaces) || [];
    } catch (err) {
      wx.hideLoading();
      console.error('[index] onSelectFactoryPlatform 查询工坊列表异常:', err);
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      return;
    }
    wx.hideLoading();

    if (spaces.length === 0) {
      wx.navigateTo({ url: '/subpackages/factory/pages/workspace-join/workspace-join' });
      return;
    }
    if (spaces.length === 1) {
      wx.navigateTo({ url: '/subpackages/factory/pages/production-fulfillment/production-fulfillment?tenantId=' + spaces[0].tenantId });
      return;
    }
    // 同时归属多个工坊（如既是自己工坊的负责人，又被别的工坊邀请当制作方）：
    // 与 profile.ts onGoToProductionFulfillment 同一套多空间选择写法
    wx.showActionSheet({
      itemList: spaces.map((s) => s.tenantName || '未命名工坊'),
      success: (r) => {
        const chosen = spaces[r.tapIndex];
        if (chosen) {
          wx.navigateTo({ url: '/subpackages/factory/pages/production-fulfillment/production-fulfillment?tenantId=' + chosen.tenantId });
        }
      }
    });
  },

  // 🐛 任务 B 配套：门店激活/自动选店必须下沉到"用户已经点了具体专区卡片之后"，
  // 不能提前发生在中立的【选择工作空间】首页——但 fetchAllStoresList() 在冷启动
  // 阶段（currentPlatformMode 还是空字符串）就可能已经跑过一次，取回的是未按
  // 专区收窄的全量跨专区列表（orgTypeFilter 为空）。currentPlatformMode 刚被
  // setData 成 'yuhua'/'general' 后，这里补一次刷新，让 fetchAllStoresList()
  // 用已经落地的新专区重新按 orgType 收窄查询，再交给 maybeAutoSelectStore()
  // 做静默默认选中——确保"先过滤专区门店列表，再在工作台展示选中站点"这个顺序，
  // 不是拿着进专区前的脏列表乱选。已绑定具体门店（currentStoreId 非空）时无需
  // 这一步，直接跳过
  syncStoresForZoneEntry() {
    if (!this.data.currentStoreId) {
      this.fetchAllStoresList();
    }
  },

  // 🛡️ 超管判定：优先信任 this.data 上已经算好的 isRealSuperAdmin（真实身份，见
  // refreshUserRoleView/onStoreChanged 根因修复）或 isSuperAdmin（当前展示态）；
  // 两者都不可信时，直接查一次 AuthService 已核验角色缓存兜底，不依赖任何
  // 本页面未定义过的字段（globalRole/cachedRole/userRole 等在这个文件里都不存在，
  // 不要照抄别处模板里的字段名，会变成永远判不中的死代码）
  //
  // 🐛 根因修复：这里判定的是"能否绕过工作空间选择页的 orgType 门店类型校验"，
  // 不是业务权限分层意义上的"超管"。platform_admin（SaaS 平台管理员）与
  // super_admin 是两个完全独立的维度（互不包含，见 authService.ts UserRole 注释），
  // 但 platform_admin 账号同样不隶属任何门店/租户，orgType 恒为空字符串——用
  // "orgType 必须等于 yuhuazhai" 这条面向业务角色门店归属的规则去卡它，只会永远
  // 命中"暂不支持"分支。这里补上 isPlatformAdmin 分支，仅用于放行这个入口判定，
  // 不会连带把 isRealSuperAdmin/isSuperAdmin 本身变成 true（那两个标志位仍严格
  // 只在真正的 super_admin 业务角色下为 true，financial 相关权限判定不受影响）
  isCurrentAccountSuperAdmin(): boolean {
    if (this.data.isRealSuperAdmin || this.data.isSuperAdmin || this.data.isPlatformAdmin) return true;
    const cached = AuthService.getCachedRoleInfo();
    return !!(cached && (cached.role === 'super_admin' || cached.role === 'platform_admin') && cached.status === 'approved');
  },

  // 🌸 雨花工作空间进入流程：分两档独立记忆声明确认，互不覆盖——
  // 'general' 档：任何角色首次进入雨花平台都必须阅读一次「非官方属性 + 不提供募捐」声明；
  // 'privileged' 档：即使已经读过 general 版，一旦这个设备上的账号第一次以财务/店长/
  // 超管权限进入雨花平台（能看到/操作账目数据的角色），必须再单独确认一次——这类角色
  // 看到的是具体金额与账本，合规风险高于普通义工视角，需要更明确地二次确认知悉其非官方属性。
  // 两档各自的确认状态分别持久化在本地 storage，只弹一次，不会每次进入都打扰用户。
  // 🛡️ 容错重构：此前第一行 `if (this.data.showComplianceModal) return;` 是一个
  // 无日志、无条件的静默 return——只要 showComplianceModal 这个标志位当下是
  // true（哪怕是别的入口，如底部 Footer「查看完整声明」的 'review' 档，遗留
  // 下来没关干净），点【雨花公益食堂专区】卡片就会看起来毫无反应，且现场完全
  // 无法诊断。改为：① 两档声明是否需要展示，先各自算出结果并打印，不再依赖
  // 提前 return 去"顺便"跳过计算；② 只有两档都不需要展示时才是真正的"放行"
  // 出口，这个出口不再受 showComplianceModal 历史值影响，直接强制 setData
  // 切换 currentPlatformMode 并触发门店同步，杜绝任何条件把用户卡在选择页
  // 出不去；③ 弹窗当前若确实在展示"本次需要的这一档"（general/privileged）
  // 才跳过重复 setData（避免连点造成弹窗内容被自己打断重置），展示的若是无关
  // 场景（如 'review'）则不拿它当挡箭牌，照常继续走该走的分支
  enterYuhuaWorkspaceFlow() {
    console.log('[YuhuaPlatform] enterYuhuaWorkspaceFlow 开始，showComplianceModal:', this.data.showComplianceModal, 'complianceModalScene:', this.data.complianceModalScene);

    const needsGeneralDisclaimer = !hasAgreedYuhuaGeneralDisclaimer();
    console.log('[YuhuaPlatform] 合规缓存读取（general 档），needsGeneralDisclaimer:', needsGeneralDisclaimer);

    const isPrivilegedView = !!(this.data.isManager || this.data.isFinance || this.data.isSuperAdmin);
    const needsPrivilegedDisclaimer = isPrivilegedView && !hasAgreedYuhuaPrivilegedDisclaimer();
    console.log('[YuhuaPlatform] 权限检查（privileged 档），isManager:', this.data.isManager, 'isFinance:', this.data.isFinance, 'isSuperAdmin:', this.data.isSuperAdmin, 'isPrivilegedView:', isPrivilegedView, 'needsPrivilegedDisclaimer:', needsPrivilegedDisclaimer);

    // ✅ 强制进入出口：两档均已同意（或本档不适用），无论 showComplianceModal
    // 此刻是什么历史值，都立即放行——同时顺手把它清成 false，避免脏值继续
    // 污染下一次判断
    if (!needsGeneralDisclaimer && !needsPrivilegedDisclaimer) {
      console.log('[YuhuaPlatform] 声明均已确认（或不适用），立即 setData currentPlatformMode=yuhua 并触发工作区初始化');
      this.setData({ currentPlatformMode: 'yuhua', showComplianceModal: false });
      this.syncStoresForZoneEntry();
      return;
    }

    // 🐛 防重复：仅当弹窗当前展示的正是本次需要的这一档场景时才跳过，避免
    // 连点导致 setData 被自己反复打断；无关场景（如 'review'）不算数
    const currentSceneMatchesNeed =
      (needsGeneralDisclaimer && this.data.complianceModalScene === 'general') ||
      (!needsGeneralDisclaimer && needsPrivilegedDisclaimer && this.data.complianceModalScene === 'privileged');
    if (this.data.showComplianceModal && currentSceneMatchesNeed) {
      console.log('[YuhuaPlatform] 合规弹窗已在展示同一场景，跳过重复 setData:', this.data.complianceModalScene);
      return;
    }

    if (needsGeneralDisclaimer) {
      console.log('[YuhuaPlatform] 尚未同意 general 档声明，setData 弹出 general 弹窗');
      this.setData({ showComplianceModal: true, complianceModalScene: 'general' });
      return;
    }

    console.log('[YuhuaPlatform] 尚未同意 privileged 档声明，setData 弹出 privileged 弹窗');
    this.setData({ showComplianceModal: true, complianceModalScene: 'privileged' });
  },

  onAcknowledgeYuhuaDisclaimer() {
    console.log('[YuhuaPlatform] onAcknowledgeYuhuaDisclaimer 确认声明，complianceModalScene:', this.data.complianceModalScene);
    if (this.data.complianceModalScene === 'general') {
      acknowledgeYuhuaGeneralDisclaimer();
      this.setData({ showComplianceModal: false });
      console.log('[YuhuaPlatform] general 档已写入本地确认标记，续跑 enterYuhuaWorkspaceFlow');
      // general 确认后立即续跑一次入口校验，若当前视角还需要 privileged 档二次确认，
      // 会紧接着弹出该档弹窗；否则直接放行，无需用户再点一次卡片
      this.enterYuhuaWorkspaceFlow();
      return;
    }
    if (this.data.complianceModalScene === 'privileged') {
      acknowledgeYuhuaPrivilegedDisclaimer();
      console.log('[YuhuaPlatform] privileged 档已写入本地确认标记，setData currentPlatformMode=yuhua 并触发工作区初始化');
      this.setData({ showComplianceModal: false, currentPlatformMode: 'yuhua' });
      this.syncStoresForZoneEntry();
    }
  },

  // 🏢 切店后校准平台模式：切店有可能跨平台边界（如超管从社区食堂门店切到雨花斋门店），
  // 避免"人已经在新门店的数据里，模式牌子却还挂着旧的"这种错乱状态。这里是被动校准，
  // 不是用户主动点卡片，所以不做 orgType 不匹配的拦截提示，只按新 orgType 静默纠正；
  // 纠正到 'yuhua' 且尚未同意声明时，仍会走完整的声明校验（不会绕过合规弹窗）
  reconcilePlatformModeWithOrgType() {
    if (!this.data.currentPlatformMode) return; // 还停留在工作空间选择首页，无需校准
    if (this.data.orgType === 'yuhuazhai') {
      if (this.data.currentPlatformMode !== 'yuhua') {
        this.enterYuhuaWorkspaceFlow();
      }
    } else if (this.data.currentPlatformMode !== 'general') {
      this.setData({ currentPlatformMode: 'general' });
    }
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
      listeningSeniors: report.listeningSeniors != null ? String(report.listeningSeniors) : '',
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

  /** 判断当前表单是否有有意义的未保存数据 */
  _hasFormDirtyData(): boolean {
    const { allDonations, dailyExpenseText, fixedExpenseItems, materialsInput, activityText, recipeImages, activityImages } = this.data;
    return !!(
      (allDonations && allDonations.trim()) ||
      (dailyExpenseText && dailyExpenseText.trim()) ||
      (fixedExpenseItems && fixedExpenseItems.length > 0) ||
      (materialsInput && materialsInput.trim()) ||
      (activityText && activityText.trim()) ||
      (recipeImages && recipeImages.length > 0) ||
      (activityImages && activityImages.length > 0)
    );
  },

  onUnload() {
    // 🛡️ 邀请码弹窗隐藏 custom-tab-bar 的安全网：正常关闭路径
    // （onCloseGenCodeModal/onCloseInviteResultModal）已经会恢复，这里防的
    // 是弹窗开着时用户通过非常规路径离开本页（如被其它逻辑强制 reLaunch），
    // 避免 custom-tab-bar 一直卡在隐藏态。已经是显示态时重复调用无副作用
    setTabBarHidden(this, false);
    // 🛡️ 页面卸载前，若有未保存数据则静默写入草稿，防止意外退出导致数据丢失
    if (this._hasFormDirtyData()) {
      this.saveDraft();
    }
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

    // 🛡️ 页面切走前，若有未保存数据则静默写入草稿
    if (this._hasFormDirtyData()) {
      this.saveDraft();
    }

    const app = getApp();
    app.globalData.onNetworkReconnected = null;
    this.releaseDraftLock();
  },

  async autoSyncOfflineQueue() {
    const queue = getQueue();
    if (queue.length === 0) {
      return;
    }

    const networkInfo = (wx as any).getNetworkTypeSync ? (wx as any).getNetworkTypeSync() : { networkType: 'wifi' };
    if (networkInfo.networkType === 'none') {
      return;
    }

    if (!isCloudAvailable()) {
      console.warn('[autoSyncOfflineQueue] 云服务不可用，跳过本轮离线队列同步');
      return;
    }

    let successCount = 0;
    let rejectedCount = 0;
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
        const saveResult = await DataService.saveReport({
          ...restItem,
          receiptImages: uploadResults
        });

        if (saveResult.success) {
          removeFromQueue(item.id);
          successCount++;
        } else if (isNonRetryableSaveError(saveResult.errorDetail)) {
          console.warn('[autoSyncOfflineQueue] 离线记录被规则拒绝，已从队列清除但不计入成功:', saveResult.errorDetail, saveResult.message);
          removeFromQueue(item.id);
          rejectedCount++;
        } else {
          // 未识别的失败原因（如云端临时故障）：保留在队列里，交给下一轮自动/手动同步重试
          console.warn('[autoSyncOfflineQueue] 离线记录同步失败，保留待重试:', saveResult.message);
        }
      } catch (error) {
        console.error('[autoSyncOfflineQueue] 同步失败:', error);
        break;
      }
    }

    if (successCount > 0 || rejectedCount > 0) {
      this.updateOfflineQueueCount();
    }
    if (successCount > 0 && rejectedCount === 0) {
      wx.showToast({
        title: `已为您自动同步 ${successCount} 条离线保存的账目汇报！🎉`,
        icon: 'none',
        duration: 3000
      });
    } else if (rejectedCount > 0) {
      // 🐛 根因修复：见上方 isNonRetryableSaveError 注释——这几条不是同步成功，
      // 必须明确告知用户去核对，不能被"已同步"的正向文案掩盖掉
      wx.showModal({
        title: '部分离线记录未能同步',
        content: successCount > 0
          ? `已同步 ${successCount} 条，另有 ${rejectedCount} 条因日期重复/门店已停用等原因被拒绝，未能保存，请前往历史记录核对。`
          : `${rejectedCount} 条离线记录因日期重复/门店已停用等原因被拒绝，未能保存，请前往历史记录核对。`,
        showCancel: false
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
    let rejectedCount = 0;
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
        const saveResult = await DataService.saveReport({
          ...restItem,
          receiptImages: uploadResults
        });

        if (saveResult.success) {
          removeFromQueue(item.id);
          successCount++;
        } else if (isNonRetryableSaveError(saveResult.errorDetail)) {
          console.warn('[syncOfflineQueueManually] 离线记录被规则拒绝，已从队列清除但不计入成功:', saveResult.errorDetail, saveResult.message);
          removeFromQueue(item.id);
          rejectedCount++;
        } else {
          // 未识别的失败原因（如云端临时故障）：保留在队列里，交给下一次手动/自动同步重试
          console.warn('[syncOfflineQueueManually] 离线记录同步失败，保留待重试:', saveResult.message);
        }
      } catch (error) {
        console.error('[syncOfflineQueueManually] 同步失败:', error);
        break;
      }
    }

    wx.hideLoading();
    this.updateOfflineQueueCount();

    if (successCount > 0 && rejectedCount === 0) {
      wx.showToast({
        title: `已成功同步 ${successCount} 条账目汇报！🎉`,
        icon: 'success',
        duration: 3000
      });
    } else if (rejectedCount > 0) {
      // 🐛 根因修复：见 isNonRetryableSaveError 处注释——这几条不是同步成功，
      // 必须明确告知用户去核对，不能被"同步成功"的正向文案掩盖掉
      wx.showModal({
        title: '部分离线记录未能同步',
        content: successCount > 0
          ? `已同步 ${successCount} 条，另有 ${rejectedCount} 条因日期重复/门店已停用等原因被拒绝，未能保存，请前往历史记录核对。`
          : `${rejectedCount} 条离线记录因日期重复/门店已停用等原因被拒绝，未能保存，请前往历史记录核对。`,
        showCancel: false
      });
    } else {
      wx.showToast({ title: '同步失败，请检查网络', icon: 'none' });
    }
  },

  // 🍚 按门店开启的餐次动态生成供餐人数汇总：数据源是 mealReserveCounts（后厨
  // 预留量统计，见 syncCheckInHoursToForm），只保留当前门店 supportedMeals 里的
  // 餐别。仅在门店开放不止一个餐次时才需要这份细分——只供一种餐次的门店（多数
  // 雨花斋）本就只有一个数字，与既有的 diningCount/volunteerCount 汇总重复，
  // 不额外占用餐报/海报的篇幅
  buildMealBreakdown(): Array<{ label: string; count: number }> {
    const supportedMeals = this.data.supportedMeals || ['lunch'];
    if (supportedMeals.length <= 1) return [];

    const counts = this.data.mealReserveCounts || { breakfast: 0, lunch: 0, dinner: 0 };
    const MEAL_LABELS: Record<string, string> = { breakfast: '早餐留餐', lunch: '午餐留餐', dinner: '晚餐留餐' };
    return supportedMeals
      .filter((m: string) => MEAL_LABELS[m])
      .map((m: string) => ({ label: MEAL_LABELS[m], count: counts[m] || 0 }));
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
      mealBreakdown: this.buildMealBreakdown(),
      verifyQrLocalPath: this.data.verifyQrLocalPath,
      showFamilyStyleFooter: this.data.posterShowFamilyStyleFooter,
      showGratitudeFooter: this.data.posterShowGratitudeFooter,
      patriarchName: this.data.storePatriarchName,
      managerName: this.data.storeManagerName,
      showPeopleSignature: this.data.posterShowPeopleSignature,
      isAnonymous: this.data.meritType === 'yin'
    };
  },

  // 🏛️ 拉取本店护持家长/日常店长姓名，供海报落款使用——复用 manageStoreProfile 的
  // get action（该函数已经在读整份 stores 文档，patriarch/manager 是其中的缓存字段，
  // 不需要额外查询）。失败时静默降级为空字符串，不阻断海报生成主流程
  async fetchStorePeopleNames() {
    try {
      if (!isCloudAvailable()) return;
      const res: any = await callFunctionWithTimeout({
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
        mealBreakdown: this.buildMealBreakdown(),
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

  // 🖨️ 导出打印清单：复用生成海报同一份 buildFinancialPosterData()，只是换成
  // printRenderer.ts 的纯黑白高对比度版式（无渐变/无圆角装饰、大字号、粗边框），
  // 供年长义工/长辈直接连接便携热敏打印机打印，或长按保存成白底黑字高清图片。
  // 导出后走 wx.previewImage 原生长按保存/分享，不额外起一个自定义预览弹窗。
  async onExportPrintList() {
    if (this.data.isGeneratingPrintList) return;

    if (!this.data.showResult) {
      wx.showModal({
        title: '提示',
        content: '请先点击「⚡ 生成文本」生成日报内容，再导出打印清单。',
        showCancel: false
      });
      return;
    }

    this.setData({ isGeneratingPrintList: true });
    wx.showLoading({ title: '正在生成打印清单...', mask: true });

    try {
      const printData = {
        ...this.buildFinancialPosterData(),
        diningCount: parseFloat(this.data.diningCount) || 0
      };
      const printImagePath = await drawPrintList(this, printData);
      wx.hideLoading();
      wx.previewImage({
        urls: [printImagePath],
        current: printImagePath
      });
    } catch (err: any) {
      console.error('[onExportPrintList] 打印清单生成失败:', err);
      wx.hideLoading();
      wx.showToast({ title: err.message || '打印清单生成失败', icon: 'none', duration: 3000 });
    } finally {
      this.setData({ isGeneratingPrintList: false });
    }
  },

  closePoster() {
    this.setData({ showPoster: false });
  },

  // 🛡️ 海报图片加载失败兜底：posterImage 是 Canvas 生成的本地临时文件，小概率
  // 在渲染前被系统清理——清空该字段退回空白，提示用户重新生成，而不是留一块裂图
  onPosterImageLoadError(e: any) {
    console.warn('[onPosterImageLoadError] 海报图片加载失败:', e && e.detail);
    this.setData({ posterImage: '' });
    wx.showToast({ title: '海报加载失败，请重新生成', icon: 'none' });
  },

  onClosePosterModal() {
    this.setData({ showPosterModal: false });
  },

  onPreviewQrCode() {
    if (this.data.qrCodeState !== 'ready' || !this.data.qrCodeUrl) {
      // 🐛 修复"点击重试没反应"：qrCodeState 的默认值是 'idle'（从未生成过），
      // 不是 'failed'——此前这里只在 'failed' 时才重新调用 generateQrCode()，
      // 如果用户这次会话从没成功触发过一次生成（比如没点过【生成公示海报】），
      // 打卡成功弹出的餐报海报里这枚二维码会一直停在 'idle'，点"点击重试"
      // 匹配不到 'failed' 分支，直接落空什么都不做。'idle' 与 'loading' 中途
      // 也允许再点一次触发（loading 时 generateQrCode 内部会被新一轮请求覆盖，
      // 不会产生阻塞，与其它"点击重试"入口的宽容度保持一致）
      if (this.data.qrCodeState !== 'loading') this.generateQrCode();
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

      const storeId = this.data.currentStoreId || '';
      const storeName = this.data.currentStoreName || this.data.shopName || '';

      // 🐛 根因修复：此前不传 purpose，落进 getStoreQRCode 的默认"门店推广邀请码"
      // 分支（仅 store_manager/super_admin 可生成）——这枚二维码是打卡成功后
      // 餐报海报底部"扫码查看透明账本"用途，义工本人就是最主要的查看者，必须
      // 传 purpose:'checkin_share' 命中该云函数里与证书码同档的低风险豁免，
      // 否则普通义工账号调用必然返回"无权限生成二维码"，点多少次重试都没用
      const requestData = { storeId, storeName, purpose: 'checkin_share' };
      console.log('[PosterQR] 发起 getStoreQRCode 调用，入参=', requestData,
        'currentUserRole=', this.data.currentUserRole);
      const qrRes = await callFunctionWithTimeout({
        name: 'getStoreQRCode',
        data: requestData
      });
      const qrResult = qrRes.result as any;
      console.log('[PosterQR] getStoreQRCode 返回=', qrResult);

      if (!qrResult || !qrResult.success || !qrResult.fileID) {
        // 🐛 字段名修复：getStoreQRCode 云函数失败时返回的是 `{success:false,
        // error:'...'}`（字段名是 error，不是 errMsg）——此前这里一直读
        // qrResult.errMsg，永远是 undefined，导致服务端真正的失败原因（如
        // "无权限生成二维码"）从没能透传到这里的 Error/日志里，只会看到一个
        // 毫无信息量的兜底文案"二维码生成失败"，没法从控制台判断真实根因
        console.error('[PosterQR] 生成失败原因:', qrResult && qrResult.error, '完整返回:', qrResult);
        throw new Error((qrResult && qrResult.error) || '二维码生成失败');
      }

      // 必须等云存储文件真正下载到本地 wxfile:// 临时路径后，再切换为 ready 触发 <image> 渲染，
      // 避免直接把 cloud:// fileID 或半下载状态的路径丢给 <image>/canvas drawImage 导致空白
      const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
      if (!downRes || !downRes.tempFilePath) {
        throw new Error('二维码文件下载失败');
      }

      this.setData({ qrCodeUrl: downRes.tempFilePath, qrCodeState: 'ready' });
    } catch (err) {
      console.error('[PosterQR] 生成失败原因:', err);
      this.setData({ qrCodeUrl: '', qrCodeState: 'failed' });
    }
  },

  // 🆕 海报「扫码验真」区域的真实二维码：指向 subpackages/admin/pages/public-verify/index，携带
  // 当前门店 storeId + 报告日期，与首页推广码（generateQrCode，指向 pages/index/index）
  // 是两个不同用途的码，各自独立生成/下载，互不影响。
  //
  // 🐛 修复"加载失败只显示占位、没有重试入口"：此前这里是单次尝试，云函数调用
  // 或 downloadFile 任一环节网络抖动失败就直接放弃、返回空字符串，海报里这块
  // 永久烙印成占位框，用户唯一的补救办法是关掉整张海报重新点【生成公示海报】
  // 从头再来一遍（连带重算财务数据），成本很高。现在：
  //  ① 云函数调用 + 下载各自最多重试 MAX_ATTEMPTS 次（间隔递增退避），网络抖动
  //     这类瞬时失败在重试窗口内大概率能自愈，不需要用户介入；
  //  ② 仍失败到底时才回退占位框，同时置位 posterVerifyQrFailed，供 WXML 展示
  //     一条可点击的重试提示（.poster-qr-retry-banner，见 onRetryVerifyQr），
  //     不需要重新生成整张海报，只重新拉这一枚二维码并原地重绘。
  async resolveVerifyQrLocalPath(): Promise<string> {
    const MAX_ATTEMPTS = 3;

    if (!isCloudAvailable()) {
      console.warn('[resolveVerifyQrLocalPath] 云开发不可用，跳过验真二维码生成');
      return '';
    }

    const storeId = this.data.currentStoreId || '';
    const storeName = this.data.currentStoreName || this.data.shopName || '';
    const dateString = deriveDateString(this.data.reportDateValue, this.data.reportDate);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // 🐛 优先复用已生成过的 fileID 重新下载，而不是每次重试都重新调云函数——
        // getStoreQRCode 的 scene 固定编码为 storeId+purpose+date，同一份码在
        // 云存储里是可复用的永久 fileID（cloud://），只有本地临时下载失败时才
        // 值得重试；云函数调用本身失败（如首次尚未生成过）仍走完整流程
        const qrRes = await callFunctionWithTimeout({
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

        if (attempt > 1) {
          console.log(`[resolveVerifyQrLocalPath] 第${attempt}次重试成功`);
        }
        this.setData({ posterVerifyQrFailed: false });
        return downRes.tempFilePath;
      } catch (err) {
        console.warn(`[resolveVerifyQrLocalPath] 第${attempt}/${MAX_ATTEMPTS}次尝试失败:`, err);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
    }

    console.warn('[resolveVerifyQrLocalPath] 已达最大重试次数，海报将回退为占位框');
    this.setData({ posterVerifyQrFailed: true });
    return '';
  },

  // 🔄 验真二维码重试入口：不重新生成整张海报（不重算财务数据、不重新走内容
  // 安全检测），只重新拉这一枚二维码，成功后按当前展示的版式（财务公示版/
  // 温馨故事版）原地重绘一次，替换掉预览里那张占位框海报
  async onRetryVerifyQr() {
    if (this.data.isSwitchingPosterType) return;
    this.setData({ isSwitchingPosterType: true });
    wx.showLoading({ title: '正在重新获取二维码...', mask: true });

    try {
      const verifyQrLocalPath = await this.resolveVerifyQrLocalPath();
      this.setData({ verifyQrLocalPath });

      if (!verifyQrLocalPath) {
        wx.showToast({ title: '二维码仍获取失败，请稍后重试', icon: 'none', duration: 2500 });
        return;
      }

      const posterImagePath = this.data.posterType === 'story'
        ? await drawStoryPoster(this, this.buildStoryPosterData())
        : await drawMeritPoster(this, this.buildFinancialPosterData());
      this.setData({ posterImage: posterImagePath });
      wx.showToast({ title: '二维码已恢复', icon: 'success' });
    } catch (err: any) {
      console.error('[onRetryVerifyQr] 重试失败:', err);
      wx.showToast({ title: err.message || '重试失败，请稍后再试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ isSwitchingPosterType: false });
    }
  },

  stopPropagation() {},

  // ☀️ 阳光账本入口（首页顶部卡片）：跳转统计页 ?tab=sunshine，落地到该页
  // 新增的「☀️ 阳光大盘」真实数据区块，取代此前 onOpenSunshineLedger 只弹一个
  // 理念/宣言 Modal、弹完无处可去的死胡同。onOpenSunshineLedger 本体保留不动——
  // 家人首页大卡片的"查看完整账本"、以及 Profile「关于雨花斋与阳光账本」的
  // 跨页交接（见 checkPendingHandoffs/requestOpenSunshineLedger）仍在用它
  onGoToSunshineBoard() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    safeNavigateTo({
      url: '/pages/statistics/statistics?tab=sunshine',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

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
      const res: any = await callFunctionWithTimeout({
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
      const isYuhuazhai = this.data.orgType === 'yuhuazhai';
      // 🆕 理念弹窗文案：result.orgType 是这次调用刚拿到的门店真实业态类型，
      // 优先于 this.data.orgType（那个字段只区分"是否雨花斋"，颗粒度不够）
      const conceptCopy = computeConceptCopy(result.orgType || '', ledgerData.storeName || this.data.currentStoreName);
      this.setData({
        sunshineLedgerData: ledgerData,
        conceptTitle: conceptCopy.title,
        conceptLabel: conceptCopy.label,
        conceptContent: conceptCopy.content,
        // 📊 完美 4x2 网格：固定 8 项，缺数据时展示"暂无数据"而不是编造出的百分比；
        // 工时/志愿人次标签随 orgType 动态切换：雨花斋用"护持"，其他组织用"服务/志愿"
        sunshineStatCards: [
          { label: '累计就餐人次', value: String(ledgerData.totalDiners) },
          { label: '当月就餐人次', value: String(ledgerData.monthlyDiners) },
          { label: '爱心送餐份数', value: String(ledgerData.takeawayMeals) },
          { label: isYuhuazhai ? '累计护持工时' : '累计服务工时', value: String(ledgerData.totalHours) },
          { label: isYuhuazhai ? '参与护持总人次' : '参与志愿总人次', value: String(ledgerData.volunteerCount) },
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
      const result = await callFunctionWithTimeout({
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
  // 📖 【机构文化与每日家训】弹窗：先按真实 orgType 定标题；只有 yuhuazhai 才
  // 装配 utils/cultureData.ts 那套雨花斋专属十大模块原文（module 7/雨花家训
  // 沿用既有三个字段，不重复赋值）。其余机构（elderly_canteen 社区助餐/敬老
  // 中心、以及未设置 orgType 的通用公益门店）没有对应的权威素材，一律走通用
  // 分支——WXML 侧按 orgType 二选一渲染，不把雨花斋内容套到其他机构头上
  onShowFamilyMottoModal() {
    // 🐛 防呆兜底：orgType 是服务端已存的门店归属值，账号尚未绑定具体门店时
    // 恒为空字符串——但用户当下明明正停留在雨花工作空间（currentPlatformMode
    // === 'yuhua'，如通过 openStorePickerForJoin 选站点前的过渡态），此时弹出
    // 面向其它机构的通用占位文案会显得文不对题。只要当前处在雨花专区，即使
    // orgType 还没落地，也按 yuhuazhai 处理，展示真正的十篇章内容
    const orgType = this.data.orgType || (this.data.currentPlatformMode === 'yuhua' ? 'yuhuazhai' : '');
    this.setData({ cultureModalTitle: computeCultureModalTitle(orgType) });

    // 🐛 根因修复：this.data.orgType 只有 onLoad 里 await initCurrentUserRole()
    // 才会用服务端最新值刷新一次；本页在 tab 间切换回来时只走
    // refreshUserRoleView()（纯本地缓存/storage，不发请求），如果用户是在个人
    // 页【组织信息配置】里刚把门店 orgType 改成 yuhuazhai、再切回首页直接点
    // 这个入口，用到的还是切页前缓存的旧值，弹窗会误走非雨花斋的占位分支。
    // 先用旧值秒开弹窗（不为了这次校验让用户等一次网络请求），再异步拿一次
    // 服务端权威值，真的对不上时才用新值重新装配一遍——多数情况下 orgType
    // 没变，这次异步刷新不会有任何可感知的界面变化
    this.refreshCultureModalOrgTypeIfStale();

    if (orgType !== 'yuhuazhai') {
      this.setData({ showFamilyMottoModal: true });
      return;
    }

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

  // 🐛 见 onShowFamilyMottoModal 同处注释：异步向服务端要一次最新 orgType，
  // 如果确实跟弹窗打开时用的缓存值不一样（且弹窗此刻还开着，没被关掉），
  // 用新值重新调用一次 onShowFamilyMottoModal 重新装配标题与内容——该方法
  // 本身是幂等的（每次都是按当前 this.data.orgType 重新算一遍），可以安全
  // 再调一次，不会有累积状态的副作用
  async refreshCultureModalOrgTypeIfStale() {
    try {
      const fresh = await AuthService.fetchUserRole();
      const freshOrgType = (fresh.success && fresh.roleInfo && (fresh.roleInfo as any).orgType) || '';
      if (freshOrgType && freshOrgType !== this.data.orgType && this.data.showFamilyMottoModal) {
        this.setData({ orgType: freshOrgType });
        this.onShowFamilyMottoModal();
      }
    } catch (err) {
      console.warn('[refreshCultureModalOrgTypeIfStale] 刷新 orgType 失败:', err);
    }
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
      const res = await callFunctionWithTimeout({
        name: 'manageNotice',
        data: { action: 'list', storeId }
      });
      const result = res.result as any;
      const rawList = (result && result.success && Array.isArray(result.data)) ? result.data : [];
      const noticeList = rawList.map(mapNoticeRecord);

      this.setData({
        noticeList,
        currentNoticeIndex: 0,
        noticeSwiperCurrent: 0,
        announcement: noticeList.length > 0 ? noticeList[0] : null,
        isNoticeBarHiddenToday: isHiddenToday,
        noticesLoading: false
      });
      this.measureNoticeMarquee();
    } catch (e) {
      console.error('[fetchNotices] 查询失败:', e);
      this.setData({
        noticeList: [],
        currentNoticeIndex: 0,
        noticeSwiperCurrent: 0,
        announcement: null,
        isNoticeBarHiddenToday: isHiddenToday,
        noticesLoading: false,
        noticeMarqueeActive: false,
        noticeSwiperAutoplay: true
      });
    }
  },

  // 轮播切换：记下当前滚动到第几条，点击时才知道该打开详情弹窗里的哪一条；
  // 每次换条都要重新量一遍新标题是否需要跑马灯（见 measureNoticeMarquee）
  onSwiperNoticeChange(e: any) {
    const idx = e.detail.current;
    const item = this.data.noticeList[idx] || null;
    this.setData({ currentNoticeIndex: idx, noticeSwiperCurrent: idx, announcement: item });
    this.measureNoticeMarquee();
  },

  // 🌟 量出当前 announcement 标题的自然宽度（靠隐形探针 #noticeMarqueeProbe），
  // 与 .announce-bar-viewport 的可视宽度比较：放得下就保持静止（ellipsis 兜
  // 底，行为与此前一致）；放不下才激活跑马灯，并暂停 swiper 自动轮播——不然
  // 3s 一次的轮播间隔会在标题还没滚完时就把它切走
  measureNoticeMarquee() {
    if (!this.data.announcement) {
      this.setData({ noticeMarqueeActive: false, noticeSwiperAutoplay: true });
      return;
    }
    wx.nextTick(() => {
      const query = wx.createSelectorQuery().in(this);
      query.select('#noticeMarqueeProbe').boundingClientRect();
      query.select('.announce-bar-viewport').boundingClientRect();
      query.exec((res: any[]) => {
        const probeRect = res && res[0];
        const viewportRect = res && res[1];
        if (!probeRect || !viewportRect) return;
        const overflow = probeRect.width > viewportRect.width;
        this.setData({
          noticeMarqueeActive: overflow,
          noticeSwiperAutoplay: !overflow
        });
      });
    });
  },

  // 跑马灯一轮完整周期（12s：停留 3s + 滚动 + 瞬时重置，见 index.wxss
  // @keyframes announce-marquee-cycle）跑完后触发——bindanimationiteration 对
  // infinite 动画每轮循环都会触发一次，借这个时机主动把 swiper 切到下一条，
  // 而不是让它无限滚同一条；切换后交给 onSwiperNoticeChange →
  // measureNoticeMarquee 重新判断新的一条是否还需要跑马灯
  onNoticeMarqueeCycle() {
    const { noticeList, currentNoticeIndex } = this.data;
    if (!noticeList || noticeList.length <= 1) return;
    const nextIdx = (currentNoticeIndex + 1) % noticeList.length;
    this.setData({ noticeSwiperCurrent: nextIdx });
  },

  // 关闭通知栏：写入"今天"这个日期，整条隐藏不留空白；到了新的一天这个判断
  // 自然失效，不需要额外的清理逻辑
  // 🌟 优雅收起 + 防抖：先切到 closing 态播放收起动效（max-height/opacity 过渡，
  // 见 index.scss .announce-bar-closing），动效播完再真正移出 wx:if；
  // isNoticeBarClosing 守卫防止动效播放期间连续点击 X 反复触发/写入
  onCloseNoticeBar() {
    if (this.data.isNoticeBarClosing) return;
    this.setData({ isNoticeBarClosing: true });

    setTimeout(() => {
      const todayStr = new Date().toISOString().split('T')[0];
      wx.setStorageSync('notice_bar_hidden_date', todayStr);
      this.setData({ isNoticeBarHiddenToday: true, isNoticeBarClosing: false });
    }, 280);
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

    // 🐛 同一处根因修复：tag 为空时不再硬编码回退成"喜讯通报"，改用
    // mapNoticeRecord 已经按标题+正文语义算好的 typeLabel（如"物资接力"/
    // "系统公告"），避免复制出去的分享文案标签与内容本身语义矛盾
    const text = `${announcement.tag || announcement.typeLabel || '系统公告'}：${announcement.title}\n\n${announcement.content}\n\n发布时间：${announcement.create_time}`;
    
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
  // 🐛 根因修复："物资告急类通知被打上喜讯通报标签"的源头之一：此前 tag 输入框
  // 缺省值硬编码死"喜讯通报"，与本条通知标题/正文实际语义无关——编辑时如果没
  // 注意到去手动改，保存后就会把这个跟内容语义矛盾的标签写回数据库。改为已有
  // tag 优先沿用，缺失时按标题+正文关键词自动建议（classifyNotice），而不是
  // 无脑塞一个固定分类
  openNoticeEdit() {
    const { announcement, mergeToReportText } = this.data;
    if (!announcement) return;

    const suggestedTag = announcement.tag || classifyNotice('', announcement.title, announcement.content).typeLabel;

    this.setData({
      showAnnouncementModal: false,
      showNoticeEditModal: true,
      noticeEditId: announcement.id || '',
      noticeEditTag: suggestedTag,
      noticeEditTitle: announcement.title || '',
      noticeEditContent: announcement.content || '',
      mergeToReportText: mergeToReportText,
      saveAsSystemTemplate: false
    });
    this.fetchNoticeTemplates();
  },

  // 新建一条通知（同一个编辑弹窗，只是清空并且不带 id）
  // 🐛 同上一处 openNoticeEdit 注释：新建时还没有任何标题/正文可供判断语义，
  // 不再硬编码"喜讯通报"这个具体分类，留空强制发布方按实际内容主动选择/填写
  // （下方"一键套用预设文案"选中任一预设时，tag 会随该预设一起正确带入）
  openNoticeCreate() {
    this.setData({
      showNoticeEditModal: true,
      noticeEditId: '',
      noticeEditTag: '',
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
      const res = await callFunctionWithTimeout({
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
  // 🆕 高危操作二次确认：标题/正文任一已有内容时，套用会整体覆盖当前已填内容，
  // 弹窗二次确认避免误触丢失编辑中的文字；内容为空时直接套用，不额外打断操作
  onApplyCloudTemplate(e: any) {
    const id = e.currentTarget.dataset.id;
    const tpl = this.data.noticeTemplates.find((t: any) => t._id === id);
    if (!tpl) return;

    const applyTemplate = () => {
      this.setData({
        noticeEditTag: tpl.tag || '',
        noticeEditTitle: tpl.title || '',
        noticeEditContent: tpl.content || ''
      });
      wx.showToast({ title: '已导入模板', icon: 'success', duration: 1500 });
    };

    if (this.data.noticeEditTitle.trim() || this.data.noticeEditContent.trim()) {
      wx.showModal({
        title: '确认替换内容？',
        content: `套用「${tpl.title}」将替换当前已填写的标题与正文，且无法撤销`,
        confirmText: '确认替换',
        confirmColor: '#E03131',
        success: (res) => {
          if (res.confirm) applyTemplate();
        }
      });
      return;
    }
    applyTemplate();
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
      const res = await callFunctionWithTimeout({
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

  // 🆕 高危操作二次确认：标题/正文任一已有内容时，套用预设会整体覆盖当前已填
  // 内容，弹窗二次确认避免误触丢失编辑中的文字；内容为空时直接套用，不额外打断
  onApplyPreset(e: any) {
    const key = e.currentTarget.dataset.key as NoticePresetType;
    // 🛡️ 全国总览视角下 currentStoreName 是"全国总览"这类虚拟聚合名，不是真实
    // 门店名，不能塞进通报正文——让 getNoticeTemplate 自己的兜底称谓接管
    const rawStoreName = this.data.currentStoreName || '';
    const isVirtualStoreName = rawStoreName === '全国总览' || rawStoreName === 'ALL_STORES';
    const storeName = isVirtualStoreName ? '' : rawStoreName;
    const preset = getNoticeTemplate(key, this.data.orgType, storeName);
    if (!preset) return;

    const applyPreset = () => {
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
    };

    if (this.data.noticeEditTitle.trim() || this.data.noticeEditContent.trim()) {
      wx.showModal({
        title: '确认替换内容？',
        content: `套用「${preset.title}」将替换当前已填写的标题与正文，且无法撤销`,
        confirmText: '确认替换',
        confirmColor: '#E03131',
        success: (res) => {
          if (res.confirm) applyPreset();
        }
      });
      return;
    }
    applyPreset();
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
      const res = await callFunctionWithTimeout({
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

    safeNavigateTo({
      url: '/pages/history/history',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  goToStatistics() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    safeNavigateTo({
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
    this._scrollToAnchor('#managerConsoleAnchor', '店务管理');
  },

  onScrollToFinanceConsole() {
    this._scrollToAnchor('#financeConsoleAnchor', '财务稽核台');
  },

  // 🐛 根因排查：此前 wx.pageScrollTo 直接传 selector，既没有 fail 回调也没有
  // 任何前置校验——.index-page-container 是 height:100vh 的 flex 列容器，
  // 大部分内容区（.page-body-scroll）走的是内部 scroll-view 独立滚动，只有
  // 非义工视角这段"打卡卡片+店务管理+财务稽核台"卡片位于该 scroll-view 之外
  // （见 index.wxss .page-body-scroll 头部注释），真正依赖原生页面级滚动。
  // 一旦这段内容总高度恰好未超出可视区（如某些机型/字号下 anchor 本就在首屏
  // 内可见）或选择器因任何原因查不到节点，selector 版 pageScrollTo 只会
  // 悄无声息地什么都不做——控制台没有一行日志、没有报错、也没有 toast，
  // 与"按钮点了没反应"的现象完全吻合。改为先用 SelectorQuery 显式定位目标
  // 节点再计算 scrollTop 滚动，找不到节点或滚动失败都会打日志+弹 toast，
  // 把"静默无效"变成"看得见原因"
  _scrollToAnchor(selector: string, label: string) {
    console.log('[Navigate] 触发滚动定位:', label, selector);
    const query = wx.createSelectorQuery();
    query.select(selector).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((res) => {
      const rect = res && res[0];
      const viewport = res && res[1];
      if (!rect) {
        console.error('[_scrollToAnchor] 未找到目标节点:', selector);
        wx.showToast({ title: `暂时无法定位${label}入口，请下滑页面查看`, icon: 'none' });
        return;
      }
      const targetTop = Math.max(0, (viewport ? viewport.scrollTop : 0) + rect.top - 20);
      wx.pageScrollTo({
        scrollTop: targetTop,
        duration: 300,
        fail: (err) => {
          console.error('[_scrollToAnchor] pageScrollTo 失败:', selector, err);
          wx.showToast({ title: `${label}定位失败，请下滑页面查看`, icon: 'none' });
        }
      });
    });
  },

  // 🛠️ 义工现场服务工具金刚区：菜单人数/物资消耗两个填报弹窗是独立自定义组件
  // （daily-menu-modal/material-usage-modal），原地直弹，不再跨 Tab 跳转到
  // 个人页。打开前调用组件暴露的 resetForm() 清空表单（对齐此前 profile.ts
  // onOpenDailyMenuModal 的"每次打开都是全新登记"行为）
  // 🛡️ 现场服务工具三个入口共用的门店绑定校验：超管在"全国总览"虚拟视角下，或
  // 账号异常缺失 storeId 时，直接拦在打开表单之前，用优雅 Toast 引导去先选定具体
  // 门店——而不是让用户填完整张表单后才在提交那一刻收到服务端"未识别到您所在的
  // 门店"报错。这三个工具（登记菜单人数/登记物资消耗/记录护持动态）背后的
  // manageVolunteerSubmission/activity-log 都需要一个真实门店作为归属，虚拟的
  // "全国总览" ID 不对应任何真实门店文档
  ensureStoreBoundForTool(resumeAction?: () => void): boolean {
    const NATIONAL_IDS = ['national_overview', 'ALL_STORES', 'all'];
    const storeId = this.data.currentStoreId;
    if (!storeId || NATIONAL_IDS.includes(storeId)) {
      wx.showToast({ title: '全国总览模式，请先选择具体门店', icon: 'none', duration: 2000 });
      if (resumeAction) {
        this._pendingStoreSelectAction = resumeAction;
      }
      // 延迟 300ms 让 Toast 先显示，再唤起门店选择器
      setTimeout(() => {
        const picker = this.selectComponent('#storePicker');
        if (picker && typeof picker.onOpenSheet === 'function') {
          picker.onOpenSheet();
        }
      }, 300);
      return false;
    }
    return true;
  },

  onTapToolDailyMenu() {
    const open = () => {
      const modal = this.selectComponent('#dailyMenuModal') as any;
      if (modal) modal.resetForm();
      this.setData({ showDailyMenuModal: true });
    };
    if (!this.ensureStoreBoundForTool(open)) return;
    open();
  },

  onCloseDailyMenuModal() {
    this.setData({ showDailyMenuModal: false });
  },

  onTapToolMaterialUsage() {
    const open = () => {
      const modal = this.selectComponent('#materialUsageModal') as any;
      if (modal) modal.resetForm();
      this.setData({ showMaterialUsageModal: true });
    };
    if (!this.ensureStoreBoundForTool(open)) return;
    open();
  },

  onCloseMaterialUsageModal() {
    this.setData({ showMaterialUsageModal: false });
  },

  onTapToolElderCheckin() {
    const open = () => {
      const modal = this.selectComponent('#elderCheckinModal') as any;
      if (modal) modal.resetForm();
      this.setData({ showElderCheckinModal: true });
    };
    if (!this.ensureStoreBoundForTool(open)) return;
    open();
  },

  onCloseElderCheckinModal() {
    this.setData({ showElderCheckinModal: false });
  },

  // 👵 长辈签到提交成功后的人数合并：elder-checkin-modal 已经把这次代报
  // 落库到独立的 elder_checkin_logs 流水（ledgerIngestionAdapter），这里只
  // 负责把 +1 合并进当前表单内存态，效果等同于人工在"义工与用餐统计"里手动
  // +1——之所以不能让云函数直接对 report_logs.dineInSeniors 做后台自增，
  // 是因为 DataService.saveReport 每次保存都会把当前表单整份覆盖回库，后台
  // 自增会被下一次正常保存静默冲掉（详见 ledgerIngestionAdapter 头部注释）。
  // 送餐到家类服务算送餐人次，其余（含堂食/家属代报）算堂食人次。
  onElderCheckinSubmitted(e: any) {
    const detail = e.detail || {};
    const isDelivery = detail.serviceType === '送餐到家';
    const field = isDelivery ? 'deliverySeniors' : 'dineInSeniors';
    const current = parseFloat(this.data[field]) || 0;
    this.setData({ [field]: String(current + 1) });
    this.recalcDiningStats();
  },

  // 📷 记录今日护持动态：本来就是独立页面（活动日志），个人页的同名入口
  // （onOpenVolunteerJournalModal）也是直接 navigateTo 过去，这里跳同一个
  // 目标页面即可，不需要交接标记
  onTapToolVolunteerJournal() {
    const open = () => {
      if (this.isNavigating) return;
      this.isNavigating = true;
      safeNavigateTo({
        url: '/subpackages/admin/pages/activity-log/activity-log',
        fail: () => { this.isNavigating = false; }
      });
    };
    if (!this.ensureStoreBoundForTool(open)) return;
    open();
  },

  // 🔗 打卡工时自动联动：拉取今日门店所有打卡工时并预填【服务总工时】字段。
  // force=true  → 忽略手动覆盖标记（check-in/revoke 成功后强制刷新）
  // force=false → 若用户已手动改过数值则跳过，避免覆盖大家长的手工修正
  async syncCheckInHoursToForm(force = false) {
    // 仅管理岗位有权限查询全店打卡数据
    if (!this.data.isManager && !this.data.isPatriarch) return;
    // 非强制模式下尊重手动输入
    if (!force && this.data.isManualHours) return;

    const reportDateValue = this.data.reportDateValue;
    // 北京时间今日日期字符串
    const todayStr = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // 历史记录编辑时不自动覆盖
    if (reportDateValue && reportDateValue !== todayStr) return;
    const dateString = reportDateValue || todayStr;

    const currentStoreId = this.data.currentStoreId || '';
    if (!currentStoreId || !isCloudAvailable()) return;

    // 同日防重复拉取（force=true 时跳过缓存，例如打卡刚完成）
    if (!force && this._checkInHoursCachedDate === dateString) return;

    try {
      const res: any = await callFunctionWithTimeout({
        name: 'manageVolunteerCheckIn',
        data: { action: 'queryStoreHours', storeId: currentStoreId, dateString }
      });
      const result = res.result;
      this._checkInHoursCachedDate = dateString;

      if (result && result.success) {
        // 🍚 后厨预留量统计：无论今日是否已有打卡工时都同步一次，供餐报文本/公示
        // 海报的"供餐人数汇总"引用（见 buildMealBreakdown）
        this.setData({
          mealReserveCounts: result.mealCounts || { breakfast: 0, lunch: 0, dinner: 0 }
        });
      }

      if (result && result.success && result.totalHours > 0) {
        // force 时重置 isManualHours，确保本次打卡数据能写入
        this.setData({
          volunteerHours: String(result.totalHours),
          checkInHoursTip: `💡 ${result.uniqueVolunteers}人次打卡`,
          isManualHours: false
        });
      } else {
        this.setData({ checkInHoursTip: '' });
      }
    } catch (err) {
      console.warn('[syncCheckInHoursToForm] 打卡工时同步失败:', err);
    }
  },

  // 🏛️ 业务模型重构入口：本方法此前只负责"按门店开放餐次过滤 shiftDefinitions
  // + 标记哪些班次今日已完成"，现在拆成两件独立的事——① 过滤/标记 availableMealSlots
  // （时段维度，逻辑与此前一致，只是数据源从 shiftDefinitions 换成
  // mealSlotDefinitions）② 每次唤起弹窗都重置 selectedJobTypes/manualHoursAdjust
  // （工种维度是"这一次打卡具体干了什么"的临时选择，不应该带着上一次打卡的
  // 残留状态）。选中工时不再从某个固定班次直接取值，改由 recomputeShiftHours()
  // 统一计算
  refreshTodayShiftStatus() {
    const todayStr = new Date().toISOString().split('T')[0];
    // 🛡️ 健壮性加固：`|| []` 只挡得住 null/undefined，挡不住 storage 里意外
    // 存成非数组真值（如损坏的旧版本数据）的情况——那种脏值会原样通过 `|| []`
    // 往下传，todayLogs.filter/wx:for 等后续消费点才会踩坑。这里改用
    // Array.isArray 做真正的形状校验，与 fetchAllStoresList 同一套防护口径
    const rawLogs = wx.getStorageSync('my_checkin_logs');
    const logs = Array.isArray(rawLogs) ? rawLogs : [];

    const todayLogs = logs.filter((log: any) => log.date === todayStr);
    const completedSlotKeys = new Set(todayLogs.map((log: any) => log.shiftKey));
    const todayHours = todayLogs.reduce((sum: number, log: any) => sum + (parseFloat(log.hours) || 0), 0);
    const todayAccumulatedHours = parseFloat(todayHours.toFixed(1));

    // 🛡️ mealSlotDefinitions/jobTypeDefinitions 只在页面 data 初始化时赋值一次
    // （见 data 块声明处），本页面代码里没有任何地方会用 setData 覆盖成其它值，
    // 理论上不可能是 undefined——这里仍加一层 Array.isArray 兜底，belt-and-
    // suspenders，避免今后有人不小心在别处 setData 覆盖了这两个字段却没保证
    // 形状，导致下面 .map() 直接抛错中断整个工作区切换渲染
    const mealSlotDefinitions = Array.isArray(this.data.mealSlotDefinitions) ? this.data.mealSlotDefinitions : [];

    // 🐛 2026-08 修复：此前按门店 supportedMeals 过滤 mealSlotDefinitions，
    // 只供午餐的门店（多数雨花斋）会导致早市/晚市班次直接从列表里消失——但
    // 打卡这一动作本身跟门店"卖不卖这顿饭"是两回事：义工可能在早市开餐前
    // 备菜、在晚市没有正式供餐的门店里做晚间保洁/收尾，这些护持工时依然需要
    // 记录。打卡时段固定展示 mealSlotDefinitions 里全部 4 档（早/午/晚/全天），
    // 不再按 supportedMeals 收窄；supportedMeals 只继续用于"留店用餐"细分
    // 餐别 Chip（getDefaultReservedMeal/.meal-type-chip-row）——那个场景问的是
    // "门店今天有没有开这顿饭可以留下吃"，跟"这个时段能不能打卡"是两套不同的
    // 判断，不能共用同一份过滤逻辑
    let firstAvailableSlot = '';
    const updatedSlots = mealSlotDefinitions.map((item: any) => {
      const isCompleted = completedSlotKeys.has(item.slotKey);
      if (!isCompleted && !firstAvailableSlot) {
        firstAvailableSlot = item.slotKey;
      }
      return { ...item, isCompleted };
    });

    // 🌟 默认时段：按当前系统真实时间自动选中最贴近的班次（见
    // getNearestShiftKeyByTime，"全天护持"不参与这一判定，只能手动选择）；
    // 当前时间点找不到合适班次（例如今天可选的都已打卡完）时，退回第一个
    // 尚未完成的时段，仍然全部打卡完则退回午市本身仅作占位展示（对应行会
    // 显示"今日已打卡"，不可再选）
    const nearestSlot = this.getNearestShiftKeyByTime(updatedSlots);
    const defaultSlot = nearestSlot || firstAvailableSlot || 'lunch';

    const allCompleted = updatedSlots.length > 0 && updatedSlots.every((item: any) => item.isCompleted);

    this.setData({
      todayLogs,
      todayAccumulatedHours,
      availableMealSlots: updatedSlots,
      allShiftsCompleted: allCompleted,
      selectedShift: defaultSlot,
      mealReserveTipText: this.getMealReserveTipText(defaultSlot),
      // 🎫 每次重新唤起打卡弹窗都清空上一次的工种选择/微调量，这次到底做了
      // 哪些工种由用户当场重新勾选，不沿用历史残留
      selectedJobTypes: [],
      manualHoursAdjust: 0
    });
    this.refreshDisplayJobTypes();
    this.recomputeShiftHours();
  },

  // 🕐 按当前系统真实时间自动选中最贴近的班次：命中某个班次的时间窗口就直接
  // 选它，都不在窗口内则选"距最近窗口边界最短"的一个；已打卡完成的班次不参与
  // 比较（避免选中一个用户点了也没用的档）；"全天护持"没有固定时间窗口，
  // 不参与这一判定，只能手动切换过去
  getNearestShiftKeyByTime(slots: any[]): string {
    const now = new Date();
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    // 与 mealSlotDefinitions 的 timeDesc 一一对应，单位分钟（自 00:00 起算）
    const windows: Record<string, [number, number]> = {
      morning: [360, 510],  // 06:00 - 08:30
      lunch: [540, 810],    // 09:00 - 13:30
      dinner: [990, 1170]   // 16:30 - 19:30
    };

    let bestKey = '';
    let bestDist = Infinity;
    (Array.isArray(slots) ? slots : []).forEach((s: any) => {
      const win = windows[s.slotKey];
      if (!win || s.isCompleted) return;
      const [start, end] = win;
      const dist = minutesNow < start ? (start - minutesNow) : (minutesNow > end ? (minutesNow - end) : 0);
      if (dist < bestDist) {
        bestDist = dist;
        bestKey = s.slotKey;
      }
    });
    return bestKey;
  },

  // 🍳 某工种在指定班次下的建议工时：优先查 jobHoursOverrideBySlot[slotKey]，
  // 查不到（如 slotKey='lunch'，或未来新增班次没配覆盖值）就退回
  // jobTypeDefinitions 里的午市基准值
  getJobHoursForSlot(jobKey: string, slotKey: string): number {
    const jobTypeDefinitions = Array.isArray(this.data.jobTypeDefinitions) ? this.data.jobTypeDefinitions : [];
    const baseJob = jobTypeDefinitions.find((j: any) => j.jobKey === jobKey);
    const baseHours = (baseJob && baseJob.hours) || 0;
    const overrideTable = this.data.jobHoursOverrideBySlot as Record<string, Record<string, number>> | undefined;
    const override = overrideTable ? overrideTable[slotKey] : undefined;
    return (override && typeof override[jobKey] === 'number') ? override[jobKey] : baseHours;
  },

  // 🍳 按当前 selectedShift + selectedJobTypes 重新算一份"工种卡片展示数据"：
  // WXML 的 job-grid-container 迭代这份而不是静态的 jobTypeDefinitions。
  //
  // 🛡️ selected/active 字段直接在这里预算好，WXML 端 class 绑定改读
  // item.selected（见 wxml），不再在 {{}} 里对 selectedJobTypes 现场调用
  // .includes()——两种写法在这个项目的基础库环境下实测都能生效（本页其它
  // Chip，如 reservedMeals.includes('breakfast')，一直在用同样的写法且工作
  // 正常），但把"是否选中"这个派生状态提前在 TS 里算好、直接以布尔字段形式
  // 交给 WXML，比每次渲染都在模板表达式里现算一遍更直接、更不依赖对表达式
  // 求值细节的信任，出问题时也更容易在 TS 里单步排查
  refreshDisplayJobTypes() {
    const slotKey = this.data.selectedShift;
    const jobTypeDefinitions = Array.isArray(this.data.jobTypeDefinitions) ? this.data.jobTypeDefinitions : [];
    const selectedJobTypes = Array.isArray(this.data.selectedJobTypes) ? this.data.selectedJobTypes : [];
    const displayJobTypes = jobTypeDefinitions.map((j: any) => {
      const isSelected = selectedJobTypes.includes(j.jobKey);
      return {
        ...j,
        hours: this.getJobHoursForSlot(j.jobKey, slotKey),
        selected: isSelected,
        active: isSelected
      };
    });
    this.setData({ displayJobTypes });
  },

  // 🍚 留餐提示文案按当前选中班次自适应：早/午/晚市班次对应具体餐别，
  // "全天护持"不对应单一餐次，退回通用文案
  getMealReserveTipText(slotKey: string): string {
    const mealLabelMap: Record<string, string> = { morning: '早餐', lunch: '午餐', dinner: '晚餐' };
    const mealLabel = mealLabelMap[slotKey];
    return mealLabel ? `今日留店用${mealLabel} (方便后厨预留餐量)` : '今日留店用餐 (方便后厨预留餐量)';
  },

  // 🍳 工种建议工时之和：selectedJobTypes 命中 displayJobTypes 的 hours 累加——
  // displayJobTypes 已经按当前 selectedShift 换算过，这里不需要再单独传
  // slotKey，供 recomputeShiftHours 与 WXML 展示"预估合计"复用同一份口径
  computeJobTypeHoursSum(jobKeys: string[]): number {
    const displayJobTypes = Array.isArray(this.data.displayJobTypes) ? this.data.displayJobTypes : [];
    return displayJobTypes
      .filter((j: any) => Array.isArray(jobKeys) && jobKeys.includes(j.jobKey))
      .reduce((sum: number, j: any) => sum + (j.hours || 0), 0);
  },

  // 🎚️ 统一工时计算入口：selectedShiftHours = clamp(工种建议工时之和 + 微调量, 0, 12)——
  // 工种切换（onToggleJobType）与工时微调（onAdjustShiftHours）都只改各自的原始
  // 输入（selectedJobTypes/manualHoursAdjust），最终值一律回到这里统一算，避免
  // 两处各自维护一份工时公式后来对不上
  recomputeShiftHours() {
    const jobSum = this.computeJobTypeHoursSum(this.data.selectedJobTypes);
    const total = Math.max(0, Math.min(12, parseFloat((jobSum + this.data.manualHoursAdjust).toFixed(1))));
    this.setData({ selectedShiftHours: total });
    this.updateHoursPreview(undefined, total);
    return total;
  },

  // 🌟 实时预览：选择工种/时段/微调后即时算出"若提交这一笔，今日总工时会变成多少"，
  // 超过 DAILY_HOURS_CAP 就标红并让确认按钮直接禁用，而不是等提交后才截断
  updateHoursPreview(todayAccumulatedHours?: number, selectedShiftHours?: number) {
    const baseHours = todayAccumulatedHours != null ? todayAccumulatedHours : this.data.todayAccumulatedHours;
    const shiftHours = selectedShiftHours != null ? selectedShiftHours : this.data.selectedShiftHours;
    const previewTotalHours = parseFloat((baseHours + shiftHours).toFixed(1));
    const isOverHoursLimit = previewTotalHours > DAILY_HOURS_CAP;

    this.setData({
      previewTotalHours: previewTotalHours,
      isOverHoursLimit: isOverHoursLimit,
      confirmButtonText: this.computeConfirmButtonText(isOverHoursLimit, shiftHours)
    });
  },

  // 🛡️ 主按钮文案计算属性：从 WXML 里三层嵌套三元表达式 + 字符串拼接
  // （{{a ? x : (b ? y : (c ? z : ('...' + n + '...')))}}）搬到这里用普通 TS
  // 逻辑算好一个纯字符串再交给 WXML 绑定——WXML {{}} 表达式引擎对这种深层
  // 嵌套三元混字符串拼接的解析在部分基础库版本下不完全可靠，出现过末尾内容
  // （单位/右括号）丢失的情况；改成 JS 端算好定长字符串后，就不存在"表达式
  // 解析到一半截断"这类风险了，来源统一收敛到这一个函数，四个分支覆盖
  // WXML 里原来的四种状态，判断顺序也保持一致（allShiftsCompleted 优先级最高）
  computeConfirmButtonText(isOverHoursLimit: boolean, shiftHours: number): string {
    if (this.data.allShiftsCompleted) return '今日时段已全部完成';
    if (isOverHoursLimit) return '工时超出每日上限';
    if (!this.data.selectedJobTypes || this.data.selectedJobTypes.length === 0) return '请先勾选护持工种';
    // 🐛 文案精简：原"确认打卡 (记录 4.5 小时)"长达 16 个字符，32rpx 加粗字号下
    // 在按钮内极易换行，固定高度的按钮会把折行的第二行裁在按钮外沿——不再靠
    // 加大按钮高度去将就长文案，而是把文案本身压缩到"确认打卡 (4.5h)"这种
    // 11 字符以内的紧凑格式，任何机型单行都能稳定容下
    return `确认打卡 (${shiftHours}h)`;
  },

  onCloseShiftModal() {
    this.setData({
      showShiftSelectModal: false
    });
  },

  // ⏱️ 今日已完成的时段不可重复选择：WXML 按 item.isCompleted 路由到本方法而非
  // onSelectMealSlot，这里只负责给出明确的提示文案，不做任何状态变更
  onSelectShiftBlocked() {
    wx.showToast({ title: '该时段今日已打卡，请选择其它时段', icon: 'none', duration: 2500 });
  },

  // 🕐 供餐时段单选：一次打卡对应一次实际到店服务的时间窗口，只切换 selectedShift
  // 本身，不影响 selectedJobTypes/工时——时段与工种是两个独立维度，互不清空对方
  onSelectMealSlot(e: any) {
    const { slot } = e.currentTarget.dataset;
    if (!slot) return;
    this.setData({ selectedShift: slot, mealReserveTipText: this.getMealReserveTipText(slot) });
    // 🍳 班次联动：下方各工种的推荐预估工时按新班次重新算一遍并刷新展示
    this.refreshDisplayJobTypes();
    this.recomputeShiftHours();
  },

  // 🍳 护持工种多选：卡片式勾选，命中的每一项都会计入建议工时之和（见
  // computeJobTypeHoursSum/recomputeShiftHours）。允许多选是本次重构的核心
  // 诉求——同一次打卡里"主要洗菜、顺便帮忙打饭"这类混合工种场景，此前的固定
  // 班次单选模型完全无法表达
  // 🍳 护持工种卡片 Toggle：selectedJobTypes 只维护"当前选中了哪些 jobKey"这
  // 一份集合本身，不维护任何累加/累减的工时中间值。
  //
  // 🧮 为什么总工时必须是"从选中集合全量重算"而不是"选中 += 该工种工时、取消
  // -= 该工种工时"：本弹窗的工种建议工时是按当前选中班次（selectedShift）动态
  // 换算的（见 refreshDisplayJobTypes/getJobHoursForSlot——同一个"主厨/面点"
  // 在早市是 2.5h、午市是 3.5h）。如果改成增量加减，会出现这样的时序漏洞：
  // 用户在【午市】选中"主厨"（+3.5h）→ 切到【早市】（该工种建议工时变成 2.5h，
  // 但增量模型里"已加过的 3.5h"早已固化进总数，不会跟着班次重新换算）→ 用户
  // 再取消"主厨"，若按当前班次的 2.5h 去减，实际扣少了 1h，总工时会越攒越多，
  // 这就是典型的"重复累加"根因。这里坚持"selectedJobTypes 只是一份 key 集合，
  // 总工时永远从这份集合 + 当前 displayJobTypes（已按当前班次换算好）现算现得"
  // （见 computeJobTypeHoursSum 的 reduce 累加），无论选中/取消先后顺序、无论
  // 中途有没有切换班次，结果永远等于"当前选中集合在当前班次下的真实工时之和"，
  // 不存在任何累积误差的可能。
  onToggleJobType(e: any) {
    const { job } = e.currentTarget.dataset;
    if (!job) return;

    // 🛡️ 同卡片防误触抖动：触屏设备偶发的"回弹二次触发"会让同一次物理点击在
    // 极短时间内对同一张卡片连续触发两次 tap 事件——两次 toggle 一加一减，
    // 净效果是选中态"闪一下就消失"，用户会觉得"点了没反应"。这里按 jobKey
    // 维度设一个 400ms 冷却窗口，冷却期内对同一张卡片的重复 tap 直接丢弃，不
    // 参与任何状态变更；快速切换点击不同的卡片不受影响（key 不同，判断不命中）
    const now = Date.now();
    if (this._lastJobToggleKey === job && (now - this._lastJobToggleTime) < 400) {
      return;
    }
    this._lastJobToggleKey = job;
    this._lastJobToggleTime = now;

    const current = this.data.selectedJobTypes || [];
    const isCurrentlySelected = current.includes(job);
    const nextSelectedKeys = isCurrentlySelected ? current.filter((k: string) => k !== job) : [...current, job];

    // 🛡️ selected/active 随 selectedJobTypes 同一次 setData 一起同步写回
    // displayJobTypes——WXML 的 class 绑定直接读 item.selected（而不是在模板
    // 表达式里对 selectedJobTypes 现场调用 .includes()），两份状态在同一次
    // setData 里原子落地，不存在"selectedJobTypes 已经变了、displayJobTypes
    // 还没跟上"的中间态
    const displayJobTypes = (this.data.displayJobTypes || []).map((item: any) => ({
      ...item,
      selected: nextSelectedKeys.includes(item.jobKey),
      active: nextSelectedKeys.includes(item.jobKey)
    }));

    this.setData({
      selectedJobTypes: nextSelectedKeys,
      displayJobTypes
    });
    // 🔁 每次 selectedJobTypes 变化都统一回到 recomputeShiftHours() 全量重算，
    // 不在这里手写任何 += / -= 的旁路捷径
    this.recomputeShiftHours();
  },

  // 🎚️ 工时微调步进器：在工种建议工时之和基础上 ±0.5h，供实际用时与建议值有
  // 出入时手动修正——最终值裁剪范围在 recomputeShiftHours 里统一处理，这里
  // 只负责改变量本身，不重复实现上下限逻辑
  onAdjustShiftHours(e: any) {
    const { dir } = e.currentTarget.dataset;
    const delta = dir === 'dec' ? -0.5 : 0.5;
    const next = parseFloat((this.data.manualHoursAdjust + delta).toFixed(1));
    this.setData({ manualHoursAdjust: next });
    this.recomputeShiftHours();
  },

  // 🍚 默认留餐时段：优先跟随当前选中班次对应的餐次（例如正选着早市班次，
  // 打开"留店用餐"大概率是想留早餐，不该还是默认勾午餐）；班次没有对应餐次
  // （全天护持）或门店未开放该餐次时，退回午餐，门店也未开放午餐（如仅供
  // 早/晚餐的门店）时再退回 supportedMeals 里的第一个餐次
  getDefaultReservedMeal(): string {
    const supportedMeals = this.data.supportedMeals && this.data.supportedMeals.length > 0
      ? this.data.supportedMeals
      : ['lunch'];
    const slotObj = this.data.mealSlotDefinitions.find((s: any) => s.slotKey === this.data.selectedShift);
    const relatedMeal = slotObj && slotObj.relatedMeal;
    if (relatedMeal && supportedMeals.includes(relatedMeal)) return relatedMeal;
    return supportedMeals.includes('lunch') ? 'lunch' : supportedMeals[0];
  },

  onToggleMealReserve() {
    const next = !this.data.willEatLunch;
    // 🍚 关闭"留店用餐"时同步清空已选餐别；重新打开时默认勾选门店默认餐次（与此前
    // willEatLunch 单一开关的语义保持一致，避免用户还要多点一次）
    this.setData({
      willEatLunch: next,
      reservedMeals: next ? (this.data.reservedMeals.length ? this.data.reservedMeals : [this.getDefaultReservedMeal()]) : []
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

    // 🍳 业务模型重构后的必填校验：至少选一个护持工种，系统才知道这次打卡
    // 到底做了什么、该按什么口径统计工时——没有工种就没有可提交的工时依据
    if (!this.data.selectedJobTypes || this.data.selectedJobTypes.length === 0) {
      wx.showToast({ title: '请至少选择一项护持工种', icon: 'none' });
      return;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    // 🐛 命名说明：这份读取只用于提交前的 UX 校验（isAlreadyChecked/recentDuplicate），
    // 是发起云端调用之前的一份快照，不是最终落盘依据——真正写回 storage 前会在
    // await 云函数之后重新读一次最新值（见下方 latestLogs），避免基于这份旧快照
    // 覆盖掉网络等待期间可能发生的其它变更
    const existingLogsSnapshot = wx.getStorageSync('my_checkin_logs') || [];
    const selectedShift = this.data.selectedShift;
    const now = Date.now();

    const isAlreadyChecked = existingLogsSnapshot.some((l: any) => l.date === todayStr && l.shiftKey === selectedShift);
    if (isAlreadyChecked) {
      wx.showToast({ title: '⚠️ 您今日已完成该班次打卡，请勿重复刷工时', icon: 'none' });
      return;
    }

    // 🌟 防刷去重：同工种 10 分钟内重复提交一律视为无效打卡（防止双击/网络重发产生重复记录）
    const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
    const recentDuplicate = existingLogsSnapshot.find((l: any) =>
      l.shiftKey === selectedShift && typeof l.timestamp === 'number' && (now - l.timestamp) < DUPLICATE_WINDOW_MS
    );
    if (recentDuplicate) {
      wx.showToast({ title: '⚠️ 检测到短时间内重复提交，请勿刷单', icon: 'none' });
      return;
    }

    // 🌟 单日工时上限：正常流程下前端已按 isOverHoursLimit 禁用按钮拦在前面，
    // 这里的截断逻辑作为服务端/极端时序下的兜底防线保留，不依赖前端状态。
    // 不再兜底 || 3.0——selectedShiftHours 由 recomputeShiftHours 按已选工种
    // 实时算出，走到这一步前已经过"至少选一项工种"的校验，理应始终 > 0
    const requestedHours = this.data.selectedShiftHours;
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

    // 🏛️ 业务模型重构：提交记录的展示名不再是某个固定班次自带的名字，改为
    // "时段 · 工种1、工种2"这样的组合描述（如"午市班次 · 洗菜/切配、保洁/洗消"），
    // 如实反映这次打卡实际选择的时段与工种组合，而不是一个笼统的固定班次名
    const slotObj = this.data.mealSlotDefinitions.find((s: any) => s.slotKey === selectedShift);
    const jobLabels = this.data.jobTypeDefinitions
      .filter((j: any) => this.data.selectedJobTypes.includes(j.jobKey))
      .map((j: any) => j.name);
    const shiftLabel = `${(slotObj && slotObj.name) || '爱心护持班'}${jobLabels.length ? ' · ' + jobLabels.join('、') : ''}`;
    // 🍚 shift_type：按餐次精准归档的枚举口径（'BREAKFAST'|'LUNCH'|'DINNER'|
    // 'FULL_DAY'），与 shiftKey（继续只做不透明去重字符串）分开，供云端/未来
    // 统计报表按餐次维度聚合，不需要反查 mealSlotDefinitions 才能知道是哪一餐
    const shiftType = (slotObj && slotObj.shiftType) || 'LUNCH';
    const currentStoreId = this.data.currentStoreId || '';
    const currentStoreName = this.data.currentStoreName || this.data.shopName || '';
    const reservedMeals = this.data.willEatLunch ? this.data.reservedMeals.slice() : [];

    // ⚡️ 云端台账：manageVolunteerCheckIn 尽力而为同步一份到 volunteer_duty_logs
    // （服务端会按 {tenantId, storeId, _openid, dateString} 重新核算工时上限，比本地
    // storage 更权威），成功则采用服务端返回的 hours/wasTruncated 覆盖本地估算值，
    // 并记下 cloudLogId 供撤销时精确对应云端记录；云端不可用/失败时静默降级为
    // 纯本地打卡（与项目其余提交流程一致的离线兜底策略），不阻断打卡本身
    let cloudLogId = '';
    try {
      if (isCloudAvailable()) {
        const res: any = await callFunctionWithTimeout({
          name: 'manageVolunteerCheckIn',
          data: {
            action: 'checkin',
            storeId: currentStoreId,
            storeName: currentStoreName,
            shiftKey: selectedShift,
            shiftName: shiftLabel,
            shift_type: shiftType,
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

    const timestamp = now;
    const newLog = {
      timestamp: timestamp,
      date: todayStr,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      shiftKey: selectedShift,
      shiftName: shiftLabel,
      shift_type: shiftType,
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

    // 🐛 修复"多班次记录被覆盖"：本方法开头读的 existingLogsSnapshot 是发起
    // 云端 manageVolunteerCheckIn 调用之前的快照，中间隔着一次 await 网络往返——
    // 期间任何其它代码路径对 my_checkin_logs 的写入都不会反映在这份快照里，
    // 若仍然基于这份旧快照 unshift 后整体写回，就会把网络等待期间发生的其它
    // 变更悄悄冲掉。这里改为在真正落盘前重新从 storage 读一次最新值，在最新
    // 状态上做 Append/Upsert（同一 date+shiftKey 已存在则更新该条，否则追加），
    // 而不是无条件在旧快照上 unshift，从根上消除"读-等待-写"之间的整个竞态窗口
    const latestLogsRaw = wx.getStorageSync('my_checkin_logs');
    const latestLogs = Array.isArray(latestLogsRaw) ? latestLogsRaw : [];
    const existingIdx = latestLogs.findIndex((l: any) => l.date === todayStr && l.shiftKey === selectedShift);
    if (existingIdx >= 0) {
      latestLogs[existingIdx] = newLog;
    } else {
      latestLogs.unshift(newLog);
    }

    // 🛡️ 全局计数器：必须从 storage 里的旧值递增，不能读 this.data.myCheckInDays 等——
    // 这三个 data 字段现在展示的是"按当前门店过滤"后的结果（见下方 scopedStats），
    // 不再等于全局值，拿它们做递增会把错误的数字写回全局计数器。hasTodayLog 同样
    // 基于刚重新读取的 latestLogs（排除本条自身）计算，与实际落盘的数据源保持一致
    const hasTodayLog = latestLogs.some((l: any) => l.date === todayStr && l.timestamp !== timestamp);
    const oldGlobalDays = wx.getStorageSync('my_checkin_days') || 0;
    const newDays = hasTodayLog ? oldGlobalDays : (oldGlobalDays + 1);

    const newCount = (wx.getStorageSync('my_checkin_count') || 0) + 1;
    const newHours = parseFloat(((wx.getStorageSync('my_service_hours') || 0) + addHours).toFixed(1));

    // 🛡️ 全局计数器继续照常维护，不删除——journey.ts/statistics.ts 的个人看板仍在读
    // 这三个 key，本次门店隔离修复不改变它们的既有语义（全部门店/历史累计口径）
    wx.setStorageSync('my_checkin_days', newDays);
    wx.setStorageSync('my_checkin_count', newCount);
    wx.setStorageSync('my_service_hours', newHours);
    wx.setStorageSync('my_checkin_logs', latestLogs);

    // 🐛 门店隔离修复：首页顶部展示的护持天数/工时/次数改为按当前门店动态过滤
    // 统计（见 computeMyCheckInStats），不再直接用上面刚写入的全局递增值——
    // 全国总览视角下仍汇总全部门店，与 loadVolunteerStats 的口径保持一致
    const isAllStoresView = this.data.isAllStoresView;
    const scopedStats = computeMyCheckInStats(currentStoreId, currentStoreName, isAllStoresView || !currentStoreName);

    this.setData({
      myCheckInDays: scopedStats.days,
      myCheckInCount: scopedStats.count,
      myServiceHours: scopedStats.hours,
      checkInLogs: latestLogs,
      showShiftSelectModal: false,
      showPosterModal: true,
      checkInSubmitting: false
    });

    // 🐛 修复"打卡成功弹出的餐报海报二维码要点一下才有反应"：qrCodeUrl/
    // qrCodeState 是这枚二维码在整个页面共享的状态，此前只有【生成公示海报】
    // 那条独立流程会主动调用 generateQrCode()，打卡成功走的是另一条路径
    // （showPosterModal），从没主动触发过——如果这次会话用户还没点过【生成
    // 公示海报】，qrCodeState 停在默认值 'idle'，海报一打开就是"点击重试"
    // 占位图。这里在打卡成功、海报即将展示的同时顺手触发一次生成（已经是
    // 'ready'/'loading' 时内部会被覆盖，不重复请求造成浪费），不阻塞上面的
    // setData 主流程，成功与否都不影响打卡本身已经落地的事实
    if (this.data.qrCodeState !== 'ready' && this.data.qrCodeState !== 'loading') {
      this.generateQrCode();
    }

    // 🐛 修复"今日已打卡记录"列表打完第二个班次后仍只显示一条：todayLogs
    // 是【今日已打卡记录】列表实际 wx:for 绑定的字段（checkInLogs 是另一个
    // 全量历史字段，两者互不相通），此前打卡成功只更新了 checkInLogs，
    // todayLogs 停留在"打开弹窗那一刻"的旧值，直到用户关掉弹窗再重新打开
    // （触发 refreshTodayShiftStatus 重新从 storage 读取）才会刷新。现在打卡
    // 成功后立即重新跑一遍 refreshTodayShiftStatus()，同时把 todayLogs/
    // todayAccumulatedHours/availableMealSlots（今日已完成的时段标记）/
    // allShiftsCompleted 全部按刚写入的最新 storage 重新算一遍，不再只更新
    // 部分字段——即使这一次没有立刻关闭弹窗（如以后允许连续打卡而不弹成功卡片），
    // 列表也会立刻反映刚提交的这一条
    this.refreshTodayShiftStatus();

    if (wasTruncated) {
      wx.showToast({ title: `已为您自动截断至 +${addHours}h（单日上限${DAILY_HOURS_CAP}h）`, icon: 'none', duration: 2500 });
    } else {
      wx.showToast({ title: `打卡成功！+${addHours}h`, icon: 'success' });
    }

    // 🔗 打卡成功 → 强制刷新服务总工时联动（忽略 isManualHours，以最新云端汇总为准）
    this.syncCheckInHoursToForm(true);
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
            const cloudRes: any = await callFunctionWithTimeout({
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
          // 🔗 撤销后强制刷新服务总工时联动
          this.syncCheckInHoursToForm(true);
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
      safeNavigateTo({
        url: '/subpackages/admin/pages/journey/journey'
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

  // 🐛 财务首页瘦身：「请填写当日明细」整条录入表单流水线默认对纯财务角色收起
  // （见 wxml form-main-card 前的 wx:if），这里提供唯一的展开入口——财务仍需保留
  // 亲自代填当日餐报的能力，不是彻底砍掉这条路径
  onToggleFinanceFormOverride() {
    this.setData({ showFinanceFormOverride: !this.data.showFinanceFormOverride });
  },

  // ☀️ 账本锁定状态：finance-home-card 顶部指标，此前是写死的 "100%" 占位文案。
  // 真实口径 = 本店累计已稽核签核笔数 / 本店累计总笔数（tenantId+storeId 精确
  // 匹配，count() 均能命中 createIndexes 里已声明的复合索引——总数命中
  // tenantId_storeId_dateString 的前两列前缀，已稽核数精确命中
  // tenantId_storeId_auditedBy 三列全匹配，两条 count() 都不会触发云开发的
  // "建议添加索引"控制台告警）
  async fetchFinanceLedgerStatus() {
    const storeId = this.data.currentStoreId;
    if (!storeId || !isCloudAvailable()) return;

    this.setData({ financeLedgerStatusLoading: true });
    try {
      const db = wx.cloud.database();
      const cachedRoleInfo = AuthService.getCachedRoleInfo();
      const tenantId = (cachedRoleInfo && cachedRoleInfo.tenantId) || '';
      const baseWhere: any = { storeId };
      if (tenantId) baseWhere.tenantId = tenantId;

      const [totalRes, auditedRes] = await Promise.all([
        db.collection('report_logs').where(baseWhere).count(),
        db.collection('report_logs').where({ ...baseWhere, auditedBy: db.command.exists(true) }).count()
      ]);

      const total = totalRes.total || 0;
      const audited = auditedRes.total || 0;
      this.setData({
        financeLedgerAuditedRate: total > 0 ? Math.round((audited / total) * 100) : null
      });
    } catch (err) {
      console.error('[fetchFinanceLedgerStatus] 查询失败:', err);
    } finally {
      this.setData({ financeLedgerStatusLoading: false });
    }
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
    safeNavigateTo({
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
      const result = await callFunctionWithTimeout({
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
      // 🐛 数字指纹 Hash：manageFinanceLock 的 lockRange 会对本次锁定的全部记录
      // 生成一份 SHA-256 摘要（见该云函数 computeLockFingerprint），确认文案
      // 提前告知用户这个动作会留下可事后核对的完整性凭证，不只是"锁定"两个字
      content: `确定要封账【${storeLabel}】${startDate} 至 ${endDate} 的账目吗？锁定后店长将无法修改，系统将为本次封账生成数字指纹 Hash 作为完整性凭证。`,
      confirmText: '确认封账',
      confirmColor: '#D32F2F',
      cancelText: '我再想想',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ financeLockInFlight: true });
        wx.showLoading({ title: '安全封账中...', mask: true });
        try {
          if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');
          const result = await callFunctionWithTimeout({
            name: 'manageFinanceLock',
            data: { action: 'lockRange', storeId, startDate, endDate }
          });
          const res2 = result.result as any;
          wx.hideLoading();
          if (res2 && res2.success) {
            const fingerprintTip = res2.lockFingerprint ? `\n数字指纹：${res2.lockFingerprint}` : '';
            wx.showModal({
              title: '封账完成',
              content: (res2.message || `已成功封账 ${res2.lockedCount || 0} 条记录`) + fingerprintTip,
              showCancel: false
            });
            this.checkRangeLockStatus();
            // 🐛 封账动作会改变"已稽核笔数"，同步刷新账本锁定状态百分比，不用等
            // 用户离开首页再回来才看到最新值
            this.fetchFinanceLedgerStatus();
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
          const result = await callFunctionWithTimeout({
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
    safeNavigateTo({ url: `/pages/history/history?anomalyType=${type}` });
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
      const result = await callFunctionWithTimeout({
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
    const store = this.data.currentStoreName || this.data.shopName || '';
    const date = this.data.reportDate || this.data.reportDateValue || '今日';

    // 🐛 根因修复：门店邀请海报弹窗打开时点"分享给微信群和朋友"，此前无条件
    // 分享的是通用 share_cover.png 封面图，用户刚生成的那张带门店二维码的海报
    // （storePosterTempFilePath）压根没被用上——收到分享的人看到的只是一张普通
    // 应用卡片，扫不到任何码。这里在弹窗开启且海报已生成完成时，转发卡片封面
    // 优先换成刚生成的海报图，标题也改为邀请语境
    if (this.data.showStorePosterModal && this.data.storePosterTempFilePath) {
      return {
        title: `🌸【${store}】诚邀您加入义工/护持团队，扫码即可申请`,
        path: `/pages/index/index?storeName=${encodeURIComponent(store)}`,
        imageUrl: this.data.storePosterTempFilePath
      };
    }

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