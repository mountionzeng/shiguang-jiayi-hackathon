const crypto = require('node:crypto');

const fail = (message, code = 'STORY_FORBIDDEN') => { throw Object.assign(new Error(message), { code }); };
const sanitize = value => String(value).replace(/[^0-9A-Za-z_-]/g, '_');
const stableVersion = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validOptionalId(value) {
  return value === undefined || (typeof value === 'string' && /^[0-9A-Za-z_-]{1,160}$/.test(value));
}

function memoryIdOf(memory, familyId) {
  return String(memory.frontendContributionId || memory.id || memory.sourceRecordId || memory._id || '')
    .replace(/^src_/, '')
    .replace(`${familyId}_`, '');
}

function selectedRevision(memory, revisionId) {
  const revisions = Array.isArray(memory.aiRevisions) ? memory.aiRevisions : [];
  if (revisionId !== undefined) {
    const selected = revisions.find(item => item && item.id === revisionId && typeof item.text === 'string');
    if (!selected) fail('这段记忆的所选版本已不可用，请重新选择', 'VERSION_CONFLICT');
    return { revisionId: selected.id, text: selected.text, title: selected.title || memory.title || '', kind: selected.kind, revisions };
  }
  const latest = revisions.length ? revisions[revisions.length - 1] : undefined;
  return {
    revisionId: null,
    text: memory.text,
    title: memory.title || '',
    kind: latest?.kind,
    revisions,
  };
}

function resolveFromMemory(memory, ctx, input) {
  if (!memory || memory.familyId !== ctx.familyId || memoryIdOf(memory, ctx.familyId) !== input.memoryId ||
      memory.scope !== 'personal' || memory.deletedAt ||
      !ctx.ownerMemberId || memory.authorMemberId !== ctx.ownerMemberId ||
      memory.sourcePolicyRequired || memory.sourceIds || memory.sourceSystem) {
    fail('这段记忆当前不可发送', 'STORY_NOT_FOUND');
  }
  if (memory.reviewStatus !== 'confirmed') fail('这段记忆还未完成内容确认，暂时不能发送');
  const selected = selectedRevision(memory, input.revisionId);
  if (typeof selected.text !== 'string' || !selected.text.trim() || selected.text.length > 500) {
    fail('这段记忆的已保存正文无效，请重新打开后再试', 'VERSION_CONFLICT');
  }
  const selectedIndex = selected.revisionId
    ? selected.revisions.findIndex(item => item?.id === selected.revisionId)
    : selected.revisions.length - 1;
  const authorizationSnapshot = {
    familyId: memory.familyId,
    memoryId: input.memoryId,
    authorMemberId: memory.authorMemberId || '',
    scope: memory.scope,
    visibility: memory.visibility || '',
    reviewStatus: memory.reviewStatus,
    deletedAt: memory.deletedAt || '',
  };
  const currentSnapshot = input.revisionId !== undefined ? {
    ...authorizationSnapshot,
    selectedRevisionId: selected.revisionId,
    selectedText: selected.text,
    selectedTitle: selected.title,
    selectedKind: selected.kind,
    revisionKindsThroughSelection: selected.revisions
      .slice(0, selectedIndex < 0 ? undefined : selectedIndex + 1)
      .map(item => ({ id: item?.id, kind: item?.kind })),
  } : {
    ...authorizationSnapshot,
    title: memory.title || '',
    text: memory.text,
    selectedRevisionId: selected.revisionId,
    selectedText: selected.text,
    selectedTitle: selected.title,
    selectedKind: selected.kind,
    revisionKindsThroughSelection: selected.revisions
      .slice(0, selectedIndex < 0 ? undefined : selectedIndex + 1)
      .map(item => ({ id: item?.id, kind: item?.kind })),
  };
  const sourceVersion = stableVersion(currentSnapshot);
  if (input.expectedSourceVersion !== undefined && input.expectedSourceVersion !== sourceVersion) {
    fail('这段记忆已有新修改，请重新选择后再发送', 'VERSION_CONFLICT');
  }
  const containsAiText = selected.revisions
    .slice(0, selectedIndex < 0 ? undefined : selectedIndex + 1)
    .some(item => item?.kind === 'ai');
  return {
    source: {
      kind: 'memory', memoryId: input.memoryId, revisionId: selected.revisionId,
      sourceVersion, title: selected.title, text: selected.text, containsAiText,
    },
  };
}

async function getMemory(repo, familyId, memoryId) {
  const canonicalId = `${familyId}_${sanitize(memoryId)}`;
  const candidateIds = [...new Set([canonicalId, memoryId, `src_${familyId}_${sanitize(memoryId)}`])];
  const found = [];
  for (const docId of candidateIds) {
    const row = await repo.get('memories', docId);
    if (row) found.push({ ...row, _id: row._id || docId });
  }
  const matches = found.filter(memory => memory.familyId === familyId && memoryIdOf(memory, familyId) === memoryId);
  matches.sort((a, b) => Number(b._id === canonicalId) - Number(a._id === canonicalId));
  return matches[0];
}

async function getOwnerMemberId(repo, familyId) {
  const canonical = await repo.get('family_members', `${familyId}_owner`);
  if (canonical && !canonical.deletedAt && canonical.kind !== 'person' && (canonical.relation === '自己' || canonical.role === 'owner')) {
    return canonical.memberId || canonical.id;
  }
  const members = await repo.all('family_members', familyId);
  const owner = members.find(member => !member.deletedAt && member.kind !== 'person' && member.relation === '自己')
    || members.find(member => !member.deletedAt && member.kind !== 'person' && member.role === 'owner');
  return owner && (owner.memberId || owner.id);
}

async function memoryExportSource(repo, ctx, input = {}) {
  if (!ctx || typeof ctx.familyId !== 'string' || !/^[0-9A-Za-z_-]{1,128}$/.test(ctx.familyId)) fail('当前账号无法确认记忆归属');
  if (!input || Object.keys(input).some(key => !['memoryId', 'revisionId', 'expectedSourceVersion'].includes(key)) ||
      typeof input.memoryId !== 'string' || !/^[0-9A-Za-z_-]{1,160}$/.test(input.memoryId) ||
      !validOptionalId(input.revisionId) ||
      (input.expectedSourceVersion !== undefined && (typeof input.expectedSourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSourceVersion)))) {
    fail('记忆来源请求无效', 'INVALID_INPUT');
  }
  const [memory, ownerMemberId] = await Promise.all([
    getMemory(repo, ctx.familyId, input.memoryId),
    getOwnerMemberId(repo, ctx.familyId),
  ]);
  return resolveFromMemory(memory, { ...ctx, ownerMemberId }, input);
}

module.exports = { memoryExportSource, resolveFromMemory, memoryIdOf };
