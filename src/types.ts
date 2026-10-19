import type * as MediaLibrary from 'expo-media-library/legacy';

export type LibraryAsset = Pick<
  MediaLibrary.Asset,
  'id' | 'uri' | 'filename' | 'mediaType' | 'width' | 'height' | 'creationTime'
>;

export type PhotoDecision = 'kept' | 'markedForDeletion' | 'deleted';

export type UndoEntry = {
  assetId: string;
  previousDecision?: PhotoDecision;
  wasSkipped: boolean;
};

export type ReviewSession = {
  assets: LibraryAsset[];
  decisions: Record<string, PhotoDecision>;
  skippedIds: string[];
  undoHistory: UndoEntry[];
  endCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
  updatedAt: number;
};

export type AppRoute =
  | 'welcome'
  | 'swipe'
  | 'pending'
  | 'summary'
  | 'confirm'
  | 'complete'
  | 'settings';
