#!/usr/bin/env node
'use strict';

// 🛡️ 初始化/重置 Web 管理中台账密（web-admin/ 独立管理中台，第四道
// 应急防线，见 CLAUDE.md 第 11 节）。
//
// 为什么需要一个独立脚本：cloudfunctions/adminWebAuth 的 login 动作要求
// platform_web_admins 集合里已经存在一条账号记录——首个账号存在"鸡生蛋"
// 问题，没有任何云函数动作能创建"第一个"Web 管理员（那样等于任何人都能
// 自助创建一个 Web 管理员账号，是一个明显的越权口子）。本脚本与
// scripts/ops/grant-super-admin.js 同一套思路：绕开应用层，直接用
// @cloudbase/node-sdk + Tencent Cloud API 密钥写数据库。
//
// 用法（创建/重置账号，密码通过交互式输入，不出现在命令行参数/shell 历史里）：
//   node scripts/ops/init-web-admin.js --username admin
//
// 环境变量（与 grant-super-admin.js 完全一致）：
//   CLOUDBASE_ENV_ID / TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY

const readline = require('readline');
const { generateSalt, hashPassword } = require('../../cloudfunctions/adminWebAuth/lib/passwordHash');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    args[token.slice(2)] = argv[i + 1];
    i++;
  }
  return args;
}

function printUsageAndExit(message) {
  if (message) console.error(`\n❌ ${message}\n`);
  console.error([
    '用法：node scripts/ops/init-web-admin.js --username <用户名>',
    '密码通过交互式输入（不回显），不接受命令行参数传入。',
    '',
    '必须的环境变量：CLOUDBASE_ENV_ID / TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY'
  ].join('\n'));
  process.exit(1);
}

// 隐藏输入的密码提示——终端不回显字符，避免密码明文出现在屏幕/终端
// 录屏/scrollback 历史里
function promptHiddenInput(promptText) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(promptText);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (char === '') { // Ctrl+C
        process.stdout.write('\n');
        process.exit(1);
      }
      if (char === '' || char === '\b') { // 退格
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    stdin.on('data', onData);
  });
}

const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = String(args.username || '').trim();
  if (!username) printUsageAndExit('缺少 --username 参数');

  const envId = process.env.CLOUDBASE_ENV_ID;
  const secretId = process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  if (!envId || !secretId || !secretKey) {
    printUsageAndExit('缺少必须的环境变量 CLOUDBASE_ENV_ID / TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY');
  }

  let cloudbase;
  try {
    cloudbase = require('@cloudbase/node-sdk');
  } catch (err) {
    printUsageAndExit('未安装 @cloudbase/node-sdk 依赖，请先执行：cd scripts/ops && npm install');
  }

  const password = await promptHiddenInput('请输入新密码（不回显，≥12位，建议含大小写字母/数字/符号）：');
  if (password.length < MIN_PASSWORD_LENGTH) {
    printUsageAndExit(`密码长度至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  const confirmPassword = await promptHiddenInput('请再次输入以确认：');
  if (password !== confirmPassword) {
    printUsageAndExit('两次输入的密码不一致');
  }

  const app = cloudbase.init({ env: envId, secretId, secretKey });
  const db = app.database();

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const now = new Date();

  const existingRes = await db.collection('platform_web_admins').where({ username }).limit(1).get().catch(() => ({ data: [] }));
  const existingDoc = (existingRes.data && existingRes.data[0]) || null;

  if (existingDoc) {
    await db.collection('platform_web_admins').doc(existingDoc._id).update({
      data: { passwordHash, passwordSalt: salt, disabled: false, passwordResetAt: now }
    });
    console.log(`\n✅ 已重置账号 "${username}" 的密码。`);
  } else {
    await db.collection('platform_web_admins').add({
      data: { username, passwordHash, passwordSalt: salt, disabled: false, createdAt: now, lastLoginAt: null }
    });
    console.log(`\n✅ 已创建新的 Web 管理中台账号 "${username}"。`);
  }

  console.log('   请立即前往 web-admin/ 登录页测试登录，并妥善保管这份密码（本脚本不会保存/回显它）。');
}

main().catch((err) => {
  console.error('\n❌ 执行失败:', err && err.message ? err.message : err);
  process.exit(1);
});
