import * as MediaLibrary from 'expo-media-library/legacy';
import type { LibraryAsset } from './types';

export const PAGE_SIZE = 60;

export function requestPhotoPermission() {
  return MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
}

export function getPhotoPermission() {
  return MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
}

export async function getPhotoPage(after?: string | null) {
  const page = await MediaLibrary.getAssetsAsync({
    first: PAGE_SIZE,
    after: after ?? undefined,
    mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  });

  return {
    assets: page.assets.map(toLibraryAsset),
    endCursor: page.endCursor || null,
    hasNextPage: page.hasNextPage,
    totalCount: page.totalCount,
  };
}

export function toLibraryAsset(asset: MediaLibrary.Asset): LibraryAsset {
  return {
    id: asset.id,
    uri: asset.uri,
    filename: asset.filename,
    mediaType: asset.mediaType,
    width: asset.width,
    height: asset.height,
    creationTime: asset.creationTime,
  };
}

export function watchPhotoLibrary(onChange: (deletedIds: string[], inserted: LibraryAsset[]) => void) {
  return MediaLibrary.addListener((event) => {
    onChange(
      event.hasIncrementalChanges ? event.deletedAssets?.map((asset) => asset.id) ?? [] : [],
      event.insertedAssets?.map(toLibraryAsset) ?? [],
    );
  });
}

export async function requestDeleteAssets(assetIds: string[]) {
  return MediaLibrary.deleteAssetsAsync(assetIds);
}

export async function openLimitedAccessPicker() {
  return MediaLibrary.presentPermissionsPickerAsync(['photo', 'video']);
}

export async function refreshAssetUri(assetId: string) {
  const asset = await MediaLibrary.getAssetInfoAsync(assetId, {
    shouldDownloadFromNetwork: false,
  });
  return asset.localUri ?? asset.uri;
}

export async function countCurrentLibraryAssets() {
  const page = await MediaLibrary.getAssetsAsync({
    first: 1,
    mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
  });
  return page.totalCount;
}
