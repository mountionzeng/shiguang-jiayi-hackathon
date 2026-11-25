import type { InterviewTurn } from '../domain/interview';
import type { XiaoyiConfig } from './xiaoyiCompanion';
import { requestAiConsent } from './aiConsent';
import { CLOUD_AI_ENABLED } from '../config/runtime';
import type { ShiguangAppOptions } from '../app';
import { articleWritingPayload, type ArticleWritingContext, type ArticleWritingDecision } from './articleWriting';

export interface ArticleTurn {
  id: string; text: string; source: string; scope: string; config: XiaoyiConfig;
  status: 'queued' | 'sending' | 'failed' | 'ready';
  history?: InterviewTurn[]; reply?: string; legacyAttempted?: boolean;
  articleWriting?: ArticleWritingContext;
  decision?: ArticleWritingDecision;
}
const active = new Map<string, ArticleConversation>();
export const ARTICLE_CHAT_INPUT_LIMIT = 20000;

function turnHistory(history: InterviewTurn[], longContext: boolean): InterviewTurn[] {
  if (!longContext) return history.slice(-16).map(turn => ({...turn}));
  let remaining = 40000;
  const turns: InterviewTurn[] = [];
  for (const turn of history.slice(-40).reverse()) {
    if (turn.text.length > remaining) break;
    remaining -= turn.text.length;
    turns.push({...turn});
  }
  return turns.reverse();
}

/** Native adaptation of desktopChatQueue: durable snapshots, ordered sends, explicit recovery. */
export class ArticleConversation {
  items: ArticleTurn[] = [];
  paused = false;
  running = false;
  constructor(readonly key: string, private changed: () => void) {
    const saved = wx.getStorageSync(key);
    if (Array.isArray(saved)) this.items = saved.filter(t => t && typeof t.id === 'string'
      && typeof t.text === 'string' && typeof t.source === 'string' && typeof t.scope === 'string'
      && ['queued','sending','failed','ready'].includes(t.status) && t.config)
      .map(t => ({...t, status:t.status === 'sending' ? 'failed' : t.status}));
    this.paused = this.items.length > 0;
  }
  static open(key: string, changed: () => void) {
    const running = active.get(key);
    if (running) {running.changed = changed;return running;}
    return new ArticleConversation(key,changed);
  }
  skip() {
    if (this.running) return;
    const first = this.items[0];
    this.paused = true;
    this.save(this.items.slice(1));
    return first;
  }
  private save(items = this.items) {
    wx.setStorageSync(this.key, items);
    this.items = items;
    this.changed();
  }
  enqueue(text: string, source: string, scope: string, config: XiaoyiConfig, articleWriting?: ArticleWritingContext) {
    if (!text.trim()) return;
    if (text.trim().length > (articleWriting ? ARTICLE_CHAT_INPUT_LIMIT : 500)) {
      throw new ArticleConversationError('这条内容太长。可以分几条发，原话仍保留。');
    }
    if (source.length > 40000) throw new ArticleConversationError('正文超过当前对话容量，请先选择文字模块。');
    const item: ArticleTurn = {id:`article-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`,
      text:text.trim(), source, scope, config:{...config}, status:'queued', articleWriting};
    // Persist before the composer is cleared. Storage errors leave input untouched.
    this.save([...this.items, item]);
    return item;
  }
  async drain(history: () => InterviewTurn[], apply: (item: ArticleTurn) => boolean, current: () => boolean, resume = false,
    recent?: (item: ArticleTurn) => ArticleWritingContext['recent']) {
    if (this.running || !current() || (this.paused && !resume)) return;
    this.paused = false; this.running = true; active.set(this.key,this); this.changed();
    try {
      while (this.items.length && current()) {
        let item = this.items[0];
        if (item.status !== 'ready') {
          if (!item.history && item.articleWriting && recent) {
            item = {...item, articleWriting:{...item.articleWriting, recent:recent(item)}};
          }
          item = {...item, status:'sending', history:item.history ?? turnHistory(history(), !!item.articleWriting)};
          this.save([item, ...this.items.slice(1)]);
          const result = await sendArticleTurn(item,current, () => {
            const attempted = {...item, legacyAttempted:true};
            this.save([attempted, ...this.items.slice(1)]);
            item = attempted;
          });
          item = {...item, status:'ready', ...result};
          this.save([item, ...this.items.slice(1)]);
        }
        if (!current() || !apply(item)) { this.paused = true; break; }
        this.save(this.items.slice(1));
      }
    } catch (error) {
      this.paused = true;
      const first = this.items[0];
      if (first && first.status !== 'ready') {
        try { this.save([{...first,status:'failed'},...this.items.slice(1)]); } catch { /* durable sending receipt remains recoverable */ }
      }
      throw error;
    } finally { this.running = false; active.delete(this.key); this.changed(); }
  }
}

class ArticleConversationError extends Error {}
function errorText(error: unknown): string {
  const value = error as {message?: unknown; errMsg?: unknown; code?: unknown} | undefined;
  return [value?.code,value?.message,value?.errMsg,typeof error === 'string' ? error : ''].join(' ');
}
export function articleConversationErrorMessage(error: unknown): string {
  if (error instanceof ArticleConversationError) return error.message;
  const text = errorText(error);
  if (/quota|rate.?limit|额度|频繁/i.test(text)) return '在线服务暂时繁忙或额度不足，原话已保留，请稍后再试。';
  if (/PERMISSION_DENIED|UNAUTHORIZED|FORBIDDEN|ACCESS_DENIED/i.test(text)) return '暂时没有接通在线服务，原话已保留，请检查登录和在线 AI 授权。';
  return '这次回复还没能确认，原话已保留。请在小忆菜单核对后继续。';
}

async function sendArticleTurn(turn: ArticleTurn, current: () => boolean, beforeLegacy: () => void):
  Promise<{reply:string;decision?:ArticleWritingDecision}> {
  // Legacy requests have no server receipt lookup. Even an upgraded endpoint must
  // not infer again after an unconfirmed legacy request.
  if (turn.legacyAttempted) throw new ArticleConversationError('上一轮回复没能确认，原话已保留。为避免重复生成，这轮不会自动重发；可在小忆菜单跳过后继续。');
  if (!CLOUD_AI_ENABLED || !wx.cloud || !getApp<ShiguangAppOptions>().globalData.aiReady || !getApp<ShiguangAppOptions>().globalData.cloudReady)
    throw new ArticleConversationError('在线对话暂不可用，发出的内容已保留。');
  if (!await requestAiConsent()) throw new ArticleConversationError('尚未允许在线处理，内容已保留。');
  if (!current()) throw new ArticleConversationError('已切换账号或章节，消息保留在原对话，请在那里继续。');
  let response;
  try {
    response = await wx.cloud.callFunction({name:'chatInterview', data:{action:'articleTurn', turnId:turn.id,
      input:{answer:turn.text, sourceText:turn.source, scope:turn.scope, storyTitle:turn.config.storyTitle || '', conversation:turn.history || [],
        ...(turn.articleWriting ? {articleWriting:articleWritingPayload(turn.articleWriting)} : {})}}});
  } catch (error) {
    // Only this explicit pre-inference validation error proves the old endpoint
    // rejected the nested input. Timeouts and all other failures must not fall back.
    if (!/\bEMPTY_ANSWER\b/.test(errorText(error)) || !turn.text.trim()) throw error;
    if (turn.text.length > 500 || turn.history?.some(t => t.text.length > 500)) {
      throw new ArticleConversationError('当前在线服务还不能处理这段长内容，原话已保留。');
    }
    if (!current()) throw new ArticleConversationError('已切换账号或章节，消息保留在原对话，请在那里继续。');
    beforeLegacy();
    const legacy = await wx.cloud.callFunction({name:'chatInterview',data:{
      answer:turn.text, askedDimensions:[], mode:'personal', memoryType:'memoir',
      storyTitle:turn.config.storyTitle || '', conversation:turn.history || [],
      sourceText:turn.source, sourceOnly:true,
    }});
    const result = legacy.result as {text?:unknown;dimension?:unknown} | undefined;
    if (typeof result?.text !== 'string' || !result.text.trim() ||
        !['person','time','place','event','feeling'].includes(String(result.dimension)))
      throw new ArticleConversationError('这次回复没有收完整，原话已保留。可在小忆菜单跳过这轮后继续。');
    return {reply:result.text.trim()};
  }
  const result = response.result as {turnId?:string; status?:string; reply?:string; decision?:ArticleWritingDecision};
  if (result?.turnId !== turn.id) throw new ArticleConversationError('对话服务版本尚未就绪，内容已保留，请勿重复发送。');
  if (result.status !== 'ready' || typeof result.reply !== 'string' || !result.reply.trim()) throw new ArticleConversationError(result.status === 'failed'
    ? '这一轮未完成，原话仍保留。可在小忆菜单核对结果。' : '这一轮仍在处理中，请稍后在小忆菜单核对结果。');
  return {reply:result.reply, decision:result.decision};
}
