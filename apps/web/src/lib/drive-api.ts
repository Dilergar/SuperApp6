import type {
  DriveListPageDto,
  DriveNodeDetailDto,
  DriveNodeDto,
  DriveOverviewDto,
  DrivePhotoBucketDto,
  DrivePhotoPageDto,
  DriveRole,
  DriveShareDto,
  DriveVersionDto,
} from '@superapp/shared';
import { api } from './api';
import type { DriveRef } from './queries';

// ============================================================
// Клиент Диска. Пространство адресуется парой необязательных параметров
// (spaceId | workspaceId); без них сервер берёт личный диск зрителя.
// ============================================================

const scope = (ref: DriveRef): Record<string, string> =>
  ref.workspaceId ? { workspaceId: ref.workspaceId } : ref.spaceId ? { spaceId: ref.spaceId } : {};

export async function fetchDriveOverview(ref: DriveRef): Promise<DriveOverviewDto> {
  const res = await api.get('/drive', { params: scope(ref) });
  return res.data.data;
}

export async function fetchDriveList(
  ref: DriveRef,
  opts: { parentId?: string | null; sort?: string; dir?: string; cursor?: string; foldersOnly?: boolean },
): Promise<DriveListPageDto> {
  const res = await api.get('/drive/nodes', {
    params: {
      ...scope(ref),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.sort ? { sort: opts.sort } : {}),
      ...(opts.dir ? { dir: opts.dir } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      ...(opts.foldersOnly ? { foldersOnly: true } : {}),
    },
  });
  return { items: res.data.data, nextCursor: res.data.nextCursor ?? null };
}

export async function fetchDriveNode(id: string): Promise<DriveNodeDetailDto> {
  const res = await api.get(`/drive/nodes/${id}`);
  return res.data.data;
}

export async function createDriveFolder(
  ref: DriveRef,
  input: { parentId?: string | null; name: string },
): Promise<DriveNodeDto> {
  const res = await api.post('/drive/folders', {
    ...scope(ref),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    name: input.name,
  });
  return res.data.data;
}

/** Положить на Диск файл, УЖЕ загруженный движком (байты Диск не принимает) */
export async function attachDriveFile(
  ref: DriveRef,
  input: { parentId?: string | null; fileId: string; name?: string },
): Promise<DriveNodeDto> {
  const res = await api.post('/drive/nodes', {
    ...scope(ref),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    fileId: input.fileId,
    ...(input.name ? { name: input.name } : {}),
  });
  return res.data.data;
}

export async function renameDriveNode(id: string, name: string): Promise<DriveNodeDto> {
  const res = await api.patch(`/drive/nodes/${id}`, { name });
  return res.data.data;
}

export async function moveDriveNodes(ids: string[], parentId?: string | null): Promise<number> {
  const res = await api.post('/drive/nodes/move', { ids, ...(parentId ? { parentId } : {}) });
  return res.data.data.moved;
}

export async function copyDriveNodes(
  ids: string[],
  ref: DriveRef,
  parentId?: string | null,
): Promise<{ copied: number; queued: number }> {
  const res = await api.post('/drive/nodes/copy', { ids, ...scope(ref), ...(parentId ? { parentId } : {}) });
  return res.data.data;
}

export async function trashDriveNodes(ids: string[]): Promise<number> {
  const res = await api.post('/drive/nodes/trash', { ids });
  return res.data.data.trashed;
}

export async function restoreDriveNodes(ids: string[]): Promise<number> {
  const res = await api.post('/drive/nodes/restore', { ids });
  return res.data.data.restored;
}

export async function purgeDriveNodes(ids: string[]): Promise<number> {
  const res = await api.delete('/drive/nodes', { data: { ids } });
  return res.data.data.purged;
}

export async function fetchDriveTrash(ref: DriveRef, cursor?: string): Promise<DriveListPageDto> {
  const res = await api.get('/drive/trash', { params: { ...scope(ref), ...(cursor ? { cursor } : {}) } });
  return { items: res.data.data, nextCursor: res.data.nextCursor ?? null };
}

export async function setDriveStar(id: string, on: boolean): Promise<void> {
  if (on) await api.post(`/drive/nodes/${id}/star`);
  else await api.delete(`/drive/nodes/${id}/star`);
}

export async function fetchDriveStarred(): Promise<DriveNodeDto[]> {
  const res = await api.get('/drive/starred');
  return res.data.data;
}

export async function fetchDriveRecent(): Promise<DriveNodeDto[]> {
  const res = await api.get('/drive/recent');
  return res.data.data;
}

// ---- Доступ ----

export async function fetchDriveShares(id: string): Promise<DriveShareDto[]> {
  const res = await api.get(`/drive/nodes/${id}/shares`);
  return res.data.data;
}

export async function shareDriveNode(
  id: string,
  input: { principalType: string; principalId: string; role: DriveRole },
): Promise<DriveShareDto[]> {
  const res = await api.post(`/drive/nodes/${id}/shares`, input);
  return res.data.data;
}

export async function unshareDriveNode(
  id: string,
  principalType: string,
  principalId: string,
): Promise<DriveShareDto[]> {
  const res = await api.delete(`/drive/nodes/${id}/shares/${principalType}/${principalId}`);
  return res.data.data;
}

// ---- Версии ----

export async function fetchDriveVersions(id: string): Promise<DriveVersionDto[]> {
  const res = await api.get(`/drive/nodes/${id}/versions`);
  return res.data.data;
}

export async function snapshotDriveVersion(id: string): Promise<DriveVersionDto> {
  const res = await api.post(`/drive/nodes/${id}/versions`);
  return res.data.data;
}

export async function restoreDriveVersion(id: string, versionId: string): Promise<number> {
  const res = await api.post(`/drive/nodes/${id}/versions/${versionId}/restore`);
  return res.data.data.versionNo;
}

// ---- Лента «Фото» ----

export async function fetchPhotoBuckets(ref: DriveRef): Promise<DrivePhotoBucketDto[]> {
  const res = await api.get('/drive/photos/buckets', { params: scope(ref) });
  return res.data.data;
}

export async function fetchPhotoPage(
  ref: DriveRef,
  opts: { month?: string; cursor?: string } = {},
): Promise<DrivePhotoPageDto> {
  const res = await api.get('/drive/photos', {
    params: { ...scope(ref), ...(opts.month ? { month: opts.month } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}) },
  });
  return res.data.data;
}
