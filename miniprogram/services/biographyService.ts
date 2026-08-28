import {
  BiographyDraft,
  buildLocalPersonalBiographyDraft,
  FamilyMember,
  FamilyRoomState,
  personalBookContributions,
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

export async function generateBiography(
  state: FamilyRoomState,
  member: FamilyMember,
): Promise<BiographyDraft> {
  const personal = personalBookContributions(state.contributions, member.id);
  if (personal.length === 0) {
    throw new Error("至少写下一段自己的经历后才能生成章节");
  }

  const app = getApp<ShiguangAppOptions>();
  if (app.globalData.cloudReady && wx.cloud) {
    try {
      const response = await wx.cloud.callFunction({
        name: "generateBiography",
        data: {
          protagonistName: member.name,
          memories: personal.map((memory) => ({
            id: memory.id,
            authorName: memory.authorName,
            relation: "本人",
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

  return buildLocalPersonalBiographyDraft(
    member.name,
    member.id,
    state.contributions,
  );
}
