'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesEventTagFilter, matchesYearFilter, matchesNameQuery, normalizeYearFilter } = require('./meritSteleFilters');

test('matchesEventTagFilter：未提供筛选条件（空字符串）时一律通过', () => {
  assert.equal(matchesEventTagFilter('岁次保生大帝诞辰法会', ''), true);
  assert.equal(matchesEventTagFilter('', ''), true);
});

test('matchesEventTagFilter：提供筛选条件时要求精确匹配，不做子串/模糊匹配', () => {
  assert.equal(matchesEventTagFilter('岁次保生大帝诞辰法会', '岁次保生大帝诞辰法会'), true);
  assert.equal(matchesEventTagFilter('岁次保生大帝诞辰法会', '诞辰法会'), false);
  assert.equal(matchesEventTagFilter('', '岁次保生大帝诞辰法会'), false);
});

test('matchesYearFilter：未提供年份筛选时一律通过', () => {
  assert.equal(matchesYearFilter('2026-03-15', ''), true);
});

test('matchesYearFilter：按年份前缀匹配', () => {
  assert.equal(matchesYearFilter('2026-03-15', '2026'), true);
  assert.equal(matchesYearFilter('2025-12-31', '2026'), false);
});

test('matchesYearFilter：dateString 缺失时即使有年份筛选也不通过（不能把日期不明的记录计入某一年）', () => {
  assert.equal(matchesYearFilter('', '2026'), false);
  assert.equal(matchesYearFilter(undefined, '2026'), false);
});

test('matchesNameQuery：未提供检索词时一律通过', () => {
  assert.equal(matchesNameQuery('陈某某', ''), true);
});

test('matchesNameQuery：按子串模糊匹配', () => {
  assert.equal(matchesNameQuery('陈某某合家', '某某'), true);
  assert.equal(matchesNameQuery('陈某某合家', '林'), false);
});

test('matchesNameQuery：name 缺失时即使有检索词也不通过', () => {
  assert.equal(matchesNameQuery('', '某某'), false);
  assert.equal(matchesNameQuery(undefined, '某某'), false);
});

test('normalizeYearFilter：合法 4 位年份原样保留', () => {
  assert.equal(normalizeYearFilter('2026'), '2026');
});

test('normalizeYearFilter：非法格式（位数不对/非数字/含字母）归一化为空字符串', () => {
  assert.equal(normalizeYearFilter('26'), '');
  assert.equal(normalizeYearFilter('20266'), '');
  assert.equal(normalizeYearFilter('abcd'), '');
  assert.equal(normalizeYearFilter('2026-01'), '');
});

test('normalizeYearFilter：缺失/undefined/null 归一化为空字符串，不抛异常', () => {
  assert.equal(normalizeYearFilter(undefined), '');
  assert.equal(normalizeYearFilter(null), '');
  assert.equal(normalizeYearFilter(''), '');
});
