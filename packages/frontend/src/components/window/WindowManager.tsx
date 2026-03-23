import { Window } from './Window';
import { useWindowStore } from '../../stores/windowStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { slugify } from '../../utils/slugify';
import { getItemExtension } from '../../utils/itemSelectors';
import { ImageViewer } from '../viewers/ImageViewer';
import { TextViewer } from '../viewers/TextViewer';
import { MarkdownViewer } from '../viewers/MarkdownViewer';
import { CodeViewer } from '../viewers/CodeViewer';
import { AudioPlayer } from '../viewers/AudioPlayer';
import { VideoPlayer } from '../viewers/VideoPlayer';
import { PDFViewer } from '../viewers/PDFViewer';
import { WebsiteViewer } from '../viewers/WebsiteViewer';
import { Calculator } from '../viewers/Calculator';
import { Clock } from '../viewers/Clock';
import { GetInfo } from '../viewers/GetInfo';
import { WallpaperPicker } from '../viewers/WallpaperPicker';
import { WelcomeReadMe } from '../viewers/WelcomeReadMe';
import { SearchWindow } from '../viewers/SearchWindow';
import { PreferencesWindow } from '../viewers/PreferencesWindow';
import { AppearancePanel } from '../viewers/AppearancePanel';
import { CSSEditor } from '../viewers/CSSEditor';
import { BazaarWindow } from '../viewers/BazaarWindow';
import { CursorCreator } from '../viewers/CursorCreator';
import { ShareDialog } from '../viewers/ShareDialog';
import { ProfileWindow } from '../viewers/ProfileWindow';
import { AgentChatWindow } from '../viewers/AgentChatWindow';
import { FolderView } from './FolderView';
import { TrashView } from './TrashView';
import { WidgetRenderer } from '../widgets';
import type { DesktopItem } from '../../types';

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

  return (
    <>
      {windows.map((win) => {
        // Compute eos- values for the window
        const sourceItems = isVisitorMode && visitorItems ? visitorItems : items;
        const item = win.contentId ? sourceItems.find((i) => i.id === win.contentId) : undefined;
        const eosName = item ? slugify(item.name) : slugify(win.title);
        const eosType = item?.type || win.contentType;
        const eosExtension = item ? getItemExtension(item) : undefined;
        const parentItem = item?.parentId ? sourceItems.find((i) => i.id === item.parentId) : undefined;
        const eosFolder = parentItem ? slugify(parentItem.name) : undefined;

        return (
        <Window
          key={win.id}
          id={win.id}
          title={win.title}
          position={win.position}
          size={win.size}
          zIndex={win.zIndex}
          minimized={win.minimized}
          collapsed={win.collapsed}
          isActive={win.id === activeWindowId}
          contentType={win.contentType}
          contentId={win.contentId}
          eosName={eosName}
          eosType={eosType}
          eosExtension={eosExtension}
          eosFolder={eosFolder}
        >
          {/* Window content will be rendered based on contentType */}
          <WindowContent
            windowId={win.id}
            contentType={win.contentType}
            contentId={win.contentId}
            isVisitorMode={isVisitorMode}
            visitorItems={visitorItems}
            folderWindowDropTargetId={folderWindowDropTargetId}
            ownerUid={ownerUid}
          />
        </Window>
        );
      })}
    </>
  );
}

/**
 * Renders content inside a window based on its type
 * Uses real viewers for images and text, folder view for folders
 */
function WindowContent({
  windowId,
  contentType,
  contentId,
  isVisitorMode = false,
  visitorItems,
  folderWindowDropTargetId,
  ownerUid,
}: {
  windowId: string;
  contentType: string;
  contentId?: string;
  isVisitorMode?: boolean;
  visitorItems?: DesktopItem[];
  folderWindowDropTargetId?: string | null;
  ownerUid?: string;
}) {
  // Subscribe to the specific item by contentId so the component re-renders
  // when the item data changes (e.g., after API fetch replaces cached items).
  // Using getItem(fn ref) alone won't trigger re-renders on item changes.
  const item = useDesktopStore((state) =>
    contentId && !isVisitorMode ? state.items.find((i) => i.id === contentId) : undefined
  ) ?? (contentId && isVisitorMode && visitorItems
    ? visitorItems.find((i) => i.id === contentId)
    : undefined);

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
      if (!item) {
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              backgroundColor: 'var(--platinum)',
            }}
          >
            <p style={{ color: 'var(--shadow)', fontSize: '12px' }}>Image not found</p>
          </div>
        );
      }
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
      if (!item) {
        return (
          <div
            style={{
              padding: '8px',
              fontFamily: 'var(--font-monaco)',
              fontSize: '12px',
            }}
          >
            <p style={{ color: 'var(--shadow)' }}>Text file not found</p>
          </div>
        );
      }
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
      if (!item) {
        return (
          <div
            style={{
              padding: '8px',
              fontFamily: 'var(--font-monaco)',
              fontSize: '12px',
            }}
          >
            <p style={{ color: 'var(--shadow)' }}>Markdown file not found</p>
          </div>
        );
      }
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
      if (!item) {
        return (
          <div
            style={{
              padding: '8px',
              fontFamily: 'var(--font-monaco)',
              fontSize: '12px',
            }}
          >
            <p style={{ color: 'var(--shadow)' }}>Code file not found</p>
          </div>
        );
      }
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
      if (!item) {
        return (
          <div
            style={{
              padding: '12px',
              fontFamily: 'var(--font-geneva)',
              fontSize: '11px',
              color: 'var(--shadow)',
            }}
          >
            Item not found
          </div>
        );
      }
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
            Version 0.1.0
          </p>
        </div>
      );

    case 'wallpaper':
      return <WallpaperPicker />;

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

    case 'trash':
      return <TrashView />;

    case 'audio':
      if (!item) {
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              backgroundColor: 'var(--platinum)',
            }}
          >
            <p style={{ color: 'var(--shadow)', fontSize: '12px' }}>Audio file not found</p>
          </div>
        );
      }
      return <AudioPlayer itemId={item.id} r2Key={item.r2Key} name={item.name} />;

    case 'video':
      if (!item) {
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              backgroundColor: '#000',
            }}
          >
            <p style={{ color: 'var(--white)', fontSize: '12px' }}>Video file not found</p>
          </div>
        );
      }
      return <VideoPlayer itemId={item.id} r2Key={item.r2Key} name={item.name} />;

    case 'pdf':
      if (!item) {
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              backgroundColor: 'var(--platinum)',
            }}
          >
            <p style={{ color: 'var(--black)', fontSize: '12px' }}>PDF file not found</p>
          </div>
        );
      }
      return <PDFViewer itemId={item.id} r2Key={item.r2Key} name={item.name} />;

    case 'calculator':
      return <Calculator />;

    case 'clock':
      return <Clock />;

    case 'link':
      if (!item) {
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              backgroundColor: 'var(--platinum)',
            }}
          >
            <p style={{ color: 'var(--shadow)', fontSize: '12px' }}>Link not found</p>
          </div>
        );
      }
      return <WebsiteViewer itemId={item.id} url={item.url} name={item.name} />;

    case 'widget':
      if (!item) {
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              backgroundColor: 'var(--platinum)',
            }}
          >
            <p style={{ color: 'var(--shadow)', fontSize: '12px' }}>Widget not found</p>
          </div>
        );
      }
      return <WidgetRenderer item={item} isOwner={!isVisitorMode} ownerUid={ownerUid} />;

    case 'share-dialog':
      return <ShareDialog isOwner={!isVisitorMode} />;

    case 'profile':
      return <ProfileWindow isOwner={!isVisitorMode} />;

    case 'agent-chat':
      return <AgentChatWindow />;

    default:
      return null;
  }
}
