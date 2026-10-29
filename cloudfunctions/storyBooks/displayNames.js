// 署名只在显示时查：别人看到的是发送者本人在「我的」里起的称呼（user_accounts.displayName）。
// 这里只取称呼一个字段，不把账号里的其他内容带出去；任何一次读取失败都静默跳过，
// 调用方退回记录里原来的备注名，绝不因为取名字让房间、回信列表或改动历史加载失败。
const PRINCIPAL_ID = /^principal_[0-9a-f]{32}$/;
const DOC_ID = /^[0-9A-Za-z_-]{1,128}$/;
const BATCH_SIZE = 20;

const cleanName = value => typeof value === 'string' && value.trim() ? Array.from(value.trim()).slice(0, 30).join('') : '';

function unique(values, pattern) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && pattern.test(value)))];
}

function batches(ids) {
  const groups = [];
  for (let index = 0; index < ids.length; index += BATCH_SIZE) groups.push(ids.slice(index, index + BATCH_SIZE));
  return groups;
}

// 每批最多 20 个；各批与批内各个读取全部并行，不会多出串行轮次。
async function readEach(ids, read) {
  const found = new Map();
  await Promise.all(batches(ids).map(group => Promise.all(group.map(async id => {
    try {
      const value = await read(id);
      if (value !== undefined && value !== '') found.set(id, value);
    } catch { /* 名字只用于显示，读不到就用备注名 */ }
  }))));
  return found;
}

async function ownNamesByAccount(reader, accountIds) {
  return readEach(unique(accountIds, DOC_ID), async id => cleanName((await reader.get('user_accounts', id))?.displayName));
}

// principalId -> accountId -> 称呼。两步读取，各步内部并行。
async function ownNamesByPrincipal(reader, principalIds) {
  const accounts = await readEach(unique(principalIds, PRINCIPAL_ID), async id => {
    const principal = await reader.get('story_principals', id);
    return typeof principal?.accountId === 'string' && DOC_ID.test(principal.accountId) ? principal.accountId : undefined;
  });
  const names = await ownNamesByAccount(reader, [...accounts.values()]);
  const byPrincipal = new Map();
  for (const [principalId, accountId] of accounts) if (names.has(accountId)) byPrincipal.set(principalId, names.get(accountId));
  return byPrincipal;
}

module.exports = { BATCH_SIZE, ownNamesByAccount, ownNamesByPrincipal };
