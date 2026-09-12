'use strict';

// 纯逻辑：数字功德碑·历代芳名录检索（meritSteleEntries）的筛选谓词，从
// index.js 抽出——该云函数其余聚合统计逻辑严重依赖 db 查询结果与其它内联
// 的脱敏/格式化辅助函数（maskName/formatDonorDisplayName 等），不适合
// 整体抽成纯函数单测；这三个谓词 + 一个年份参数校验本身只做字符串/参数
// 比较，天然独立、不依赖数据库，配 node --test 单测覆盖，此前完全没有
// 测试覆盖过。与同目录（本仓库其余云函数）resolveCaller.js 等纯函数抽取
// 同一套既定写法。

// eventTag 精确匹配：未提供筛选条件（空字符串）时视为"不筛选"，全部通过
function matchesEventTagFilter(recordTag, tagFilter) {
  if (!tagFilter) return true;
  return recordTag === tagFilter;
}

// 按年份前缀匹配 dateString（如 "2026-03-15" 匹配 yearFilter "2026"）；
// dateString 缺失时一律不通过（避免把日期不明的记录错误计入某一年）
function matchesYearFilter(dateString, yearFilter) {
  if (!yearFilter) return true;
  return !!dateString && String(dateString).startsWith(yearFilter);
}

// 姓名模糊匹配（子串包含，不做拼音/繁简转换等更复杂的模糊匹配）；
// name 缺失时一律不通过
function matchesNameQuery(name, nameQuery) {
  if (!nameQuery) return true;
  return !!name && String(name).includes(nameQuery);
}

// 年份参数校验：只接受严格的 4 位数字字符串，格式不对（含 undefined/null/
// 空字符串/非数字/位数不对）一律归一化为空字符串（视为"不筛选"），不让
// 一个脏参数意外拼进查询条件或误判所有记录都不匹配
function normalizeYearFilter(donorYear) {
  return /^\d{4}$/.test(String(donorYear || '')) ? String(donorYear) : '';
}

module.exports = { matchesEventTagFilter, matchesYearFilter, matchesNameQuery, normalizeYearFilter };
