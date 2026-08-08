// app.ts

import { isCloudAvailable } from './utils/cloudGuard';

if (typeof App === 'undefined') {
  // 防御 Linux 环境下开发者工具打包器（wxmodule.patch.js）模块加载顺序错乱、
  // 全局 App 尚未被基础库注入时执行本文件的问题：先挂一个占位 App，
  // 等真正的全局 App 就位后再补发注册，避免整个小程序直接崩溃。
  // 注：wx.getApp 不是真实存在的 API（getApp 是独立的全局函数，不挂在 wx 上），
  // 用它做就绪判断永远为 false，会让占位 App 变成永久静默黑洞——因此改为对
  // 真正全局 App 的直接轮询，并在多次重试仍未就绪时打印明确报错，避免静默失败。
  (globalThis as any).App = function (options: any) {
    const placeholder = (globalThis as any).App;
    let retries = 0;
    const tryRegister = () => {
      if (typeof App !== 'undefined' && App !== placeholder) {
        App(options);
      } else if (retries < 20) {
        retries++;
        setTimeout(tryRegister, 50);
      } else {
        console.error('[app.ts] 全局 App 注入超时（可能是基础库加载彻底失败），小程序未能启动');
      }
    };
    setTimeout(tryRegister, 0);
  };
}

interface StorePermission {
  storeId: string;
  storeName: string;
  role: 'MANAGER' | 'FINANCE' | 'VOLUNTEER';
}

// 🌟 朋友圈扫码引流：证书二维码 scene 编码为 "u=<openid前10位>&s=<storeId前10位>"
// （见 cloudfunctions/getStoreQRCode 的 isPersonalCertificate 分支），扫码启动时
// 在这里解析出"谁分享的、指向哪家门店"，暂存进 globalData 供首页 onShow 弹出
// 邀请绑定确认框；两个字段都只是截断前缀，不是完整 ID（见 bindReferralStore
// 云函数的模糊匹配说明）
interface InviteContext {
  referrerUserId: string;
  targetStoreId: string;
}

App({
  globalData: {
    onNetworkReconnected: null as (() => void) | null,
    selectedStore: null as { storeId: string; storeName: string } | null,
    // 🌐 多租户：不再预设任何具体门店，等用户登录后由 checkUserRole/store-picker 动态写入
    currentStore: {
      storeId: '',
      storeName: '',
      role: 'VOLUNTEER' as 'MANAGER' | 'FINANCE' | 'VOLUNTEER' | 'PATRIARCH' | 'STORE_PATRIARCH' | 'FAMILY' | 'STORE_FAMILY' | 'ADMIN' | 'SUPER_ADMIN'
    },
    userStoresList: [] as StorePermission[],
    // 🏪 门店运营状态全局态：与 current_store_status 本地存储双写同步，
    // 见 utils/storeManager.ts 的 fetchAndSyncStoreStatus() —— 一处拉取，
    // 全局共享，避免个人页/首页各自发起重复查询还容易互相不一致
    currentStoreStatus: '' as string,
    // 🔔 通知 Tab 红点徽标计数：由 pages/notice/notice.ts 每次拉取列表后写入，
    // custom-tab-bar 组件读取展示（详见 custom-tab-bar/index.ts 的 syncBadgeFromGlobal）
    pendingApprovalCount: 0,
    // 🌟 云开发 SDK 就绪状态：wx.cloud.init 曾在个别环境抛出内部致命错误
    // "Fatal: unexpected loadSdkSubPackage case"，此后 wx.cloud 可能残留为半初始化状态，
    // 后续 getCloudAPI 相关调用会直接 TypeError。全局记录一次探测结果，
    // 页面/工具函数可据此判断是否要跳过云端路径、直接走本地缓存。
    isCloudReady: false,
    // 🌟 朋友圈扫码引流：非空时代表本次启动/切前台携带了一个尚未处理的证书邀请，
    // 首页 onShow 读取后按需弹出绑定确认框，处理完（用户确认/取消/已绑定过）
    // 由首页自行清空，避免同一个 scene 在多次 onShow 间反复弹窗
    inviteContext: null as InviteContext | null,
    // 🔑 特权邀请码太阳码：scene 编码为 code=<邀请码>（见 cloudfunctions/
    // manageStoreInviteCode 的 generate 动作），与上面证书邀请的 u=/s= 格式是
    // 两种互斥的 scene 形态——扫这张码启动/切前台时暂存邀请码本身，首页 onShow
    // 据此调用 manageStoreInviteCode 的 peek/redeem 动作完成"扫码直达绑定"闭环
    pendingInviteCode: '' as string
  },

  onLaunch(options: any) {
    console.log('[App] onLaunch start');
    this._captureInviteContext(options);

    // 云开发初始化
    // 🐛 根因修复：此前无条件把首次 wx.cloud.init 延迟到 onLaunch 后 1.5s 才执行，
    // 是为了避开本地 Linux 开发者工具在 init 阶段偶发的致命错误（Fatal: unexpected
    // loadSdkSubPackage case）——但该问题按既有排查结论"本地 Linux 模拟器环境下高频
    // 出现，真机环境完全正常"，也就是说这 1.5s+ 的人为延迟对真机用户毫无必要，却让
    // 所有真机用户在这段窗口期内的早期云调用（例如首页 onLoad 就发起的云函数请求）
    // 100% 撞上 "Cloud API isn't enabled, please call wx.cloud.init first"。
    // 改为优先同步尝试一次：真机/健康环境下 onLaunch 内同步执行就能立刻就绪，早于
    // 任何页面的 onLoad；仅当这次同步尝试真的失败（判定为撞上了那个已知的 Linux
    // 开发者工具问题）时，才退回原来的延迟重试兜底路径，不让该环境的用户失去保护。
    if (!this._attemptCloudInit()) {
      console.log('[App] wx.cloud.init 同步尝试失败（疑似本地开发者工具已知问题），进入延迟重试...');
      wx.nextTick(() => {
        setTimeout(() => {
          if (!this._attemptCloudInit()) {
            console.log('[App] wx.cloud.init 延迟重试仍失败，1000ms 后再次发起...');
            setTimeout(() => {
              this._attemptCloudInit();
            }, 1000);
          }
        }, 1500);
      });
    }

    const logs = wx.getStorageSync('logs') || [];
    logs.unshift(Date.now());
    if (logs.length > 20) logs.length = 20;
    wx.setStorageSync('logs', logs);

    // 登录预热延迟执行，不阻塞首屏渲染
    setTimeout(() => {
      this._delayedLoginInit();
    }, 500);

    wx.onNetworkStatusChange((res) => {
      if (res.isConnected && this.globalData.onNetworkReconnected) {
        try {
          this.globalData.onNetworkReconnected!();
        } catch (error) {
          console.error('[App] 网络恢复回调执行失败:', error);
        }
      }
    });

    console.log('[App] onLaunch end');
  },

  // 🌟 从后台切回前台（例如点开朋友圈证书图片里的小程序码）同样要能捕获 scene——
  // onLaunch 只在小程序冷启动时触发一次，热启动/已在后台被拉起到前台走的是 onShow
  onShow(options: any) {
    this._captureInviteContext(options);
  },

  // 扫码启动时解析出邀请上下文：微信官方两种可能的携带形式都尝试一遍——
  // wxacode.getUnlimited 生成的码，scene 原样透传在 options.scene（原始编码串，
  // 需要 decodeURIComponent）；如果将来改用完整路径+query 的其它入口方式启动，
  // 则会走 options.query.scene。两者任一存在即可，取到就不再看另一个。
  //
  // 🔑 两种互斥的 scene 形态：证书邀请码（u=<openid前10位>&s=<storeId前10位>）
  // vs 特权邀请码太阳码（code=<8位邀请码>）——同一段 scene 字符串只会命中其中
  // 一种，按解析出的 key 分流写入 inviteContext 或 pendingInviteCode
  _captureInviteContext(options: any) {
    try {
      const rawScene = (options && options.query && options.query.scene) || (options && options.scene) || '';
      if (!rawScene) return;

      const sceneStr = decodeURIComponent(String(rawScene));
      // 🛡️ 不用 URLSearchParams：项目 tsconfig 的 lib 未包含 DOM 类型，手动按 & 分段
      // 解析 key=value，与 index.ts 里已有的 scene 解析兜底写法保持同一种风格
      let referrerUserId = '';
      let targetStoreId = '';
      let inviteCode = '';
      sceneStr.split('&').forEach((pair) => {
        const idx = pair.indexOf('=');
        if (idx < 0) return;
        const key = pair.slice(0, idx);
        const value = pair.slice(idx + 1);
        if (key === 'u') referrerUserId = value;
        if (key === 's') targetStoreId = value;
        if (key === 'code') inviteCode = value;
      });

      if (referrerUserId && targetStoreId) {
        this.globalData.inviteContext = { referrerUserId, targetStoreId };
        console.log('[App] 捕获朋友圈邀请上下文:', this.globalData.inviteContext);
      } else if (inviteCode) {
        this.globalData.pendingInviteCode = inviteCode;
        console.log('[App] 捕获特权邀请码:', inviteCode);
      }
    } catch (err) {
      console.warn('[App] 解析邀请 scene 失败:', err);
    }
  },

  // 尝试一次 wx.cloud.init + 方法表完整性校验，返回是否成功就绪。
  // 供 onLaunch 首次调用与 500ms 后的重试共用，避免逻辑重复。
  _attemptCloudInit(): boolean {
    try {
      // 🛡️ 动态防御拦截：比原来的 "if (!wx.cloud)" 更前置、更明确——半初始化状态下
      // wx.cloud 这个对象本身可能已经存在，但 init 方法尚未挂载完全，这正是
      // loadSdkSubPackage 内部死锁最典型的残留状态。原来的写法会直接往下调用
      // wx.cloud.init(...)，虽然外层 try/catch 能兜住它抛出的异常，但这里改成显式
      // 提前拦截 + 立即安全返回，不让代码有机会跑到 WAService 内部 getCloudAPI
      // 那一层运行时崩溃路径，防御做在调用之前而不是只靠事后捕获异常。
      if (typeof wx.cloud === 'undefined' || !wx.cloud.init) {
        console.error('[App] wx.cloud 或 wx.cloud.init 不可用（疑似分包尚未挂载完全/基础库不支持云开发），已降级本地模式');
        this.globalData.isCloudReady = false;
        return false;
      }

      wx.cloud.init({
        env: 'cloudbase-d8g7hg2bf851750ab',
        traceUser: true
      });

      // init 调用本身未抛错，不代表 SDK 真的可用——再做一次方法表探测
      const sdkIntact = typeof wx.cloud.database === 'function' && typeof wx.cloud.callFunction === 'function';
      if (sdkIntact) {
        this.globalData.isCloudReady = true;
        console.log('[App] wx.cloud.init ok，云开发 SDK 就绪');
        return true;
      }

      this.globalData.isCloudReady = false;
      console.error('[App] wx.cloud.init 未抛出异常，但 SDK 方法表不完整（疑似 loadSdkSubPackage 内部错误），已降级本地模式');
      return false;
    } catch (err) {
      this.globalData.isCloudReady = false;
      console.error('[App] wx.cloud.init 初始化失败（疑似 loadSdkSubPackage 致命错误），已降级本地模式:', err);
      return false;
    }
  },

  async _delayedLoginInit() {
    try {
      const { AuthService } = require('./utils/authService');
      const res = await AuthService.ensureLogin();
      if (res.success) {
        console.log('[App] 静默登录预热成功:', res.openid);
        this.fetchUserStorePermissions(res.openid!);
      } else {
        console.warn('[App] 静默登录预热失败:', res.error);
      }
    } catch (err) {
      console.warn('[App] 登录预热异常:', err);
    }
  },

  async fetchUserStorePermissions(openid: string) {
    try {
      // 🌟 用 isCloudAvailable() 实时探测（其内部本就会核对 globalData.isCloudReady，
      // 见 utils/cloudGuard.ts）：多数环境下 onLaunch 已同步完成 wx.cloud.init，
      // 但退回延迟重试路径的少数环境里，_delayedLoginInit 固定 500ms 触发的本方法仍可能
      // 早于云初始化真正就绪，实时探测能正确识别这种情况并跳过，而不是走缓存的一次性判断。
      if (!isCloudAvailable()) {
        console.warn('[App] 云开发 SDK 不可用，跳过多店权限拉取');
        return;
      }
      const db = wx.cloud.database();
      const res = await db.collection('user_roles').where({
        _openid: openid
      }).get();

      if (res.data && res.data.length > 0) {
        const userRec = res.data[0];
        const storeList = userRec.storePermissions || [];

        if (storeList.length > 0) {
          const savedStoreId = wx.getStorageSync('active_store_id');
          const matchedStore = storeList.find((s: any) => s.storeId === savedStoreId) || storeList[0];

          const normalizedStores = storeList.map((s: any) => ({
            storeId: s.storeId,
            storeName: s.storeName,
            role: (s.role || 'VOLUNTEER').toUpperCase() as 'MANAGER' | 'FINANCE' | 'VOLUNTEER'
          }));

          this.globalData.userStoresList = normalizedStores;
          this.globalData.currentStore = {
            storeId: matchedStore.storeId,
            storeName: matchedStore.storeName,
            role: (matchedStore.role || 'VOLUNTEER').toUpperCase() as 'MANAGER' | 'FINANCE' | 'VOLUNTEER'
          };

          wx.setStorageSync('active_store_id', matchedStore.storeId);
          console.log('[App] 多店权限加载完成:', normalizedStores.length, '个门店');
        }
      }
    } catch (err) {
      console.error('获取多店权限失败:', err);
    }
  },

  switchStore(storeId: string, storeName: string, role: 'MANAGER' | 'FINANCE' | 'VOLUNTEER') {
    this.globalData.currentStore = { storeId, storeName, role };
    this.globalData.selectedStore = { storeId, storeName };
    wx.setStorageSync('active_store_id', storeId);
    wx.setStorageSync('selectedStore', { storeId, storeName });
    console.log('[App] 已切换门店:', storeName, '角色:', role);
  }
})