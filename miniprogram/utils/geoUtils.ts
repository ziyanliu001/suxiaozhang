// 门店距离计算：Haversine 公式算两点间球面直线距离（单位：公里）
// 与 wx.getLocation({type:'gcj02'})/wx.chooseLocation 使用同一套坐标系，
// 门店经纬度未设置时不参与距离计算（由调用方自行判断 lat/lng 是否存在）

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

// 格式化展示：<1km 显示"XXXm"，否则保留 1 位小数"X.Xkm"
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}m`;
  return `${km.toFixed(1)}km`;
}
