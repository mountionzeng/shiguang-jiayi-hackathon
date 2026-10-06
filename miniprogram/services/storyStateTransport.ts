interface StateChunk {
  stateTransport: number;
  offset: number;
  totalChars: number;
  text: string;
  digest: string;
  nextOffset: number | null;
}

/** Reassemble without dropping historical revisions or mixing concurrent edits. */
export async function readStoryState(call: (data: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  const first = await call({stateTransport:1});
  if ((first as Partial<StateChunk> | null)?.stateTransport !== 1) return first;
  const parts: string[] = [];
  let chunk = first as StateChunk;
  const {digest, totalChars} = chunk;
  let offset = 0;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) ||
      !Number.isSafeInteger(totalChars) || totalChars <= 0 || totalChars > 64 * 1024 * 1024) {
    throw new Error('故事数据分段无效，请重新加载');
  }
  while (true) {
    const end = offset + (typeof chunk.text === 'string' ? chunk.text.length : 0);
    if (chunk.stateTransport !== 1 || chunk.digest !== digest || chunk.totalChars !== totalChars ||
        chunk.offset !== offset || end <= offset || end > totalChars ||
        chunk.nextOffset !== (end === totalChars ? null : end)) {
      throw new Error('故事数据分段无效，请重新加载');
    }
    parts.push(chunk.text);
    if (chunk.nextOffset === null) return JSON.parse(parts.join(''));
    offset = chunk.nextOffset;
    const next = await call({stateTransport:1, stateOffset:offset, stateDigest:digest});
    if (!next || typeof next !== 'object') throw new Error('故事数据分段无效，请重新加载');
    chunk = next as StateChunk;
  }
}
