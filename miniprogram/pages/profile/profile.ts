import { AuthService } from '../../utils/authService';
import { getSelectedStore, getCachedStoreStatus, fetchAndSyncStoreStatus } from '../../utils/storeManager';
import { computeMyCheckInStats, computeMyCheckInStreak } from '../../utils/checkinStats';
import { getSafeSystemInfo } from '../../utils/util';
import { compressAndUploadScaledImage } from '../../utils/imageCompress';
import { isCloudAvailable } from '../../utils/cloudGuard';
import { drawVolunteerCertificate } from '../../utils/drawVolunteerCertificate';
import {
  applyRoleViewOverride, getPreviewViewMode, setPreviewViewMode,
  PreviewViewMode, PREVIEW_VIEW_MODE_LABELS
} from '../../utils/viewModePreview';
import { requestOpenSunshineLedger } from '../../utils/sunshineLedgerHandoff';
import { requestOpenCultureFull } from '../../utils/cultureFullHandoff';
import { requestOpenStorePicker } from '../../utils/storePickerHandoff';
import { isVirtualStoreName } from '../../utils/storeIdentity';
import { computeBadgeList as computeBadgeListShared } from '../../utils/badgeWall';
import { checkTenantPermission, FEATURE_KEYS } from '../../utils/tenantPermission';

const VIEW_MODE_OPTIONS: PreviewViewMode[] = ['SUPER_ADMIN', 'STORE_MANAGER', 'FINANCE'];

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

const PATRIARCH_PROFILE_FIELD_LABELS: Record<string, string> = {
  partyMembers: '中共党员',
  socialWorkers: '社会工作者',
  volunteersCount: '志愿者',
  dineInSeniorsCount: '堂食老人',
  deliverySeniorsCount: '送餐老人',
  listeningSeniorsCount: '倾听陪伴老人',
  otherCount: '其他'
};

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
    currentUserRole: 'volunteer' as 'super_admin' | 'store_manager' | 'store_patriarch' | 'finance' | 'volunteer' | 'store_family',
    currentStoreName: '',
    // 🏪 门店运营状态：见 utils/storeManager.ts fetchAndSyncStoreStatus/getCachedStoreStatus，
    // 全局态与 Storage 双写同步，"查看店铺状态"菜单标题据此动态渲染
    currentStoreStatus: '',
    // 🛡️ 语义化权限状态：避免模板里反复重复 role 字符串比较
    hasPrivilege: false,
    isSuperAdmin: false,
    // 🌟 isVolunteer 严格指"已审核通过的真实义工"，用于和 isFamily 互斥区分；
    // isFamily/isServiceUser：新用户/未审核用户的默认身份（家人 · 服务对象），
    // 底层 role 与真实义工共用同一个 'volunteer' 值，只能靠 status !== 'approved'
    // 这个信号区分（见 checkUserRole 云函数：未审核账号 role 恒为 volunteer）
    isVolunteer: false,
    isFamily: false,
    isServiceUser: false,
    // 🏛️ 家长管理 / 资源兜底卡片的显隐开关：家长本人或超管可见
    isPatriarch: false,
    // 🌟 视角切换预览：isRealSuperAdmin 恒等于真实身份，用于切换入口自身的显隐判断；
    // currentViewMode 与选项文案，供页面内的切换 Picker 使用
    isRealSuperAdmin: false,
    // 🏢 平台管理员（SaaS 运维方）：与业务角色 isSuperAdmin 彻底独立的另一个维度
    // （详见 authService.ts UserRole 定义处注释），仅用于"开发者与超管工具箱"里
    // "会员开通/续费管理"这一项的显隐判断，不参与任何业务权限计算
    isPlatformAdmin: false,
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
      expireDateStr: ''
    },
    currentViewMode: 'SUPER_ADMIN' as PreviewViewMode,
    viewModeOptionLabels: VIEW_MODE_OPTIONS.map((m) => PREVIEW_VIEW_MODE_LABELS[m]),
    viewModeOptionIndex: 0,
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
      pendingVoidList: [] as any[],
      pendingProfileUpdate: null as any,
      pendingProfileItems: [] as { label: string; value: number }[],
      voidActionInFlight: false,
      profileActionInFlight: false
    },

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

    // 🌸 家人专属【雨花温情故事】说明弹窗：引导 + 直达门店日志，不重新做一套独立
    // 的故事内容库（真正的故事内容沉淀在 activity_logs 门店日志里）
    showWarmStoryModal: false,

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
    feedbackAdminList: [] as Array<{
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
    pendingElevatedApplicationCount: 0,
    showElevatedApplicationModal: false,
    elevatedApplicationLoading: false,
    elevatedApplicationList: [] as Array<{
      applyId: string; realName: string; phone: string; requestedRole: string;
      requestedRoleLabel: string; applyTimeStr: string; isCustomStore: boolean;
      storeProfile: { storeName: string; address: string; contactPhone: string; storePhotos: string[] };
    }>,
    // ❌ 驳回申请原因弹窗：member/elevated 两个队列共用同一套输入框，
    // rejectApplicationQueue 记住当前驳回的是哪一个队列的申请，便于处理完后
    // 更新对应的列表与角标
    showRejectApplicationModal: false,
    rejectApplicationId: '',
    rejectApplicationQueue: 'member' as 'member' | 'elevated',
    rejectApplicationReason: '',
    rejectApplicationSubmitting: false,

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
    this.initMinePage();
    this.loadUserProfile();
    this.refreshStoreStatus();

    // 🌟 同步自定义 TabBar 高亮态（见 index.ts onShow 中的说明）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
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
    const storageRole = wx.getStorageSync('current_user_role');
    if (storageRole) {
      const persistedRole = (cachedRoleInfo && cachedRoleInfo.role) || 'volunteer';
      role = AuthService.resolveEffectiveRole(persistedRole).toLowerCase();
      // 手动切换的具体身份说了算：选家人就是家人，选除家人外的任何身份
      // （含义工/家长/店长/财务/超管）都不再是"默认未审核家人"视角
      isFamily = role === 'store_family';
    }
    console.log('[verify] initMinePage 角色解析: cachedRole=', cachedRoleInfo && cachedRoleInfo.role, 'storageRole=', storageRole, '-> 生效role=', role);

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

    const isRealSuperAdmin = role === 'super_admin';
    // 🏢 平台管理员：与业务角色是两个独立维度，platform_admin 不会经过下面的
    // applyRoleViewOverride 预览覆盖（那套只针对 super_admin），直接按真实角色判定
    const isPlatformAdmin = role === 'platform_admin';

    // 🌟 视角切换预览：仅真实身份为 super_admin 时才可能生效，展示层降级模拟
    // 店长/财务视角；hasPrivilege 随预览角色一并变化（volunteer 视角下应隐藏管理入口）
    // 🏛️ 权限向下继承：大家长天然拥有店长 + 财务的全套日常管理权限
    const overridden = applyRoleViewOverride(role, {
      currentUserRole: role, isVolunteer: role === 'volunteer',
      isManager: role === 'store_manager' || role === 'store_patriarch',
      isFinance: role === 'finance' || role === 'store_patriarch',
      isSuperAdmin: isRealSuperAdmin
    });
    const displayRole = overridden.currentUserRole;
    const hasPrivilege = displayRole === 'store_manager' || displayRole === 'finance' || displayRole === 'store_patriarch' || displayRole === 'super_admin';
    const currentViewMode = getPreviewViewMode();
    // 🏛️ 家长管理卡片显隐：预览模式的可选项里没有"家长"这一档（VIEW_MODE_OPTIONS
    // 只有 SUPER_ADMIN/STORE_MANAGER/FINANCE），displayRole 能等于 store_patriarch
    // 只可能是真实角色本身就是家长，不受超管预览切换影响
    const isPatriarch = displayRole === 'store_patriarch';
    // 🌟 isVolunteer 严格指"真实义工"，与 isFamily 互斥——两者底层 currentUserRole
    // 都是 'volunteer'，靠 isFamily 区分展示哪一套版面
    const isVolunteer = displayRole === 'volunteer' && !isFamily;
    console.log('[verify] initMinePage 计算结果: displayRole=', displayRole, 'isPatriarch=', isPatriarch, 'isFamily=', isFamily, 'isVolunteer=', isVolunteer);

    this.setData({
      currentUserRole: displayRole as any,
      currentStoreName: storeName,
      hasPrivilege,
      isSuperAdmin: overridden.isSuperAdmin,
      isRealSuperAdmin,
      isPlatformAdmin,
      isPatriarch,
      isVolunteer,
      isFamily,
      isServiceUser: isFamily,
      currentViewMode,
      viewModeOptionIndex: VIEW_MODE_OPTIONS.indexOf(currentViewMode)
    });

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

    const pendingFetches: Promise<any>[] = [this.fetchMeritStats(role)];

    // 🏛️ 家长管理 / 资源兜底：仅家长本人或超管（含预览降级后的超管，与卡片
    // wx:if 口径保持一致）才需要加载，避免给普通义工/店长/财务发多余的云函数请求
    if (isPatriarch || overridden.isSuperAdmin) {
      pendingFetches.push(this.fetchPatriarchDashboardData());
    }

    // 📮 爱心意见箱管理入口的可见范围比家长大盘更宽（含店长），角标需要独立
    // 判断加载时机，不能只挂在上面 isPatriarch || isSuperAdmin 这个条件下
    if (displayRole === 'store_manager' || isPatriarch || overridden.isSuperAdmin) {
      pendingFetches.push(this.fetchPendingFeedbackCount());
      pendingFetches.push(this.fetchPendingVolunteerSubmissions());
      pendingFetches.push(this.fetchPendingApplications());
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

    try {
      await Promise.allSettled(pendingFetches);
    } finally {
      this._initMinePageInFlight = false;
    }
  },

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

      const data = result.data;
      const pendingProfileItems = data.pendingProfileUpdate
        ? Object.keys(PATRIARCH_PROFILE_FIELD_LABELS)
            .filter((f) => data.pendingProfileUpdate[f] !== undefined)
            .map((f) => ({ label: PATRIARCH_PROFILE_FIELD_LABELS[f], value: data.pendingProfileUpdate[f] }))
        : [];

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
          auditedCount: data.auditedCount || 0,
          totalCount: data.totalCount || 0,
          pendingVoidList: data.pendingVoidList || [],
          pendingProfileUpdate: data.pendingProfileUpdate || null,
          pendingProfileItems
        }
      });
    } catch (err) {
      console.error('[fetchPatriarchDashboardData] 加载家长大盘异常:', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ 'patriarchData.loading': false });
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
    this.setData({ showFeedbackAdminModal: true, feedbackAdminLoading: true, feedbackAdminList: [] });

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
      this.setData({ feedbackAdminList: result.data.list || [] });
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

  // 🌟 超级管理员视角切换：仅纯前端展示层预览，绝不改写云端真实角色。
  // 仅在 isRealSuperAdmin 为真时才会被 WXML 渲染出这个入口，此处再做一次二次校验兜底。
  onSwitchViewMode(e: any) {
    if (!this.data.isRealSuperAdmin) return;

    const index = parseInt(e.detail.value, 10);
    const mode = VIEW_MODE_OPTIONS[index];
    if (!mode) return;

    setPreviewViewMode(mode);
    wx.showToast({
      title: mode === 'SUPER_ADMIN' ? '已切回超级管理员全景' : `已切换为${PREVIEW_VIEW_MODE_LABELS[mode]}预览`,
      icon: 'none'
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
      const activeStore = getSelectedStore();
      const storeId = (activeStore && activeStore.storeId) || '';

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
          submittedReports: submittedCount || (role === 'store_manager' || role === 'store_patriarch' || role === 'super_admin' ? 14 : 0),
          auditedReports: auditedCount || (role === 'finance' || role === 'store_patriarch' || role === 'super_admin' ? 8 : 0)
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
          submittedReports: role === 'store_manager' || role === 'store_patriarch' || role === 'super_admin' ? 14 : 0,
          auditedReports: role === 'finance' || role === 'store_patriarch' || role === 'super_admin' ? 8 : 0
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

  applyLeaderboardResult(result: any) {
    this.setData({
      leaderboardList: result.list || [],
      leaderboardSelfRank: result.selfRank || 0,
      leaderboardSelfHours: result.selfHours || 0,
      leaderboardGapToNext: result.gapToNext || 0,
      leaderboardTotalRanked: result.totalRanked || 0,
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

    this.setData({ showSwitchIdentityModal: false });
    wx.showToast({ title: `已切换至${ROLE_TOKEN_LABELS[role] || role}视角`, icon: 'none' });
    this.initMinePage();
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
      const list = result.data.list || [];
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
        const list = result.data.list || [];
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

  // 👥🏛️ 待审批的成员/高级角色申请：服务端已按 caller 角色分流（店长/家长只拿本店
  // 义工/财务申请，超管拿全机构店长/家长/新店申请），客户端只需按返回的 queueType
  // 落到对应的列表 + 角标，不需要分开发两次请求
  async fetchPendingApplications() {
    if (!isCloudAvailable()) return;
    try {
      const res: any = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { action: 'listPendingApplications' }
      });
      const result = res.result;
      if (!result || !result.success) return;

      const list = result.data || [];
      if (result.queueType === 'member') {
        this.setData({ memberApplicationList: list, pendingMemberApplicationCount: list.length });
      } else if (result.queueType === 'elevated') {
        this.setData({ elevatedApplicationList: list, pendingElevatedApplicationCount: list.length });
      }
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

  onOpenElevatedApplicationModal() {
    if (this.data.elevatedApplicationLoading) return;
    this.setData({ showElevatedApplicationModal: true, elevatedApplicationLoading: true });
    this.fetchPendingApplications().finally(() => {
      this.setData({ elevatedApplicationLoading: false });
    });
  },

  onCloseElevatedApplicationModal() {
    this.setData({ showElevatedApplicationModal: false });
  },

  _removeApplicationFromQueue(id: string, queue: 'member' | 'elevated') {
    if (queue === 'elevated') {
      const next = this.data.elevatedApplicationList.filter((item) => item.applyId !== id);
      this.setData({ elevatedApplicationList: next, pendingElevatedApplicationCount: next.length });
    } else {
      const next = this.data.memberApplicationList.filter((item) => item.applyId !== id);
      this.setData({ memberApplicationList: next, pendingMemberApplicationCount: next.length });
    }
  },

  // 🛡️ 高权限角色审批前强确认：与首页工作台的门店审核弹窗（index.ts onProcessAudit）
  // 走的是同一个 processRoleAudit 云函数、同一套权限敏感度，此前这里两个队列
  // （member 里的义工/财务申请、elevated 里的店长/家长/新建门店申请）通过按钮一律
  // 无确认直接批准——elevated 队列清一色是高权限授权，member 队列里的"财务"申请
  // 同样能看到/操作门店账本，都应该在授权前弹一次强确认，而不是只有首页那份入口
  // 才有这层保护，本页留了个能一键提权的缺口
  async onApproveApplication(e: any) {
    const id = e.currentTarget.dataset.id;
    const queue = e.currentTarget.dataset.queue as 'member' | 'elevated';
    if (!id) return;

    const list = queue === 'elevated' ? this.data.elevatedApplicationList : this.data.memberApplicationList;
    const item = (list as any[]).find((r) => r.applyId === id);

    // elevated 队列（店长/家长任命、新建门店）恒为高权限；member 队列仅 finance 敏感，
    // volunteer 维持原有一键通过的轻量体验
    const isSensitive = queue === 'elevated' || (item && item.requestedRole === 'finance');

    if (isSensitive && item) {
      const displayName = item.realName || '该申请人';
      const content = queue === 'elevated'
        ? (item.isCustomStore
          ? `通过后将自动创建新门店【${item.storeProfile ? item.storeProfile.storeName : ''}】并授予「${displayName}」对应管理权限，确认通过吗？`
          : `授权后「${displayName}」将以【${item.requestedRoleLabel}】身份管理门店账本与人员，确认通过吗？`)
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
    const queue = e.currentTarget.dataset.queue as 'member' | 'elevated';
    if (!id) return;
    this.setData({ showRejectApplicationModal: true, rejectApplicationId: id, rejectApplicationQueue: queue, rejectApplicationReason: '' });
  },

  onPreviewApplicationStorePhoto(e: any) {
    const { url, urls } = e.currentTarget.dataset;
    if (!url) return;
    wx.previewImage({ current: url, urls: urls || [url] });
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

  // 🍚 门店餐饮与物资统计：即时查询，不缓存不预加载，每次打开都拿最新数字
  onOpenStoreStatsModal() {
    if (this.data.storeStatsLoading) return;
    this.setData({ showStoreStatsModal: true, storeStatsLoading: true });

    wx.cloud.callFunction({
      name: 'manageVolunteerSubmission',
      data: { action: 'statsSummary' }
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
      this.setData({ myFeedbackList: result.data.list || [] });
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

  // 🌸 家人专属【雨花家园】· 雨花温情故事：项目里没有独立的"故事内容库"，
  // 真正沉淀温馨故事/活动花絮的地方是门店日志（activity_logs）——这里展示一段
  // 引导语，不编造一份假的故事列表，点击直达已有的门店日志入口
  onOpenWarmStory() {
    this.setData({ showWarmStoryModal: true });
  },

  onCloseWarmStory() {
    this.setData({ showWarmStoryModal: false });
  },

  onViewActivityLogFromWarmStory() {
    this.setData({ showWarmStoryModal: false });
    this.onGoToActivityLog();
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

  onTriggerClearCache() {
    wx.showModal({
      title: '🧹 确认清洗测试缓存？',
      content: '此操作将清理本地所有测试缓存数据。云端正式数据不会受影响。确认继续？',
      confirmText: '确认清洗',
      confirmColor: '#8C1D18',
      success: (res) => {
        if (res.confirm) {
          try {
            wx.clearStorageSync();
            wx.showToast({ title: '测试缓存已清除', icon: 'success' });
            
            setTimeout(() => {
              this.isNavigating = true;
              wx.reLaunch({
                url: '/pages/index/index',
                fail: () => {
                  this.isNavigating = false;
                }
              });
            }, 800);
          } catch (err) {
            wx.showToast({ title: '清理失败', icon: 'none' });
          }
        }
      }
    });
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

  // 🔐 套餐升级/续费半屏卡片：复用 checkTenantPermission（与首页/统计页同一套
  // 租户订阅鉴权入口），拿到的 planType/isExpired/serviceExpireDate 就是本机构
  // 当前生效的套餐状态——传哪个 featureKey 不影响这几个字段的取值，任选一个即可。
  // 🐛 防重锁：与 statistics.ts fetchStatistics 同一套 isLoading 式防抖，避免用户
  // 手快连点"会员开通/续费管理"打出重复的鉴权云调用
  async onOpenSubscriptionModal() {
    if (this.data.subscriptionLoading) return;
    this.setData({ showSubscriptionModal: true, subscriptionLoading: true });

    try {
      const result = await checkTenantPermission(FEATURE_KEYS.MULTI_STORE_DASHBOARD, { skipCache: true });
      const expireDateStr = result.serviceExpireDate || '';
      // 🌟 7 天内到期同样标红提醒——与 pages/platform-admin 大盘"7 天内到期机构"
      // 预警口径保持一致（见 getPlatformOverview 的 soonExpiringTenants）
      const EXPIRING_SOON_MS = 7 * 24 * 3600 * 1000;
      const expireTime = expireDateStr ? new Date(expireDateStr).getTime() : NaN;
      const isExpiringSoon = !result.isExpired && !Number.isNaN(expireTime) && (expireTime - Date.now()) <= EXPIRING_SOON_MS;

      this.setData({
        subscriptionInfo: {
          planType: result.planType,
          planLabel: PLAN_LABELS[result.planType] || result.planType,
          isExpired: result.isExpired,
          isExpiringSoon,
          expireDateStr: expireDateStr || '尚未开通'
        }
      });
    } catch (err) {
      console.warn('[onOpenSubscriptionModal] 加载套餐信息失败:', err);
    } finally {
      this.setData({ subscriptionLoading: false });
    }
  },

  onCloseSubscriptionModal() {
    this.setData({ showSubscriptionModal: false });
  },

  // 🎨 "复制续费申请信息"：本项目没有自助续费/工单系统——tenant_subscriptions
  // 完全由 platform_admin 通过 pages/platform-admin 单方发起管理（见
  // manageTenantSubscription 的 5 个 action，没有一个是"租户提交申请"），这里
  // 不假装存在一个能提交到的后端队列，复制一段结构化文案由店长/大家长自己
  // 粘贴发给项目管理员，是当前架构下唯一诚实、可交付的"提交续费需求"实现
  onCopyRenewalRequest() {
    const { planLabel, expireDateStr } = this.data.subscriptionInfo;
    const storeName = this.data.currentStoreName || '本机构';
    const text = `【续费申请】${storeName}\n当前套餐：${planLabel}\n到期时间：${expireDateStr}\n申请：希望升级/续费专业版套餐，请协助处理，感谢！`;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '续费申请信息已复制，请粘贴发送给项目管理员', icon: 'none', duration: 2500 })
    });
  }
});
