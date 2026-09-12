import { MemoryContribution } from "./biography";

/** 记忆在列表里显示的名字：自己起的标题优先，没有就取第一句话。 */
export function memoryDisplayTitle(memory: MemoryContribution): string {
  const storedTitle = typeof memory.title === "string" ? memory.title.trim() : "";
  if (storedTitle) return storedTitle;
  const firstSentence = memory.text.split(/[。！？!?]/)[0].trim();
  return firstSentence.slice(0, 18) || "一段记忆";
}
