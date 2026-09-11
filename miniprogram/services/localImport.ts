import { FamilyRoomState } from "../domain/biography";
import { loadCloudRoomState, currentFamilyId } from "./cloudRoomStorage";
import { loadRoomState, saveRoomState, saveCurrentMemberId } from "./roomStorage";

/** Explicit one-way import: namespace all identities and never overwrite local edits. */
export function mergeLegacyCloud(local: FamilyRoomState, remote: FamilyRoomState, source: string): FamilyRoomState {
  if (local.importedCloudRooms?.includes(source)) return local;
  const prefix = source + ":";
  const id = (value: string) => prefix + value;
  const remapDrafts = (drafts: FamilyRoomState["personalDrafts"]) =>
    Object.fromEntries(Object.entries(drafts ?? {}).map(([key, value]) => [id(key), value]));
  return {
    ...local,
    members: [...local.members, ...remote.members.map(member => ({ ...member, id: id(member.id) }))],
    contributions: [...local.contributions, ...remote.contributions.map(item => ({
      ...item, id: id(item.id), authorMemberId: id(item.authorMemberId),
      relatedMemberIds: item.relatedMemberIds?.map(id), sharedWithMemberIds: item.sharedWithMemberIds?.map(id),
    }))],
    personalDrafts: { ...local.personalDrafts, ...remapDrafts(remote.personalDrafts) },
    legacyPersonalDrafts: { ...local.legacyPersonalDrafts, ...remapDrafts(remote.legacyPersonalDrafts) },
    manuscriptRevisions: [...(local.manuscriptRevisions ?? []), ...(remote.manuscriptRevisions ?? []).map(item => ({
      ...item, id: id(item.id), memberId: id(item.memberId),
    }))],
    importedCloudRooms: [...(local.importedCloudRooms ?? []), source],
  };
}

export async function importLegacyCloud(): Promise<FamilyRoomState> {
  const source = await currentFamilyId();
  const before = loadRoomState();
  if (before.importedCloudRooms?.includes(source)) return before;
  const remote = await loadCloudRoomState({ readOnly: true });
  if (!remote.members.length) throw new Error("旧云端没有可导入的档案；本机内容没有改动");
  // Re-read after network I/O so records written while downloading are retained.
  const latest = loadRoomState();
  const merged = mergeLegacyCloud(latest, remote, source);
  saveRoomState(merged);
  if (!latest.members.length) {
    const profile = merged.members.find(member => member.kind !== "person");
    if (profile) saveCurrentMemberId(profile.id);
  }
  return merged;
}
