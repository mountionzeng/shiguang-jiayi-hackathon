import { startPerformanceMeasure } from './performanceLog';

// Disposable display derivatives only. Callers must first load the current story
// and its selected cover ID; this cache is never a source of story permissions.
const STORAGE_KEY = 'shiguang-book-preview-v1';
const PREFIX = 'book-preview-v1-';
interface Entry { key: string; path: string }

export function bookCoverExists(path: string): boolean {
  try { wx.getFileSystemManager().accessSync(path); return true; }
  catch { return false; }
}

function entries(): Entry[] {
  const stored: unknown = wx.getStorageSync(STORAGE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is Entry => Boolean(entry && typeof entry.key === 'string'
    && typeof entry.path === 'string' && entry.path.startsWith(`${wx.env.USER_DATA_PATH}/${PREFIX}`)));
}

export function cachedBookCover(key: string): string {
  const finish = startPerformanceMeasure('book.cover-cache');
  try {
    const entry = entries().find(item => item.key === key);
    if (!entry) return '';
    if (!bookCoverExists(entry.path)) return '';
    finish('ok', { route: 'local' });
    return entry.path;
  } catch { return ''; }
}

export async function cacheBookCover(key: string, tempFilePath: string): Promise<string> {
  let saved = '';
  try {
    const fs = wx.getFileSystemManager();
    saved = await new Promise<string>((resolve, reject) => fs.saveFile({
      tempFilePath,
      filePath: `${wx.env.USER_DATA_PATH}/${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
      success: result => resolve(result.savedFilePath), fail: reject,
    }));
    const previous = entries();
    const next = [{ key, path: saved }, ...previous.filter(item => item.key !== key)].slice(0, 12);
    wx.setStorageSync(STORAGE_KEY, next);
    for (const entry of previous) {
      if (!next.some(item => item.path === entry.path)) fs.unlink({ filePath: entry.path, fail: () => undefined });
    }
    return saved;
  } catch {
    // A full/disabled cache must not prevent this session from displaying the book.
    if (saved) return saved;
    return tempFilePath;
  }
}
