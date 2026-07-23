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

export interface HonorProgress {
  currentLevelName: string
  nextLevelName: string
  currentHours: number
  nextHours: number
  progressPercent: number
  remainHours: number
}

export interface ArchiveUserInfo {
  nickName?: string
  avatarUrl?: string
  totalDays: number
  totalCheckInCount: number
  totalHours: number
}

const MEDAL_LEVELS = [
  { name: '初心行者', minHours: 0, color: '#9E9E9E' },
  { name: '雨花爱心学习者', minHours: 10, color: '#CD7F32' },
  { name: '雨花爱心守望者', minHours: 25, color: '#C0C0C0' },
  { name: '雨花金牌守护者', minHours: 50, color: '#F5A623' },
  { name: '雨花钻石护持者', minHours: 100, color: '#B22222' },
  { name: '雨花无上菩提行者', minHours: 200, color: '#8C1D18' }
]

function computeHonorProgress(totalHours: number): HonorProgress {
  for (let i = MEDAL_LEVELS.length - 1; i >= 0; i--) {
    if (totalHours >= MEDAL_LEVELS[i].minHours) {
      const nextLevel = MEDAL_LEVELS[i + 1]
      if (nextLevel) {
        const range = nextLevel.minHours - MEDAL_LEVELS[i].minHours
        const progress = totalHours - MEDAL_LEVELS[i].minHours
        const percent = Math.min(100, Math.max(0, Math.round((progress / range) * 100)))
        return {
          currentLevelName: MEDAL_LEVELS[i].name,
          nextLevelName: nextLevel.name,
          currentHours: totalHours,
          nextHours: nextLevel.minHours,
          progressPercent: percent,
          remainHours: parseFloat((nextLevel.minHours - totalHours).toFixed(1))
        }
      }
      // 满级
      return {
        currentLevelName: MEDAL_LEVELS[i].name,
        nextLevelName: '已是最高荣誉',
        currentHours: totalHours,
        nextHours: totalHours,
        progressPercent: 100,
        remainHours: 0
      }
    }
  }
  return {
    currentLevelName: MEDAL_LEVELS[0].name,
    nextLevelName: MEDAL_LEVELS[1].name,
    currentHours: totalHours,
    nextHours: MEDAL_LEVELS[1].minHours,
    progressPercent: Math.min(100, Math.max(0, Math.round((totalHours / MEDAL_LEVELS[1].minHours) * 100))),
    remainHours: parseFloat((MEDAL_LEVELS[1].minHours - totalHours).toFixed(1))
  }
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
    isDrawing: false
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

        await wx.saveImageToPhotosAlbum({ filePath: posterPath })
        wx.showToast({ title: '海报已保存到相册', icon: 'success' })
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
          console.error('[archive-modal] 生成/保存海报失败:', err)
          wx.showToast({ title: (err && err.message) || '海报生成失败，请重试', icon: 'none' })
        }
      } finally {
        // 🛡️ 双重保险：无论成功、失败还是超时兜底触发，必须关闭 loading 与按钮锁定态
        wx.hideLoading()
        this.setData({ isDrawing: false })
      }
    },

    /**
     * Canvas 合成荣誉海报
     * 画布尺寸：900 x 1440 px（2x 高清）
     */
    async drawHonorPoster(): Promise<string> {
      const userInfo = this.data.userInfo as ArchiveUserInfo
      const honor = this.data.honor as HonorProgress
      const nickName = userInfo.nickName || '雨花义工家人'
      const totalDays = userInfo.totalDays || 0
      const totalHours = userInfo.totalHours || 0
      const totalCount = userInfo.totalCheckInCount || 0

      const canvas = await this._getCanvasNode()
      const ctx = canvas.getContext('2d')
      const dpr = wx.getSystemInfoSync().pixelRatio || 1
      canvas.width = 900 * dpr
      canvas.height = 1440 * dpr
      ctx.scale(dpr, dpr)

      // 1. 背景：禅意米色渐变
      const bgGradient = ctx.createLinearGradient(0, 0, 900, 1440)
      bgGradient.addColorStop(0, '#FDFBF6')
      bgGradient.addColorStop(0.5, '#F9F5ED')
      bgGradient.addColorStop(1, '#F3EDE2')
      ctx.fillStyle = bgGradient
      ctx.fillRect(0, 0, 900, 1440)

      // 顶部装饰弧线
      ctx.beginPath()
      ctx.arc(450, -200, 600, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(178,34,34,0.06)'
      ctx.fill()

      // 底部装饰弧线
      ctx.beginPath()
      ctx.arc(450, 1640, 600, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(245,166,35,0.08)'
      ctx.fill()

      // 2. 标题
      ctx.textAlign = 'center'
      ctx.fillStyle = '#8C1D18'
      ctx.font = 'bold 52px sans-serif'
      ctx.fillText('我的雨花护持档案', 450, 120)

      // 3. 头像（圆形裁剪）：先把 avatarUrl（cloud:// fileID / http(s) 直链 / 本机临时路径）
      // 统一解析成一个可直接喂给 canvas.createImage() 的本地路径，任何一步失败都
      // 优雅降级为默认头像图标，不让整张海报的生成因为头像下载失败而卡死/报错
      const avatarSize = 160
      const avatarX = 450 - avatarSize / 2
      const avatarY = 190
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

      this._drawPosterContent(ctx, nickName, totalDays, totalHours, totalCount, honor)
      return this._canvasToTempFile(canvas)
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

      // 头像金色边框
      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, size / 2 + 6, 0, Math.PI * 2)
      ctx.lineWidth = 6
      ctx.strokeStyle = '#D4AF37'
      ctx.stroke()
    },

    _drawDefaultAvatar(ctx: any, x: number, y: number, size: number) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
      ctx.fillStyle = '#EFE6D8'
      ctx.fill()
      ctx.clip()
      ctx.fillStyle = '#8C1D18'
      ctx.font = 'bold 70px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('义', x + size / 2, y + size / 2)
      ctx.restore()

      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, size / 2 + 6, 0, Math.PI * 2)
      ctx.lineWidth = 6
      ctx.strokeStyle = '#D4AF37'
      ctx.stroke()
    },

    _drawPosterContent(ctx: any, nickName: string, totalDays: number, totalHours: number, totalCount: number, honor: HonorProgress) {
      // 用户名
      ctx.textAlign = 'center'
      ctx.fillStyle = '#4A4A4A'
      ctx.font = 'bold 40px sans-serif'
      ctx.fillText(nickName, 450, 410)

      // 副标题
      ctx.fillStyle = '#8C6D46'
      ctx.font = '28px sans-serif'
      ctx.fillText('感恩您的每一次默默付出', 450, 460)

      // 数据卡片背景
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      this._roundRect(ctx, 80, 520, 740, 280, 24)
      ctx.fill()
      ctx.strokeStyle = 'rgba(212,175,55,0.3)'
      ctx.lineWidth = 2
      ctx.stroke()

      // 三个数据
      const drawData = (label: string, value: string, xPos: number) => {
        ctx.textAlign = 'center'
        ctx.fillStyle = '#B22222'
        ctx.font = 'bold 64px sans-serif'
        ctx.fillText(value, xPos, 620)
        ctx.fillStyle = '#666666'
        ctx.font = '26px sans-serif'
        ctx.fillText(label, xPos, 670)
      }
      drawData('累计护持天数', String(totalDays), 220)
      drawData('累计打卡次数', String(totalCount), 450)
      drawData('贡献爱心工时', String(totalHours) + 'h', 680)

      // 当前勋章
      ctx.fillStyle = '#8C1D18'
      ctx.font = 'bold 34px sans-serif'
      ctx.fillText('当前荣誉：' + honor.currentLevelName, 450, 760)

      // 进度条容器
      const barX = 120
      const barY = 810
      const barW = 660
      const barH = 28
      ctx.fillStyle = '#EDE8DF'
      this._roundRect(ctx, barX, barY, barW, barH, barH / 2)
      ctx.fill()

      // 进度条渐变填充
      const progressW = barW * (honor.progressPercent / 100)
      const pGradient = ctx.createLinearGradient(barX, barY, barX + progressW, barY)
      pGradient.addColorStop(0, '#F5D78E')
      pGradient.addColorStop(1, '#D4AF37')
      ctx.fillStyle = pGradient
      this._roundRect(ctx, barX, barY, progressW, barH, barH / 2)
      ctx.fill()

      // 进度文字
      ctx.textAlign = 'center'
      ctx.fillStyle = '#FFFFFF'
      ctx.font = 'bold 22px sans-serif'
      if (progressW > 80) {
        ctx.fillText(honor.progressPercent + '%', barX + progressW / 2, barY + 20)
      }

      // 下一级提示
      ctx.textAlign = 'center'
      ctx.fillStyle = '#8C6D46'
      ctx.font = '26px sans-serif'
      const nextTip = honor.remainHours > 0
        ? `距离「${honor.nextLevelName}」还需 ${honor.remainHours} 小时`
        : '您已达到最高荣誉等级，感恩无尽护持'
      ctx.fillText(nextTip, 450, 900)

      // 中部装饰线
      ctx.beginPath()
      ctx.moveTo(200, 950)
      ctx.lineTo(700, 950)
      ctx.strokeStyle = 'rgba(140,29,24,0.15)'
      ctx.lineWidth = 2
      ctx.stroke()

      // 4. 二维码区域（占位：生成装饰性二维码图案）
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      this._roundRect(ctx, 280, 990, 340, 340, 20)
      ctx.fill()

      this._drawDecorativeQRCode(ctx, 330, 1040, 240)

      ctx.fillStyle = '#666666'
      ctx.font = '24px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('扫码加入雨花爱心餐报助手', 450, 1370)

      // 底部品牌语
      ctx.fillStyle = '#8C1D18'
      ctx.font = 'bold 30px sans-serif'
      ctx.fillText('端上一碗热饭，温暖世间一颗心', 450, 1420)
    },

    _drawDecorativeQRCode(ctx: any, x: number, y: number, size: number) {
      // 装饰性二维码：12x12 随机方块，模拟小程序码视觉效果
      const cells = 12
      const cellSize = size / cells
      const seed = 42
      const rand = (idx: number) => {
        const v = Math.sin(seed + idx) * 10000
        return v - Math.floor(v)
      }

      ctx.fillStyle = '#8C1D18'
      for (let r = 0; r < cells; r++) {
        for (let c = 0; c < cells; c++) {
          const idx = r * cells + c
          // 保留四角定位图案空白
          const isCorner = (r < 3 && c < 3) || (r < 3 && c >= cells - 3) || (r >= cells - 3 && c < 3)
          if (!isCorner && rand(idx) > 0.45) {
            ctx.fillRect(x + c * cellSize, y + r * cellSize, cellSize - 2, cellSize - 2)
          }
        }
      }

      // 三个定位角
      const drawPositionMarker = (mx: number, my: number) => {
        ctx.strokeStyle = '#8C1D18'
        ctx.lineWidth = 4
        ctx.strokeRect(mx + 4, my + 4, cellSize * 3 - 8, cellSize * 3 - 8)
        ctx.fillStyle = '#8C1D18'
        ctx.fillRect(mx + cellSize, my + cellSize, cellSize, cellSize)
      }
      drawPositionMarker(x, y)
      drawPositionMarker(x + size - cellSize * 3, y)
      drawPositionMarker(x, y + size - cellSize * 3)

      // 中心小图标
      ctx.fillStyle = '#D4AF37'
      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, cellSize, 0, Math.PI * 2)
      ctx.fill()
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
