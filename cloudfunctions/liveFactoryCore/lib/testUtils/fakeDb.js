// 仅供单元测试使用的最小化云开发数据库模拟，只实现 scheduling.js 用到的那部分
// API 形状（where/update/add/limit/get，db.command 的 lte/gte/inc）。
'use strict';

function matches(doc, cond) {
  return Object.keys(cond).every((key) => {
    const expect = cond[key];
    if (expect && typeof expect === 'object' && expect.__op) {
      const actual = doc[key];
      if (expect.__op === 'lte') return actual !== undefined && actual <= expect.__val;
      if (expect.__op === 'gte') return actual !== undefined && actual >= expect.__val;
      throw new Error('unsupported op in fakeDb: ' + expect.__op);
    }
    return doc[key] === expect;
  });
}

function applyUpdate(doc, data) {
  Object.keys(data).forEach((key) => {
    const val = data[key];
    if (val && typeof val === 'object' && val.__op === 'inc') {
      doc[key] = (doc[key] || 0) + val.__val;
    } else {
      doc[key] = val;
    }
  });
}

function createFakeDb(initialDocs = []) {
  let docs = initialDocs.map((d, i) => ({ _id: d._id || `doc_${i}`, ...d }));
  let nextId = docs.length;

  const command = {
    lte: (v) => ({ __op: 'lte', __val: v }),
    gte: (v) => ({ __op: 'gte', __val: v }),
    inc: (v) => ({ __op: 'inc', __val: v })
  };

  function collection() {
    return {
      where(cond) {
        return {
          async update({ data }) {
            const matched = docs.filter((d) => matches(d, cond));
            matched.forEach((d) => applyUpdate(d, data));
            return { stats: { updated: matched.length } };
          },
          limit() {
            return {
              async get() {
                return { data: docs.filter((d) => matches(d, cond)) };
              }
            };
          }
        };
      },
      async add({ data }) {
        const doc = { _id: `doc_${nextId++}`, ...data };
        docs.push(doc);
        return { _id: doc._id };
      }
    };
  }

  return { collection, command, _dump: () => docs };
}

module.exports = { createFakeDb };
