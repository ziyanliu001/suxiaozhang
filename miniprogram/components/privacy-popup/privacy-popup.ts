import { subscribeNeedAuth, unsubscribeNeedAuth, PrivacyAuthSubscriber } from '../../utils/privacyAuthHub';

// 🌟 微信用户隐私保护弹窗组件
//
// 背景：微信平台自 2023 年起对 chooseAvatar（头像填写能力）、chooseMedia/chooseImage
// （相册/拍照选图）等涉及用户个人信息的接口做了隐私合规拦截——小程序若未在用户操作前
// 展示隐私授权弹窗并取得同意，这些接口会被平台静默拦截：不抛异常、不触发 success/fail
// 回调，界面表现就是"点击完全没反应"。这正是本次排查【图片识别】【头像编辑】两个按钮
// 问题的最终根因，而不是代码逻辑本身有 bug。
//
// wx.onNeedPrivacyAuthorization 是平台提供的钩子：当某次隐私接口调用即将被拦截时触发，
// 业务方需要在回调里展示确认弹窗，并在用户做出选择后调用平台传入的 resolve 函数——
// resolve({ event: 'agree' }) 放行本次被拦截的调用，resolve({ event: 'disagree' }) 中断它。
// 【同意】按钮本身还需要是 open-type="agreePrivacyAuthorization" 的原生按钮（这是平台对
// "同意"操作的合规审计要求），但按钮本身不会自动调用 resolve，仍然需要在
// bindagreeprivacyauthorization 回调里手动调用一次，两者缺一不可。
//
// 🔧 诊断开关：若怀疑当前 DevTools（尤其社区维护的 Linux 移植版）对 getPrivacySetting/
// onNeedPrivacyAuthorization 这两个较新（2023+）的隐私合规 API 模拟实现有问题导致模拟器
// 卡死，可临时改为 false 来验证——如果关掉后卡死消失，就证实是 DevTools 模拟器对这两个
// API 的模拟实现有 bug，而不是本组件或页面自身的业务逻辑问题（该结论已通过逐行代码追踪
// 排除：index.ts 完全没有引用这两个 API，本文件内部也没有任何递归/自我调用）。
// 验证完记得改回 true，否则"点击图片识别/头像编辑没反应"的隐私合规拦截会失效。
const ENABLE_PRIVACY_API_PROBE = true;

Component({
  data: {
    visible: false,
    privacyContractName: ''
  },

  lifetimes: {
    attached() {
      if (!ENABLE_PRIVACY_API_PROBE) return;

      // 🛡️ 防御性幂等卫士：正常情况下每个页面只挂载一次本组件，attached 只会触发一次；
      // 这里额外挡一道是为了防止万一某种场景下组件被重复挂载，重复订阅（虽然订阅
      // 走的是下面的 Set，重复 add 本就是安全的空操作，这里仍保留卫士，避免重复
      // 触发下面的 getPrivacySetting 请求）
      if ((this as any)._attachedOnce) return;
      (this as any)._attachedOnce = true;

      const wxAny = wx as any;

      // 🐛 合规重构：移除了此前"组件一挂载就主动弹窗"的检测逻辑——本组件挂载在
      // index/history/daily-menu/activity-log/profile 等页面的最外层，attached()
      // 在页面 onLoad 时就会触发，此前那段"needAuthorization 就直接 visible:true"
      // 的主动检测会导致首页一进来就整屏弹出隐私授权框，遮住工作空间选择主界面，
      // 且用户此时还没做任何需要相册/相机权限的操作——不符合微信"隐私接口按需
      // 弹窗"的合规要求（微信官方按需模型：只在用户真正触发 chooseMedia/
      // chooseImage/saveImageToPhotosAlbum 等隐私接口、平台即将拦截该调用时，
      // 才通过 wx.onNeedPrivacyAuthorization 回调弹出确认框）。
      // 现在只保留下面的 getPrivacySetting 调用来预取 privacyContractName（用于
      // 弹窗标题/正文动态展示真实协议名，不因此触发弹窗本身），真正的弹出时机
      // 完全交给下方对 privacyAuthHub 的订阅按需触发
      try {
        if (typeof wxAny.getPrivacySetting === 'function') {
          wxAny.getPrivacySetting({
            success: (res: any) => {
              if (res && res.privacyContractName) {
                this.setData({ privacyContractName: res.privacyContractName });
              }
            },
            fail: () => {
              // 取不到隐私配置时静默跳过，不影响下面按需弹出
            }
          });
        }
      } catch (e) {
        console.error('[privacy-popup] getPrivacySetting 调用异常:', e);
      }

      // 🛡️ 内存泄漏根因修复：此前每个组件实例各自直接调用 wx.onNeedPrivacyAuthorization
      // 注册一份原生监听器，卸载时尝试 wx.offNeedPrivacyAuthorization 注销——但该 off API
      // 在不少基础库版本里根本不存在，一旦静默失败，注册就永远撤不掉，history/statistics
      // 这类非 tabBar 页面每次导航进出都会新增一次注册，最终触发"21 listeners of event
      // onBeforeUnloadPage_N have been added, possibly causing memory leak"告警。
      // 现在原生 API 只在 app.ts onLaunch 里注册一次（见 utils/privacyAuthHub.ts），
      // 这里只是订阅一个模块内的普通 Set，attached/detached 无论触发多少次都只是
      // Set.add/delete，不会有任何残留。onResolved 用于收起本实例可能残留的陈旧
      // 弹窗（见 privacyAuthHub 顶部注释——其它 tab 页的实例先一步 resolve 时）
      const privacySubscriber: PrivacyAuthSubscriber = {
        onNeedAuth: (resolve) => {
          (this as any)._pendingResolve = resolve;
          this.setData({ visible: true });
        },
        onResolved: () => {
          this.setData({ visible: false });
          (this as any)._pendingResolve = null;
        }
      };
      (this as any)._privacySubscriber = privacySubscriber;
      subscribeNeedAuth(privacySubscriber);
    },

    detached() {
      const subscriber = (this as any)._privacySubscriber;
      if (subscriber) {
        unsubscribeNeedAuth(subscriber);
      }
      (this as any)._privacySubscriber = null;
      (this as any)._pendingResolve = null;
      (this as any)._attachedOnce = false;
    }
  },

  methods: {
    onOpenPrivacyContract() {
      const wxAny = wx as any;
      if (typeof wxAny.openPrivacyContract === 'function') {
        wxAny.openPrivacyContract({
          fail: () => {
            wx.showToast({ title: '打开隐私协议失败，请稍后重试', icon: 'none' });
          }
        });
      }
    },

    onAgree() {
      this.setData({ visible: false });
      const pendingResolve = (this as any)._pendingResolve;
      if (pendingResolve) {
        pendingResolve({ event: 'agree' });
        (this as any)._pendingResolve = null;
      }
    },

    onDisagree() {
      this.setData({ visible: false });
      const pendingResolve = (this as any)._pendingResolve;
      if (pendingResolve) {
        pendingResolve({ event: 'disagree' });
        (this as any)._pendingResolve = null;
      }
      wx.showToast({ title: '未同意隐私协议，相关功能暂时无法使用', icon: 'none' });
    }
  }
});
