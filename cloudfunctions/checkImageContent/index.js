const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

/**
 * 🛡️ 图像内容安全审核云函数
 * 调用微信官方 imgSecCheck 接口，检测色情、暴力、政治敏感、违法广告等违规内容
 * @param {Object} event.imgBuffer - Base64 编码的图片数据
 * @param {String} event.contentType - 图片 MIME 类型（可选，默认 image/jpeg）
 */
exports.main = async (event, context) => {
  const { imgBuffer, contentType = 'image/jpeg' } = event;

  if (!imgBuffer) {
    return { success: false, isSafe: false, msg: '图片数据为空' };
  }

  try {
    const checkResult = await cloud.openapi.security.imgSecCheck({
      media: {
        contentType: contentType,
        value: Buffer.from(imgBuffer, 'base64')
      }
    });

    console.log('🛡️ [Image Safety Check Result]:', checkResult);

    if (checkResult.errCode === 0) {
      return { success: true, isSafe: true };
    }

    return { success: false, isSafe: false, errCode: checkResult.errCode, msg: '图片内容检测未通过' };

  } catch (err) {
    if (err.errCode === 87014) {
      return {
        success: true,
        isSafe: false,
        errCode: 87014,
        msg: '🚨 检测到敏感或违规内容，已被系统强行拦截！'
      };
    }

    console.error('🛡️ [Image Safety Check Error]:', err);
    return { success: true, isSafe: true, log: '安全服务检测异常，降级通过' };
  }
};
