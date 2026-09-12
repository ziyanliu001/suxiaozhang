#!/usr/bin/env node
'use strict';

// 🛡️ 紧急逃生舱 · 第三道防线：本地/CI 命令行直连数据库自愈脚本
//
// 与 cloudfunctions/emergencyClaimSuperAdmin（第二道防线，微信小程序内
// 凭密钥自助接管）、cloudfunctions/adminWebConsole（第四道防线，独立 Web
// 管理中台）是完全独立、互不依赖的三条路径——本脚本走的是 @cloudbase/
// node-sdk，用 Tencent Cloud API 密钥（SecretId/SecretKey）直连数据库，
// 完全不经过任何已部署的云函数，也完全不依赖小程序/微信生态是否可用。
// 只要还能访问 Tencent Cloud 控制台拿到 API 密钥，这条路径永远可用，是
// 四道防线里唯一"绕过应用层"的一条，因此也是权限模型里最强的一把钥匙——
// SecretId/SecretKey 一旦泄露，能做的远不止"授予 super_admin"，请按
// 本仓库对待生产环境凭证同等（或更高）的谨慎程度保管，绝不提交进版本库。
//
// ⚠️ 为什么不能直接用 wx-server-sdk：本仓库 scripts/seedActivationCodes.ts
// 已经记录过同一个结论——wx-server-sdk 的 cloud.init() 依赖云函数运行时
// 环境隐式注入的凭据，本地脚本环境里用不了。@cloudbase/node-sdk 是腾讯云
// CloudBase 专门给"外部服务器/本地脚本"场景设计的另一个 SDK，走显式的
// SecretId/SecretKey 鉴权，这正是本脚本存在的意义。
//
// 用法：
//   node scripts/ops/grant-super-admin.js --openid <NEW_OPENID> --name "应急管理员"
//   node scripts/ops/grant-super-admin.js --openid <NEW_OPENID> --name "张三" --phone 13800001111 --tenant-id <TENANT_ID>
//   node scripts/ops/grant-super-admin.js --openid <NEW_OPENID> --name "应急管理员" --yes   # 跳过二次确认，供 CI/自动化场景使用
//
// 环境变量（三者缺一不可，均通过环境变量传入，不接受命令行参数——避免
// 明文密钥出现在 shell 历史记录里）：
//   CLOUDBASE_ENV_ID          云开发环境 ID（云开发控制台首页可查看，
//                             与本仓库各云函数 config.json 里的
//                             permissions.cloudbase.env 是同一个值）
//   TENCENTCLOUD_SECRETID     腾讯云 API 密钥 SecretId（CAM 控制台申请）
//   TENCENTCLOUD_SECRETKEY    腾讯云 API 密钥 SecretKey（同上）
//
// 依赖：本脚本使用独立的 scripts/ops/package.json，@cloudbase/node-sdk 只
// 安装在 scripts/ops/node_modules 下，不污染仓库根目录/云函数的依赖树——
// 先 `cd scripts/ops && npm install` 再运行本脚本。

const readline = require('readline');
const {
  validateRealName: strictValidateRealName,
  validatePhone: strictValidatePhone,
  buildUserRoleDoc,
  buildAuditLogEntry
} = require('../../cloudfunctions/emergencyClaimSuperAdmin/lib/validateClaim');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'yes' || key === 'y') {
      args.yes = true;
      continue;
    }
    const value = argv[i + 1];
    args[key] = value;
    i++;
  }
  return args;
}

function printUsageAndExit(message) {
  if (message) console.error(`\n❌ ${message}\n`);
  console.error([
    '用法：node scripts/ops/grant-super-admin.js --openid <NEW_OPENID> --name "应急管理员" [--phone <手机号>] [--tenant-id <TENANT_ID>] [--yes]',
    '',
    '必须的环境变量：CLOUDBASE_ENV_ID / TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY',
    '详见本脚本文件头部注释与 scripts/ops/README.md'
  ].join('\n'));
  process.exit(1);
}

function confirm(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${promptText} (yes/no): `, (answer) => {
      rl.close();
      resolve(String(answer || '').trim().toLowerCase() === 'yes');
    });
  });
}

// 与 emergencyClaimSuperAdmin/index.js 的 resolveTenantId 是同一份决策
// 逻辑的独立拷贝（这里用的是 @cloudbase/node-sdk 的 db 实例，与云函数里
// wx-server-sdk 的 db 实例类型不同，无法直接复用同一份实现，但两者暴露的
// collection().where()/doc().get() 链式 API 形状一致，逻辑可以逐行对照）
async function resolveTenantId(db, requestedTenantId) {
  if (requestedTenantId) {
    // 🐛 .doc(id).get() 返回的 .data 是单个文档对象，不是数组——与下面
    // .where().get() 返回数组是两种不同的返回形状，判断"是否查到"只能看
    // truthy，不能像数组那样判断 .length
    const byIdRes = await db.collection('tenants').doc(requestedTenantId).get().catch(() => null);
    if (byIdRes && byIdRes.data) return { resolved: true, tenantId: requestedTenantId };
    const byFieldRes = await db.collection('tenants').where({ tenantId: requestedTenantId }).limit(1).get().catch(() => ({ data: [] }));
    if (byFieldRes.data && byFieldRes.data.length > 0) return { resolved: true, tenantId: requestedTenantId };
    return { resolved: false, error: '指定的 --tenant-id 不存在，请核实后重试' };
  }
  const allRes = await db.collection('tenants').limit(2).get().catch(() => ({ data: [] }));
  const tenants = allRes.data || [];
  if (tenants.length === 1) return { resolved: true, tenantId: tenants[0].tenantId || tenants[0]._id };
  if (tenants.length === 0) return { resolved: true, tenantId: '' };
  return { resolved: false, error: '系统中存在多家机构，请显式传入 --tenant-id（不猜测，避免关联到错误机构）' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const openid = String(args.openid || '').trim();
  if (!openid) {
    printUsageAndExit('缺少 --openid 参数');
  }

  const envId = process.env.CLOUDBASE_ENV_ID;
  const secretId = process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  if (!envId || !secretId || !secretKey) {
    printUsageAndExit('缺少必须的环境变量 CLOUDBASE_ENV_ID / TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY');
  }

  // 🛡️ 真实姓名/手机号在这条通道里是"留痕信息"，不是身份验证手段——本脚本
  // 的真正身份验证是"是否持有有效的 Tencent Cloud API 密钥"，比另外两条
  // 通道（微信密钥 / Web 账密）的验证强度更高，因此这里不强制要求填写
  // 手机号（与另外两条通道复用的 lib/validateClaim.js 校验器要求"非空"不
  // 同），缺省时留一句可识别的占位说明，不假装有一个真实号码
  const realName = String(args.name || '').trim() || '应急管理员';
  const phone = String(args.phone || '').trim() || '(未提供，走 CLI 应急通道授予)';
  const nameCheck = strictValidateRealName(realName);
  if (!nameCheck.valid) printUsageAndExit(nameCheck.error);
  void strictValidatePhone; // 手机号本脚本不做强制校验，见上方注释；保留 import 供未来需要时启用

  let cloudbase;
  try {
    cloudbase = require('@cloudbase/node-sdk');
  } catch (err) {
    printUsageAndExit('未安装 @cloudbase/node-sdk 依赖，请先执行：cd scripts/ops && npm install');
  }

  const app = cloudbase.init({ env: envId, secretId, secretKey });
  const db = app.database();

  console.log(`\n🚨 即将为 openid=${openid} 授予 super_admin（超级管理员）权限。`);
  console.log(`   环境：${envId}`);
  console.log(`   姓名：${nameCheck.value}`);
  console.log(`   手机：${phone}`);

  if (!args.yes) {
    const ok = await confirm('确认执行这次紧急超管授予吗？');
    if (!ok) {
      console.log('已取消，未做任何改动。');
      process.exit(0);
    }
  }

  const tenantResolution = await resolveTenantId(db, args['tenant-id'] ? String(args['tenant-id']).trim() : '');
  if (!tenantResolution.resolved) {
    printUsageAndExit(tenantResolution.error);
  }

  const existingRes = await db.collection('user_roles').where({ _openid: openid }).limit(1).get().catch(() => ({ data: [] }));
  const existingDoc = (existingRes.data && existingRes.data[0]) || null;

  const { isUpdate, docId, patch } = buildUserRoleDoc({
    openid,
    realName: nameCheck.value,
    phone,
    tenantId: tenantResolution.tenantId,
    existingDoc
  });

  const now = new Date();
  if (isUpdate) {
    await db.collection('user_roles').doc(docId).update({ data: { ...patch, emergencyClaimedAt: now } });
  } else {
    await db.collection('user_roles').add({ data: { ...patch, emergencyClaimedAt: now, applyTime: now, approveTime: now } });
  }

  await db.collection('audit_logs').add({
    data: {
      ...buildAuditLogEntry({
        openid,
        success: true,
        realName: nameCheck.value,
        phone,
        tenantId: tenantResolution.tenantId,
        isUpdate,
        channel: 'cli_script'
      }),
      operate_time: now
    }
  }).catch((err) => {
    console.error('⚠️ 审计日志写入失败（不影响权限授予本身，但需要人工补记）:', err.message || err);
  });

  console.log(`\n✅ 已成功${isUpdate ? '升级既有记录为' : '创建新的'} super_admin 记录（openid=${openid}，tenantId=${tenantResolution.tenantId || '(空)'})。`);
  console.log('   请立即通知该账号本人登录小程序核实权限已生效，并考虑是否需要处置原有失效账号的历史绑定关系。');
}

main().catch((err) => {
  console.error('\n❌ 执行失败:', err && err.message ? err.message : err);
  process.exit(1);
});
