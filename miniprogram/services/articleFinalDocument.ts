import type { XiaoyiMessage } from './xiaoyiCompanion';

export interface WritingDocumentSection {
  title: string;
  text: string;
}

export interface WritingDocumentPlan {
  storyId: string;
  title: string;
  sections: WritingDocumentSection[];
}

export interface WritingDocumentLink {
  storyId: string;
  title: string;
}

const formats = [
  /微信|wechat/i, /朋友圈|social post/i, /短信|text message/i, /邮件|email/i,
  /书信|信件|letter/i, /备注|备忘|memo/i,
];

export function articleDocumentRequest(input: string) {
  const request = input.trim();
  if (request.length > 500 || /[\r\n]/.test(request) ||
      /(?:别|不用|不要|先不|暂不)[^，。；]{0,6}(?:保存|建|创建|新建)|(?:don’t|don't|do not) (?:save|create)/i.test(request)) return;
  const create = /(?:^|[。！!；;])\s*(?:请|麻烦)?\s*(?:帮我|给我|为我)?\s*(?:现在)?(?:新建|创建|建|保存为|存成|另存为)(?:一份|一篇|一个)?(?:名为|叫做?|标题为|《|[^，。；]{0,48}(?:文档|故事|书稿))|(?:^|[.!;])\s*(?:please )?(?:create|save as) (?:a |the )?(?:new )?document/i;
  const action = create.exec(request);
  if (!action) return;
  if (!/(?:文档|故事|书稿|document)/i.test(request)) return;
  const command = request.slice(action.index);
  const title = (/(?:名为|叫做?|标题为|保存为|存成|另存为)\s*[《「『“"]([^》」』”"]+)[》」』”"]/.exec(command) ||
    /《([^》]+)》/.exec(command) || /(?:named|called|titled)\s+["“]([^"”]+)["”]/i.exec(command) ||
    /(?:名为|叫做?|标题为)([^，。；]{1,40}?)(?:的)?(?:文档|故事|书稿)/.exec(command))?.[1].trim() || '';
  const contents = title ? command.replace(title,'') : command;
  const references = formats.filter(format => format.test(contents));
  return { title, references, manuscript: /书稿|manuscript/i.test(contents),
    separate: /(?:分开|两段|两部分|一并|连同|一起放|separate|both)/i.test(contents) || references.length > 0 };
}

function finalizedSources(messages: XiaoyiMessage[]) {
  const result: WritingDocumentSection[] = [];
  for (const message of messages) {
    if (message.kind !== 'answer' || message.documentWrite) continue;
    const lines = message.text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim().replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '');
      const match = /^(.{1,58}?)(?:[:：]\s*(.+))?$/.exec(line.replace(/^\*\*|\*\*$/g, ''));
      const heading = match?.[1].replace(/\*\*/g, '').trim() || '';
      const confirmed = /(?:[（(]?\s*(?:最终)?定稿(?:原话)?|[（(]?\s*原样保留|[（(]?\s*原话|\bverbatim|\bfinal)\s*[）)]?$/i;
      if (!confirmed.test(heading)) continue;
      const title = heading.replace(confirmed,'').trim();
      if (!title || title.length > 40) continue;
      let text = match?.[2] || '';
      if (!text) {
        const next = lines.slice(index + 1).join('\n').replace(/^(?:[\t ]*\r?\n)+/, '');
        text = next.split(/\r?\n\s*\r?\n|\r?\n(?=\s*(?:#{1,6}\s|[-*]\s|[^：:\n]{1,32}[:：]))/, 1)[0];
      }
      text = text.trim();
      const quote = /^(?:“([\s\S]+)”|「([\s\S]+)」|『([\s\S]+)』|"([\s\S]+)")$/.exec(text);
      if (quote) text = quote.slice(1).find(Boolean) || '';
      if (text && !result.some(item => item.title === title && item.text === text)) result.push({title,text});
    }
  }
  return result;
}

export function articleDocumentSections(messages: XiaoyiMessage[], request: NonNullable<ReturnType<typeof articleDocumentRequest>>):
  WritingDocumentSection[] | 'draft' | 'verbatim' | 'ambiguous' {
  const drafts = [...messages].reverse().filter(item => item.kind === 'draft' && item.articleDraftLabel && item.text.trim());
  const draft = (request.manuscript && drafts.find(item => /书稿|manuscript/i.test(item.articleDraftLabel!))) || drafts[0];
  if (!draft) return 'draft';
  const sections = [{title:draft.articleDraftLabel!,text:draft.text}];
  if (!request.separate) return sections;
  const sources = finalizedSources(messages);
  const groups = request.references.length ? request.references.map(format => sources.filter(item => format.test(item.title))) : [sources];
  for (const group of groups) {
    const unique = group.filter((item,index) => group.findIndex(other => other.text === item.text) === index);
    if (!unique.length) return 'verbatim';
    if (unique.length > 1) return 'ambiguous';
    if (!sections.some(section => section.title === unique[0].title && section.text === unique[0].text)) sections.push(unique[0]);
  }
  return sections;
}
