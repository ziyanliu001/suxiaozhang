import { isCloudAvailable } from './cloudGuard';

// 通用文本内容安全检测：复用 msgSecCheck 云函数，供各表单/弹窗（含自定义组件，
// 组件实例访问不到宿主页面的方法）在提交前统一调用，不重复实现同一段云函数调用逻辑
export async function checkContentSafety(text: string): Promise<boolean> {
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
    console.warn('[checkContentSafety] 内容安全检测调用失败，跳过检测:', err);
    return true;
  }
}
