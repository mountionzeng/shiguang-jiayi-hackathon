const TRAINING_TEXT_TTL_MS=7*24*60*60*1000;

function trainingTextExpiresAt(fetchedAt) {
  const fetchedAtMs=Date.parse(fetchedAt);
  if(!Number.isFinite(fetchedAtMs))throw new Error('INVALID_TRAINING_TEXT_TIME');
  return new Date(fetchedAtMs+TRAINING_TEXT_TTL_MS).toISOString();
}

function isTrainingTextValid(trainingText,at) {
  const expiresAtMs=Date.parse(trainingText?.expiresAt),atMs=Date.parse(at);
  return Number.isFinite(expiresAtMs)&&Number.isFinite(atMs)&&expiresAtMs>atMs;
}

module.exports={TRAINING_TEXT_TTL_MS,trainingTextExpiresAt,isTrainingTextValid};
