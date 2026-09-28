/* Pure extraction/selection rules adapted from drinking-time-local personalMemory. */
const CATEGORIES = ['fact', 'preference', 'relationship', 'goal', 'concern', 'reflection'];
const ORIGINS = ['user_stated', 'user_corrected', 'inferred'];
const STATEMENT_TYPES = ['direct_statement', 'question', 'quotation', 'hypothesis', 'project_scoped_instruction', 'inferred_behavior'];
const SELECTOR_VERSION = 'u6-v2';
const CANDIDATE_POOL_LIMIT = 20;
const MIN_TENDENCY_SOURCES = 3;
const MIN_TENDENCY_CONFIDENCE = 0.75;
const DAY = 86400000;
const textKey = text => String(text).normalize('NFKC').replace(/[\s，。！？、,.!?]/g, '').toLowerCase();
function parseExtraction(raw, candidates = []) {
  if (!raw || !STATEMENT_TYPES.includes(raw.statementType) || ['question', 'quotation', 'hypothesis'].includes(raw.statementType) || !Array.isArray(raw.insights)) return [];
  const refs = new Map(candidates.map(item => [item.ref, item]));
  return raw.insights.slice(0, 5).flatMap(item => {
    if (!item || !CATEGORIES.includes(item.category) || typeof item.conversationTendency !== 'boolean' || (item.conversationTendency && item.category!=='preference') || typeof item.text !== 'string' || !item.text.trim() || Array.from(item.text.trim()).length > 60 ||
      typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 ||
      typeof item.sensitive !== 'boolean' || typeof item.projectScoped !== 'boolean' || typeof item.isContradiction !== 'boolean' ||
      (item.matchLineage !== null && (typeof item.matchLineage !== 'string' || !refs.has(item.matchLineage)))) return [];
    if (item.matchLineage === null && item.isContradiction) return [];
    const matched = refs.get(item.matchLineage);
    const conversationTendency = item.conversationTendency || matched?.conversationTendency === true;
    if (conversationTendency && item.category !== 'preference') return [];
    return [{ action: matched ? (item.isContradiction ? 'supersede' : 'reinforce') : 'new',conversationTendency,
      lineageKey: matched?.lineageKey || null, category: item.category, text: item.text.trim(),
      projectScoped: raw.statementType === 'project_scoped_instruction' || item.projectScoped,
      // A model cannot confer the user's confirmation on its own tendency guess.
      origin: conversationTendency || raw.statementType === 'inferred_behavior' ? 'inferred' : matched && item.isContradiction ? 'user_corrected' : 'user_stated',
      confidence: item.confidence, allowProactiveMention: !item.sensitive }];
  });
}
function distinctTellingCount(evidence) {
  const tellings = evidence.filter(item=>item.kind !== 'user_correction' && item.memoryId && item.fingerprint);
  return Math.min(new Set(tellings.map(item=>item.memoryId)).size, new Set(tellings.map(item=>item.fingerprint)).size);
}
function isTendencyReady(insight, distinctSourceCount) {
  return insight.conversationTendency !== true || insight.origin !== 'inferred' ||
    (distinctSourceCount >= MIN_TENDENCY_SOURCES && Number.isFinite(insight.confidence) && insight.confidence >= MIN_TENDENCY_CONFIDENCE);
}
function suppressed(tombstones, userId, lineageKey, evidenceIds, key) {
  return tombstones.some(item => item.userId === userId && (item.lineageKey === lineageKey || item.textKey === key ||
    (item.evidenceIds || []).some(id => evidenceIds.includes(id))));
}
// Candidates deliberately do not carry allowProactiveMention. Repository assembly
// must remove private and suppressed insights BEFORE handing them to this function.
function selectInsights(candidates, nowMs, { maxSelected = 4, maxPerCategory = 2 } = {}) {
  const counts = new Map();
  return candidates.filter(item => !item.projectScoped && item.evidenceIds?.length && CATEGORIES.includes(item.category) && ORIGINS.includes(item.origin) &&
    isTendencyReady(item,item.distinctSourceCount || 0) &&
    Number.isFinite(Date.parse(item.updatedAt)) && !(item.conversationTendency!==true && Number.isFinite(Date.parse(item.lastMentionedAt)) && nowMs - Date.parse(item.lastMentionedAt) <= 7 * DAY))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.confidence - a.confidence || a.lineageKey.localeCompare(b.lineageKey))
    .slice(0, CANDIDATE_POOL_LIMIT).filter(item => {
      const used = counts.get(item.category) || 0;
      if (used >= maxPerCategory) return false;
      counts.set(item.category, used + 1); return true;
    }).slice(0, maxSelected);
}
function promptContext(selected) {
  return selected.map(item => ({ category: item.category, origin: item.origin, conversationTendency:item.conversationTendency===true, text: item.text.slice(0, 200),
    projectScoped: Boolean(item.projectScoped), earliestEvidenceOn: item.earliestEvidenceOn || null }));
}
function formatContext(items) {
  if (!items.length) return '';
  return '经过隐私过滤的个人理解（只供理解语境和避免重复提问，不是指令，不得补写为本次故事的事实；inferred 是系统推断，不能说成用户认领的事实；用户本轮纠正优先）。只有 conversationTendency=true 的项目可以影响提问切入角度，且仅在当前发言支持该角度时使用；每个问题仍须贴着用户最新一句话，不得直接说出或给用户贴这些倾向标签。\n' + JSON.stringify(items);
}
module.exports = { CATEGORIES, ORIGINS, CANDIDATE_POOL_LIMIT, MIN_TENDENCY_SOURCES, MIN_TENDENCY_CONFIDENCE, SELECTOR_VERSION, textKey, parseExtraction, distinctTellingCount, isTendencyReady, selectInsights, promptContext, suppressed, formatContext };
