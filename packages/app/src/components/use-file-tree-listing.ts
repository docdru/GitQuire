import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { createRefreshScheduler } from '@/lib/refresh-scheduler';
import { fileEntryToTreePath, treeDirectoryPathToFolderPath } from './file-tree-adapter';
import {
  type FileTreeListingSource,
  httpFileTreeListingSource,
} from './file-tree-listing-transport';
import { mergeRootEntriesAdditive, spliceLazyFolderChildren } from './file-tree-merge';
import { type FileEntry, filterVisibleEntries, isFolderEntry } from './file-tree-utils';

interface ListingMessages {
  fallbackErrorTitle: string;
  schemaMismatchTitle: string;
  couldNotReachServerTitle: string;
}

interface FileTreeListingOptions {
  showHiddenFiles: boolean;
  showOnlyMarkdownFiles: boolean;
  showOkFolders: boolean;
  messages: ListingMessages;
  source?: FileTreeListingSource;
}

export interface FileTreeListingHandle {
  documents: FileEntry[];
  setDocuments: Dispatch<SetStateAction<FileEntry[]>>;
  recordOptimisticAdd(entry: FileEntry): void;
  loading: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  truncatedShownCount: number | null;
  unfilteredRootEntryCount: number;
  observeExpandedFolderPaths(paths: readonly string[]): void;
}

export function useFileTreeListing({
  showHiddenFiles,
  showOnlyMarkdownFiles,
  showOkFolders,
  messages,
  source = httpFileTreeListingSource,
}: FileTreeListingOptions): FileTreeListingHandle {
  const [documents, setDocuments] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncatedShownCount, setTruncatedShownCount] = useState<number | null>(null);
  const [unfilteredRootEntryCount, setUnfilteredRootEntryCount] = useState(0);

  const documentsRef = useRef(documents);
  const visibilityRef = useRef({ showHiddenFiles, showOnlyMarkdownFiles, showOkFolders });
  const messagesRef = useRef(messages);
  const expandedFolderPathsRef = useRef<ReadonlySet<string>>(new Set());
  const optimisticAddsRef = useRef<Map<string, number>>(new Map());
  const loadedFolderPathsRef = useRef<Set<string>>(new Set());
  const childControllersRef = useRef<Map<string, AbortController>>(new Map());
  const childGenerationRef = useRef(0);
  const requestRefreshRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  function visibility() {
    return visibilityRef.current;
  }

  function reportServerReachableError(title: string) {
    setError(title);
  }

  function reportConnectivityFailure() {
    setError(messagesRef.current.couldNotReachServerTitle);
  }

  function recordOptimisticAdd(entry: FileEntry) {
    optimisticAddsRef.current.set(fileEntryToTreePath(entry), Date.now());
  }

  function startLazyFolderListing(folderTreePath: string, includeKnownEmpty: boolean) {
    if (loadedFolderPathsRef.current.has(folderTreePath)) return;
    if (childControllersRef.current.has(folderTreePath)) return;
    const folderPath = treeDirectoryPathToFolderPath(folderTreePath);
    const entry = documentsRef.current.find(
      (candidate): candidate is Extract<FileEntry, { kind: 'folder' }> =>
        isFolderEntry(candidate) && candidate.path === folderPath,
    );
    if (!includeKnownEmpty && entry?.hasChildren === false) return;

    const generation = childGenerationRef.current;
    const controller = new AbortController();
    childControllersRef.current.set(folderTreePath, controller);
    void source
      .listDepthOne({
        dir: folderPath,
        showOk: visibility().showOkFolders,
        signal: controller.signal,
        messages: messagesRef.current,
      })
      .catch((cause: unknown) => ({ kind: 'network-error' as const, cause }))
      .then((result) => {
        if (childControllersRef.current.get(folderTreePath) === controller) {
          childControllersRef.current.delete(folderTreePath);
        }
        if (controller.signal.aborted || generation !== childGenerationRef.current) return;
        if (result.kind === 'network-error') {
          reportConnectivityFailure();
          console.warn(
            '[FileTree] lazy folder children fetch failed:',
            folderTreePath,
            result.cause,
          );
          return;
        }
        if (result.kind === 'http-error') {
          console.warn('[FileTree] lazy folder children http error:', folderTreePath, result.title);
          reportServerReachableError(result.title);
          return;
        }
        const children = filterVisibleEntries(result.entries, visibility());
        loadedFolderPathsRef.current.add(folderTreePath);
        setDocuments((previous) =>
          spliceLazyFolderChildren(previous, folderTreePath, children, optimisticAddsRef.current),
        );
        setError(null);
        if (result.truncated) setTruncatedShownCount(result.entries.length);
      });
  }

  function revalidateExpandedFolders() {
    for (const path of expandedFolderPathsRef.current) {
      startLazyFolderListing(path, true);
    }
  }

  function observeExpandedFolderPaths(paths: readonly string[]) {
    const expanded = new Set(paths);
    const previous = expandedFolderPathsRef.current;
    expandedFolderPathsRef.current = expanded;
    for (const path of expanded) {
      if (!previous.has(path)) startLazyFolderListing(path, false);
    }
  }

  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: this lifecycle owns one scheduler per source and locale message set; helpers deliberately read live refs so visibility and reconnect state do not recreate it.
  useEffect(() => {
    let active = true;
    let rootController: AbortController | null = null;

    async function refresh() {
      rootController?.abort();
      const controller = new AbortController();
      rootController = controller;
      childGenerationRef.current += 1;
      for (const childController of childControllersRef.current.values()) childController.abort();
      childControllersRef.current.clear();
      loadedFolderPathsRef.current.clear();

      let paintedFirstVisibleBatch = false;
      const result = await source
        .listDepthOne({
          dir: '',
          showOk: visibility().showOkFolders,
          signal: controller.signal,
          messages: messagesRef.current,
          onBatch: (batch) => {
            if (!active || controller.signal.aborted || rootController !== controller) return;
            const visibleBatch = filterVisibleEntries(batch, visibility());
            if (visibleBatch.length === 0) return;
            setDocuments((previous) => mergeRootEntriesAdditive(previous, visibleBatch));
            if (!paintedFirstVisibleBatch) {
              paintedFirstVisibleBatch = true;
              setError(null);
              setLoading(false);
            }
          },
        })
        .catch((cause: unknown) => ({ kind: 'network-error' as const, cause }));
      if (!active || controller.signal.aborted || rootController !== controller) return;
      if (result.kind === 'network-error') {
        reportConnectivityFailure();
        console.warn('[FileTree] fetch failed:', result.cause);
      } else if (result.kind === 'http-error') {
        reportServerReachableError(result.title);
        if (result.cause === undefined) {
          setTruncatedShownCount(null);
        } else {
          console.warn('[FileTree] fetch failed:', result.cause);
        }
      } else {
        const currentVisibility = visibility();
        const serverEntries = filterVisibleEntries(result.entries, currentVisibility);
        setDocuments((previous) =>
          spliceLazyFolderChildren(previous, '', serverEntries, optimisticAddsRef.current),
        );
        setError(null);
        setTruncatedShownCount(result.truncated ? result.entries.length : null);
        setUnfilteredRootEntryCount(result.entries.length);
        revalidateExpandedFolders();
      }
      if (active) setLoading(false);
    }

    const scheduler = createRefreshScheduler(refresh, () => rootController?.abort());
    requestRefreshRef.current = () => scheduler.request();
    scheduler.request();
    const handleResume = () => {
      if (document.visibilityState === 'visible') scheduler.request();
    };
    window.addEventListener('focus', handleResume);
    window.addEventListener('visibilitychange', handleResume);
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) scheduler.request();
    });
    return () => {
      active = false;
      requestRefreshRef.current = null;
      scheduler.dispose();
      for (const controller of childControllersRef.current.values()) controller.abort();
      childControllersRef.current.clear();
      window.removeEventListener('focus', handleResume);
      window.removeEventListener('visibilitychange', handleResume);
      unsubscribe();
    };
  }, [messages.fallbackErrorTitle, messages.schemaMismatchTitle, source]);

  useLayoutEffect(() => {
    visibilityRef.current = { showHiddenFiles, showOnlyMarkdownFiles, showOkFolders };
  }, [showHiddenFiles, showOnlyMarkdownFiles, showOkFolders]);

  const firstVisibilityEffectRunRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibility values are transition triggers; the layout effect owns ref synchronization and this effect schedules through a stable ref.
  useEffect(() => {
    if (firstVisibilityEffectRunRef.current) {
      firstVisibilityEffectRunRef.current = false;
      return;
    }
    requestRefreshRef.current?.();
  }, [showHiddenFiles, showOnlyMarkdownFiles, showOkFolders]);

  return {
    documents,
    setDocuments,
    recordOptimisticAdd,
    loading,
    error,
    setError,
    truncatedShownCount,
    unfilteredRootEntryCount,
    observeExpandedFolderPaths,
  };
}
