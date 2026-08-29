/**
 * archive-modal.ts
 * 我的雨花护持档案弹窗组件
 *
 * 业务特性：
 *  - 展示累计护持天数、贡献工时、当前荣誉勋章
 *  - 金色渐变进度条：可视化当前工时距离下一级勋章的差距
 *  - 「分享荣誉海报」主按钮：Canvas 合成头像/用户名/护持数据/二维码海报并保存到相册
 *  - 「继续护持」辅助按钮：关闭弹窗
 */
import { AuthService } from '../../utils/authService'
import { drawStaticWxacodeFallback } from '../../utils/staticWxacode'
import { HonorProgress, computeHonorProgress, lightenHex, drawMedalBadge } from '../../utils/honorLevels'
import { getSafeSystemInfo } from '../../utils/util'
import { callFunctionWithTimeout } from '../../utils/withTimeout';

export type { HonorProgress }

export interface ArchiveUserInfo {
  nickName?: string
  avatarUrl?: string
  totalDays: number
  totalCheckInCount: number
  totalHours: number
}

Component({
  options: {
    styleIsolation: 'apply-shared',
    addGlobalClass: true
  },

  properties: {
    visible: {
      type: Boolean,
      value: false
    },
    userInfo: {
      type: Object,
      value: {} as ArchiveUserInfo
    }
  },

  data: {
    honor: {} as HonorProgress,
    isDrawing: false,

    // 🌟「我的爱心荣誉卡」预览：海报生成完成后先展示出来让用户确认，而不是
    // 生成完直接静默存进相册——用户此前完全看不到长什么样，只能等它出现在相册里
    showPosterPreview: false,
    posterTempFilePath: '',
    posterSaving: false
  },

  observers: {
    'visible, userInfo': function (visible: boolean, userInfo: ArchiveUserInfo) {
      if (visible && userInfo) {
        const honor = computeHonorProgress(userInfo.totalHours || 0)
        this.setData({ honor })
      }
    }
  },

  methods: {
    onMaskTap() {
      // 点击遮罩不关闭，避免误触
    },

    noop() {
      // 阻止冒泡空函数
    },

    onClose() {
      this.triggerEvent('close', {}, {})
    },

    onViewJourney() {
      this.triggerEvent('viewJourney', {}, {})
    },

    // 🐛 修复"卡在正在生成海报..无法退出"：此前 drawHonorPoster() 内部用
    // wx.downloadFile 下载头像，但本项目头像上传后存的是 cloud:// fileID（见
    // utils/imageCompress.ts compressAndUploadScaledImage），wx.downloadFile 只支持
    // http(s):// 协议——传入 cloud:// 地址在部分机型/基础库上既不触发 success 也不
    // 触发 fail 回调，导致整条 Promise 链永久悬空，单纯加 try/catch 拦不住"永远不
    // resolve/reject"的情况。这里双管齐下：① 用 Promise.race 叠加超时兜底，保证无论
    // 如何 15 秒后必然退出 loading；② 从根源修复头像下载逻辑，按协议头正确分流到
    // wx.cloud.downloadFile（cloud://）或 wx.downloadFile（http/https），与
    // utils/posterGenerator.ts 里 resolveHeroImageLocalPath 的既有处理口径保持一致
    async onSharePoster() {
      if (this.data.isDrawing) return
      this.setData({ isDrawing: true })
      // 🐛 修复"卡在生成海报界面退不出来"：mask:true 会加一层原生全屏触摸拦截层，
      // 挡住下面本来就可以点的 X/继续护持关闭按钮，用户直观感受就是"界面卡死"——
      // 哪怕 15 秒超时兜底最终会退出 loading，这段时间内也完全点不动关闭按钮。
      // 这里改为不加全屏遮罩，仅保留顶部提示条文案，按钮自身的"生成中..."态
      // 已经能表达"正在处理"，用户随时可以点击关闭，生成任务在后台继续跑，
      // 结束后 finally 里的 hideLoading/setData 依然会正常执行（组件只是被
      // visible=false 隐藏，并未销毁）
      wx.showLoading({ title: '正在生成海报...', mask: false })

      try {
        const posterPath = await Promise.race([
          this.drawHonorPoster(),
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error('海报生成超时，请检查网络后重试')), 15000)
          })
        ])

        // 🐛 根因修复：此前生成完直接 wx.saveImageToPhotosAlbum 静默存进相册，
        // 用户完全看不到长什么样——先展示预览，看清楚了再手动点"保存到相册"
        this.setData({ posterTempFilePath: posterPath, showPosterPreview: true })
      } catch (err: any) {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) {
          // 用户取消，不提示
        } else {
          console.error('[archive-modal] 生成海报失败:', err)
          wx.showToast({ title: (err && err.message) || '海报生成失败，请重试', icon: 'none' })
        }
      } finally {
        // 🛡️ 双重保险：无论成功、失败还是超时兜底触发，必须关闭 loading 与按钮锁定态
        wx.hideLoading()
        this.setData({ isDrawing: false })
      }
    },

    // 「我的爱心荣誉卡」预览弹窗：关闭（保存中禁止误触关闭）
    onClosePosterPreview() {
      if (this.data.posterSaving) return
      this.setData({ showPosterPreview: false })
    },

    // 预览确认后才真正写入相册
    async onConfirmSavePoster() {
      if (this.data.posterSaving || !this.data.posterTempFilePath) return
      this.setData({ posterSaving: true })

      try {
        await wx.saveImageToPhotosAlbum({ filePath: this.data.posterTempFilePath })
        wx.showToast({ title: '海报已保存到相册', icon: 'success' })
        this.setData({ showPosterPreview: false })
      } catch (err: any) {
        if (err && err.errMsg && err.errMsg.indexOf('auth deny') >= 0) {
          wx.showModal({
            title: '需要授权',
            content: '保存海报需要您授权「保存到相册」权限',
            confirmText: '去设置',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting()
              }
            }
          })
        } else if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) {
          // 用户取消，不提示
        } else {
          console.error('[archive-modal] 保存海报失败:', err)
          wx.showToast({ title: '保存失败，请重试', icon: 'none' })
        }
      } finally {
        this.setData({ posterSaving: false })
      }
    },

    /**
     * Canvas 合成【我的爱心荣誉卡】
     * 画布尺寸：900 x 1500 px（2x 高清）
     *
     * 🌟 视觉重构：与 utils/drawVolunteerCertificate.ts 的古风证书（米色宣纸 + 金色
     * 三层描边 + 红色印章）做出明确区分——这张卡走"现代温馨"路线：顶部纯色渐变
     * 头图（暖橘色，圆角收边）+ 白底数据卡片 + 一枚随护持工时动态换色的勋章徽章
     * （压在头图与卡片的接缝处），整体是"现代 App 成就卡"的视觉语言，而不是仿古卷轴
     */
    async drawHonorPoster(): Promise<string> {
      const userInfo = this.data.userInfo as ArchiveUserInfo
      const honor = this.data.honor as HonorProgress
      const nickName = userInfo.nickName || '雨花义工家人'
      const totalDays = userInfo.totalDays || 0
      const totalHours = userInfo.totalHours || 0
      const totalCount = userInfo.totalCheckInCount || 0

      const W = 900
      const H = 1500
      const canvas = await this._getCanvasNode()
      const ctx = canvas.getContext('2d')
      const dpr = getSafeSystemInfo().pixelRatio || 1
      canvas.width = W * dpr
      canvas.height = H * dpr
      ctx.scale(dpr, dpr)

      // 1. 白底打底：现代卡片风格的中性背景，不用米色宣纸这类"做旧"底色
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, W, H)

      // 2. 顶部暖橘渐变头图（圆角收边）+ 随等级递增的点缀光点
      const heroH = 460
      this._drawHeroBand(ctx, W, heroH, honor)

      // 3. 头像（圆形裁剪，白色描边）：叠在头图上——先把 avatarUrl（cloud:// fileID /
      // http(s) 直链 / 本机临时路径）统一解析成本地路径，任何一步失败都优雅降级为
      // 默认头像图标，不让整张卡片的生成因为头像下载失败而卡死/报错
      const avatarSize = 140
      const avatarX = W / 2 - avatarSize / 2
      const avatarY = 64
      const localAvatarPath = await this._resolveAvatarLocalPath(userInfo.avatarUrl || '')

      if (localAvatarPath) {
        const img = await this._loadCanvasImage(canvas, localAvatarPath)
        if (img) {
          this._drawAvatar(ctx, img, avatarX, avatarY, avatarSize)
        } else {
          this._drawDefaultAvatar(ctx, avatarX, avatarY, avatarSize)
        }
      } else {
        this._drawDefaultAvatar(ctx, avatarX, avatarY, avatarSize)
      }

      // 4. 昵称 + 副标题（白字，叠在头图下半部分）
      ctx.textAlign = 'center'
      ctx.fillStyle = '#FFFFFF'
      ctx.font = 'bold 38px sans-serif'
      ctx.fillText(nickName, W / 2, avatarY + avatarSize + 52)
      ctx.fillStyle = 'rgba(255,255,255,0.88)'
      ctx.font = '24px sans-serif'
      ctx.fillText('感恩您的每一次默默付出', W / 2, avatarY + avatarSize + 90)

      // 5. 成就徽章：压在头图与下方白色内容区的接缝处，颜色随当前护持等级变化
      // （初心行者=灰、爱心学习者=铜、守望者=银、金牌守护者=金……），是本次改版
      // "根据护持天数/工时动态展示成就徽章"的核心视觉元素
      const badgeCenterY = heroH
      const badgeRadius = 78
      drawMedalBadge(ctx, W / 2, badgeCenterY, badgeRadius, honor.currentLevelColor)
      ctx.textAlign = 'center'
      ctx.fillStyle = honor.currentLevelColor
      ctx.font = 'bold 32px sans-serif'
      ctx.fillText(honor.currentLevelName, W / 2, badgeCenterY + badgeRadius + 44)

      this._drawPosterContent(ctx, totalDays, totalHours, totalCount, honor)
      await this._drawQRSection(ctx, canvas)
      return this._canvasToTempFile(canvas)
    },

    // 顶部暖橘渐变头图：圆角矩形收边（底部两角），叠加随等级数量递增的白色光点，
    // 呼应"根据护持天数/工时动态展示不同背景装饰"——用固定暖色渐变而非勋章色本身
    // 打底，是刻意的：初心行者的勋章色是灰色，若整块头图跟着变灰会显得整张卡片
    // 暗淡无生气，把"随等级变化"的信号收敛到徽章配色 + 光点数量上更稳妥
    _drawHeroBand(ctx: any, w: number, h: number, honor: HonorProgress) {
      const r = 40
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(w, 0)
      ctx.lineTo(w, h - r)
      ctx.arcTo(w, h, w - r, h, r)
      ctx.lineTo(r, h)
      ctx.arcTo(0, h, 0, h - r, r)
      ctx.closePath()
      ctx.clip()

      const grad = ctx.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, '#FF8A65')
      grad.addColorStop(1, '#FFB74D')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      // 点缀光点：数量 = 当前等级序号 + 2，用固定三角函数种子代替 Math.random()，
      // 保证同一等级每次生成的点缀位置是确定性的（便于排查问题时复现同一张图）
      const sparkleCount = honor.currentLevelIndex + 2
      ctx.fillStyle = 'rgba(255,255,255,0.32)'
      for (let i = 0; i < sparkleCount; i++) {
        const sx = (Math.sin(i * 12.9898) * 0.5 + 0.5) * w
        const sy = (Math.sin(i * 78.233 + 4) * 0.5 + 0.5) * (h - 60) + 30
        const sr = 3 + (i % 3) * 2
        ctx.beginPath()
        ctx.arc(sx, sy, sr, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()

      ctx.textAlign = 'center'
      ctx.fillStyle = '#FFFFFF'
      ctx.font = 'bold 28px sans-serif'
      ctx.fillText('💛 我的爱心荣誉卡', w / 2, 44)
    },

    _getCanvasNode(): Promise<any> {
      return new Promise((resolve, reject) => {
        const query = wx.createSelectorQuery().in(this)
        query.select('#honorPosterCanvas')
          .fields({ node: true, size: true })
          .exec((res) => {
            if (!res || !res[0] || !res[0].node) {
              reject(new Error('canvas node not found'))
              return
            }
            resolve(res[0].node)
          })
      })
    },

    // 🐛 根因修复：本项目头像上传后存的是 cloud:// fileID（utils/imageCompress.ts
    // compressAndUploadScaledImage），不是 http(s) 直链——wx.downloadFile 只认
    // http(s):// 协议，此前不分青红皂白一律走 wx.downloadFile，遇到 cloud:// 地址在
    // 部分机型/基础库上既不 success 也不 fail，海报生成 Promise 永久悬空。这里按
    // 协议头正确分流，与 utils/posterGenerator.ts resolveHeroImageLocalPath 同一套口径：
    // cloud:// 用 wx.cloud.downloadFile，http(s) 用 wx.downloadFile，其余（已经是
    // 本机临时路径）直接原样使用，不再重复下载。任何一步失败都返回 null 交给调用方
    // 降级为默认头像图标，不让整张海报因为头像下载失败而报错/卡死
    async _resolveAvatarLocalPath(avatarUrl: string): Promise<string | null> {
      if (!avatarUrl) return null
      try {
        if (avatarUrl.indexOf('cloud://') === 0) {
          const res = await wx.cloud.downloadFile({ fileID: avatarUrl })
          return res.tempFilePath
        }
        if (avatarUrl.indexOf('http://') === 0 || avatarUrl.indexOf('https://') === 0) {
          // 🐛 wx.downloadFile 在本项目的类型声明里是回调式（返回 DownloadTask 而非
          // Promise），与 wx.cloud.downloadFile 不同，不能直接 await——手动包一层
          // Promise，与 utils/posterGenerator.ts downloadHttpFile 同一套写法
          return await new Promise<string>((resolve, reject) => {
            wx.downloadFile({
              url: avatarUrl,
              success: (res) => resolve(res.tempFilePath),
              fail: (err) => reject(err)
            })
          })
        }
        return avatarUrl
      } catch (err) {
        console.warn('[archive-modal] 头像下载失败，海报将使用默认头像图标:', err)
        return null
      }
    },

    _loadCanvasImage(canvas: any, src: string): Promise<any | null> {
      return new Promise((resolve) => {
        const img = canvas.createImage()
        img.src = src
        img.onload = () => resolve(img)
        img.onerror = () => resolve(null)
      })
    },

    _drawAvatar(ctx: any, img: any, x: number, y: number, size: number) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
      ctx.clip()

      // 🐛 修复：旧写法 drawImage(img, x, y, size, size) 是把源图整张拉伸铺满 size×size，
      // 源图不是正方形时会被压扁/拉长变形。改为居中裁出源图的最大正方形区域再铺满，
      // 避免非正方形头像（本项目头像上传现在直接存原始文件，不再强制方形裁剪，
      // 见 miniprogram/utils/imageCompress.ts compressAndUploadScaledImage）在海报里走形
      const cropSize = Math.min(img.width, img.height)
      const cropX = (img.width - cropSize) / 2
      const cropY = (img.height - cropSize) / 2
      ctx.drawImage(img, cropX, cropY, cropSize, cropSize, x, y, size, size)
      ctx.restore()

      // 头像白色描边：叠在暖橘色头图上时比金色边框反差更清晰，更符合现代卡片风格
      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, size / 2 + 6, 0, Math.PI * 2)
      ctx.lineWidth = 6
      ctx.strokeStyle = '#FFFFFF'
      ctx.stroke()
    },

    _drawDefaultAvatar(ctx: any, x: number, y: number, size: number) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
      ctx.fillStyle = '#FFE0CC'
      ctx.fill()
      ctx.clip()
      ctx.fillStyle = '#FF7043'
      ctx.font = 'bold 70px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('义', x + size / 2, y + size / 2)
      ctx.restore()

      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, size / 2 + 6, 0, Math.PI * 2)
      ctx.lineWidth = 6
      ctx.strokeStyle = '#FFFFFF'
      ctx.stroke()
    },

    // 昵称/副标题/徽章都已在 drawHonorPoster 里画在头图区域，这里只负责头图
    // 以下的白色内容区：三项数据 + 等级进度条 + 下一级提示 + 分隔线
    _drawPosterContent(ctx: any, totalDays: number, totalHours: number, totalCount: number, honor: HonorProgress) {
      // 数据卡片背景：现代扁平卡片，浅灰描边而非证书那种金色描边
      const cardY = 620
      const cardH = 220
      ctx.fillStyle = '#FBFAF8'
      this._roundRect(ctx, 80, cardY, 740, cardH, 24)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.05)'
      ctx.lineWidth = 2
      ctx.stroke()

      // 三个数据：强调色改用暖橘（呼应头图），与证书的正红/深红强调色区分开
      const drawData = (label: string, value: string, xPos: number) => {
        ctx.textAlign = 'center'
        ctx.fillStyle = '#FF7043'
        ctx.font = 'bold 60px sans-serif'
        ctx.fillText(value, xPos, cardY + 95)
        ctx.fillStyle = '#8D8D8D'
        ctx.font = '24px sans-serif'
        ctx.fillText(label, xPos, cardY + 140)
      }
      drawData('累计护持天数', String(totalDays), 220)
      drawData('累计打卡次数', String(totalCount), 450)
      drawData('贡献爱心工时', String(totalHours) + 'h', 680)

      // 等级进度条：渐变色跟随当前勋章色，等级越高进度条颜色也随之变化
      const barX = 120
      const barY = cardY + cardH + 30
      const barW = 660
      const barH = 26
      ctx.fillStyle = '#F0EEEA'
      this._roundRect(ctx, barX, barY, barW, barH, barH / 2)
      ctx.fill()

      const progressW = barW * (honor.progressPercent / 100)
      const pGradient = ctx.createLinearGradient(barX, barY, barX + progressW, barY)
      pGradient.addColorStop(0, lightenHex(honor.currentLevelColor, 0.35))
      pGradient.addColorStop(1, honor.currentLevelColor)
      ctx.fillStyle = pGradient
      this._roundRect(ctx, barX, barY, progressW, barH, barH / 2)
      ctx.fill()

      ctx.textAlign = 'center'
      ctx.fillStyle = '#FFFFFF'
      ctx.font = 'bold 20px sans-serif'
      if (progressW > 70) {
        ctx.fillText(honor.progressPercent + '%', barX + progressW / 2, barY + 18)
      }

      // 下一级提示
      ctx.textAlign = 'center'
      ctx.fillStyle = '#9E9E9E'
      ctx.font = '24px sans-serif'
      const nextTip = honor.remainHours > 0
        ? `距离「${honor.nextLevelName}」还需 ${honor.remainHours} 小时`
        : '您已达到最高荣誉等级，感恩无尽护持'
      ctx.fillText(nextTip, 450, barY + 60)

      // 分隔线
      ctx.beginPath()
      ctx.moveTo(200, barY + 95)
      ctx.lineTo(700, barY + 95)
      ctx.strokeStyle = 'rgba(0,0,0,0.06)'
      ctx.lineWidth = 2
      ctx.stroke()
    },

    // 🐛 根因修复：这里原来的二维码是 _drawDecorativeQRCode 手绘的假图案——用固定
    // seed 的伪随机数拼数据模块，看起来像小程序码（三个角有定位框），但模块本身不
    // 是任何真实编码内容，微信扫不出任何东西。改为和 pages/profile/profile.ts 里
    // 证书二维码同一套做法：调用 getStoreQRCode 云函数（内部走
    // cloud.openapi.wxacode.getUnlimited 生成真正指向小程序首页的小程序码），下载
    // 到本地后直接 drawImage 绘制到画布上，才是真正可扫描的码。云函数失败时不再
    // 用 utils/qrEncoder.ts 现算一张只能编码纯文本的本地 QR 码——微信扫一扫客户端
    // 会直接拦下提示"暂不支持展示二维码中的文本内容"，等于没有码。改用随包打包的
    // 官方静态小程序码兜底（utils/staticWxacode.ts），扫码 100% 能拉起本小程序
    async _drawQRSection(ctx: any, canvas: any) {
      // 二维码卡片底：留出足够留白（quiet zone），避免定位角贴边影响识别率
      ctx.fillStyle = '#FBFAF8'
      this._roundRect(ctx, 280, 1000, 340, 340, 20)
      ctx.fill()

      const qrLocalPath = await this._fetchRealQRCodeLocalPath()
      const qrImg = qrLocalPath ? await this._loadCanvasImage(canvas, qrLocalPath) : null
      if (qrImg) {
        // 240×240 画在 340×340 白底卡片正中，四周各留 50px 留白，不额外叠加任何
        // Logo/圆点装饰——小程序码定位角本身容错率有限，叠加装饰只会增加扫描失败风险
        ctx.drawImage(qrImg, 330, 1050, 240, 240)
      } else {
        try {
          await drawStaticWxacodeFallback(ctx, canvas, 330, 1050, 240)
        } catch (err) {
          console.warn('[archive-modal] 静态小程序码兜底加载异常:', err)
        }
      }

      ctx.fillStyle = '#8D8D8D'
      ctx.font = '24px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('扫码加入雨花爱心餐报助手', 450, 1380)

      // 底部品牌语
      ctx.fillStyle = '#FF7043'
      ctx.font = 'bold 30px sans-serif'
      ctx.fillText('端上一碗热饭，温暖世间一颗心', 450, 1425)
    },

    async _fetchRealQRCodeLocalPath(): Promise<string> {
      try {
        const cachedRole = AuthService.getCachedRoleInfo()
        const storeId = cachedRole && cachedRole.storeId
        if (!storeId) return ''
        const qrRes = await callFunctionWithTimeout({
          name: 'getStoreQRCode',
          data: { storeId, storeName: cachedRole.storeName, purpose: 'certificate' }
        })
        const qrResult = qrRes.result as any
        if (qrResult && qrResult.success && qrResult.fileID) {
          const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID })
          return downRes.tempFilePath
        }
        console.warn('[archive-modal] 小程序码生成失败:', qrResult && qrResult.error)
        return ''
      } catch (err) {
        console.warn('[archive-modal] 小程序码获取异常，海报将使用静态小程序码兜底:', err)
        return ''
      }
    },

    _roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
      const min = Math.min(w, h)
      if (r > min / 2) r = min / 2
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    },

    _canvasToTempFile(canvas: any): Promise<string> {
      return new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas,
          success: (res: any) => resolve(res.tempFilePath),
          fail: reject
        }, this)
      })
    }
  }
})
