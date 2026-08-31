#!/usr/bin/env node
'use strict';

// 🛡️ Open-Core 架构拆分 · 第三阶段：安全防泄露扫描脚本
//
// 用途：扫描指定目录（默认仓库根目录；scripts/build-open-core.js 会传入
// 生成的 Core 发布包目录），确保不存在硬编码的 AppSecret、商户号、微信
// 支付私钥、生产环境 HMAC 密钥等敏感信息。发现违规命中时以 exit code 1
// 中断，并用红色输出逐条列出文件:行号 + 命中规则。
//
// 用法：
//   node scripts/security-audit.js                 # 扫描仓库根目录
//   node scripts/security-audit.js --dir dist/xxx   # 扫描指定目录
//
// 设计取舍：
//   - 只扫描文本源码文件（.js/.ts/.json/.wxml/.wxss/.md 等），跳过图片/
//     字体等二进制资源与 node_modules/.git，避免海量误报与不必要的 IO。
//   - "发现明文私钥文件"（.key/.pem）与"发现明文私钥内容"（PEM 头）分开判：
//     前者哪怕文件内容本身还没读到坏东西，光是这类文件出现在待发布目录里
//     就已经是流程性事故（正常情况下私钥文件不应该被拷贝进任何构建产物），
//     直接判定违规，不需要先解析内容。
//   - 命中输出做了脱敏截断（只显示前 4 位 + 星号 + 总长度），避免这份本该
//     帮忙"发现并清除敏感信息"的工具，自己又在终端/CI 日志里把敏感信息
//     完整打印了一遍，造成新的泄露面。
const fs = require('fs');
const path = require('path');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const args = process.argv.slice(2);
const dirFlagIndex = args.indexOf('--dir');
const TARGET_DIR = path.resolve(
  dirFlagIndex >= 0 && args[dirFlagIndex + 1] ? args[dirFlagIndex + 1] : path.resolve(__dirname, '..')
);

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'miniprogram_npm', '.cloudbase']);
const TEXT_FILE_EXTS = new Set(['.js', '.ts', '.json', '.wxml', '.wxss', '.wxs', '.md', '.txt', '.yml', '.yaml']);
const SENSITIVE_FILE_EXTS = new Set(['.key', '.pem', '.p12', '.pfx']);

// 已知曾经出现过的不安全默认值（见 stampReportChecksum/cascadeRecalculator/
// updateAndRecalculateCascade 2026-08-31 第二阶段 fail-closed 改造）——一旦
// 未来有人手滑改回类似"env 缺失时用弱默认值签名"的写法，这里要能立刻拦下来，
// 属于回归检测，不是通用规则
const KNOWN_LEAKED_DEFAULTS = ['yuhua_ledger_default_secret_please_override_in_cloud_env'];

// 明显是占位符/示例值，不应该被判定为"真的泄露了一个密钥"
const PLACEHOLDER_HINTS = /^(your[_-]?|xxx+|changeme|placeholder|example|sample|test|demo|dummy|fake|<.*>|\$\{.*\}|process\.env)/i;

function isLikelyPlaceholder(value) {
  if (PLACEHOLDER_HINTS.test(value)) return true;
  // 全部同一个字符（如 "0000000000"）或长度不足以构成真实密钥的，不判定
  if (/^(.)\1*$/.test(value)) return true;
  return false;
}

function redact(value) {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 4))}(len=${value.length})`;
}

// ── 内容级规则 ────────────────────────────────────────────────────────
// 每条规则：{ name, regex（须含一个捕获组作为"命中的敏感值"）, severity }
const CONTENT_RULES = [
  {
    name: 'PEM 私钥块',
    regex: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/g,
    extractValue: () => 'PEM PRIVATE KEY BLOCK'
  },
  {
    // 只扫描代码文件——docs/ 里允许用 Markdown 原样引用这段历史字符串来
    // 说明"这个不安全默认值已经被修复"，那是文档在陈述历史，不是代码里
    // 真的还在这么写
    name: '已知历史泄露默认值回归',
    regex: new RegExp(`(${KNOWN_LEAKED_DEFAULTS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g'),
    extractValue: (m) => m[1],
    onlyExts: ['.js', '.ts']
  },
  {
    // 微信 AppSecret：官方格式固定 32 位小写十六进制
    name: '疑似硬编码微信 AppSecret',
    regex: /app_?secret['"]?\s*[:=]\s*['"]([a-f0-9]{32})['"]/gi,
    extractValue: (m) => m[1]
  },
  {
    // 微信支付商户号：6~12 位纯数字，且同一行不是从 process.env 读取
    name: '疑似硬编码微信支付商户号(mchid)',
    regex: /\bmch_?id['"]?\s*[:=]\s*['"]?(\d{6,12})['"]?/gi,
    extractValue: (m) => m[1],
    lineMustNotContain: 'process.env'
  },
  {
    // 泛化规则：形如 XXX_SECRET/XXX_KEY/XXX_TOKEN 的环境变量读取，若 `||`
    // 之后跟的默认值不是空字符串，视为"环境变量缺失时静默使用一个非空
    // 默认凭据"——生产环境 HMAC/内部调用令牌类必须 fail-closed（空字符串
    // 默认值 + 运行时判空拒绝），历史教训见 docs/OPEN_CORE_ARCHITECTURE.md
    // 第 5 节
    name: '密钥类环境变量存在非空硬编码兜底值',
    regex: /process\.env\.([A-Z0-9_]*(?:SECRET|PRIVATE_KEY|API_V3_KEY|TOKEN|APPSECRET)[A-Z0-9_]*)\s*\|\|\s*['"]([^'"]+)['"]/g,
    extractValue: (m) => `${m[1]}=${m[2]}`,
    isSensitive: (m) => m[2].length > 0 && !isLikelyPlaceholder(m[2]),
    // 同上：Markdown 文档里用代码块引用历史上的错误写法来说明"这个问题
    // 已经修复"，不代表真实代码里还这么写
    onlyExts: ['.js', '.ts']
  }
];

function shouldSkipDir(name) {
  return SKIP_DIR_NAMES.has(name) || name.startsWith('.');
}

// 本脚本自己的源码里必然逐字包含 KNOWN_LEAKED_DEFAULTS 的字面量（否则怎么
// 检测回归），扫描到自己是预期之内的自我引用，不是真的泄露，直接跳过
const SELF_PATH = path.resolve(__filename);

function walk(dir, onFile) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walk(path.join(dir, entry.name), onFile);
    } else if (entry.isFile()) {
      onFile(path.join(dir, entry.name));
    }
  }
}

function auditFile(filePath, findings) {
  if (path.resolve(filePath) === SELF_PATH) return;

  const ext = path.extname(filePath).toLowerCase();
  const relPath = path.relative(TARGET_DIR, filePath);

  if (SENSITIVE_FILE_EXTS.has(ext)) {
    findings.push({
      file: relPath,
      line: null,
      rule: '目录中存在明文私钥/证书文件',
      value: `文件类型 ${ext}，不应出现在任何构建产物或代码仓库中`
    });
    return;
  }

  if (!TEXT_FILE_EXTS.has(ext)) return;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return; // 二进制或不可读文件，忽略
  }

  const lines = content.split('\n');

  for (const rule of CONTENT_RULES) {
    if (rule.onlyExts && !rule.onlyExts.includes(ext)) continue;
    rule.regex.lastIndex = 0;
    let m;
    while ((m = rule.regex.exec(content)) !== null) {
      if (rule.isSensitive && !rule.isSensitive(m)) continue;
      const upToMatch = content.slice(0, m.index);
      const lineNo = upToMatch.split('\n').length;
      const lineText = lines[lineNo - 1] || '';
      if (rule.lineMustNotContain && lineText.includes(rule.lineMustNotContain)) continue;
      const value = rule.extractValue(m);
      findings.push({ file: relPath, line: lineNo, rule: rule.name, value: redact(String(value)) });
    }
  }
}

function main() {
  if (!fs.existsSync(TARGET_DIR)) {
    console.log(`${RED}❌ 目标目录不存在: ${TARGET_DIR}${RESET}`);
    process.exit(1);
  }

  console.log(`${BOLD}🛡️  安全防泄露扫描: ${TARGET_DIR}${RESET}`);

  const findings = [];
  walk(TARGET_DIR, (filePath) => auditFile(filePath, findings));

  if (findings.length === 0) {
    console.log(`${GREEN}✅ 未发现硬编码敏感信息，扫描通过${RESET}`);
    process.exit(0);
  }

  console.log(`${RED}${BOLD}❌ 发现 ${findings.length} 处疑似敏感信息泄露：${RESET}`);
  for (const f of findings) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`${RED}  [${f.rule}] ${loc} → ${f.value}${RESET}`);
  }
  console.log(`${YELLOW}⚠️  请核实以上命中：若确认是真实凭据，立即从代码中移除并改走环境变量；` +
    `若是占位符/示例误报，可在 scripts/security-audit.js 的 PLACEHOLDER_HINTS 中补充规则。${RESET}`);
  process.exit(1);
}

main();
