import { AuthService } from '../../utils/authService';
import { getSelectedStore } from '../../utils/storeManager';
import { getSafeSystemInfo } from '../../utils/util';
import { compressAndUploadSquareImage } from '../../utils/imageCompress';
import { drawVolunteerCertificate } from '../../utils/drawVolunteerCertificate';
import {
  applyRoleViewOverride, getPreviewViewMode, setPreviewViewMode,
  PreviewViewMode, PREVIEW_VIEW_MODE_LABELS
} from '../../utils/viewModePreview';

const VIEW_MODE_OPTIONS: PreviewViewMode[] = ['SUPER_ADMIN', 'STORE_MANAGER', 'FINANCE'];

const PROFILE_COMPRESS_CANVAS_ID = 'imgCompressCanvas';
const CERTIFICATE_CANVAS_ID = 'certificateCanvas';

// 🌟 荣誉徽章解锁规则：护持天数 / 累计工时任一维度达标即视为解锁。
// 阈值为产品侧可调参数，这里给出一组由浅入深、早期容易触达的示例梯度，
// 让新义工也能较快解锁第一枚徽章，建立正反馈。
const BADGE_CONFIG: Array<{ id: string; emoji: string; name: string; type: 'days' | 'hours'; threshold: number }> = [
  { id: 'starter', emoji: '🌱', name: '初心', type: 'days', threshold: 1 },
  { id: 'storm', emoji: '☔', name: '风雨无阻', type: 'days', threshold: 30 },
  { id: 'hours100', emoji: '⏰', name: '百时勋章', type: 'hours', threshold: 100 },
  { id: 'century', emoji: '💯', name: '百日精进', type: 'days', threshold: 100 },
  { id: 'guardian', emoji: '🛡️', name: '护持先锋', type: 'hours', threshold: 500 }
];

Page({
  isNavigating: false,
  // 🐛 头像"退出重进又变回旧值"根因：loadUserProfile 里缓存优先渲染（快）与云端
  // fetchUserRole 刷新（慢，多一轮 checkUserRole 云函数往返）各自独立调用
  // applyAvatarUrl，谁的 getTempFileURL 请求先返回完全看网络时序，不保证按发起顺序
  // 落地——一旦云端刷新那次意外先于缓存那次 resolve，随后姗姗来迟的"缓存版"
  // setData 反而会把已经展示的最新头像覆盖回旧值。avatarApplySeq 按【发起顺序】
  // 单调递增，只有序号不小于当前已生效序号的结果才允许 setData，确保后发起的
  // （更新鲜的）结果永远不会被先发起、但后返回的旧结果覆盖。
  avatarApplySeq: 0,
  lastAppliedAvatarSeq: 0,

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    // 🛡️ 自定义导航栏避让官方胶囊菜单：与 statistics.ts 同款方案，capsuleLeft/windowWidth
    // 用于给右上角"⋯"按钮换算出正确的右侧安全内边距，不再用固定 24rpx 硬编码贴右——
    // 不同机型胶囊按钮的实际左边距不同，硬编码在部分机型上会被胶囊直接盖住/裁切
    windowWidth: 0,
    capsuleLeft: 0,
    currentUserRole: 'volunteer' as 'super_admin' | 'store_manager' | 'finance' | 'volunteer',
    currentStoreName: '',
    // 🛡️ 语义化权限状态：避免模板里反复重复 role 字符串比较
    hasPrivilege: false,
    isSuperAdmin: false,
    // 🌟 视角切换预览：isRealSuperAdmin 恒等于真实身份，用于切换入口自身的显隐判断；
    // currentViewMode 与选项文案，供页面内的切换 Picker 使用
    isRealSuperAdmin: false,
    currentViewMode: 'SUPER_ADMIN' as PreviewViewMode,
    viewModeOptionLabels: VIEW_MODE_OPTIONS.map((m) => PREVIEW_VIEW_MODE_LABELS[m]),
    viewModeOptionIndex: 0,
    stats: {
      volunteerDays: 0,
      volunteerHours: 0,
      submittedReports: 0,
      auditedReports: 0
    },
    showReleaseModal: false,
    releaseRoleLabel: '',
    isReleasing: false,

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
    badgeList: [] as Array<{ id: string; emoji: string; name: string; unlocked: boolean; hint: string }>,
    showCertificateModal: false,
    certificateTempFilePath: '',
    certificateGenerating: false
  },

  onLoad() {
    this.calculateNavBarHeight();
  },

  onShow() {
    this.isNavigating = false;
    this.initMinePage();
    this.loadUserProfile();

    // 🌟 同步自定义 TabBar 高亮态（见 index.ts onShow 中的说明）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
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

    const storageRole = wx.getStorageSync('current_user_role');
    if (storageRole) {
      role = storageRole.toLowerCase();
    }

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

    // 🌟 视角切换预览：仅真实身份为 super_admin 时才可能生效，展示层降级模拟
    // 店长/财务视角；hasPrivilege 随预览角色一并变化（volunteer 视角下应隐藏管理入口）
    const overridden = applyRoleViewOverride(role, {
      currentUserRole: role, isVolunteer: role === 'volunteer',
      isManager: role === 'store_manager', isFinance: role === 'finance', isSuperAdmin: isRealSuperAdmin
    });
    const displayRole = overridden.currentUserRole;
    const hasPrivilege = displayRole === 'store_manager' || displayRole === 'finance' || displayRole === 'super_admin';
    const currentViewMode = getPreviewViewMode();

    this.setData({
      currentUserRole: displayRole as any,
      currentStoreName: storeName,
      hasPrivilege,
      isSuperAdmin: overridden.isSuperAdmin,
      isRealSuperAdmin,
      currentViewMode,
      viewModeOptionIndex: VIEW_MODE_OPTIONS.indexOf(currentViewMode)
    });

    // fetchMeritStats 按真实角色查询（super_admin 本就同时满足 store_manager/finance 两类统计条件，
    // 预览视角切换时无需重新查询，WXML 侧的显隐已经按 currentUserRole 展示角色自动收敛）
    this.fetchMeritStats(role);
    this.loadVolunteerStats();
  },

  // 🙋 头像昵称填写规范：优先用缓存的 RoleInfo 秒开显示，再静默刷新一次确保最新
  loadUserProfile() {
    const cached = AuthService.getCachedRoleInfo();
    // 🩺 临时诊断日志：定位"头像退出重进又变回旧值"到底是缓存脏了还是云端返回的数据本身
    // 就不对——排查完成后请删除这两行 console.log（搜索 [诊断][loadUserProfile]）
    console.log('[诊断][loadUserProfile] 本地缓存 cached.avatarUrl =', cached && cached.avatarUrl);
    if (cached) {
      this.applyAvatarUrl(cached.avatarUrl || '');
      this.setData({ userNickName: cached.nickName || '' });
    }

    AuthService.fetchUserRole().then(result => {
      console.log('[诊断][loadUserProfile] checkUserRole 返回 roleInfo.avatarUrl =', result.roleInfo && result.roleInfo.avatarUrl);
      if (result.success && result.roleInfo) {
        this.applyAvatarUrl(result.roleInfo.avatarUrl || '');
        this.setData({ userNickName: result.roleInfo.nickName || '' });
      }
    }).catch(err => {
      console.warn('[profile] loadUserProfile 刷新失败:', err);
    });
  },

  // 🐛 修复"头像显示灰块/裂图"：数据库里存的 avatarUrl 是 wx.cloud.uploadFile 返回的
  // cloud:// fileID，不是可以直接喂给 <image> 的 http(s) 地址——部分基础库/设备环境下
  // <image src> 无法解析 cloud:// 协议，表现为灰块或裂图图标。必须先用
  // wx.cloud.getTempFileURL 换成临时 https 链接再 setData，与 history.ts 处理凭证图片
  // 的方式保持一致。非 cloud:// 值（本地临时路径/已经是 https 链接）直接使用，不做转换。
  async applyAvatarUrl(avatarUrl: string) {
    // 按发起顺序取号，而不是按 resolve 顺序——见类定义处 avatarApplySeq 的注释
    const seq = ++this.avatarApplySeq;
    const commit = (patch: { userAvatarUrl: string; avatarLoadFailed: boolean }) => {
      if (seq < this.lastAppliedAvatarSeq) {
        // 已经有发起时间更晚（更新鲜）的一次调用抢先落地过，这次是姗姗来迟的旧结果，丢弃
        return;
      }
      this.lastAppliedAvatarSeq = seq;
      console.log('[诊断][applyAvatarUrl] 落地 seq=', seq, 'userAvatarUrl=', patch.userAvatarUrl);
      this.setData(patch);
    };

    if (!avatarUrl) {
      commit({ userAvatarUrl: '', avatarLoadFailed: false });
      return;
    }

    if (avatarUrl.indexOf('cloud://') !== 0) {
      commit({ userAvatarUrl: avatarUrl, avatarLoadFailed: false });
      return;
    }

    try {
      const res: any = await wx.cloud.getTempFileURL({ fileList: [avatarUrl] });
      const tempUrl = res && res.fileList && res.fileList[0] && res.fileList[0].tempFileURL;
      commit({ userAvatarUrl: tempUrl || avatarUrl, avatarLoadFailed: false });
    } catch (err) {
      console.warn('[profile] 头像临时链接转换失败:', err);
      commit({ userAvatarUrl: avatarUrl, avatarLoadFailed: false });
    }
  },

  // 🛡️ 头像 <image> 加载失败兜底：常见于云存储读权限未设为"所有用户可读"时，
  // 其他人（非上传者本人）查看会直接加载失败——不管什么原因，降级展示占位图，
  // 而不是留一块空白框给用户
  onAvatarLoadError(e: any) {
    console.warn('[profile] 头像加载失败，降级为占位图:', e.detail);
    this.setData({ avatarLoadFailed: true });
  },

  // 🌟 诊断专用：与 bindchooseavatar 分开打点。如果点击头像后这里打印了、但
  // onChooseAvatar 那条日志始终没出现，说明按钮本身能收到点击，问题出在
  // chooseAvatar 这个专属事件没有被触发——最常见原因是手机微信客户端版本偏旧，
  // 实际运行时基础库低于 chooseAvatar 能力要求的 2.21.2（无论项目 libVersion 配多高，
  // 真正生效的基础库上限取决于用户手机安装的微信版本，不受项目配置约束）。
  onAvatarBtnTap() {
    const sysInfo = getSafeSystemInfo();
    console.log('[onAvatarBtnTap] 头像按钮已收到点击，当前运行时基础库 SDKVersion =', sysInfo.SDKVersion);
  },

  // 选择微信头像（官方 chooseAvatar 能力）：拿到本地临时文件后压缩上传至云存储，再落库
  async onChooseAvatar(e: any) {
    // 🌟 诊断日志：点击头像后连这一行都没打印，说明问题不在这个函数内部，
    // 大概率是当前预览/真机跑的还不是最新编译产物（同类问题参见图片识别按钮排查记录）
    console.log('[onChooseAvatar] 头像选择回调已触发', e.detail);
    const tempAvatarUrl = e.detail && e.detail.avatarUrl;
    if (!tempAvatarUrl) {
      console.warn('[onChooseAvatar] e.detail.avatarUrl 为空，微信未返回临时头像文件');
      return;
    }

    this.setData({ avatarUploading: true });
    wx.showLoading({ title: '头像上传中...', mask: true });

    try {
      // 🐛 头像"被放大只显示中央局部"排查结论：wx.chooseAvatar 的原生裁剪 UI 在部分手机
      // 微信客户端版本/开发者工具 Linux 模拟环境下不总是可靠触发正方形裁剪，导致这里拿到的
      // tempAvatarUrl 实际是非正方形原图；而 <image mode="aspectFill"> 只能裁剪"显示效果"，
      // 裁不掉底层文件本身的长宽比，于是在圆形头像框里表现为把原图长边居中裁掉一大截、
      // 视觉上像是"被放大只看到中间"。改用 compressAndUploadSquareImage 从源头强制居中裁剪成
      // 正方形再压缩上传，存进云端的文件本身就是 1:1，不再依赖原生裁剪 UI 是否生效。
      const uploaded = await compressAndUploadSquareImage(PROFILE_COMPRESS_CANVAS_ID, tempAvatarUrl, 'users/avatars');

      const result = await AuthService.updateProfile({ avatarUrl: uploaded.url });

      wx.hideLoading();
      this.setData({ avatarUploading: false });

      if (result.success) {
        // 🐛 优先用本地临时路径（tempAvatarUrl）立即更新视图，不等云端 fileID 转临时链接
        // 那一轮网络往返——本地路径此刻已经是裁剪压缩后的正方形图，直接可用，视觉上更即时，
        // 也避免了 cloud:// fileID 在少数设备/基础库上无法被 <image> 直接解析的问题
        this.setData({ userAvatarUrl: tempAvatarUrl, avatarLoadFailed: false });
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
    console.log('[onNicknameBlur] 昵称输入框已失焦', e.detail);
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
  loadVolunteerStats() {
    try {
      const checkInDays = wx.getStorageSync('my_checkin_days') || 0;
      const checkInCount = wx.getStorageSync('my_checkin_count') || 0;
      const serviceHours = wx.getStorageSync('my_service_hours') || 0;

      this.setData({
        'stats.volunteerDays': checkInDays,
        'stats.volunteerHours': serviceHours,
        'stats.volunteerCheckInCount': checkInCount
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

    const badgeList = BADGE_CONFIG.map(cfg => {
      const current = cfg.type === 'days' ? volunteerDays : volunteerHours;
      const unlocked = current >= cfg.threshold;
      const remaining = Math.max(0, Math.ceil(cfg.threshold - current));
      const unit = cfg.type === 'days' ? '天' : '小时';
      const verb = cfg.type === 'days' ? '护持' : '累计';

      return {
        id: cfg.id,
        emoji: cfg.emoji,
        name: cfg.name,
        unlocked,
        hint: unlocked ? '' : `再${verb} ${remaining} ${unit}即可解锁「${cfg.name}」徽章`
      };
    });

    this.setData({ badgeList });
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

      let submittedCount = 0;
      let auditedCount = 0;

      try {
        if ((role === 'store_manager' || role === 'super_admin') && tenantId) {
          const subRes = await db.collection('report_logs')
            .where({
              tenantId,
              createdBy: openid
            })
            .count();
          submittedCount = subRes.total || 0;
        }

        // 这两个数字是直接展示给用户的"已提交/已稽核"荣誉墙统计，不是单纯的"是否存在"
        // 判断，所以不能用 limit(1) 替代——limit(1) 只能回答"有没有"，答不出"有多少"。
        // 真正的优化点是让 tenantId+auditedBy 复合索引生效，把全表扫描收窄到单租户内。
        if ((role === 'finance' || role === 'super_admin') && tenantId) {
          const audRes = await db.collection('report_logs')
            .where({
              tenantId,
              auditedBy: db.command.exists(true)
            })
            .count();
          auditedCount = audRes.total || 0;
        }
      } catch (dbErr) {
        console.warn('[fetchMeritStats] 数据库查询失败，使用兜底数据:', dbErr);
      }

      const volunteerDays = wx.getStorageSync('my_checkin_days') || 0;
      const volunteerHours = wx.getStorageSync('my_service_hours') || 0;
      const volunteerCheckInCount = wx.getStorageSync('my_checkin_count') || 0;

      this.setData({
        stats: {
          volunteerDays,
          volunteerHours,
          volunteerCheckInCount,
          submittedReports: submittedCount || (role === 'store_manager' || role === 'super_admin' ? 14 : 0),
          auditedReports: auditedCount || (role === 'finance' || role === 'super_admin' ? 8 : 0)
        }
      });
      this.computeBadgeList();
    } catch (err) {
      console.error('[fetchMeritStats] 加载失败:', err);
      const volunteerDays = wx.getStorageSync('my_checkin_days') || 0;
      const volunteerHours = wx.getStorageSync('my_service_hours') || 0;
      const volunteerCheckInCount = wx.getStorageSync('my_checkin_count') || 0;

      this.setData({
        stats: {
          volunteerDays,
          volunteerHours,
          volunteerCheckInCount,
          submittedReports: role === 'store_manager' || role === 'super_admin' ? 14 : 0,
          auditedReports: role === 'finance' || role === 'super_admin' ? 8 : 0
        }
      });
      this.computeBadgeList();
    }
  },

  onReleaseUserRole() {
    if (this.isNavigating) return;

    const roleMap: Record<string, string> = {
      'store_manager': '店长',
      'finance': '财务',
      'super_admin': '超级管理员'
    };
    const roleLabel = roleMap[this.data.currentUserRole] || '管理员';

    this.setData({
      showReleaseModal: true,
      releaseRoleLabel: roleLabel
    });
  },

  stopPropagation() {},

  onCancelReleaseModal() {
    if (this.data.isReleasing) return;
    this.setData({ showReleaseModal: false });
  },

  onConfirmReleaseRole() {
    if (this.data.isReleasing) return;
    this.setData({ isReleasing: true });

    wx.showLoading({ title: '安全卸任中...' });

    try {
      wx.removeStorageSync('current_user_role');
      wx.removeStorageSync('my_authorized_roles');
      wx.removeStorageSync('current_user_role_info');

      AuthService.clearAuth();

      wx.setStorageSync('current_user_role', 'volunteer');

      setTimeout(() => {
        wx.hideLoading();
        this.setData({ showReleaseModal: false, isReleasing: false });
        wx.showToast({ title: '身份已卸任重置', icon: 'success' });

        setTimeout(() => {
          this.isNavigating = true;
          wx.reLaunch({
            url: '/pages/index/index',
            fail: () => {
              this.isNavigating = false;
            }
          });
        }, 600);
      }, 500);

    } catch (err) {
      wx.hideLoading();
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

  onGoToJourney() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/journey/journey',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🌟 数字荣誉墙：点击某枚徽章。已解锁 -> 直接打开证书弹窗（与"义工证书"入口共用同一套
  // 生成逻辑，个人只有一张证书，不区分是从哪枚徽章点进来的）；未解锁 -> 提示还差多少即可解锁，
  // 不弹证书——避免用户以为点了没有解锁的徽章也能拿到证书
  onTapBadge(e: any) {
    const id = e.currentTarget.dataset.id;
    const badge = (this.data.badgeList || []).find((b: any) => b.id === id);
    if (!badge) return;

    if (badge.unlocked) {
      this.onGoToBadges();
    } else {
      wx.showToast({ title: badge.hint, icon: 'none', duration: 2200 });
    }
  },

  // 义工证书：异步绘制一张长图证书（Canvas 2D），绘制完成后展示为可保存的全屏预览
  async onGoToBadges() {
    const { userNickName, stats, currentStoreName } = this.data;

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
      const cachedRole = AuthService.getCachedRoleInfo();
      const storeId = (cachedRole && cachedRole.storeId) || '';
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
              days: stats.volunteerDays || 0,
              hours: stats.volunteerHours || 0,
              qrCodeTempPath: qrCodeLocalPath,
              width: 340,
              height: 480
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

  onGoToMySubmissions() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/history/history?view=mine',
      fail: () => {
        this.isNavigating = false;
      }
    });
  },

  // 🌟 店长专属入口：门店营运数据总览，复用首页 goToStatistics 同一个统计页面
  // （/pages/statistics/statistics），不新建一套统计逻辑，只是从个人中心多开一个入口
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

  onGoToAbout() {
    if (this.isNavigating) return;
    this.isNavigating = true;

    wx.navigateTo({
      url: '/pages/help/help',
      fail: () => {
        this.isNavigating = false;
      }
    });
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
  }
});
