import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReviewSession } from './types';

const SESSION_KEY = '@swipeclean/review-session-v1';

export async function loadReviewSession(): Promise<ReviewSession | null> {
  const saved = await AsyncStorage.getItem(SESSION_KEY);
  if (!saved) return null;

  const parsed: unknown = JSON.parse(saved);
  if (!isReviewSession(parsed)) {
    await AsyncStorage.removeItem(SESSION_KEY);
    return null;
  }
  return parsed;
}

export function saveReviewSession(session: ReviewSession) {
  return AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearReviewSession() {
  return AsyncStorage.removeItem(SESSION_KEY);
}

function isReviewSession(value: unknown): value is ReviewSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<ReviewSession>;
  const decisions = session.decisions;
  const validDecision = (decision: unknown) =>
    decision === 'kept' || decision === 'markedForDeletion' || decision === 'deleted';
  return (
    Array.isArray(session.assets) &&
    session.assets.every(
      (asset) =>
        !!asset &&
        typeof asset.id === 'string' &&
        typeof asset.uri === 'string' &&
        typeof asset.filename === 'string' &&
        typeof asset.mediaType === 'string' &&
        typeof asset.width === 'number' &&
        typeof asset.height === 'number' &&
        typeof asset.creationTime === 'number',
    ) &&
    !!decisions &&
    typeof decisions === 'object' &&
    Object.values(decisions).every(validDecision) &&
    Array.isArray(session.skippedIds) &&
    session.skippedIds.every((id) => typeof id === 'string') &&
    Array.isArray(session.undoHistory) &&
    session.undoHistory.every(
      (entry) =>
        !!entry &&
        typeof entry.assetId === 'string' &&
        typeof entry.wasSkipped === 'boolean' &&
        (entry.previousDecision === undefined || validDecision(entry.previousDecision)),
    ) &&
    (typeof session.endCursor === 'string' || session.endCursor === null) &&
    typeof session.hasNextPage === 'boolean' &&
    typeof session.totalCount === 'number' &&
    Number.isFinite(session.totalCount) &&
    session.totalCount >= 0
  );
}
