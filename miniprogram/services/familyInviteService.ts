import { FamilyRoomState, MemoryContribution } from "../domain/biography";
import { InviteCardStyleId } from "./inviteCard";

export interface FamilyInvitation {
  token: string;
  inviterName: string;
  inviteeName: string;
  relation: string;
  headline: string;
  message: string;
  signature: string;
  illustrationStyle: InviteCardStyleId;
  roomName: string;
  familyId: string;
  memberId: string;
  status: "pending" | "accepted";
  acceptedByMe: boolean;
  expiresAt: string;
}

interface InviteResult {
  invitation: FamilyInvitation;
  codeBase64?: string;
}

export interface SharedFamilyRoom {
  familyId: string;
  viewerMemberId: string;
  viewerRole: "owner" | "contributor";
  state: FamilyRoomState;
}

export interface JoinedFamilyRoom {
  familyId: string;
  roomName: string;
  memberName: string;
  relation: string;
  avatarText: string;
}

async function callInvite<T>(data: Record<string, unknown>): Promise<T> {
  if (!wx.cloud) throw new Error("当前微信版本暂不支持亲友邀请");
  const response = await wx.cloud.callFunction({ name: "familyInvite", data });
  return response.result as T;
}

export function createFamilyInvitation(
  inviteeName: string,
  relation: string,
  headline: string,
  message: string,
  signature: string,
  illustrationStyle: InviteCardStyleId,
  envVersion: "develop" | "trial" | "release",
): Promise<InviteResult> {
  return callInvite({ action: "create", inviteeName, relation, headline, message, signature, illustrationStyle, envVersion });
}

export async function generateFamilyInvitationCopy(input: {
  inviteeName: string;
  relation: string;
  currentHeadline: string;
  currentMessage: string;
}): Promise<{ headline: string; message: string; aiDisclosure: string }> {
  if (!wx.cloud) throw new Error("当前微信版本暂不支持 AI 写邀请语");
  const response = await wx.cloud.callFunction({
    name: "chatInterview",
    data: { action: "inviteCopy", ...input },
  });
  return response.result as { headline: string; message: string; aiDisclosure: string };
}

export function createFamilyInvitationCode(
  token: string,
  envVersion: "develop" | "trial" | "release",
): Promise<{ codeBase64: string }> {
  return callInvite({ action: "code", token, envVersion });
}

export function loadFamilyInvitation(token: string): Promise<InviteResult> {
  return callInvite({ action: "get", token });
}

export function acceptFamilyInvitation(token: string): Promise<InviteResult> {
  return callInvite({ action: "accept", token });
}

export function loadSharedFamilyRoom(familyId: string): Promise<SharedFamilyRoom> {
  return callInvite({ action: "loadRoom", familyId });
}

export async function loadJoinedFamilyRooms(): Promise<JoinedFamilyRoom[]> {
  const result = await callInvite<{ rooms: JoinedFamilyRoom[] }>({ action: "listRooms" });
  return Array.isArray(result.rooms) ? result.rooms : [];
}

export function submitSharedContribution(
  familyId: string,
  contribution: MemoryContribution,
): Promise<{ ok: boolean; contributionId: string; reviewStatus: "pending" }> {
  return callInvite({ action: "submitContribution", familyId, contribution });
}
