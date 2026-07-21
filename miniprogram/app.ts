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

App({
  globalData: {
    onNetworkReconnected: null as (() => void) | null,
    selectedStore: null as { storeId: string; storeName: string } | null,
    currentStore: {
      storeId: 'store_haicang_001',
      storeName: '海沧区雨花斋',
      role: 'VOLUNTEER' as 'MANAGER' | 'FINANCE' | 'VOLUNTEER'
    },
    userStoresList: [] as StorePermission[],
    // 🔔 通知 Tab 红点徽标计数：由 pages/notice/notice.ts 每次拉取列表后写入，
    // custom-tab-bar 组件读取展示（详见 custom-tab-bar/index.ts 的 syncBadgeFromGlobal）
    pendingApprovalCount: 0,
    // 🌟 云开发 SDK 就绪状态：wx.cloud.init 曾在个别环境抛出内部致命错误
    // "Fatal: unexpected loadSdkSubPackage case"，此后 wx.cloud 可能残留为半初始化状态，
    // 后续 getCloudAPI 相关调用会直接 TypeError。全局记录一次探测结果，
    // 页面/工具函数可据此判断是否要跳过云端路径、直接走本地缓存。
    isCloudReady: false
  },

  onLaunch() {
    console.log('[App] onLaunch start');

    // 云开发初始化（延迟到首页再执行，避免阻塞启动）
    // 🐛 容错 + 时序错开：wx.cloud.init 本身可能同步抛出致命错误（典型表现：Fatal:
    // unexpected loadSdkSubPackage case），本地 Linux 模拟器环境下高频出现，真机环境
    // 完全正常——根因是开发者工具在 onLaunch 阶段异步挂载云开发基础库分包，如果在
    // onLaunch 同步执行阶段就立刻调用 wx.cloud.init，容易撞上分包还没挂载完全的窗口期。
    // 用 wx.nextTick 先让出当前这一帧，再叠加 1500ms 的宏任务延迟，把首次调用尽量错开到
    // 分包加载大概率已经完成、主线程空闲之后再执行；仍失败则再重试一次。
    // 🛡️ isCloudReady 目前唯一的读取点在 fetchUserStorePermissions（经 _delayedLoginInit
    // 500ms 后触发），如果只把这里的首次调用推迟到 1500ms，会出现"登录预热跑在云初始化
    // 完成之前"的时序倒挂——健康的真机环境下也会因为读到还没来得及置位的 isCloudReady
    // 而被误判成云不可用，静默跳过多店权限拉取。为此把 fetchUserStorePermissions 里的
    // 判断改成了实时探测的 isCloudAvailable()（与全项目其余云调用点一致的判定方式），
    // 不再依赖这个只会在 onLaunch 里某个时间点才置位一次的缓存标记，从根上消除这个时序耦合。
    wx.nextTick(() => {
      setTimeout(() => {
        if (!this._attemptCloudInit()) {
          console.log('[App] wx.cloud.init 首次尝试失败，1000ms 后发起重试...');
          setTimeout(() => {
            this._attemptCloudInit();
          }, 1000);
        }
      }, 1500);
    });

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
      // 🌟 这里改用 isCloudAvailable() 实时探测，而不是读取 globalData.isCloudReady 缓存标记：
      // 云初始化已延迟到 onLaunch 后约 1.5s 才发起（见上方 wx.nextTick 时序调整），而
      // _delayedLoginInit 仍固定在 500ms 触发本方法，若继续依赖缓存标记，健康设备上也会
      // 因为标记还没来得及置 true 而被误判为"云不可用"，导致多店权限拉取被永久跳过。
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