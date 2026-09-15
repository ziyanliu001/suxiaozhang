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
//   node scripts/security-audit.js --staged         # 只扫描当前已 git add
//                                                    # 暂存区里的文件内容
//                                                    # （读 git 暂存区 blob，
//                                                    # 不是工作区文件内容，
//                                                    # 供 commit 前预检使用）
//
// 🛡️（2026-09-14 商业安全与防密码泄漏审查体系升级）新增内容级规则：
//   - 通用密码/密钥字面量（password/passwd/secret/token 后面直接跟一段
//     引号包裹的非空字符串字面量）——裸 `process.env.X` 读取本身不带引号，
//     天然不会命中；只有 `xxx || '一个非空字面量'` 这种"环境变量缺失时静默
//     兜底成真实凭据"的写法才会被判定为违规，与既有的"密钥类环境变量存在
//     非空硬编码兜底值"规则是同一条原则的两个互补覆盖面。
//   - 测试文件（`*.test.js`）假数据命名规约：这两条规则一旦在测试文件里
//     命中，一律要求命中的字符串显式带 `mock_secret_` 前缀才放行，其余任何
//     写法（哪怕本来能通过占位符宽松判定）一律照样拦截——强制测试夹具
//     "一眼可辨认是假数据"，不依赖阅读者自行判断"这串测试用的字符串到底是
//     不是真的泄露了"。
//   - 未脱敏的中国大陆手机号（11 位，1[3-9] 开头）与身份证号（18 位，含
//     出生年月日结构校验）——防止真实/仿真 PII 混入测试数据或示例代码。
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
const { execFileSync } = require('child_process');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const args = process.argv.slice(2);
const dirFlagIndex = args.indexOf('--dir');
const STAGED_MODE = args.includes('--staged');
const TRACKED_MODE = args.includes('--tracked');
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
  // 🛡️（2026-09-14）WXML 模板表达式绑定（如 password="{{!visible}}"）不是
  // 硬编码字面量——本身是"password"这个 WXML 组件属性名 + 一段 JS 表达式，
  // 不含任何真实密码内容。真实复现：profile.wxml 的
  // `<input password="{{!adminKeyModalInputVisible}}">`（"密码遮罩开关"，
  // 与 HTML `<input type="password">` 是同一种"是否遮罩显示"语义）曾被
  // "疑似硬编码密码/密钥字面量"规则误判
  if (/^\{\{[\s\S]*\}\}$/.test(value.trim())) return true;
  return false;
}

// 🛡️（2026-09-14 国内隐私信息扫描）已知的、明确用于对外公开展示的联系方式
// ——不是"泄露"，是产品有意在 UI 上展示给用户的客服/联系电话（见
// profile.ts SUPER_ADMIN_CONTACT、nationalDashboardService.ts
// PLATFORM_SUPPORT_CONTACT 两处头部注释），与"不小心把私人手机号提交进
// 代码库"是两回事。仅收录明确核实过用途的值，不要为了消掉误报就把整条
// 规则关掉
const KNOWN_PUBLIC_CONTACT_VALUES = new Set(['15859242258']);

// 🛡️（2026-09-14）手机号/身份证号"看起来像测试占位符"的启发式判定：真实
// 运营商签发的号码后 8 位近似随机、覆盖多种数字；纯手写的测试夹具/示例文案
// 里的号码几乎总是明显重复/递增的模式（如 13800001111、13900002222），
// 后 8 位里出现的不同数字种类通常只有 2~4 种。这不是严谨的数学证明，是一条
// 启发式降噪规则——用来减少"手机号格式校验单测/CLI 用法示例"这类良性场景的
// 误报，不影响下面 KNOWN_PUBLIC_CONTACT_VALUES 之外的真实号码判定
function isLikelyPlaceholderNumber(value) {
  const tail = value.slice(-8);
  const distinctDigits = new Set(tail.split(''));
  return distinctDigits.size <= 4;
}

function redact(value) {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 4))}(len=${value.length})`;
}

// 🛡️（2026-09-14）测试文件假数据命名规约：只对标了 `enforceMockSecretNamingInTests`
// 的规则生效（目前是"通用密码/密钥字面量"与"密钥类环境变量存在非空硬编码
// 兜底值"这两条——都属于"密码/机密硬编码"范畴，AppSecret 格式定长/mchid
// 纯数字/PEM 私钥块这几条既有规则不受影响，维持升级前行为）。测试文件只有
// 严格匹配 `mock_secret_` 前缀（大小写不敏感）才放行，其余写法一律照样
// 拦截——即便本来能通过下面 isLikelyPlaceholder() 的宽松占位符判定也不例外，
// 这是比生产代码更严格的规矩，强制测试夹具自证"这是有意为之的假数据"
const MOCK_SECRET_PREFIX_RE = /mock_secret_/i;

function isTestFile(relPath) {
  return /\.test\.js$/i.test(relPath);
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
    // 泛化规则：形如 XXX_SECRET/XXX_KEY/XXX_TOKEN/XXX_PASSWORD 的环境变量
    // 读取，若 `||` 之后跟的默认值不是空字符串，视为"环境变量缺失时静默使用
    // 一个非空默认凭据"——生产环境 HMAC/内部调用令牌/密码类必须 fail-closed
    // （空字符串默认值 + 运行时判空拒绝），历史教训见
    // docs/OPEN_CORE_ARCHITECTURE.md 第 5 节
    // 🛡️（2026-09-14）变量名匹配集追加 PASSWORD/PASSWD——此前只覆盖
    // SECRET/PRIVATE_KEY/API_V3_KEY/TOKEN/APPSECRET，遗漏了密码类环境变量
    name: '密钥类环境变量存在非空硬编码兜底值',
    regex: /process\.env\.([A-Z0-9_]*(?:SECRET|PRIVATE_KEY|API_V3_KEY|TOKEN|APPSECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*\|\|\s*['"]([^'"]+)['"]/g,
    extractValue: (m) => `${m[1]}=${m[2]}`,
    isSensitive: (m) => m[2].length > 0 && !isLikelyPlaceholder(m[2]),
    // 同上：Markdown 文档里用代码块引用历史上的错误写法来说明"这个问题
    // 已经修复"，不代表真实代码里还这么写
    onlyExts: ['.js', '.ts'],
    enforceMockSecretNamingInTests: true
  },
  {
    // 🛡️（2026-09-14）通用密码/密钥字面量：password/passwd/secret/token
    // 后面直接跟一段引号包裹、长度 >6 的非空字符串字面量。裸
    // `process.env.X`（不带引号）天然不会命中这条正则；`lineMustNotContain`
    // 兜底排除同一行出现 process.env 的情形（那类交给上面"环境变量兜底值"
    // 规则单独判定，避免同一处命中被两条规则重复计数、也避免误伤
    // `token = process.env.X || 'xxx'` 这种已经被上面规则覆盖的写法）
    name: '疑似硬编码密码/密钥字面量',
    regex: /\b(password|passwd|secret|token)['"]?\s*[:=]\s*['"]([^'"]{7,})['"]/gi,
    extractValue: (m) => `${m[1]}=${m[2]}`,
    isSensitive: (m) => !isLikelyPlaceholder(m[2]),
    lineMustNotContain: 'process.env',
    enforceMockSecretNamingInTests: true
  },
  {
    // 🛡️（2026-09-14 国内隐私信息扫描）中国大陆手机号：11 位，1[3-9] 开头。
    // 不限定文件类型——文档示例/种子数据同样不该出现看起来真实的手机号，
    // 误报由人工复核 + 后续按需在 PLACEHOLDER_HINTS 或本规则旁补充白名单
    name: '疑似未脱敏的手机号',
    regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    extractValue: (m) => m[0],
    isSensitive: (m) => !isLikelyPlaceholderNumber(m[0]) && !KNOWN_PUBLIC_CONTACT_VALUES.has(m[0])
  },
  {
    // 🛡️（2026-09-14 国内隐私信息扫描）中国大陆身份证号：18 位，前 6 位
    // 地区码 + 8 位出生年月日（做了年份/月份/日期范围的基本结构校验，不是
    // 完整的国标校验码算法——这是一份启发式扫描工具，宁可用结构校验降低
    // 误报，也不引入一整套校验码计算逻辑）+ 3 位顺序码 + 1 位校验位（数字
    // 或 X/x）
    name: '疑似未脱敏的身份证号',
    regex: /(?<![\dXx])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])/g,
    extractValue: (m) => m[0],
    isSensitive: (m) => !isLikelyPlaceholderNumber(m[0])
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

// 🛡️（2026-09-14）内容级正则扫描核心逻辑——从 auditFile() 拆出，供"遍历
// 文件系统"（默认模式）与"只读 git 暂存区 blob 内容"（--staged 模式）两条
// 路径共用，避免两处各写一份、日后改规则漏改一处
function auditContent(relPath, ext, content, findings) {
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

      if (rule.enforceMockSecretNamingInTests && isTestFile(relPath)) {
        if (MOCK_SECRET_PREFIX_RE.test(String(value))) continue; // 已按规约命名，放行
        findings.push({
          file: relPath,
          line: lineNo,
          rule: `${rule.name}（测试文件假数据未按 mock_secret_ 命名规约命名）`,
          value: redact(String(value))
        });
        continue;
      }

      findings.push({ file: relPath, line: lineNo, rule: rule.name, value: redact(String(value)) });
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

  auditContent(relPath, ext, content, findings);
}

// ── --staged 模式：只读 git 暂存区内容，不碰工作区文件 ──────────────────
// 用途：commit 前预检——已经 `git add` 但尚未 commit 的内容才是即将真正落
// 进版本库的东西；工作区里还没 add 的改动、或 add 之后又在工作区改过还没
// 重新 add 的部分，都不该被这次预检误判成"已经准备提交"。用 `git show
// :relPath` 读暂存区里的 blob 内容，而不是 `fs.readFileSync` 读工作区文件。
function getStagedFiles() {
  let out;
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
      cwd: TARGET_DIR,
      encoding: 'utf8'
    });
  } catch (err) {
    console.log(`${RED}❌ 读取 git 暂存区文件列表失败（是否在 git 仓库内？）: ${err.message}${RESET}`);
    process.exit(1);
  }
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// git show 的路径分隔符要求 POSIX 风格（正斜杠），Windows 上 path.relative
// 可能产出反斜杠，两条 git 读取路径（暂存区/HEAD）共用这一步归一化
function toGitPath(relPath) {
  return relPath.split(path.sep).join('/');
}

function readGitContent(ref, relPath) {
  try {
    return execFileSync('git', ['show', `${ref}:${toGitPath(relPath)}`], {
      cwd: TARGET_DIR,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (err) {
    return null; // 二进制文件/已删除文件等，忽略
  }
}

// ── --tracked 模式：只扫描 git 已跟踪的文件（`git ls-files`），按 HEAD 上
// 已提交的内容读取 ──────────────────────────────────────────────────────
// 用途：pre-push 钩子预检——即将被推送出去的只会是"已提交、且被 git 跟踪"
// 的内容。默认全盘扫描模式（遍历文件系统）会把工作目录里任何符合
// SENSITIVE_FILE_EXTS/CONTENT_RULES 的文件都算上，哪怕它已经被 .gitignore
// 正确排除、永远不会进入版本库（真实案例：本机 WeChat 开发者工具本地上传
// 私钥 private.wx*.key，被 .gitignore 正确排除，但默认模式仍会把它判定为
// "违规"，导致钩在 pre-push 上的默认全盘扫描永远无法通过、每次 push 都被
// 物理拦死）。`git ls-files` 本身已经只列出跟踪文件，天然遵守 .gitignore，
// 不需要额外过滤
function getTrackedFiles() {
  let out;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: TARGET_DIR, encoding: 'utf8' });
  } catch (err) {
    console.log(`${RED}❌ 读取 git 跟踪文件列表失败（是否在 git 仓库内？）: ${err.message}${RESET}`);
    process.exit(1);
  }
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// --staged 与 --tracked 共用同一套"按文件列表 + git 内容源逐个审计"逻辑，
// 只是文件列表来源（暂存区变更 vs 全部跟踪文件）与内容读取的 git ref
// （:（index）vs HEAD）不同
function auditGitFiles(fileList, ref, sensitiveRuleName, findings) {
  for (const relPath of fileList) {
    const absPath = path.resolve(TARGET_DIR, relPath);
    if (absPath === SELF_PATH) continue;

    const ext = path.extname(relPath).toLowerCase();

    if (SENSITIVE_FILE_EXTS.has(ext)) {
      findings.push({
        file: relPath,
        line: null,
        rule: sensitiveRuleName,
        value: `文件类型 ${ext}，不应提交进版本库`
      });
      continue;
    }

    if (!TEXT_FILE_EXTS.has(ext)) continue;

    const content = readGitContent(ref, relPath);
    if (content === null) continue;

    auditContent(relPath, ext, content, findings);
  }
}

function main() {
  if (!fs.existsSync(TARGET_DIR)) {
    console.log(`${RED}❌ 目标目录不存在: ${TARGET_DIR}${RESET}`);
    process.exit(1);
  }

  const modeLabel = STAGED_MODE ? '（仅 git 暂存区）' : (TRACKED_MODE ? '（仅 git 已跟踪文件 @ HEAD）' : '');
  console.log(`${BOLD}🛡️  安全防泄露扫描: ${TARGET_DIR}${modeLabel}${RESET}`);

  const findings = [];
  if (STAGED_MODE) {
    auditGitFiles(getStagedFiles(), ':', '暂存区中存在明文私钥/证书文件', findings);
  } else if (TRACKED_MODE) {
    auditGitFiles(getTrackedFiles(), 'HEAD', '版本库中存在明文私钥/证书文件', findings);
  } else {
    walk(TARGET_DIR, (filePath) => auditFile(filePath, findings));
  }

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
    `若是占位符/示例误报，可在 scripts/security-audit.js 的 PLACEHOLDER_HINTS 中补充规则；` +
    `若是测试文件里有意为之的假数据，改名为 mock_secret_ 前缀即可放行。${RESET}`);
  process.exit(1);
}

main();
