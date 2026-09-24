// Call sites supply fixed operation names only. Never log arguments, IDs,
// returned documents or error messages from a user's room.
async function measurePerformance(operation, work) {
  const started = Date.now();
  let outcome = 'error';
  try {
    const result = await work();
    outcome = 'ok';
    return result;
  } finally {
    try {
      console.info('[performance]', { operation, outcome, durationMs: Math.max(0, Date.now() - started) });
    } catch { /* Diagnostics must never change a response or hide its error. */ }
  }
}

module.exports = { measurePerformance };
