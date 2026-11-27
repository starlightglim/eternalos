import { lazy, memo, Suspense, useCallback, useEffect, useMemo } from 'react';
import { Window } from './Window';
import { useWindowStore } from '../../stores/windowStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { slugify } from '../../utils/slugify';
import { getItemExtension } from '../../utils/itemSelectors';
import { openAppearance } from '../../utils/openAppearance';
import { Calculator } from '../viewers/Calculator';
import { Clock } from '../viewers/Clock';
import { FetchCard } from '../viewers/FetchCard';

import { FolderView } from './FolderView';
import { TrashView } from './TrashView';
import { WidgetRenderer } from '../widgets';
import { WindowErrorBoundary } from './WindowErrorBoundary';
import { APP_VERSION } from './appVersion';
import type { DesktopItem, WindowState } from '../../types';

const ImageViewer = lazy(() => import('../viewers/ImageViewer').then(({ ImageViewer: component }) => ({ default: component })));
const TextViewer = lazy(() => import('../viewers/TextViewer').then(({ TextViewer: component }) => ({ default: component })));
const MarkdownViewer = lazy(() => import('../viewers/MarkdownViewer').then(({ MarkdownViewer: component }) => ({ default: component })));
const CodeViewer = lazy(() => import('../viewers/CodeViewer').then(({ CodeViewer: component }) => ({ default: component })));
const AudioPlayer = lazy(() => import('../viewers/AudioPlayer').then(({ AudioPlayer: component }) => ({ default: component })));
const VideoPlayer = lazy(() => import('../viewers/VideoPlayer').then(({ VideoPlayer: component }) => ({ default: component })));
const PDFViewer = lazy(() => import('../viewers/PDFViewer').then(({ PDFViewer: component }) => ({ default: component })));
const WebsiteViewer = lazy(() => import('../viewers/WebsiteViewer').then(({ WebsiteViewer: component }) => ({ default: component })));
const GetInfo = lazy(() => import('../viewers/GetInfo').then(({ GetInfo: component }) => ({ default: component })));
const WelcomeReadMe = lazy(() => import('../viewers/WelcomeReadMe').then(({ WelcomeReadMe: component }) => ({ default: component })));
const SearchWindow = lazy(() => import('../viewers/SearchWindow').then(({ SearchWindow: component }) => ({ default: component })));
const PreferencesWindow = lazy(() => import('../viewers/PreferencesWindow').then(({ PreferencesWindow: component }) => ({ default: component })));
const AppearancePanel = lazy(() => import('../viewers/AppearancePanel').then(({ AppearancePanel: component }) => ({ default: component })));
const CSSEditor = lazy(() => import('../viewers/CSSEditor').then(({ CSSEditor: component }) => ({ default: component })));
const BazaarWindow = lazy(() => import('../viewers/BazaarWindow').then(({ BazaarWindow: component }) => ({ default: component })));
const CursorCreator = lazy(() => import('../viewers/CursorCreator').then(({ CursorCreator: component }) => ({ default: component })));
const ShareDialog = lazy(() => import('../viewers/ShareDialog').then(({ ShareDialog: component }) => ({ default: component })));
const ProfileWindow = lazy(() => import('../viewers/ProfileWindow').then(({ ProfileWindow: component }) => ({ default: component })));
const AgentChatWindow = lazy(() => import('../viewers/AgentChatWindow').then(({ AgentChatWindow: component }) => ({ default: component })));
const AppViewer = lazy(() => import('../viewers/AppViewer').then(({ AppViewer: component }) => ({ default: component })));
const DeveloperStudio = lazy(() => import('../viewers/DeveloperStudio').then(({ DeveloperStudio: component }) => ({ default: component })));
const ConsolePlayer = lazy(() => import('../console/ConsolePlayer').then(({ ConsolePlayer: component }) => ({ default: component })));
const CartridgeEditor = lazy(() => import('../console/CartridgeEditor').then(({ CartridgeEditor: component }) => ({ default: component })));

interface WindowManagerProps {
  isVisitorMode?: boolean;
  visitorItems?: DesktopItem[];
  folderWindowDropTargetId?: string | null;
  ownerUid?: string;
}

/**
 * WindowManager - renders all open windows
 * Manages which window is active (top z-index)
 */
export function WindowManager({ isVisitorMode = false, visitorItems, folderWindowDropTargetId, ownerUid }: WindowManagerProps) {
  const windows = useWindowStore((state) => state.windows);
  const items = useDesktopStore((state) => state.items);

  // Find the active window (highest z-index among non-minimized)
  const visibleWindows = windows.filter((w) => !w.minimized);
  const activeWindowId =
    visibleWindows.length > 0
      ? visibleWindows.reduce((top, w) => (w.zIndex > top.zIndex ? w : top)).id
      : null;

  // One id -> item index per items change instead of two linear scans per
  // window per render (renders happen on every drag frame).
  const sourceItems = isVisitorMode && visitorItems ? visitorItems : items;
  const itemsById = useMemo(() => new Map(sourceItems.map((item) => [item.id, item])), [sourceItems]);

  return (
    <>
      {windows.map((win) => {
        const item = win.contentId ? itemsById.get(win.contentId) : undefined;
        const parentItem = item?.parentId ? itemsById.get(item.parentId) : undefined;
        return (
          <ManagedWindow
            key={win.id}
            win={win}
            item={item}
            // Visitor mode without visitor items has no content source.
            contentItem={isVisitorMode && !visitorItems ? undefined : item}
            parentName={parentItem?.name}
            isActive={win.id === activeWindowId}
            isVisitorMode={isVisitorMode}
            visitorItems={visitorItems}
            folderWindowDropTargetId={folderWindowDropTargetId}
            ownerUid={ownerUid}
          />
        );
      })}
    </>
  );
}

interface ManagedWindowProps {
  win: WindowState;
  item?: DesktopItem;
  contentItem?: DesktopItem;
  parentName?: string;
  isActive: boolean;
  isVisitorMode: boolean;
  visitorItems?: DesktopItem[];
  folderWindowDropTargetId?: string | null;
  ownerUid?: string;
}

/**
 * One window plus its content. Memoized on stable props (the store keeps the
 * object identity of windows that didn't change), so dragging one window
 * re-renders only that window.
 */
const ManagedWindow = memo(function ManagedWindow({
  win,
  item,
  contentItem,
  parentName,
  isActive,
  isVisitorMode,
  visitorItems,
  folderWindowDropTargetId,
  ownerUid,
}: ManagedWindowProps) {
  const closeWindow = useWindowStore((state) => state.closeWindow);
  const handleClose = useCallback(() => closeWindow(win.id), [closeWindow, win.id]);

  return (
    <Window
      id={win.id}
      title={win.title}
      position={win.position}
      size={win.size}
      zIndex={win.zIndex}
      minimized={win.minimized}
      collapsed={win.collapsed}
      isActive={isActive}
      contentType={win.contentType}
      contentId={win.contentId}
      eosName={item ? slugify(item.name) : slugify(win.title)}
      eosType={item?.type || win.contentType}
      eosExtension={item ? getItemExtension(item) : undefined}
      eosFolder={parentName ? slugify(parentName) : undefined}
    >
      {/* A crashing viewer (or a lazy chunk gone after a deploy) breaks only its own window. */}
      <WindowErrorBoundary title={win.title} onClose={handleClose}>
        <Suspense fallback={<WindowContentFallback />}>
          <WindowContent
            windowId={win.id}
            contentType={win.contentType}
            contentId={win.contentId}
            launchFileId={win.launchFileId}
            item={contentItem}
            isVisitorMode={isVisitorMode}
            visitorItems={visitorItems}
            folderWindowDropTargetId={folderWindowDropTargetId}
            ownerUid={ownerUid}
          />
        </Suspense>
      </WindowErrorBoundary>
    </Window>
  );
});

function WindowContentFallback() {
  return (
    <div
      role="status"
      style={{
        display: 'grid',
        height: '100%',
        placeItems: 'center',
        padding: 24,
        background: 'var(--surface, var(--window-bg, var(--white)))',
        color: 'var(--text-muted, var(--window-text-secondary, var(--shadow)))',
        fontFamily: 'var(--font-geneva)',
        fontSize: 11,
      }}
    >
      Loading viewer…
    </div>
  );
}

function MissingContent({ message, dark = false }: { message: string; dark?: boolean }) {
  return (
    <div
      role="status"
      style={{
        display: 'grid',
        height: '100%',
        placeItems: 'center',
        padding: 24,
        background: dark ? 'var(--preview-bg, var(--black))' : 'var(--surface-chrome, var(--platinum))',
        color: dark ? 'var(--selection-text, var(--white))' : 'var(--text-muted, var(--shadow))',
        fontFamily: 'var(--font-geneva)',
        fontSize: 12,
        textAlign: 'center',
      }}
    >
      {message}
    </div>
  );
}

/**
 * Renders content inside a window based on its type
 * Uses real viewers for images and text, folder view for folders
 */
const WindowContent = memo(function WindowContent({
  windowId,
  contentType,
  contentId,
  launchFileId,
  item,
  isVisitorMode = false,
  visitorItems,
  folderWindowDropTargetId,
  ownerUid,
}: {
  windowId: string;
  contentType: string;
  contentId?: string;
  launchFileId?: string;
  /** The window's desktop item, looked up by WindowManager (re-renders when it changes). */
  item?: DesktopItem;
  isVisitorMode?: boolean;
  visitorItems?: DesktopItem[];
  folderWindowDropTargetId?: string | null;
  ownerUid?: string;
}) {
  switch (contentType) {
    case 'folder':
      return (
        <FolderView
          folderId={contentId || null}
          visitorItems={isVisitorMode ? visitorItems : undefined}
          isVisitorMode={isVisitorMode}
          isDropTarget={folderWindowDropTargetId === contentId}
        />
      );

    case 'image':
      if (!item) return <MissingContent message="Image not found" />;
      return (
        <ImageViewer
          itemId={item.id}
          windowId={windowId}
          name={item.name}
          r2Key={item.r2Key}
          mimeType={item.mimeType}
          isOwner={!isVisitorMode}
        />
      );

    case 'text':
      if (!item) return <MissingContent message="Text file not found" />;
      return (
        <TextViewer
          itemId={item.id}
          windowId={windowId}
          name={item.name}
          textContent={item.textContent}
          isOwner={!isVisitorMode} // Read-only in visitor mode
        />
      );

    case 'markdown':
      if (!item) return <MissingContent message="Markdown file not found" />;
      return (
        <MarkdownViewer
          itemId={item.id}
          windowId={windowId}
          name={item.name}
          textContent={item.textContent}
          isOwner={!isVisitorMode}
        />
      );

    case 'code':
      if (!item) return <MissingContent message="Code file not found" />;
      return (
        <CodeViewer
          itemId={item.id}
          windowId={windowId}
          name={item.name}
          textContent={item.textContent}
          isOwner={!isVisitorMode}
        />
      );

    case 'get-info':
      if (!item) return <MissingContent message="Item not found" />;
      return <GetInfo item={item} isOwner={!isVisitorMode} />;

    case 'about':
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: '20px',
            textAlign: 'center',
          }}
        >
          <h2
            style={{
              fontFamily: 'var(--font-chicago)',
              fontSize: '16px',
              marginBottom: '8px',
            }}
          >
            EternalOS
          </h2>
          <p style={{ fontFamily: 'var(--font-geneva)', fontSize: '11px', color: 'var(--shadow)' }}>
            Your corner of the internet
          </p>
          <p
            style={{
              fontFamily: 'var(--font-geneva)',
              fontSize: '10px',
              color: 'var(--shadow)',
              marginTop: '12px',
            }}
          >
            Version {APP_VERSION}
          </p>
        </div>
      );

    case 'wallpaper':
      // Legacy saved windows: the wallpaper picker lives in Appearance now.
      return <LegacyWallpaperWindow windowId={windowId} isVisitorMode={isVisitorMode} />;

    case 'welcome':
      return <WelcomeReadMe />;

    case 'search':
      return <SearchWindow />;

    case 'preferences':
      return <PreferencesWindow />;

    case 'appearance':
      return <AppearancePanel />;

    case 'css-editor':
      return <CSSEditor />;

    case 'bazaar':
      return <BazaarWindow />;

    case 'cursor-creator':
      return <CursorCreator />;

    case 'developer-studio':
      return <DeveloperStudio />;

    case 'console-player':
      // contentId carries the gameId ('demo', 'draft:{cartId}', or a packId)
      if (!contentId) return <MissingContent message="Game not found" dark />;
      return <ConsolePlayer gameId={contentId} windowId={windowId} />;

    case 'cartridge-editor':
      return <CartridgeEditor />;


    case 'trash':
      return <TrashView />;

    case 'audio':
      if (!item) return <MissingContent message="Audio file not found" />;
      return <AudioPlayer itemId={item.id} r2Key={item.r2Key} name={item.name} />;

    case 'video':
      if (!item) return <MissingContent message="Video file not found" dark />;
      return <VideoPlayer itemId={item.id} r2Key={item.r2Key} name={item.name} />;

    case 'pdf':
      if (!item) return <MissingContent message="PDF file not found" />;
      return <PDFViewer itemId={item.id} r2Key={item.r2Key} name={item.name} />;

    case 'calculator':
      return <Calculator />;

    case 'clock':
      return <Clock />;

    case 'fetch':
      return <FetchCard />;

    case 'link':
      if (!item) return <MissingContent message="Link not found" />;
      return <WebsiteViewer itemId={item.id} url={item.url} name={item.name} />;

    case 'widget':
      if (!item) return <MissingContent message="Widget not found" />;
      return <WidgetRenderer item={item} isOwner={!isVisitorMode} ownerUid={ownerUid} />;

    case 'share-dialog':
      return <ShareDialog isOwner={!isVisitorMode} />;

    case 'profile':
      return <ProfileWindow isOwner={!isVisitorMode} />;

    case 'agent-chat':
      return <AgentChatWindow />;

    case 'app':
      if (!item?.appManifest?.appId) return <MissingContent message="App not found" dark />;
      return <AppViewer appId={item.appManifest.appId} windowId={windowId} launchFileId={launchFileId} isVisitor={isVisitorMode} />;

    case 'app-preview':
      if (!contentId) return <MissingContent message="Preview not found" dark />;
      return <AppViewer previewId={contentId} windowId={windowId} />;

    default:
      return null;
  }
});

/**
 * A `wallpaper` window saved before the picker moved into the Appearance hub:
 * the owner's is swapped for Appearance at its Wallpaper section.
 */
function LegacyWallpaperWindow({ windowId, isVisitorMode }: { windowId: string; isVisitorMode: boolean }) {
  useEffect(() => {
    if (isVisitorMode) return;
    useWindowStore.getState().closeWindow(windowId);
    openAppearance('desktop');
  }, [windowId, isVisitorMode]);

  if (isVisitorMode) return <MissingContent message="Wallpaper settings moved to Appearance." />;
  return <WindowContentFallback />;
}
