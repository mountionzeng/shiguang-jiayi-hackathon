import type { InterviewTurn } from '../domain/interview';

/** Only the user's words are material. Assistant suggestions never become facts. */
export function articleChatMaterial(conversation: InterviewTurn[], unsent: string): string[] {
  const words = conversation.filter(turn => turn.role === 'user').map(turn => turn.text.trim()).filter(Boolean);
  const current = unsent.trim();
  if (current && words[words.length - 1] !== current) words.push(current);
  const text = words.join('\n');
  if (text.length > 4000) throw new Error('这段对话超过 4000 字，请分成几条记忆保存。');
  return text.match(/[\s\S]{1,500}/g) || [];
}
