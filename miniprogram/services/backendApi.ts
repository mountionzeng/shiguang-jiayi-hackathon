import {
  biographySourceContributions,
  FamilyRoomState,
  MemoryContribution,
  ReviewStatus,
} from "../domain/biography";
import { BACKEND_API_BASE_URL } from "../config/runtime";

interface BackendSourceRecord {
  id: string;
}

interface BackendMemory {
  id: string;
  title?: string | null;
  content: string;
  visibility: string;
  review_status: string;
  created_at: string;
}

interface BackendGenerationJob {
  id: string;
  product_type: string;
  detail_level: string;
  status: string;
}

type BackendRequestMethod = "GET" | "POST" | "PUT";
type BackendRequestData = string | WechatMiniprogram.IAnyObject | ArrayBuffer;

export interface BackendSourceRecordCreatePayload {
  contributor_person_id: string;
  source_type: "text";
  raw_text: string;
  notes: string;
}

export interface BackendMemoryCreatePayload {
  author_person_id: string;
  title: string;
  content: string;
  visibility: "family" | "private";
  review_status: ReviewStatus;
  source: "family_contribution";
  source_record_ids: string[];
}

export interface BackendGenerationJobCreatePayload {
  product_type: "memoir_review";
  output_modality: "text";
  input_memory_ids: string[];
  input_source_record_ids: string[];
}

export function buildSourceRecordPayload(
  contribution: MemoryContribution,
): BackendSourceRecordCreatePayload {
  return {
    contributor_person_id: contribution.authorMemberId,
    source_type: "text",
    raw_text: contribution.text,
    notes: JSON.stringify({
      frontendContributionId: contribution.id,
      authorName: contribution.authorName,
      relation: contribution.relation,
      visibility: contribution.visibility,
      reviewStatus: contribution.reviewStatus,
      createdAt: contribution.createdAt,
    }),
  };
}

export function buildMemoryPayload(
  contribution: MemoryContribution,
  sourceRecordId: string,
): BackendMemoryCreatePayload {
  return {
    author_person_id: contribution.authorMemberId,
    title: contribution.text.slice(0, 24),
    content: contribution.text,
    visibility: contribution.visibility,
    review_status: contribution.reviewStatus,
    source: "family_contribution",
    source_record_ids: [sourceRecordId],
  };
}

export function buildBiographyJobPayload(
  memoryIds: string[],
  sourceRecordIds: string[],
): BackendGenerationJobCreatePayload {
  return {
    product_type: "memoir_review",
    output_modality: "text",
    input_memory_ids: memoryIds,
    input_source_record_ids: sourceRecordIds,
  };
}

export function backendEligibleContributionIds(state: FamilyRoomState): string[] {
  return biographySourceContributions(state.contributions).map((contribution) => contribution.id);
}

function requestJson<T>(
  path: string,
  method: BackendRequestMethod,
  data?: BackendRequestData,
): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BACKEND_API_BASE_URL}${path}`,
      method,
      data,
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T);
          return;
        }
        reject(response);
      },
      fail: reject,
    });
  });
}

export async function createBackendContribution(
  familyId: string,
  contribution: MemoryContribution,
): Promise<BackendMemory> {
  const sourceRecord = await requestJson<BackendSourceRecord>(
    `/families/${familyId}/source-records`,
    "POST",
    buildSourceRecordPayload(contribution),
  );

  return requestJson<BackendMemory>(
    `/families/${familyId}/memories`,
    "POST",
    buildMemoryPayload(contribution, sourceRecord.id),
  );
}

export function updateBackendContributionReview(
  familyId: string,
  memoryId: string,
  reviewStatus: Exclude<ReviewStatus, "pending">,
): Promise<BackendMemory> {
  return requestJson<BackendMemory>(
    `/families/${familyId}/memories/${memoryId}`,
    "PUT",
    { review_status: reviewStatus },
  );
}

export function createBackendBiographyJob(
  familyId: string,
  memoryIds: string[],
  sourceRecordIds: string[],
): Promise<BackendGenerationJob> {
  return requestJson<BackendGenerationJob>(
    `/families/${familyId}/generation-jobs`,
    "POST",
    buildBiographyJobPayload(memoryIds, sourceRecordIds),
  );
}
