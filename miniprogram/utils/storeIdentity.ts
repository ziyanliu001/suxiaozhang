import { getSelectedStore } from './storeManager';

// 🛡️ "全国总览"/"全部门店" 是 store-picker 里仅供 super_admin 选用的虚拟聚合门店名，
// 不是任何真实门店。与 statistics.ts 的 VIRTUAL_STORE_NAMES/isVirtualStoreName
// 同一份定义——这里提炼成共享工具，供 journey.ts/statistics.ts 等多处"个人荣誉卡/
// 海报"生成逻辑复用，不再各自维护一份
export const VIRTUAL_STORE_NAMES = ['全国总览', '全部门店'];

export function isVirtualStoreName(storeName: string | undefined | null): boolean {
  return VIRTUAL_STORE_NAMES.includes(String(storeName || '').trim());
}

// 🐛 根因修复："爱心志愿者荣誉卡"门店名误显示为"全国总览"：AuthService.getCachedRoleInfo()
// 的 storeName 直接来自服务端 user_roles 文档，而该文档一旦曾经被 setupSuperAdmin
// 写成 super_admin（storeId:'', storeName:'全国总览'），之后哪怕账号被降级回
// volunteer/store_manager 等角色，只要没人显式重置这两个字段，storeName 会一直
// 残留"全国总览"这个历史脏值——调用方过去直接拿 roleInfo.storeName 就用，
// 完全没有过滤，导致这条脏数据直接印在荣誉卡上。
//
// 解析口径（与 statistics.ts resolveEffectiveStoreIdentity 同一套原则）：
// 1. 非超管账号：storeName 命中虚拟聚合名时一律当作"没有真实门店"，改用
//    getSelectedStore() 兜底找当前实际选中/绑定的门店；
// 2. 真超管：允许显示"全国总览"（这本来就是其真实身份状态，不做剔除）；
// 3. 上述都拿不到具体门店名时，才回退展示"全国总览"占位文案。
export function resolveHonorCardStoreName(roleStoreName: string | undefined | null, isSuperAdmin: boolean): string {
  let storeName = roleStoreName || '';

  if (!isSuperAdmin && isVirtualStoreName(storeName)) {
    storeName = '';
  }

  if (!storeName) {
    const activeStore = getSelectedStore();
    const activeStoreName = (activeStore && activeStore.storeName) || '';
    if (activeStoreName && !(!isSuperAdmin && isVirtualStoreName(activeStoreName))) {
      storeName = activeStoreName;
    }
  }

  return storeName || '全国总览';
}
