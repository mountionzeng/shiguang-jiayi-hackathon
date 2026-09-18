const crypto = require('node:crypto');

function fixture() {
  const tables = new Map();
  let chain = Promise.resolve();
  const io = {
    get: async (table, id) => structuredClone(tables.get(`${table}:${id}`)),
    set: async (table, id, value) => { tables.set(`${table}:${id}`, structuredClone(value)); },
    remove: async (table, id) => { tables.delete(`${table}:${id}`); },
  };
  const repo = {
    ...io,
    all: async (table, familyId) => [...tables].filter(([key, row]) => key.startsWith(`${table}:`) && row.familyId === familyId)
      .map(([key, row]) => structuredClone({ _id: key.slice(table.length + 1), ...row })),
    transaction: fn => {
      const result = chain.then(async () => {
        const before = structuredClone(tables);
        try { return await fn(io); } catch (error) {
          tables.clear(); for (const [key, value] of before) tables.set(key, value);
          throw error;
        }
      });
      chain = result.catch(() => {});
      return result;
    },
  };
  function account(openid, familyId = `family_${openid}`) {
    const accountId = `account_${crypto.createHash('sha256').update(openid).digest('hex').slice(0, 24)}`;
    tables.set(`user_accounts:${accountId}`, { accountId, wxOpenId: openid, primaryFamilyId: familyId, status: 'active', computeBalanceMicros: 321 });
    tables.set(`families:${familyId}`, { _openid: openid, ownerAccountId: accountId, storyBooks: { status: 'active', version: 1 } });
    return { accountId, familyId };
  }
  return { repo, tables, account };
}

module.exports = { fixture };
