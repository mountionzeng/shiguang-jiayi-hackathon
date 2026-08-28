import {
  biographySourceContributions,
  BiographyDraft,
  buildLocalBiographyDraft,
  FamilyRoomState,
} from "../domain/biography";
import type { ShiguangAppOptions } from "../app";

interface CloudBiographyResult {
  title?: unknown;
  paragraphs?: unknown;
  sourceCount?: unknown;
  generatedAt?: unknown;
  generationMode?: unknown;
}

function isCloudBiographyResult(value: unknown): value is BiographyDraft {
  if (!value || typeof value !== "object") return false;
  const result = value as CloudBiographyResult;
  return (
    typeof result.title === "string" &&
    Array.isArray(result.paragraphs) &&
    result.paragraphs.every((paragraph) => typeof paragraph === "string") &&
    typeof result.sourceCount === "number" &&
    typeof result.generatedAt === "string" &&
    result.generationMode === "cloud-ai"
  );
}

export async function generateBiography(state: FamilyRoomState): Promise<BiographyDraft> {
  const confirmed = biographySourceContributions(state.contributions);
  if (confirmed.length === 0) {
    throw new Error("至少确认一段回忆后才能生成章节");
  }

  const app = getApp<ShiguangAppOptions>();
  if (app.globalData.cloudReady && wx.cloud) {
    try {
      const response = await wx.cloud.callFunction({
        name: "generateBiography",
        data: {
          protagonistName: state.protagonistName,
          memories: confirmed.map((memory) => ({
            id: memory.id,
            authorName: memory.authorName,
            relation: memory.relation,
            text: memory.text,
          })),
        },
      });

      if (isCloudBiographyResult(response.result)) {
        return response.result;
      }

      console.warn("云函数返回格式不完整，将使用透明演示草稿", response.result);
    } catch (error) {
      console.warn("AI 云生成不可用，将使用透明演示草稿", error);
    }
  }

  return buildLocalBiographyDraft(state.protagonistName, state.contributions);
}
