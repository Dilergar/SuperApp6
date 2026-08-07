import type {
  DriveListPageDto,
  DriveNodeDetailDto,
  DriveNodeDto,
  DriveOverviewDto,
  DrivePhotoBucketDto,
  DrivePhotoPageDto,
  DriveRole,
  DriveShareDto,
  DriveSpaceRef,
  DriveVersionDto,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './api';

// ============================================================
// Клиент Диска. Пространство адресуется парой необязательных параметров
// (spaceId | workspaceId); без них сервер берёт личный диск зрителя.
// ============================================================

const scope = (ref: DriveSpaceRef): Record<string, string> =>
  ref.workspaceId ? { workspaceId: ref.workspaceId } : ref.spaceId ? { spaceId: ref.spaceId } : {};

export async function fetchDriveOverview(ref: DriveSpaceRef): Promise<DriveOverviewDto> {
  return apiGet<DriveOverviewDto>('/drive', { params: scope(ref) });
}

export async function fetchDriveList(
  ref: DriveSpaceRef,
  opts: { parentId?: string | null; sort?: string; dir?: string; cursor?: string; foldersOnly?: boolean },
): Promise<DriveListPageDto> {
  // DriveListPageDto теперь стоит на ОБЕИХ сторонах: страница едет в `data` цельной,
  // и собирать её обратно руками больше не нужно (тип и был web-only ровно поэтому).
  return apiGet<DriveListPageDto>('/drive/nodes', {
    params: {
      ...scope(ref),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.sort ? { sort: opts.sort } : {}),
      ...(opts.dir ? { dir: opts.dir } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      ...(opts.foldersOnly ? { foldersOnly: true } : {}),
    },
  });
}

export async function fetchDriveNode(id: string): Promise<DriveNodeDetailDto> {
  return apiGet<DriveNodeDetailDto>(`/drive/nodes/${id}`);
}

export async function createDriveFolder(
  ref: DriveSpaceRef,
  input: { parentId?: string | null; name: string },
): Promise<DriveNodeDto> {
  return apiPost<DriveNodeDto>('/drive/folders', {
    ...scope(ref),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    name: input.name,
  });
}

/** Положить на Диск файл, УЖЕ загруженный движком (байты Диск не принимает) */
export async function attachDriveFile(
  ref: DriveSpaceRef,
  input: { parentId?: string | null; fileId: string; name?: string },
): Promise<DriveNodeDto> {
  return apiPost<DriveNodeDto>('/drive/nodes', {
    ...scope(ref),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    fileId: input.fileId,
    ...(input.name ? { name: input.name } : {}),
  });
}

export async function renameDriveNode(id: string, name: string): Promise<DriveNodeDto> {
  return apiPatch<DriveNodeDto>(`/drive/nodes/${id}`, { name });
}

export async function moveDriveNodes(ids: string[], parentId?: string | null): Promise<number> {
  const res = await apiPost<{ moved: number }>('/drive/nodes/move', { ids, ...(parentId ? { parentId } : {}) });
  return res.moved;
}

export async function copyDriveNodes(
  ids: string[],
  ref: DriveSpaceRef,
  parentId?: string | null,
): Promise<{ copied: number; queued: number }> {
  return apiPost<{ copied: number; queued: number }>('/drive/nodes/copy', { ids, ...scope(ref), ...(parentId ? { parentId } : {}) });
}

export async function trashDriveNodes(ids: string[]): Promise<number> {
  const res = await apiPost<{ trashed: number }>('/drive/nodes/trash', { ids });
  return res.trashed;
}

export async function restoreDriveNodes(ids: string[]): Promise<number> {
  const res = await apiPost<{ restored: number }>('/drive/nodes/restore', { ids });
  return res.restored;
}

export async function purgeDriveNodes(ids: string[]): Promise<number> {
  const res = await apiDelete<{ purged: number }>('/drive/nodes', { data: { ids } });
  return res.purged;
}

export async function fetchDriveTrash(ref: DriveSpaceRef, cursor?: string): Promise<DriveListPageDto> {
  return apiGet<DriveListPageDto>('/drive/trash', {
    params: { ...scope(ref), ...(cursor ? { cursor } : {}) },
  });
}

export async function setDriveStar(id: string, on: boolean): Promise<void> {
  if (on) await apiPost(`/drive/nodes/${id}/star`);
  else await apiDelete(`/drive/nodes/${id}/star`);
}

export async function fetchDriveStarred(): Promise<DriveNodeDto[]> {
  return apiGet<DriveNodeDto[]>('/drive/starred');
}

export async function fetchDriveRecent(): Promise<DriveNodeDto[]> {
  return apiGet<DriveNodeDto[]>('/drive/recent');
}

// ---- Доступ ----

export async function fetchDriveShares(id: string): Promise<DriveShareDto[]> {
  return apiGet<DriveShareDto[]>(`/drive/nodes/${id}/shares`);
}

export async function shareDriveNode(
  id: string,
  input: { principalType: string; principalId: string; role: DriveRole },
): Promise<DriveShareDto[]> {
  return apiPost<DriveShareDto[]>(`/drive/nodes/${id}/shares`, input);
}

export async function unshareDriveNode(
  id: string,
  principalType: string,
  principalId: string,
): Promise<DriveShareDto[]> {
  return apiDelete<DriveShareDto[]>(`/drive/nodes/${id}/shares/${principalType}/${principalId}`);
}

// ---- Версии ----

export async function fetchDriveVersions(id: string): Promise<DriveVersionDto[]> {
  return apiGet<DriveVersionDto[]>(`/drive/nodes/${id}/versions`);
}

export async function snapshotDriveVersion(id: string): Promise<DriveVersionDto> {
  return apiPost<DriveVersionDto>(`/drive/nodes/${id}/versions`);
}

export async function restoreDriveVersion(id: string, versionId: string): Promise<number> {
  const res = await apiPost<{ versionNo: number }>(`/drive/nodes/${id}/versions/${versionId}/restore`);
  return res.versionNo;
}

// ---- Лента «Фото» ----

export async function fetchPhotoBuckets(ref: DriveSpaceRef): Promise<DrivePhotoBucketDto[]> {
  return apiGet<DrivePhotoBucketDto[]>('/drive/photos/buckets', { params: scope(ref) });
}

export async function fetchPhotoPage(
  ref: DriveSpaceRef,
  opts: { month?: string; cursor?: string } = {},
): Promise<DrivePhotoPageDto> {
  return apiGet<DrivePhotoPageDto>('/drive/photos', {
    params: {
      ...scope(ref),
      ...(opts.month ? { month: opts.month } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    },
  });
}
