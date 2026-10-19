import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  countCurrentLibraryAssets,
  getPhotoPage,
  getPhotoPermission,
  openLimitedAccessPicker,
  refreshAssetUri,
  requestDeleteAssets,
  requestPhotoPermission,
  watchPhotoLibrary,
} from './src/photoLibrary';
import { clearReviewSession, loadReviewSession, saveReviewSession } from './src/sessionStorage';
import type { AppRoute, LibraryAsset, PhotoDecision, ReviewSession } from './src/types';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const COLORS = {
  background: '#090B0D',
  panel: '#121619',
  panelRaised: '#1A2023',
  border: '#252D30',
  text: '#F4F6F5',
  muted: '#929C9F',
  green: '#53D69A',
  red: '#FF7474',
  gold: '#F3C977',
};

const EMPTY_SESSION: ReviewSession = {
  assets: [],
  decisions: {},
  skippedIds: [],
  undoHistory: [],
  endCursor: null,
  hasNextPage: false,
  totalCount: 0,
  updatedAt: Date.now(),
};

export default function App() {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const sessionRef = useRef<ReviewSession | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const busyRef = useRef(false);
  const loadingPageRef = useRef(false);
  const routeBeforeSettings = useRef<AppRoute>('welcome');
  const [route, setRoute] = useState<AppRoute>('welcome');
  const [permission, setPermission] = useState<'all' | 'limited' | 'none'>('none');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState('');
  const [libraryMessage, setLibraryMessage] = useState('');
  const [failedAssetId, setFailedAssetId] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
  const [deletionResult, setDeletionResult] = useState(0);

  const commitSession = useCallback((next: ReviewSession) => {
    const updated = { ...next, updatedAt: Date.now() };
    sessionRef.current = updated;
    setSession(updated);
    setSaving(true);
    saveQueue.current = saveQueue.current
      .then(() => saveReviewSession(updated))
      .catch((error: unknown) => {
        setNotice(`Your session could not be saved: ${errorMessage(error)}`);
      })
      .finally(() => setSaving(false));
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const permissionResponse = await getPhotoPermission();
        if (!mounted) return;
        setPermission(permissionResponse.granted ? (permissionResponse.accessPrivileges ?? 'all') : 'none');
        if (permissionResponse.granted) {
          const saved = await loadReviewSession();
          if (!mounted) return;
          if (saved) {
            sessionRef.current = saved;
            setSession(saved);
            setRoute(saved.assets.length ? 'swipe' : 'welcome');
          }
        }
      } catch (error) {
        if (mounted) setNotice(`We couldn't restore your session: ${errorMessage(error)}`);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void getPhotoPermission()
        .then((response) => {
          const access = response.granted ? (response.accessPrivileges ?? 'all') : 'none';
          setPermission(access);
          if (access === 'none') {
            setNotice('Photo access changed. Your saved session is safe; allow access again to continue.');
            setRoute('welcome');
          }
        })
        .catch((error: unknown) =>
          setNotice(`Photo access couldn't be refreshed: ${errorMessage(error)}`),
        );
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = watchPhotoLibrary((deletedIds, inserted) => {
      const current = sessionRef.current;
      if (!current) return;
      const deleted = new Set(deletedIds);
      const existing = new Set(current.assets.map((asset) => asset.id));
      const newAssets = inserted.filter((asset) => !existing.has(asset.id));
      const decisions = { ...current.decisions };
      for (const id of deletedIds) {
        if (decisions[id]) decisions[id] = 'deleted';
      }
      const next = {
        ...current,
        assets: [...newAssets, ...current.assets.filter((asset) => !deleted.has(asset.id))],
        decisions,
        skippedIds: current.skippedIds.filter((id) => !deleted.has(id)),
        undoHistory: current.undoHistory.filter((entry) => !deleted.has(entry.assetId)),
        totalCount: Math.max(0, current.totalCount + inserted.length - deletedIds.length),
      };
      commitSession(next);
      setLibraryMessage('Your photo library changed. SwipeClean updated this session.');
      void countCurrentLibraryAssets()
        .then((totalCount) => {
          const latest = sessionRef.current;
          if (latest) commitSession({ ...latest, totalCount });
        })
        .catch((error: unknown) => setNotice(`Library count could not be refreshed: ${errorMessage(error)}`));
    });
    return () => subscription.remove();
  }, [commitSession]);

  const currentAsset = useMemo(() => {
    if (!session) return null;
    const skipped = new Set(session.skippedIds);
    return (
      session.assets.find((asset) => !session.decisions[asset.id] && !skipped.has(asset.id)) ??
      null
    );
  }, [session]);

  const pendingAssets = useMemo(
    () =>
      session?.assets.filter((asset) => session.decisions[asset.id] === 'markedForDeletion') ?? [],
    [session],
  );
  const keptCount = useMemo(
    () => Object.values(session?.decisions ?? {}).filter((decision) => decision === 'kept').length,
    [session],
  );
  const loadNextPage = useCallback(async () => {
    const current = sessionRef.current;
    if (!current?.hasNextPage || loadingPageRef.current) return;
    loadingPageRef.current = true;
    setLoading(true);
    try {
      const page = await getPhotoPage(current.endCursor);
      const latest = sessionRef.current ?? current;
      const existingIds = new Set(latest.assets.map((asset) => asset.id));
      commitSession({
        ...latest,
        assets: [...latest.assets, ...page.assets.filter((asset) => !existingIds.has(asset.id))],
        endCursor: page.endCursor,
        hasNextPage: page.hasNextPage,
        totalCount: page.totalCount,
      });
    } catch (error) {
      setNotice(`We couldn't load more photos: ${errorMessage(error)}`);
    } finally {
      loadingPageRef.current = false;
      setLoading(false);
    }
  }, [commitSession]);

  useEffect(() => {
    if (route !== 'swipe' || !session) return;
    if (!currentAsset && session.hasNextPage) {
      void loadNextPage();
    } else if (!currentAsset && !session.hasNextPage && session.assets.length > 0) {
      setRoute('summary');
    }
  }, [currentAsset, loadNextPage, route, session]);

  useEffect(() => {
    if (!currentAsset) {
      setFailedAssetId(null);
      return;
    }
    setFailedAssetId(null);
    let active = true;
    void refreshAssetUri(currentAsset.id)
      .then((uri) => {
        if (!active) return;
        const latest = sessionRef.current;
        if (!latest) return;
        const asset = latest.assets.find((item) => item.id === currentAsset.id);
        if (asset && asset.uri !== uri) {
          commitSession({
            ...latest,
            assets: latest.assets.map((item) =>
              item.id === currentAsset.id ? { ...item, uri } : item,
            ),
          });
        }
      })
      .catch(() => {
        if (active) setFailedAssetId(currentAsset.id);
      });
    return () => {
      active = false;
    };
  }, [commitSession, currentAsset]);

  const beginReview = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setNotice('');
    setLoading(true);
    try {
      const permissionResponse = await requestPhotoPermission();
      setPermission(permissionResponse.granted ? (permissionResponse.accessPrivileges ?? 'all') : 'none');
      if (!permissionResponse.granted) {
        setNotice('Photo access is needed to show your library. You can enable it in Settings at any time.');
        return;
      }
      const page = await getPhotoPage();
      const newSession: ReviewSession = {
        ...EMPTY_SESSION,
        assets: page.assets,
        endCursor: page.endCursor,
        hasNextPage: page.hasNextPage,
        totalCount: page.totalCount,
      };
      commitSession(newSession);
      setRoute('swipe');
    } catch (error) {
      setNotice(`We couldn't open your photo library: ${errorMessage(error)}`);
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  }, [commitSession]);

  const resumeSession = useCallback(async () => {
    if (permission !== 'none') {
      setRoute('swipe');
      return;
    }
    try {
      const currentPermission = await getPhotoPermission();
      const response = currentPermission.granted
        ? currentPermission
        : await requestPhotoPermission();
      setPermission(response.granted ? (response.accessPrivileges ?? 'all') : 'none');
      if (response.granted) setRoute('swipe');
      else setNotice('Photo access is needed to continue. You can enable it in Settings at any time.');
    } catch (error) {
      setNotice(`Photo access couldn't be checked: ${errorMessage(error)}`);
    }
  }, [permission]);

  const actOnCurrent = useCallback(
    (action: 'kept' | 'markedForDeletion' | 'skipped') => {
      if (busyRef.current) return;
      const current = sessionRef.current;
      const asset = current?.assets.find(
        (item) =>
          !current.decisions[item.id] &&
          !current.skippedIds.includes(item.id),
      );
      if (!current || !asset) return;
      busyRef.current = true;
      const entry = {
        assetId: asset.id,
        previousDecision: current.decisions[asset.id],
        wasSkipped: current.skippedIds.includes(asset.id),
      };
      if (action === 'skipped') {
        commitSession({
          ...current,
          skippedIds: [...current.skippedIds, asset.id],
          undoHistory: [...current.undoHistory, entry].slice(-100),
        });
        void Haptics.selectionAsync();
      } else {
        commitSession({
          ...current,
          decisions: { ...current.decisions, [asset.id]: action },
          skippedIds: current.skippedIds.filter((id) => id !== asset.id),
          undoHistory: [...current.undoHistory, entry].slice(-100),
        });
        void Haptics.impactAsync(action === 'kept' ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium);
      }
      setFailedAssetId(null);
      setTimeout(() => {
        busyRef.current = false;
      }, 240);
    },
    [commitSession],
  );

  const undo = useCallback(() => {
    if (busyRef.current) return;
    const current = sessionRef.current;
    const entry = current?.undoHistory.at(-1);
    if (!current || !entry) return;
    const decisions = { ...current.decisions };
    if (entry.previousDecision) decisions[entry.assetId] = entry.previousDecision;
    else delete decisions[entry.assetId];
    const skippedIds = new Set(current.skippedIds);
    if (entry.wasSkipped) skippedIds.add(entry.assetId);
    else skippedIds.delete(entry.assetId);
    commitSession({
      ...current,
      decisions,
      skippedIds: [...skippedIds],
      undoHistory: current.undoHistory.slice(0, -1),
    });
    setRoute('swipe');
    void Haptics.selectionAsync();
  }, [commitSession]);

  const removeFromDeletionQueue = useCallback(
    (asset: LibraryAsset) => {
      const current = sessionRef.current;
      if (!current) return;
      const decisions = { ...current.decisions };
      delete decisions[asset.id];
      commitSession({
        ...current,
        decisions,
        undoHistory: [
          ...current.undoHistory,
          { assetId: asset.id, previousDecision: 'markedForDeletion' as const, wasSkipped: false },
        ].slice(-100),
      });
      setPreviewAsset(null);
    },
    [commitSession],
  );

  const confirmDeletion = useCallback(async () => {
    if (deleting || pendingAssets.length === 0) return;
    const ids = pendingAssets.map((asset) => asset.id);
    setDeleting(true);
    setNotice('');
    try {
      const succeeded = await requestDeleteAssets(ids);
      if (!succeeded) {
        setNotice('No deletion was confirmed. Your photos are still in the library and remain in the pending list.');
        return;
      }
      const current = sessionRef.current;
      if (current) {
        const decisions = { ...current.decisions };
        const deletedIds = new Set(ids);
        for (const id of ids) decisions[id] = 'deleted';
        commitSession({
          ...current,
          decisions,
          skippedIds: current.skippedIds.filter((id) => !deletedIds.has(id)),
          undoHistory: current.undoHistory.filter((entry) => !deletedIds.has(entry.assetId)),
        });
      }
      setDeletionResult(ids.length);
      setRoute('complete');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setNotice(`The deletion request failed. Your pending list is unchanged. ${errorMessage(error)}`);
    } finally {
      setDeleting(false);
    }
  }, [commitSession, deleting, pendingAssets]);

  const openSettings = (from: AppRoute) => {
    routeBeforeSettings.current = from;
    setRoute('settings');
  };

  const manageSelectedPhotos = async () => {
    try {
      await openLimitedAccessPicker();
      const permissionResponse = await getPhotoPermission();
      setPermission(permissionResponse.granted ? (permissionResponse.accessPrivileges ?? 'all') : 'none');
      setLibraryMessage('Photo access was updated. Your saved decisions are still here.');
    } catch (error) {
      setNotice(`Photo access couldn't be changed: ${errorMessage(error)}`);
    }
  };

  const resetSession = () => {
    Alert.alert(
      'Reset this session?',
      'This clears your review progress and pending selections. It will not delete any photos.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset session',
          style: 'destructive',
          onPress: () => {
            saveQueue.current = saveQueue.current
              .then(() => clearReviewSession())
              .then(() => {
                sessionRef.current = null;
                setSession(null);
                setRoute('welcome');
                setNotice('');
              })
              .catch((error: unknown) =>
                setNotice(`The session couldn't be reset: ${errorMessage(error)}`),
              );
          },
        },
      ],
    );
  };

  const reviewed = session
    ? Object.keys(session.decisions).length + session.skippedIds.length
    : 0;
  const progress = session?.totalCount
    ? Math.min(reviewed / session.totalCount, 1)
    : 0;

  if (loading && !session && route === 'welcome') {
    return (
      <SafeAreaProvider>
        <View style={styles.loadingScreen}>
          <ActivityIndicator color={COLORS.green} size="large" />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <StatusBar style="light" />
        <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
          {route === 'welcome' && (
            <WelcomeScreen
              permission={permission}
              loading={loading}
              notice={notice}
              onStart={beginReview}
              hasSession={!!session?.assets.length}
              canStartNewSession={
                !!session?.assets.length &&
                pendingAssets.length === 0 &&
                !currentAsset &&
                session.skippedIds.length === 0 &&
                !session.hasNextPage
              }
              onResume={resumeSession}
              onNewSession={beginReview}
              onSettings={() => openSettings('welcome')}
            />
          )}
          {route === 'swipe' && (
            <SwipeScreen
              asset={currentAsset}
              failedAsset={failedAssetId === currentAsset?.id}
              session={session ?? EMPTY_SESSION}
              pendingCount={pendingAssets.length}
              reviewed={reviewed}
              progress={progress}
              loading={loading}
              saving={saving}
              libraryMessage={libraryMessage}
              onAction={actOnCurrent}
              onUndo={undo}
              onPending={() => setRoute('pending')}
              onSummary={() => setRoute('summary')}
              onSettings={() => openSettings('swipe')}
              onLoad={() => {
                if (sessionRef.current?.hasNextPage) void loadNextPage();
                else void beginReview();
              }}
              onImageError={(id) => setFailedAssetId(id)}
              onRetryImage={() => setFailedAssetId(null)}
            />
          )}
          {route === 'pending' && (
            <PendingScreen
              assets={pendingAssets}
              notice={notice}
              onBack={() => setRoute('swipe')}
              onPreview={setPreviewAsset}
              onContinue={() => {
                setNotice('');
                setRoute('confirm');
              }}
            />
          )}
          {route === 'summary' && (
            <SummaryScreen
              session={session ?? EMPTY_SESSION}
              kept={keptCount}
              pending={pendingAssets.length}
              reviewed={reviewed}
              onContinue={() => {
                const current = sessionRef.current;
                if (current?.skippedIds.length) {
                  commitSession({ ...current, skippedIds: [] });
                  setRoute('swipe');
                } else if (pendingAssets.length) {
                  setRoute('pending');
                } else {
                  setRoute('complete');
                  setDeletionResult(0);
                }
              }}
              onPending={() => setRoute('pending')}
              onFinish={() => {
                setDeletionResult(0);
                setRoute('complete');
              }}
            />
          )}
          {route === 'confirm' && (
            <ConfirmScreen
              assets={pendingAssets}
              notice={notice}
              deleting={deleting}
              onBack={() => setRoute('pending')}
              onCancel={() => setRoute('swipe')}
              onPreview={setPreviewAsset}
              onConfirm={() => void confirmDeletion()}
            />
          )}
          {route === 'complete' && (
            <CompletionScreen
              deleted={deletionResult}
              kept={keptCount}
              pending={pendingAssets.length}
              onContinue={() => setRoute('swipe')}
              onPending={() => setRoute('pending')}
              onHome={() => {
                setRoute('welcome');
              }}
            />
          )}
          {route === 'settings' && (
            <SettingsScreen
              permission={permission}
              notice={notice}
              onBack={() => {
                setNotice('');
                setRoute(routeBeforeSettings.current);
              }}
              onOpenSettings={() => {
                void Linking.openSettings().catch((error: unknown) =>
                  setNotice(`iPhone Settings couldn't be opened: ${errorMessage(error)}`),
                );
              }}
              onManage={manageSelectedPhotos}
              onReset={resetSession}
            />
          )}
          {previewAsset && (
            <PreviewModal
              asset={previewAsset}
              isPending={session?.decisions[previewAsset.id] === 'markedForDeletion'}
              onClose={() => setPreviewAsset(null)}
              onRemove={() => removeFromDeletionQueue(previewAsset)}
            />
          )}
        </SafeAreaView>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

function WelcomeScreen({
  permission,
  loading,
  notice,
  hasSession,
  canStartNewSession,
  onStart,
  onResume,
  onNewSession,
  onSettings,
}: {
  permission: 'all' | 'limited' | 'none';
  loading: boolean;
  notice: string;
  hasSession: boolean;
  canStartNewSession: boolean;
  onStart: () => void;
  onResume: () => void;
  onNewSession: () => void;
  onSettings: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.welcomeScreen}>
      <View style={styles.welcomeTop}>
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" style={styles.iconButton} onPress={onSettings}>
          <MaterialCommunityIcons name="cog-outline" size={22} color={COLORS.muted} />
        </Pressable>
        <View style={styles.brandMark}>
          <MaterialCommunityIcons name="image-multiple-outline" size={25} color={COLORS.green} />
        </View>
      </View>
      <View style={styles.welcomeCopy}>
        <Text style={styles.eyebrow}>A LITTLE SPACE TO BREATHE</Text>
        <Text style={styles.heroTitle}>A calmer{'\n'}camera roll.</Text>
        <Text style={styles.bodyCopy}>
          One photo at a time. Keep the moments you love, set aside the ones you don't.
        </Text>
      </View>
      <View style={styles.howCard}>
        <HowRow icon="arrow-left" tint={COLORS.red} title="Swipe left" detail="Mark for deletion" />
        <HowRow icon="arrow-right" tint={COLORS.green} title="Swipe right" detail="Keep it" />
        <HowRow icon="arrow-up" tint={COLORS.gold} title="Swipe up" detail="Come back to it later" />
      </View>
      <View style={styles.privacyNote}>
        <MaterialCommunityIcons name="shield-check-outline" size={19} color={COLORS.green} />
        <Text style={styles.privacyText}>
          Nothing is deleted until you review your picks and confirm. Your library stays on your device.
        </Text>
      </View>
      {permission === 'limited' && (
        <Text style={styles.inlineMuted}>You currently have access to selected photos only.</Text>
      )}
      {notice ? <Notice text={notice} /> : null}
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        onPress={hasSession ? onResume : onStart}
        disabled={loading}
      >
        {loading ? <ActivityIndicator color={COLORS.background} /> : (
          <>
            <Text style={styles.primaryButtonText}>{hasSession ? 'Continue session' : 'Start cleaning'}</Text>
            <MaterialCommunityIcons name="arrow-right" size={20} color={COLORS.background} />
          </>
        )}
      </Pressable>
      {canStartNewSession && (
        <Pressable style={styles.textButton} onPress={onNewSession}>
          <Text style={styles.subtleLink}>Start a new review</Text>
        </Pressable>
      )}
      <Text style={styles.footnote}>Free to use · No account · No uploads</Text>
    </ScrollView>
  );
}

function HowRow({ icon, tint, title, detail }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; tint: string; title: string; detail: string }) {
  return (
    <View style={styles.howRow}>
      <View style={[styles.howIcon, { backgroundColor: `${tint}18` }]}>
        <MaterialCommunityIcons name={icon} size={18} color={tint} />
      </View>
      <Text style={styles.howTitle}>{title}</Text>
      <Text style={styles.howDetail}>{detail}</Text>
    </View>
  );
}

function SwipeScreen({
  asset,
  failedAsset,
  session,
  pendingCount,
  reviewed,
  progress,
  loading,
  saving,
  libraryMessage,
  onAction,
  onUndo,
  onPending,
  onSummary,
  onSettings,
  onLoad,
  onImageError,
  onRetryImage,
}: {
  asset: LibraryAsset | null;
  failedAsset: boolean;
  session: ReviewSession;
  pendingCount: number;
  reviewed: number;
  progress: number;
  loading: boolean;
  saving: boolean;
  libraryMessage: string;
  onAction: (action: 'kept' | 'markedForDeletion' | 'skipped') => void;
  onUndo: () => void;
  onPending: () => void;
  onSummary: () => void;
  onSettings: () => void;
  onLoad: () => void;
  onImageError: (assetId: string) => void;
  onRetryImage: () => void;
}) {
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const swipeCommitted = useSharedValue(false);
  const [acting, setActing] = useState(false);
  const screenHeight = SCREEN_HEIGHT;
  const decide = useCallback((action: 'kept' | 'markedForDeletion' | 'skipped') => {
    if (acting) return;
    setActing(true);
    onAction(action);
    setTimeout(() => setActing(false), 240);
  }, [acting, onAction]);
  const gesture = Gesture.Pan()
    .enabled(!acting)
    .onBegin(() => {
      swipeCommitted.value = false;
    })
    .activeOffsetX([-10, 10])
    .activeOffsetY([-10, 10])
    .onUpdate((event) => {
      offsetX.value = event.translationX;
      offsetY.value = event.translationY;
    })
    .onEnd((event) => {
      const leftRight = Math.abs(event.translationX) > SCREEN_WIDTH * 0.23 || Math.abs(event.velocityX) > 850;
      const up = event.translationY < -95 || event.velocityY < -850;
      if (up && (!leftRight || Math.abs(event.translationY) > Math.abs(event.translationX))) {
        swipeCommitted.value = true;
        runOnJS(decide)('skipped');
        offsetY.value = withSpring(-screenHeight);
      } else if (leftRight) {
        const direction = event.translationX || event.velocityX;
        const action = direction > 0 ? 'kept' : 'markedForDeletion';
        swipeCommitted.value = true;
        runOnJS(decide)(action);
        offsetX.value = withSpring(direction > 0 ? SCREEN_WIDTH : -SCREEN_WIDTH);
      } else {
        offsetX.value = withSpring(0);
        offsetY.value = withSpring(0);
      }
    })
    .onFinalize(() => {
      if (!swipeCommitted.value) {
        offsetX.value = withSpring(0);
        offsetY.value = withSpring(0);
      }
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: offsetX.value },
      { translateY: offsetY.value },
      { rotate: `${interpolate(offsetX.value, [-SCREEN_WIDTH, 0, SCREEN_WIDTH], [-11, 0, 11], Extrapolation.CLAMP)}deg` },
      { scale: interpolate(Math.abs(offsetX.value) + Math.abs(offsetY.value), [0, 450], [1, 0.94], Extrapolation.CLAMP) },
    ],
  }));
  const keepOverlayStyle = useAnimatedStyle(() => ({
    opacity: interpolate(offsetX.value, [0, 100], [0, 1], Extrapolation.CLAMP),
  }));
  const deleteOverlayStyle = useAnimatedStyle(() => ({
    opacity: interpolate(offsetX.value, [-100, 0], [1, 0], Extrapolation.CLAMP),
  }));
  const undoAvailable = session.undoHistory.length > 0;

  useEffect(() => {
    offsetX.value = 0;
    offsetY.value = 0;
    setActing(false);
  }, [asset?.id, offsetX, offsetY]);

  if (!asset && !loading && !session.assets.length) {
    return (
      <View style={styles.centerScreen}>
        <TopBar onPending={onPending} onSettings={onSettings} pendingCount={pendingCount} />
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIcon}><MaterialCommunityIcons name="image-off-outline" size={34} color={COLORS.muted} /></View>
          <Text style={styles.sectionTitle}>Your camera roll is quiet.</Text>
          <Text style={styles.bodyCopy}>No photos or videos are available yet. You can try again after adding some to your library.</Text>
          <Pressable style={styles.secondaryButton} onPress={onLoad}><Text style={styles.secondaryButtonText}>Try again</Text></Pressable>
        </View>
      </View>
    );
  }

  if (!asset && !loading && session.assets.length > 0) {
    return (
      <View style={styles.centerScreen}>
        <ActivityIndicator color={COLORS.green} />
        <Text style={styles.inlineMuted}>Wrapping up your review…</Text>
      </View>
    );
  }

  return (
    <View style={styles.swipeScreen}>
      <TopBar onPending={onPending} onSettings={onSettings} pendingCount={pendingCount} />
      <View style={styles.progressArea}>
        <View style={styles.progressTextRow}>
          <Text style={styles.progressText}>
            {session.totalCount ? `${Math.min(reviewed + 1, session.totalCount)} of ${session.totalCount}` : 'Preparing your library'}
          </Text>
          <Text style={styles.progressAside}>{reviewed} reviewed</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.max(progress * 100, session.totalCount ? 0.8 : 0)}%` }]} />
        </View>
      </View>
      {libraryMessage ? (
        <Pressable style={styles.libraryBanner} onPress={() => {}}>
          <MaterialCommunityIcons name="information-outline" size={16} color={COLORS.green} />
          <Text style={styles.libraryBannerText}>{libraryMessage}</Text>
        </Pressable>
      ) : null}
      <View style={styles.cardStage}>
        {asset ? (
          <GestureDetector gesture={gesture}>
            <Animated.View style={[styles.photoCard, cardStyle]}>
              {!failedAsset ? (
                <Image
                  source={{ uri: asset.uri }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="contain"
                  transition={160}
                  cachePolicy="memory"
                  onError={() => onImageError(asset.id)}
                />
              ) : (
                <Pressable style={styles.photoUnavailable} onPress={onRetryImage}>
                  <MaterialCommunityIcons name="image-off-outline" size={36} color={COLORS.muted} />
                  <Text style={styles.inlineMuted}>This photo isn't available right now.</Text>
                  <Text style={styles.inlineMuted}>Tap to try again, or skip it.</Text>
                </Pressable>
              )}
              {asset.mediaType === 'video' && (
                <View style={styles.videoBadge}>
                  <MaterialCommunityIcons name="play" size={15} color={COLORS.text} />
                  <Text style={styles.videoLabel}>VIDEO</Text>
                </View>
              )}
              <Animated.View pointerEvents="none" style={[styles.swipeLabel, styles.keepLabel, keepOverlayStyle]}>
                <Text style={[styles.swipeLabelText, { color: COLORS.green }]}>KEEP</Text>
              </Animated.View>
              <Animated.View pointerEvents="none" style={[styles.swipeLabel, styles.deleteLabel, deleteOverlayStyle]}>
                <Text style={[styles.swipeLabelText, { color: COLORS.red }]}>DELETE</Text>
              </Animated.View>
              <View style={styles.photoFooter}>
                <View style={styles.datePill}>
                  <MaterialCommunityIcons name="calendar-blank-outline" size={14} color={COLORS.text} />
                  <Text style={styles.dateText}>{formatCaptureDate(asset.creationTime)}</Text>
                </View>
              </View>
            </Animated.View>
          </GestureDetector>
        ) : (
          <View style={styles.photoCardLoading}><ActivityIndicator size="large" color={COLORS.green} /></View>
        )}
      </View>
      <View style={styles.controlsArea}>
        <View style={styles.actionLabels}>
          <Text style={[styles.actionHint, { color: COLORS.red }]}>DELETE</Text>
          <Text style={styles.actionHint}>SWIPE TO DECIDE</Text>
          <Text style={[styles.actionHint, { color: COLORS.green }]}>KEEP</Text>
        </View>
        <View style={styles.controlsRow}>
          <RoundControl icon="undo-variant" label="Undo last action" onPress={onUndo} disabled={!undoAvailable} small />
          <RoundControl icon="close" label="Mark for deletion" onPress={() => decide('markedForDeletion')} tint={COLORS.red} disabled={acting} />
          <RoundControl icon="arrow-up" label="Skip this photo" onPress={() => decide('skipped')} tint={COLORS.gold} small disabled={acting} />
          <RoundControl icon="check" label="Keep this photo" onPress={() => decide('kept')} tint={COLORS.green} disabled={acting} />
        </View>
        <View style={styles.bottomMeta}>
          <Text style={styles.subtleMeta}>{saving ? 'Saving…' : `${pendingCount} marked for deletion`}</Text>
          <Pressable accessibilityRole="button" onPress={onSummary}>
            <Text style={styles.subtleLink}>Session summary</Text>
          </Pressable>
        </View>
      </View>
      {loading && asset ? <ActivityIndicator style={styles.pageLoader} size="small" color={COLORS.muted} /> : null}
    </View>
  );
}

function TopBar({ onPending, onSettings, pendingCount }: { onPending: () => void; onSettings: () => void; pendingCount: number }) {
  return (
    <View style={styles.topBar}>
      <View style={styles.topBrand}>
        <View style={styles.brandMarkSmall}><MaterialCommunityIcons name="image-multiple-outline" size={17} color={COLORS.green} /></View>
        <Text style={styles.brandName}>SwipeClean</Text>
      </View>
      <View style={styles.topActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${pendingCount} photos pending deletion`} style={styles.pendingButton} onPress={onPending}>
          <MaterialCommunityIcons name="trash-can-outline" size={18} color={COLORS.red} />
          <Text style={styles.pendingCount}>{pendingCount}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" style={styles.iconButton} onPress={onSettings}>
          <MaterialCommunityIcons name="cog-outline" size={21} color={COLORS.muted} />
        </Pressable>
      </View>
    </View>
  );
}

function RoundControl({
  icon,
  label,
  onPress,
  tint = COLORS.text,
  small = false,
  disabled = false,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  onPress: () => void;
  tint?: string;
  small?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.roundControl,
        small && styles.roundControlSmall,
        { borderColor: `${tint}38` },
        disabled && styles.disabledControl,
        pressed && styles.pressed,
      ]}
    >
      <MaterialCommunityIcons name={icon} size={small ? 20 : 25} color={disabled ? '#51595B' : tint} />
    </Pressable>
  );
}

function PendingScreen({
  assets,
  notice,
  onBack,
  onPreview,
  onContinue,
}: {
  assets: LibraryAsset[];
  notice: string;
  onBack: () => void;
  onPreview: (asset: LibraryAsset) => void;
  onContinue: () => void;
}) {
  return (
    <View style={styles.pageScreen}>
      <PageHeader title="Set aside" subtitle={`${assets.length} ${assets.length === 1 ? 'photo' : 'photos'} · Not deleted yet`} onBack={onBack} />
      {notice ? <Notice text={notice} /> : null}
      {assets.length ? (
        <FlatList
          data={assets}
          keyExtractor={(item) => item.id}
          numColumns={3}
          contentContainerStyle={styles.gridContent}
          columnWrapperStyle={styles.gridRow}
          renderItem={({ item }) => <PhotoTile asset={item} onPress={() => onPreview(item)} />}
        />
      ) : (
        <View style={styles.emptyWrap}>
          <MaterialCommunityIcons name="check-circle-outline" size={40} color={COLORS.green} />
          <Text style={styles.sectionTitle}>Nothing set aside.</Text>
          <Text style={styles.bodyCopy}>Photos you mark for deletion will appear here for a careful second look.</Text>
        </View>
      )}
      <View style={styles.bottomActions}>
        <Pressable style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryButtonText}>Back to review</Text>
        </Pressable>
        {assets.length > 0 && (
          <Pressable style={styles.dangerButton} onPress={onContinue}>
            <Text style={styles.dangerButtonText}>Review before deleting</Text>
            <MaterialCommunityIcons name="arrow-right" size={18} color={COLORS.text} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function ConfirmScreen({
  assets,
  notice,
  deleting,
  onBack,
  onCancel,
  onPreview,
  onConfirm,
}: {
  assets: LibraryAsset[];
  notice: string;
  deleting: boolean;
  onBack: () => void;
  onCancel: () => void;
  onPreview: (asset: LibraryAsset) => void;
  onConfirm: () => void;
}) {
  return (
    <View style={styles.pageScreen}>
      <PageHeader title="One last look" subtitle="Nothing happens until you confirm" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.confirmContent}>
        <View style={styles.confirmIcon}><MaterialCommunityIcons name="trash-can-outline" size={26} color={COLORS.red} /></View>
        <Text style={styles.confirmTitle}>Remove {assets.length} {assets.length === 1 ? 'photo' : 'photos'}?</Text>
        <Text style={styles.confirmCopy}>
          SwipeClean will ask your iPhone to remove these items from your photo library. Apple may show its own confirmation. Deleted items may remain in Recently Deleted for a while.
        </Text>
        <View style={styles.confirmGrid}>
          {assets.slice(0, 12).map((asset) => (
            <PhotoTile key={asset.id} asset={asset} onPress={() => onPreview(asset)} compact />
          ))}
          {assets.length > 12 && <Text style={styles.morePhotos}>+{assets.length - 12} more</Text>}
        </View>
        {notice ? <Notice text={notice} /> : null}
      </ScrollView>
      <View style={styles.bottomActions}>
        <Pressable style={styles.secondaryButton} onPress={onCancel} disabled={deleting}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={[styles.dangerButton, deleting && styles.disabledButton]}
          onPress={onConfirm}
          disabled={deleting || assets.length === 0}
        >
          {deleting ? <ActivityIndicator color={COLORS.text} /> : (
            <>
              <Text style={styles.dangerButtonText}>Confirm removal</Text>
              <MaterialCommunityIcons name="trash-can-outline" size={18} color={COLORS.text} />
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function SummaryScreen({
  session,
  kept,
  pending,
  reviewed,
  onContinue,
  onPending,
  onFinish,
}: {
  session: ReviewSession;
  kept: number;
  pending: number;
  reviewed: number;
  onContinue: () => void;
  onPending: () => void;
  onFinish: () => void;
}) {
  const skipped = session.skippedIds.length;
  const undecided = Math.max(
    session.totalCount - Object.keys(session.decisions).length - skipped,
    0,
  );
  return (
    <View style={styles.pageScreen}>
      <PageHeader title="A good start" subtitle="Your session so far" onBack={onContinue} />
      <View style={styles.summaryContent}>
        <View style={styles.summaryIcon}><MaterialCommunityIcons name="star-four-points-outline" size={28} color={COLORS.green} /></View>
        <Text style={styles.summaryTitle}>Your camera roll,{'\n'}a little lighter.</Text>
        <Text style={styles.summarySub}>{reviewed} photos reviewed{session.totalCount ? ` of ${session.totalCount}` : ''}</Text>
        <View style={styles.statsCard}>
          <StatLine icon="check-circle-outline" tint={COLORS.green} label="Kept" value={kept} />
          <StatLine icon="trash-can-outline" tint={COLORS.red} label="Set aside" value={pending} />
          <StatLine icon="arrow-up-circle-outline" tint={COLORS.gold} label="Skipped · to revisit" value={skipped} />
          <StatLine icon="image-outline" tint={COLORS.muted} label="Not yet reviewed" value={undecided} last />
        </View>
        <Text style={styles.summarySafety}>Set-aside photos stay untouched until you confirm removal.</Text>
      </View>
      <View style={styles.bottomActions}>
        <Pressable style={styles.secondaryButton} onPress={onFinish}>
          <Text style={styles.secondaryButtonText}>Finish for now</Text>
        </Pressable>
        {pending > 0 && (
          <Pressable style={styles.dangerButton} onPress={onPending}>
            <Text style={styles.dangerButtonText}>Review {pending} for deletion</Text>
          </Pressable>
        )}
        {skipped > 0 && (
          <Pressable style={styles.primaryButton} onPress={onContinue}>
            <Text style={styles.primaryButtonText}>Revisit skipped photos</Text>
            <MaterialCommunityIcons name="arrow-right" size={19} color={COLORS.background} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function StatLine({ icon, tint, label, value, last = false }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; tint: string; label: string; value: number; last?: boolean }) {
  return (
    <View style={[styles.statLine, last && styles.statLineLast]}>
      <MaterialCommunityIcons name={icon} size={20} color={tint} />
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function CompletionScreen({
  deleted,
  kept,
  pending,
  onContinue,
  onPending,
  onHome,
}: {
  deleted: number;
  kept: number;
  pending: number;
  onContinue: () => void;
  onPending: () => void;
  onHome: () => void;
}) {
  return (
    <View style={styles.pageScreen}>
      <View style={styles.completionContent}>
        <View style={styles.completionIcon}>
          <MaterialCommunityIcons name={deleted ? 'check' : 'image-multiple-outline'} size={36} color={COLORS.green} />
        </View>
        <Text style={styles.completionTitle}>{deleted ? 'All done.' : 'Saved for next time.'}</Text>
        <Text style={styles.bodyCopy}>
          {deleted
            ? `${deleted} ${deleted === 1 ? 'photo was' : 'photos were'} removed from your library. Apple may keep them in Recently Deleted for a while.`
            : 'Your review progress is saved on this device. Pick up right where you left off.'}
        </Text>
        <View style={styles.completionStats}>
          <Text style={styles.completionStatText}>{kept} kept</Text>
          <View style={styles.statDot} />
          <Text style={styles.completionStatText}>{pending} still set aside</Text>
        </View>
      </View>
      <View style={styles.bottomActions}>
        <Pressable style={styles.primaryButton} onPress={onContinue}>
          <Text style={styles.primaryButtonText}>Continue reviewing</Text>
          <MaterialCommunityIcons name="arrow-right" size={19} color={COLORS.background} />
        </Pressable>
        {pending > 0 && (
          <Pressable style={styles.secondaryButton} onPress={onPending}>
            <Text style={styles.secondaryButtonText}>Review remaining set-aside photos</Text>
          </Pressable>
        )}
        <Pressable style={styles.textButton} onPress={onHome}>
          <Text style={styles.subtleLink}>Back to start</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SettingsScreen({
  permission,
  notice,
  onBack,
  onOpenSettings,
  onManage,
  onReset,
}: {
  permission: 'all' | 'limited' | 'none';
  notice: string;
  onBack: () => void;
  onOpenSettings: () => void;
  onManage: () => void;
  onReset: () => void;
}) {
  return (
    <View style={styles.pageScreen}>
      <PageHeader title="Settings" subtitle="A few useful things" onBack={onBack} />
      <View style={styles.settingsContent}>
        <Text style={styles.settingsGroupTitle}>PHOTO ACCESS</Text>
        <View style={styles.settingCard}>
          <View style={styles.settingIcon}><MaterialCommunityIcons name="image-lock-outline" size={21} color={COLORS.green} /></View>
          <View style={styles.settingText}>
            <Text style={styles.settingTitle}>Library access</Text>
            <Text style={styles.settingDescription}>
              {permission === 'all' ? 'All photos and videos' : permission === 'limited' ? 'Selected photos and videos only' : 'Not currently allowed'}
            </Text>
          </View>
        </View>
        {permission === 'limited' && (
          <SettingButton icon="image-multiple-outline" title="Manage selected photos" detail="Choose which items SwipeClean can see" onPress={onManage} />
        )}
        <SettingButton icon="cog-outline" title="Open iPhone Settings" detail="Change SwipeClean's photo permissions" onPress={onOpenSettings} />
        <Text style={[styles.settingsGroupTitle, { marginTop: 28 }]}>SESSION</Text>
        <SettingButton icon="restart" title="Reset review session" detail="Clears progress; does not delete photos" destructive onPress={onReset} />
        {notice ? <Notice text={notice} /> : null}
        <View style={styles.aboutCard}>
          <Text style={styles.aboutName}>SwipeClean</Text>
          <Text style={styles.settingDescription}>Private by design. Your photo library and session stay on this device.</Text>
        </View>
      </View>
    </View>
  );
}

function SettingButton({ icon, title, detail, destructive = false, onPress }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; title: string; detail: string; destructive?: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.settingCard} onPress={onPress}>
      <View style={[styles.settingIcon, destructive && { backgroundColor: '#321D20' }]}>
        <MaterialCommunityIcons name={icon} size={21} color={destructive ? COLORS.red : COLORS.muted} />
      </View>
      <View style={styles.settingText}>
        <Text style={[styles.settingTitle, destructive && { color: COLORS.red }]}>{title}</Text>
        <Text style={styles.settingDescription}>{detail}</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={19} color={COLORS.muted} />
    </Pressable>
  );
}

function PageHeader({ title, subtitle, onBack }: { title: string; subtitle: string; onBack: () => void }) {
  return (
    <View style={styles.pageHeader}>
      <Pressable accessibilityRole="button" accessibilityLabel="Go back" style={styles.iconButton} onPress={onBack}>
        <MaterialCommunityIcons name="arrow-left" size={22} color={COLORS.text} />
      </Pressable>
      <View style={styles.pageHeaderCopy}>
        <Text style={styles.pageTitle}>{title}</Text>
        <Text style={styles.pageSubtitle}>{subtitle}</Text>
      </View>
      <View style={{ width: 42 }} />
    </View>
  );
}

function PhotoTile({ asset, onPress, compact = false }: { asset: LibraryAsset; onPress: () => void; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${asset.filename}`} style={[styles.photoTile, compact && styles.photoTileCompact]} onPress={onPress}>
      {failed ? (
        <View style={styles.tileUnavailable}>
          <MaterialCommunityIcons name="image-off-outline" size={22} color={COLORS.muted} />
        </View>
      ) : (
        <Image
          source={{ uri: asset.uri }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          cachePolicy="memory"
          onError={() => setFailed(true)}
        />
      )}
      {asset.mediaType === 'video' && (
        <View style={styles.tileVideo}><MaterialCommunityIcons name="play" size={15} color={COLORS.text} /></View>
      )}
    </Pressable>
  );
}

function PreviewModal({
  asset,
  isPending,
  onClose,
  onRemove,
}: {
  asset: LibraryAsset;
  isPending: boolean;
  onClose: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.previewOverlay}>
      <View style={styles.previewHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close preview" style={styles.iconButton} onPress={onClose}>
          <MaterialCommunityIcons name="close" size={22} color={COLORS.text} />
        </Pressable>
        <Text style={styles.previewDate}>{formatCaptureDate(asset.creationTime)}</Text>
        <View style={{ width: 42 }} />
      </View>
      <Image source={{ uri: asset.uri }} style={{ flex: 1, width: '100%' }} contentFit="contain" />
      {isPending && (
        <Pressable style={styles.previewRemove} onPress={onRemove}>
          <MaterialCommunityIcons name="undo-variant" size={19} color={COLORS.text} />
          <Text style={styles.previewRemoveText}>Keep in my library</Text>
        </Pressable>
      )}
    </View>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <View style={styles.notice}>
      <MaterialCommunityIcons name="information-outline" size={18} color={COLORS.gold} />
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

function formatCaptureDate(timestamp: number) {
  if (!timestamp || !Number.isFinite(timestamp)) return 'Date unavailable';
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Please try again.';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.background },
  welcomeScreen: { flexGrow: 1, paddingHorizontal: 26, paddingBottom: 24 },
  welcomeTop: { height: 62, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandMark: { position: 'absolute', left: '50%', marginLeft: -22, width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#14231E' },
  brandMarkSmall: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#14231E' },
  brandName: { marginLeft: 9, color: COLORS.text, fontSize: 15, fontWeight: '700', letterSpacing: 0.15 },
  welcomeCopy: { marginTop: Math.min(SCREEN_HEIGHT * 0.052, 42) },
  eyebrow: { color: COLORS.green, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  heroTitle: { marginTop: 13, color: COLORS.text, fontSize: 47, lineHeight: 51, letterSpacing: -1.8, fontWeight: '700' },
  bodyCopy: { marginTop: 13, color: COLORS.muted, fontSize: 15, lineHeight: 23 },
  howCard: { marginTop: 27, paddingVertical: 5, paddingHorizontal: 16, borderRadius: 20, backgroundColor: COLORS.panel, borderWidth: 1, borderColor: COLORS.border },
  howRow: { height: 55, flexDirection: 'row', alignItems: 'center', borderBottomColor: '#222A2D', borderBottomWidth: StyleSheet.hairlineWidth },
  howIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  howTitle: { width: 99, color: COLORS.text, fontSize: 13, fontWeight: '600' },
  howDetail: { flex: 1, color: COLORS.muted, fontSize: 12 },
  privacyNote: { marginTop: 18, paddingHorizontal: 2, flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  privacyText: { flex: 1, color: '#AFB8B8', fontSize: 12, lineHeight: 18 },
  inlineMuted: { color: COLORS.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 10 },
  primaryButton: { minHeight: 54, borderRadius: 17, paddingHorizontal: 20, backgroundColor: COLORS.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  primaryButtonText: { color: COLORS.background, fontSize: 15, fontWeight: '700' },
  footnote: { marginTop: 13, color: '#687275', textAlign: 'center', fontSize: 11 },
  iconButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: COLORS.panel, borderWidth: 1, borderColor: COLORS.border },
  pressed: { opacity: 0.76, transform: [{ scale: 0.97 }] },
  notice: { padding: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderRadius: 14, marginVertical: 11, backgroundColor: '#272116', borderWidth: 1, borderColor: '#493B20' },
  noticeText: { flex: 1, color: '#E9D8AE', fontSize: 12, lineHeight: 18 },
  swipeScreen: { flex: 1, paddingHorizontal: 19, paddingBottom: 7 },
  topBar: { height: 53, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topBrand: { flexDirection: 'row', alignItems: 'center' },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  pendingButton: { height: 40, minWidth: 57, paddingHorizontal: 11, borderRadius: 13, borderWidth: 1, borderColor: '#4A2B2B', backgroundColor: '#211617', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  pendingCount: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  progressArea: { marginTop: 7, marginBottom: 11 },
  progressTextRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  progressText: { color: COLORS.text, fontSize: 12, fontWeight: '600' },
  progressAside: { color: COLORS.muted, fontSize: 11 },
  progressTrack: { height: 3, borderRadius: 3, backgroundColor: '#242B2E', overflow: 'hidden' },
  progressFill: { height: '100%', minWidth: 2, backgroundColor: COLORS.green, borderRadius: 3 },
  libraryBanner: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6, paddingHorizontal: 9, marginBottom: 5, borderRadius: 10, backgroundColor: '#14201B' },
  libraryBannerText: { flex: 1, color: '#B8C7C1', fontSize: 10, lineHeight: 14 },
  cardStage: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 210 },
  photoCard: { width: '100%', height: '100%', maxHeight: SCREEN_HEIGHT * 0.59, borderRadius: 22, overflow: 'hidden', backgroundColor: '#15191B', borderWidth: 1, borderColor: '#262C2E', justifyContent: 'center' },
  photoCardLoading: { width: '100%', height: '78%', alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: COLORS.panel },
  photoImage: { width: '100%', height: '100%' },
  photoUnavailable: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: '#101416' },
  swipeLabel: { position: 'absolute', top: 24, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 2, transform: [{ rotate: '-12deg' }] },
  keepLabel: { left: 19, borderColor: COLORS.green },
  deleteLabel: { right: 19, borderColor: COLORS.red, transform: [{ rotate: '12deg' }] },
  swipeLabelText: { fontSize: 20, fontWeight: '900', letterSpacing: 2 },
  photoFooter: { position: 'absolute', bottom: 13, left: 13, right: 13, flexDirection: 'row', justifyContent: 'flex-start' },
  datePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 12, backgroundColor: 'rgba(9,11,13,0.76)' },
  dateText: { color: COLORS.text, fontSize: 11, fontWeight: '600' },
  videoBadge: { position: 'absolute', top: 13, right: 13, flexDirection: 'row', alignItems: 'center', gap: 2, borderRadius: 10, paddingVertical: 4, paddingHorizontal: 7, backgroundColor: 'rgba(9,11,13,0.76)' },
  videoLabel: { color: COLORS.text, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  controlsArea: { paddingTop: 12 },
  actionLabels: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 1, marginBottom: 10 },
  actionHint: { color: '#626D70', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  controlsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6 },
  roundControl: { width: 59, height: 59, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.panel, borderWidth: 1.5 },
  roundControlSmall: { width: 48, height: 48, borderRadius: 18, backgroundColor: '#101416' },
  disabledControl: { borderColor: '#252A2C', opacity: 0.68 },
  bottomMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 11, minHeight: 22 },
  subtleMeta: { color: COLORS.muted, fontSize: 11 },
  subtleLink: { color: COLORS.green, fontSize: 11, fontWeight: '600' },
  pageLoader: { position: 'absolute', top: 74, right: 3 },
  centerScreen: { flex: 1, paddingHorizontal: 19 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  emptyIcon: { width: 72, height: 72, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.panel, marginBottom: 18 },
  sectionTitle: { marginTop: 18, color: COLORS.text, fontSize: 21, fontWeight: '700', textAlign: 'center' },
  secondaryButton: { minHeight: 50, paddingHorizontal: 17, borderRadius: 15, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.panel, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  pageScreen: { flex: 1, paddingHorizontal: 20 },
  pageHeader: { minHeight: 70, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pageHeaderCopy: { flex: 1, alignItems: 'center' },
  pageTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  pageSubtitle: { marginTop: 3, color: COLORS.muted, fontSize: 11 },
  gridContent: { paddingTop: 14, paddingBottom: 20, gap: 8 },
  gridRow: { gap: 8 },
  photoTile: { width: '31.8%', aspectRatio: 1, borderRadius: 13, overflow: 'hidden', backgroundColor: COLORS.panelRaised, borderWidth: 1, borderColor: COLORS.border },
  photoTileCompact: { width: '31%', borderRadius: 10 },
  tileImage: { width: '100%', height: '100%' },
  tileUnavailable: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111618' },
  tileVideo: { position: 'absolute', right: 5, bottom: 5, width: 25, height: 25, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(9,11,13,0.76)' },
  bottomActions: { paddingTop: 12, paddingBottom: 10, gap: 9 },
  dangerButton: { minHeight: 50, paddingHorizontal: 16, borderRadius: 15, backgroundColor: '#692D32', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dangerButtonText: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  confirmContent: { flexGrow: 1, paddingHorizontal: 2, paddingBottom: 20, alignItems: 'center' },
  confirmIcon: { width: 56, height: 56, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: '#29191A', marginTop: 20 },
  confirmTitle: { marginTop: 17, color: COLORS.text, fontSize: 23, fontWeight: '700', textAlign: 'center' },
  confirmCopy: { maxWidth: 370, marginTop: 10, marginBottom: 18, color: COLORS.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  confirmGrid: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: 8 },
  morePhotos: { alignSelf: 'center', color: COLORS.muted, fontSize: 12, padding: 10 },
  summaryContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  summaryIcon: { width: 61, height: 61, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: '#14231E', marginBottom: 17 },
  summaryTitle: { color: COLORS.text, fontSize: 29, lineHeight: 34, fontWeight: '700', textAlign: 'center', letterSpacing: -0.7 },
  summarySub: { marginTop: 8, color: COLORS.muted, fontSize: 13 },
  statsCard: { width: '100%', marginTop: 26, paddingHorizontal: 17, paddingVertical: 2, borderRadius: 18, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.panel },
  statLine: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  statLineLast: { borderBottomWidth: 0 },
  statLabel: { flex: 1, color: COLORS.muted, fontSize: 13 },
  statValue: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  summarySafety: { marginTop: 16, maxWidth: 290, color: COLORS.muted, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  completionContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  completionIcon: { width: 75, height: 75, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: '#14231E', marginBottom: 20 },
  completionTitle: { color: COLORS.text, fontSize: 30, fontWeight: '700', marginBottom: 5 },
  completionStats: { marginTop: 22, paddingVertical: 13, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, backgroundColor: COLORS.panel },
  completionStatText: { color: COLORS.muted, fontSize: 12, fontWeight: '600' },
  statDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: COLORS.green },
  textButton: { alignItems: 'center', paddingVertical: 7 },
  settingsContent: { paddingTop: 18 },
  settingsGroupTitle: { marginBottom: 10, color: COLORS.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  settingCard: { minHeight: 70, padding: 12, marginBottom: 9, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.panel },
  settingIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#14231E' },
  settingText: { flex: 1 },
  settingTitle: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  settingDescription: { marginTop: 4, color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  aboutCard: { marginTop: 23, padding: 15, borderRadius: 15, backgroundColor: COLORS.panel },
  aboutName: { marginBottom: 6, color: COLORS.text, fontSize: 13, fontWeight: '700' },
  previewOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 10, backgroundColor: COLORS.background, paddingHorizontal: 12, paddingBottom: 22 },
  previewHeader: { height: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  previewDate: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  previewImage: { flex: 1, width: '100%' },
  previewRemove: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingVertical: 13, paddingHorizontal: 18, borderRadius: 15, backgroundColor: COLORS.panelRaised },
  previewRemoveText: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  disabledButton: { opacity: 0.5 },
});
