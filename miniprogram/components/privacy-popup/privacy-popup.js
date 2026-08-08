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
            if (!ENABLE_PRIVACY_API_PROBE)
                return;
            // 🛡️ 防御性幂等卫士：正常情况下每个页面只挂载一次本组件，attached 只会触发一次；
            // 这里额外挡一道是为了防止万一某种场景下组件被重复挂载，重复调用
            // wx.onNeedPrivacyAuthorization（该 API 是累加式注册，多次调用会叠加多个全局监听器，
            // 不会互相覆盖，也不会自动去重）
            if (this._attachedOnce)
                return;
            this._attachedOnce = true;
            const wxAny = wx;
            // 🌟 双保险：主动检测 + 被动拦截兜底，两者不冲突——
            // ① 主动检测（本次新增）：组件一挂载（也就是页面 onLoad 附近）就调用
            //   wx.getPrivacySetting 查一次 needAuthorization，如果用户还没同意，直接把弹窗
            //   提前弹出来，让用户在真正点【图片识别】【头像】之前就把授权走完，
            //   避免"点了半天没反应"的困惑体验——这正是需求里要求的"第一步"。
            // ② 被动兜底（原有逻辑）：万一主动检测这次调用失败/漏判，wx.onNeedPrivacyAuthorization
            //   仍然会在平台真正拦截某次隐私接口调用时兜底弹出，双重保证不会出现"死锁"。
            //
            // 两处都包了 try/catch：如果当前 DevTools 模拟器对这两个 API 的实现有 bug、
            // 调用时同步抛异常，至少不会让整个组件 attached() 直接崩溃导致页面渲染中断。
            try {
                if (typeof wxAny.getPrivacySetting === 'function') {
                    wxAny.getPrivacySetting({
                        success: (res) => {
                            if (res && res.privacyContractName) {
                                this.setData({ privacyContractName: res.privacyContractName });
                            }
                            if (res && res.needAuthorization) {
                                this.setData({ visible: true });
                            }
                        },
                        fail: () => {
                            // 取不到隐私配置时静默跳过——不影响下面 onNeedPrivacyAuthorization 的被动兜底
                        }
                    });
                }
            }
            catch (e) {
                console.error('[privacy-popup] getPrivacySetting 调用异常:', e);
            }
            try {
                if (typeof wxAny.onNeedPrivacyAuthorization === 'function') {
                    const privacyHandler = (resolve) => {
                        this._pendingResolve = resolve;
                        this.setData({ visible: true });
                    };
                    this._privacyHandler = privacyHandler;
                    wxAny.onNeedPrivacyAuthorization(privacyHandler);
                }
            }
            catch (e) {
                console.error('[privacy-popup] onNeedPrivacyAuthorization 注册异常:', e);
            }
        },
        // 🛡️ 内存泄漏防护：配套 off，消除 onBeforeUnloadPage 监听器告警
        detached() {
            const wxAny = wx;
            try {
                const handler = this._privacyHandler;
                if (handler && typeof wxAny.offNeedPrivacyAuthorization === 'function') {
                    wxAny.offNeedPrivacyAuthorization(handler);
                }
            }
            catch (e) { /* 旧基础库无此 API，静默跳过 */ }
            this._privacyHandler = null;
            this._pendingResolve = null;
            this._attachedOnce = false;
        }
    },
    methods: {
        onOpenPrivacyContract() {
            const wxAny = wx;
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
            const pendingResolve = this._pendingResolve;
            if (pendingResolve) {
                pendingResolve({ event: 'agree' });
                this._pendingResolve = null;
            }
        },
        onDisagree() {
            this.setData({ visible: false });
            const pendingResolve = this._pendingResolve;
            if (pendingResolve) {
                pendingResolve({ event: 'disagree' });
                this._pendingResolve = null;
            }
            wx.showToast({ title: '未同意隐私协议，相关功能暂时无法使用', icon: 'none' });
        }
    }
});
