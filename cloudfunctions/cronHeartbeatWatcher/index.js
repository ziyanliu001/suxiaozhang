// 云函数：cronHeartbeatWatcher — 长辈静默守护定时触发器
//
// 本仓库第一个使用定时触发器（config.json triggers）的云函数，每 2 小时扫描
// 一次 elder_guardian_bindings，找出 last_active_time 超出 heartbeat_timeout_hours
// 预警窗口的长辈，向绑定家属推送温和关怀提醒。
//
// 🔧 部署要求（与 completeProductionOrder 的发货提醒同一套接入方式）：
//   - 环境变量 ELDER_HEARTBEAT_TEMPLATE_ID（微信订阅消息"长者关怀提醒"类
//     模板 ID，未配置时静默跳过推送，不影响扫描/续期逻辑本身）
//   - config.json 的 openapi 权限需包含 subscribeMessage.send（已声明）
//   - 定时触发器需要随 config.json 一并部署到云端才会按 cron 生效，本地/
//     手动调用 exports.main 只能验证扫描与发送逻辑，无法验证触发时机本身
//
// 🛡️ 防刷冷却：一条长辈绑定记录一旦被判定为"心跳超时"并成功推送，
// notify_status 置为 'notified'、记录 last_notify_time；在 last_notify_time
// 24 小时内即使仍然超时也不重复推送，避免家属被同一件事反复打扰。长辈一旦
// 有新的代报餐/签到（ledgerIngestionAdapter.renewHeartbeat），notify_status
// 会被复位为 'normal'，下次超时会重新进入这套判定。
//
// 🌟 单条失败不影响其余记录：查询/发送/更新任一环节抛错，只 console.warn
// 并继续处理下一条，扫描结束后返回整体统计，不因个别脏数据/网络抖动整批失败。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { buildHeartbeatNoticePayload } = require('./lib/buildHeartbeatNoticePayload');

const GUARDIAN_COLLECTION = 'elder_guardian_bindings';
const DEFAULT_TIMEOUT_HOURS = 48;
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// 与 getVolunteerHonorStats 同一套防御式扫描上限，避免绑定记录量异常时
// 单次调用无限循环跑满超时
const BATCH_SIZE = 100;
const BATCH_CAP = 5000;

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

// 云函数容器时区固定为 UTC，与项目内其余云函数同一套 +8 小时偏移换算
function formatDateStr(dateLike) {
  if (!dateLike) return '';
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (isNaN(d.getTime())) return '';
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())}`;
}

async function fetchAllBindings() {
  const all = [];
  let skip = 0;
  while (skip < BATCH_CAP) {
    let res;
    try {
      res = await db.collection(GUARDIAN_COLLECTION).skip(skip).limit(BATCH_SIZE).get();
    } catch (err) {
      if (!isCollectionNotExistError(err)) throw err;
      return all;
    }
    const rows = res.data || [];
    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    skip += BATCH_SIZE;
  }
  return all;
}

function isHeartbeatOverdue(binding, now) {
  const timeoutHours = Number(binding.heartbeat_timeout_hours) || DEFAULT_TIMEOUT_HOURS;
  const timeoutMs = timeoutHours * 60 * 60 * 1000;
  if (!binding.last_active_time) return true;
  const lastActiveMs = new Date(binding.last_active_time).getTime();
  if (isNaN(lastActiveMs)) return true;
  return now - lastActiveMs >= timeoutMs;
}

function isInNotifyCooldown(binding, now) {
  if (binding.notify_status !== 'notified' || !binding.last_notify_time) return false;
  const lastNotifyMs = new Date(binding.last_notify_time).getTime();
  if (isNaN(lastNotifyMs)) return false;
  return now - lastNotifyMs < NOTIFY_COOLDOWN_MS;
}

async function sendHeartbeatNotice(binding, templateId) {
  const payload = buildHeartbeatNoticePayload({
    guardianOpenId: binding.guardian_openid,
    templateId,
    elderName: binding.elder_name,
    storeName: binding.storeName || '',
    lastActiveDateStr: formatDateStr(binding.last_active_time)
  });
  if (!payload) return false;

  await cloud.openapi.subscribeMessage.send(payload);
  return true;
}

exports.main = async () => {
  const templateId = process.env.ELDER_HEARTBEAT_TEMPLATE_ID || '';
  if (!templateId) {
    console.warn('[cronHeartbeatWatcher] ELDER_HEARTBEAT_TEMPLATE_ID 未配置，本次扫描仅续期检查，跳过全部推送');
  }

  const now = Date.now();
  const bindings = await fetchAllBindings();

  let overdueCount = 0;
  let notifiedCount = 0;
  let skippedCooldownCount = 0;
  let failedCount = 0;

  for (const binding of bindings) {
    if (!isHeartbeatOverdue(binding, now)) continue;
    overdueCount++;

    if (isInNotifyCooldown(binding, now)) {
      skippedCooldownCount++;
      continue;
    }
    if (!binding.guardian_openid) continue;

    try {
      const sent = templateId ? await sendHeartbeatNotice(binding, templateId) : false;
      if (sent) {
        await db.collection(GUARDIAN_COLLECTION).doc(binding._id).update({
          data: { notify_status: 'notified', last_notify_time: db.serverDate() }
        });
        notifiedCount++;
      }
    } catch (err) {
      failedCount++;
      console.warn('[cronHeartbeatWatcher] 单条长辈心跳提醒处理失败（不影响其余记录）:', binding._id, err);
    }
  }

  return {
    success: true,
    scannedCount: bindings.length,
    overdueCount,
    notifiedCount,
    skippedCooldownCount,
    failedCount,
    templateConfigured: !!templateId
  };
};
