import { openAppearance } from '../../utils/openAppearance';
import { BarModules } from './BarModules';
import { barFromTokens } from '../../utils/riceInfo';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { openAppSkins } from '../../utils/appWindowBus';
import { useState, useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type FocusEvent as ReactFocusEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWindowStore } from '../../stores/windowStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { useAuthStore } from '../../stores/authStore';
import { useClipboardStore } from '../../stores/clipboardStore';
import { useAlertStore } from '../../stores/alertStore';
import { isApiConfigured } from '../../services/api';
import { downloadDesktopExport } from '../../utils/exportDesktop';
import { isModalOpen } from '../../utils/modalGate';
import type { MenuItem } from '../../types';
import { MenuBarDropdown } from './MenuBarDropdown';
import styles from './MenuBar.module.css';

// The top-level menus, in display order. Keyboard navigation (F10, Left/
// Right) walks this list; it must match the keys of `menus` below.
const MENU_NAMES = ['apple', 'file', 'edit', 'view', 'special'] as const;
type MenuName = (typeof MENU_NAMES)[number];

// True when the keydown's target is a text control — an input, textarea,
// select, or anything inside a contenteditable root: the keystroke belongs
// to that control, not the menu commands. Mirrors the desktop shortcuts'
// rule (`isTextEditingTarget` in desktopKeyboard.ts), extended with SELECT
// (a focused <select> owns its keys the same way). Tag names instead of
// `instanceof HTMLInputElement`/`HTMLTextAreaElement` — identical semantics
// in the browser (those are exactly the INPUT/TEXTAREA tags), and it also
// runs under the repo's node-env test DOM, where those globals don't
// exist. The contenteditable check walks ancestors because the caret can
// sit in a descendant of the editable root, and the attribute read covers
// the test DOM, for the same reasons as in desktopKeyboard.ts.
const ELEMENT_NODE = 1;
function isTextControlTarget(target: EventTarget | null): boolean {
  const start = target as Node | null;
  if (start && start.nodeType === ELEMENT_NODE) {
    const tag = (start as Element).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  }
  for (let node = start; node; node = node.parentNode) {
    if (node.nodeType !== ELEMENT_NODE) continue;
    const candidate = node as Element;
    if ((candidate as HTMLElement).isContentEditable) return true;
    const declared = candidate.getAttribute('contenteditable');
    if (declared === 'true' || declared === '') return true;
  }
  return false;
}

/**
 * Classic Mac OS-style Menu Bar
 * Features:
 * - Fixed top position, 20px tall, white background
 * - Apple icon + File, Edit, View, Special menus
 * - Click to open dropdown, hover to switch between menus
 * - Inverted colors on hover (black bg, white text)
 * - Keyboard shortcuts display
 * - Keyboard-operable WAI-ARIA menubar: F10 focuses it, Left/Right move
 *   between the top-level menus (wrapping), Down/Enter/Space open a menu,
 *   and the open dropdown supports the shared roving-focus menu keys
 *   (arrows/Home/End wrap and skip disabled items, Enter/Space activate).
 *   Escape closes the dropdown and returns focus to the top-level item; a
 *   second Escape restores focus to where it was before F10.
 * - The document-level shortcuts stand down while any aria-modal dialog is
 *   open (F10 and the ⌘-commands alike — a modal owns the keyboard, shared
 *   modalGate signal), and the ⌘-commands stand down while focus is in a
 *   text control (input/textarea/select/contenteditable), like the desktop
 *   shortcuts.
 */
export function MenuBar() {
  // Field-level selectors: a whole-store subscription re-rendered the menu
  // bar on every unrelated store change (drag frames, upload progress...).
  // Store actions are stable references, so selecting them is free.
  const windows = useWindowStore((s) => s.windows);
  const closeWindow = useWindowStore((s) => s.closeWindow);
  const getTopWindow = useWindowStore((s) => s.getTopWindow);
  const openWindow = useWindowStore((s) => s.openWindow);
  const selectedIds = useDesktopStore((s) => s.selectedIds);
  const items = useDesktopStore((s) => s.items);
  const addItem = useDesktopStore((s) => s.addItem);
  const deselectAll = useDesktopStore((s) => s.deselectAll);
  const selectAll = useDesktopStore((s) => s.selectAll);
  const cleanUp = useDesktopStore((s) => s.cleanUp);
  const sortByName = useDesktopStore((s) => s.sortByName);
  const sortByDate = useDesktopStore((s) => s.sortByDate);
  const sortByKind = useDesktopStore((s) => s.sortByKind);
  const pasteItems = useDesktopStore((s) => s.pasteItems);
  const duplicateItems = useDesktopStore((s) => s.duplicateItems);
  const emptyTrash = useDesktopStore((s) => s.emptyTrash);
  const getTrashCount = useDesktopStore((s) => s.getTrashCount);
  const profile = useAuthStore((s) => s.profile);
  const logout = useAuthStore((s) => s.logout);
  const clipboard = useClipboardStore((s) => s.clipboard);
  const cut = useClipboardStore((s) => s.cut);
  const copy = useClipboardStore((s) => s.copy);
  const clearClipboard = useClipboardStore((s) => s.clear);
  const hasClipboardItems = clipboard !== null && clipboard.itemIds.length > 0;
  const showConfirm = useAlertStore((s) => s.showConfirm);
  const navigate = useNavigate();

  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  // The top-level menu holding (or entitled to) the menubar's roving focus.
  // Null while the menubar isn't focused — the top-level items are then not
  // Tab stops (the desktop owns plain Tab for icon navigation); F10 is the
  // documented way in.
  const [focusedMenu, setFocusedMenu] = useState<MenuName | null>(null);
  const barStyle = useAppearanceStore((state) => barFromTokens(state.appearance.designTokens).style);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const topItemRefs = useRef<Partial<Record<MenuName, HTMLDivElement | null>>>({});
  // Where focus was before F10 moved it into the menubar; the second Escape
  // returns to it.
  const preMenubarFocusRef = useRef<HTMLElement | null>(null);

  // ============================================
  // MENU ACTIONS (defined before useEffect)
  // ============================================

  const handleNewFolder = useCallback(() => {
    // Check if top window is a folder — if so, create inside it
    const topWindow = getTopWindow();
    const targetParentId = topWindow && topWindow.contentType === 'folder' && topWindow.contentId
      ? topWindow.contentId
      : null;

    // Find next available position within the target folder/desktop
    const siblingItems = items.filter((item) => item.parentId === targetParentId && !item.isTrashed);
    let maxY = -1;
    siblingItems.forEach((item) => {
      if (item.position.x === 0 && item.position.y > maxY) {
        maxY = item.position.y;
      }
    });

    const newFolder = {
      id: `folder-${Date.now()}`,
      type: 'folder' as const,
      name: 'Untitled Folder',
      parentId: targetParentId,
      position: { x: 0, y: maxY + 1 },
      isPublic: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    addItem(newFolder);
    setActiveMenu(null);
  }, [items, addItem, getTopWindow]);

  const handleCloseWindow = useCallback(() => {
    const topWindow = getTopWindow();
    if (topWindow) {
      closeWindow(topWindow.id);
    }
    setActiveMenu(null);
  }, [getTopWindow, closeWindow]);

  const handleTrashSelected = useCallback(() => {
    // Move selected items to trash (soft delete)
    if (selectedIds.size === 0) return;
    const { moveToTrash } = useDesktopStore.getState();
    moveToTrash(Array.from(selectedIds));
    deselectAll();
    setActiveMenu(null);
  }, [selectedIds, deselectAll]);

  const handleEmptyTrash = useCallback(() => {
    const trashCount = getTrashCount();
    if (trashCount === 0) {
      setActiveMenu(null);
      return;
    }

    showConfirm(
      `Are you sure you want to permanently delete ${trashCount} item${trashCount > 1 ? 's' : ''} in the Trash? This cannot be undone.`,
      () => {
        emptyTrash();
      },
      undefined,
      'Empty Trash'
    );
    setActiveMenu(null);
  }, [getTrashCount, emptyTrash, showConfirm]);

  const handleAbout = useCallback(() => {
    openWindow({
      id: 'about-eternalos',
      title: 'About EternalOS',
      position: { x: 150, y: 100 },
      size: { width: 300, height: 200 },
      minimized: false,
      maximized: false,
      contentType: 'about',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handlePreviewAsVisitor = useCallback(() => {
    if (profile?.username) {
      // Open visitor view in new tab with ?visitor flag to force visitor mode
      // even when logged in as the same user
      window.open(`/@${profile.username}?visitor=true`, '_blank');
    }
    setActiveMenu(null);
  }, [profile]);

  const handleOpenCalculator = useCallback(() => {
    openWindow({
      id: 'calculator',
      title: 'Calculator',
      position: { x: 200, y: 100 },
      size: { width: 200, height: 280 },
      minimized: false,
      maximized: false,
      contentType: 'calculator',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenFetch = useCallback(() => {
    openWindow({
      id: 'fetch',
      title: 'About This Desktop',
      position: { x: 180, y: 90 },
      size: { width: 560, height: 390 },
      minimized: false,
      maximized: false,
      contentType: 'fetch',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenClock = useCallback(() => {
    openWindow({
      id: 'clock',
      title: 'Clock',
      position: { x: 250, y: 80 },
      size: { width: 160, height: 220 },
      minimized: false,
      maximized: false,
      contentType: 'clock',
    });
    setActiveMenu(null);
  }, [openWindow]);

  // Wallpaper lives in the Appearance hub now.
  const handleOpenWallpaperPicker = useCallback(() => {
    openAppearance('desktop');
    setActiveMenu(null);
  }, []);

  const handleOpenPreferences = useCallback(() => {
    openWindow({
      id: 'preferences-window',
      title: 'Settings',
      position: { x: 88, y: 34 },
      size: { width: 520, height: 620 },
      minimized: false,
      maximized: false,
      contentType: 'preferences',
    });
    setActiveMenu(null);
  }, [openWindow]);

  // Skins panel of the frontmost app window (also: right-click its title bar).
  const topAppWindowId = [...windows].filter((w) => w.contentType === 'app' && !w.minimized).sort((a, b) => b.zIndex - a.zIndex)[0]?.id;
  const handleOpenAppSkins = useCallback(() => {
    if (topAppWindowId) openAppSkins(topAppWindowId);
    setActiveMenu(null);
  }, [topAppWindowId]);

  const handleOpenAppearance = useCallback(() => {
    openAppearance();
    setActiveMenu(null);
  }, []);

  const handleOpenBazaar = useCallback(() => {
    openWindow({
      id: 'bazaar-window',
      title: 'Bazaar',
      position: { x: 140, y: 70 },
      size: { width: 500, height: 420 },
      minimized: false,
      maximized: false,
      contentType: 'bazaar',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenCursorCreator = useCallback(() => {
    openWindow({
      id: 'cursor-creator',
      title: 'Cursor Creator',
      position: { x: 120, y: 50 },
      size: { width: 460, height: 520 },
      minimized: false,
      maximized: false,
      contentType: 'cursor-creator',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenCSSEditor = useCallback(() => {
    openWindow({
      id: 'css-editor',
      title: 'Custom CSS',
      position: { x: 80, y: 50 },
      size: { width: 520, height: 500 },
      minimized: false,
      maximized: false,
      contentType: 'css-editor',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenGameConsole = useCallback(() => {
    openWindow({
      id: 'console-player-demo',
      title: 'Game Console',
      position: { x: 160, y: 60 },
      size: { width: 420, height: 460 },
      minimized: false,
      maximized: false,
      contentType: 'console-player',
      contentId: 'demo',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenCartridgeStudio = useCallback(() => {
    openWindow({
      id: 'cartridge-editor',
      title: 'Cartridge Studio',
      position: { x: 70, y: 45 },
      size: { width: 860, height: 600 },
      minimized: false,
      maximized: false,
      contentType: 'cartridge-editor',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenDeveloperStudio = useCallback(() => {
    openWindow({
      id: 'developer-studio',
      title: 'Developer Studio',
      position: { x: 60, y: 40 },
      size: { width: 750, height: 550 },
      minimized: false,
      maximized: false,
      contentType: 'developer-studio',
    });
    setActiveMenu(null);
  }, [openWindow]);


  const handleShareDesktop = useCallback(() => {
    openWindow({
      id: 'share-dialog',
      title: 'Share Desktop',
      position: { x: 150, y: 100 },
      size: { width: 340, height: 420 },
      minimized: false,
      maximized: false,
      contentType: 'share-dialog',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenAgentChat = useCallback(() => {
    openWindow({
      id: 'agent-chat',
      title: 'Ask Eternal',
      position: { x: 48, y: 34 },
      size: { width: 920, height: 620 },
      minimized: false,
      maximized: false,
      contentType: 'agent-chat',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpen = useCallback(() => {
    // Open each selected item
    if (selectedIds.size === 0) return;

    selectedIds.forEach((id) => {
      const item = items.find((i) => i.id === id);
      if (!item) return;

      if (item.type === 'folder') {
        openWindow({
          id: `folder-${item.id}`,
          title: item.name,
          position: { x: 100 + Math.random() * 100, y: 100 + Math.random() * 100 },
          size: { width: 400, height: 300 },
          minimized: false,
          maximized: false,
          contentType: 'folder',
          contentId: item.id,
        });
      } else if (item.type === 'text') {
        openWindow({
          id: `text-${item.id}`,
          title: item.name,
          position: { x: 150 + Math.random() * 100, y: 120 + Math.random() * 100 },
          size: { width: 400, height: 300 },
          minimized: false,
          maximized: false,
          contentType: 'text',
          contentId: item.id,
        });
      } else if (item.type === 'image') {
        openWindow({
          id: `image-${item.id}`,
          title: item.name,
          position: { x: 120 + Math.random() * 100, y: 80 + Math.random() * 100 },
          size: { width: 450, height: 350 },
          minimized: false,
          maximized: false,
          contentType: 'image',
          contentId: item.id,
        });
      } else if (item.type === 'audio') {
        openWindow({
          id: `audio-${item.id}`,
          title: item.name,
          position: { x: 140 + Math.random() * 100, y: 100 + Math.random() * 100 },
          size: { width: 320, height: 240 },
          minimized: false,
          maximized: false,
          contentType: 'audio',
          contentId: item.id,
        });
      } else if (item.type === 'video') {
        openWindow({
          id: `video-${item.id}`,
          title: item.name,
          position: { x: 100 + Math.random() * 100, y: 80 + Math.random() * 100 },
          size: { width: 480, height: 360 },
          minimized: false,
          maximized: false,
          contentType: 'video',
          contentId: item.id,
        });
      } else if (item.type === 'pdf') {
        openWindow({
          id: `pdf-${item.id}`,
          title: item.name,
          position: { x: 80 + Math.random() * 100, y: 40 + Math.random() * 80 },
          size: { width: 550, height: 700 },
          minimized: false,
          maximized: false,
          contentType: 'pdf',
          contentId: item.id,
        });
      } else if (item.type === 'link') {
        openWindow({
          id: `link-${item.id}`,
          title: item.name,
          position: { x: 80 + Math.random() * 100, y: 60 + Math.random() * 80 },
          size: { width: 640, height: 480 },
          minimized: false,
          maximized: false,
          contentType: 'link',
          contentId: item.id,
        });
      } else if (item.type === 'widget') {
        openWindow({
          id: `widget-${item.id}`,
          title: item.name,
          position: { x: 100 + Math.random() * 100, y: 80 + Math.random() * 80 },
          size: { width: 250, height: 250 },
          minimized: false,
          maximized: false,
          contentType: 'widget',
          contentId: item.id,
        });
      }
    });
    setActiveMenu(null);
  }, [selectedIds, items, openWindow]);

  const handleGetInfo = useCallback(() => {
    if (selectedIds.size === 0) return;

    // Open Get Info window for first selected item
    const firstId = Array.from(selectedIds)[0];
    const item = items.find((i) => i.id === firstId);
    if (!item) return;

    openWindow({
      id: `info-${item.id}`,
      title: `${item.name} Info`,
      position: { x: 200, y: 150 },
      size: { width: 280, height: 320 },
      minimized: false,
      maximized: false,
      contentType: 'get-info',
      contentId: item.id,
    });
    setActiveMenu(null);
  }, [selectedIds, items, openWindow]);

  const handleSelectAll = useCallback(() => {
    // Select all items on the desktop (root level)
    selectAll(null);
    setActiveMenu(null);
  }, [selectAll]);

  const handleCleanUp = useCallback(() => {
    // Arrange icons in a neat grid (focused folder or desktop)
    const topWindow = getTopWindow();
    const targetFolder = topWindow && topWindow.contentType === 'folder' && topWindow.contentId
      ? topWindow.contentId
      : null;
    cleanUp(targetFolder);
    setActiveMenu(null);
  }, [cleanUp, getTopWindow]);

  // Get the focused folder from the top window (if it's a folder window)
  const getFocusedFolder = useCallback((): string | null => {
    const topWindow = getTopWindow();
    if (topWindow && topWindow.contentType === 'folder' && topWindow.contentId) {
      return topWindow.contentId;
    }
    return null;
  }, [getTopWindow]);

  const handleCut = useCallback(() => {
    if (selectedIds.size === 0) return;
    cut(Array.from(selectedIds), getFocusedFolder());
    setActiveMenu(null);
  }, [selectedIds, cut, getFocusedFolder]);

  const handleCopy = useCallback(() => {
    if (selectedIds.size === 0) return;
    copy(Array.from(selectedIds), getFocusedFolder());
    setActiveMenu(null);
  }, [selectedIds, copy, getFocusedFolder]);

  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    await pasteItems(clipboard.itemIds, clipboard.isCut, getFocusedFolder());
    if (clipboard.isCut) {
      clearClipboard();
    }
    setActiveMenu(null);
  }, [clipboard, pasteItems, clearClipboard, getFocusedFolder]);

  const handleDuplicate = useCallback(async () => {
    if (selectedIds.size === 0) return;
    await duplicateItems(Array.from(selectedIds), getFocusedFolder());
    setActiveMenu(null);
  }, [selectedIds, duplicateItems, getFocusedFolder]);

  // Helper to get the target folder for sorting
  // If top window is a folder, sort that folder; otherwise sort desktop
  const getTargetFolderForSort = useCallback((): string | null => {
    const topWindow = getTopWindow();
    if (topWindow && topWindow.contentType === 'folder' && topWindow.contentId) {
      return topWindow.contentId;
    }
    return null; // Desktop
  }, [getTopWindow]);

  const handleSortByName = useCallback(() => {
    const targetFolder = getTargetFolderForSort();
    sortByName(targetFolder);
    setActiveMenu(null);
  }, [sortByName, getTargetFolderForSort]);

  const handleSortByDate = useCallback(() => {
    const targetFolder = getTargetFolderForSort();
    sortByDate(targetFolder);
    setActiveMenu(null);
  }, [sortByDate, getTargetFolderForSort]);

  const handleSortByKind = useCallback(() => {
    const targetFolder = getTargetFolderForSort();
    sortByKind(targetFolder);
    setActiveMenu(null);
  }, [sortByKind, getTargetFolderForSort]);

  const handleFind = useCallback(() => {
    openWindow({
      id: 'find-window',
      title: 'Find',
      position: { x: 180, y: 72 },
      size: { width: 640, height: 420 },
      minimized: false,
      maximized: false,
      contentType: 'search',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleLogout = useCallback(async () => {
    setActiveMenu(null);
    await logout();
    navigate('/login');
  }, [logout, navigate]);

  const handleExportDesktop = useCallback(() => {
    downloadDesktopExport({
      items,
      username: profile?.username || 'user',
      wallpaper: profile?.wallpaper || 'default',
    });
    setActiveMenu(null);
  }, [items, profile]);

  // ============================================
  // MENUBAR KEYBOARD NAVIGATION (WAI-ARIA menubar)
  // ============================================

  // F10 focuses the menubar (first top-level entry). Nothing else in the app
  // binds F10 (existing bindings are ⌘+letter / ⌘⌫ / ⌘` and the desktop's
  // Tab/Enter/arrows), and F10 is the WAI-ARIA APG menubar convention on
  // Windows/Linux. Already focused inside the menubar: keep position, and
  // never let a second F10 overwrite the saved restore target.
  const focusMenuBar = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && menuBarRef.current?.contains(active)) {
      return;
    }
    preMenubarFocusRef.current = active;
    setFocusedMenu(MENU_NAMES[0]);
    topItemRefs.current[MENU_NAMES[0]]?.focus();
  }, []);

  // Restore focus to where it was before the menubar was focused.
  const exitMenuBar = useCallback(() => {
    const opener = preMenubarFocusRef.current;
    preMenubarFocusRef.current = null;
    setFocusedMenu(null);
    if (opener && document.contains(opener)) {
      opener.focus();
    }
  }, []);

  // Down/Enter/Space on a top-level item: open its dropdown. The dropdown
  // takes focus on mount (first enabled item) through the shared roving
  // helper, like ContextMenu.
  const openMenu = useCallback((name: MenuName) => {
    setActiveMenu(name);
  }, []);

  // Left/Right: move to the neighboring top-level menu, wrapping. While a
  // dropdown is open (from the dropdown itself, or the transient state where
  // focus is on a title), the open state follows to the next menu, and its
  // dropdown takes the focus.
  const switchTopLevel = useCallback(
    (from: MenuName, direction: 1 | -1) => {
      const count = MENU_NAMES.length;
      const next = MENU_NAMES[(MENU_NAMES.indexOf(from) + direction + count) % count];
      setFocusedMenu(next);
      topItemRefs.current[next]?.focus();
      if (activeMenu) {
        setActiveMenu(next);
      }
    },
    [activeMenu]
  );

  // Keys pressed on a focused top-level item. (Keys pressed inside the open
  // dropdown are handled by MenuBarDropdown and stopped there.)
  const handleTopLevelKeyDown = useCallback(
    (event: ReactKeyboardEvent, name: MenuName) => {
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          switchTopLevel(name, 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          switchTopLevel(name, -1);
          break;
        case 'ArrowDown':
        case 'Enter':
        case ' ':
          event.preventDefault();
          openMenu(name);
          break;
        case 'Escape':
          event.preventDefault();
          if (activeMenu === name) {
            // Close the dropdown; focus stays on this top-level item.
            setActiveMenu(null);
          } else {
            // Second Escape (or Escape with nothing open): leave the menubar
            // and restore the pre-F10 focus.
            exitMenuBar();
          }
          break;
        default:
          break;
      }
    },
    [switchTopLevel, openMenu, activeMenu, exitMenuBar]
  );

  // Escape inside a dropdown: close it and return focus to the top-level item.
  const handleDropdownEscape = useCallback((name: string) => {
    setActiveMenu(null);
    topItemRefs.current[name as MenuName]?.focus();
  }, []);

  // Left/Right inside a dropdown: switch to the neighboring menu, open.
  const handleDropdownSwitch = useCallback((name: string, direction: 1 | -1) => {
    switchTopLevel(name as MenuName, direction);
  }, [switchTopLevel]);

  // When focus leaves the menubar entirely, drop the roving-tabindex marker.
  // (Focus events bubble, so the open dropdown's own focus never trips this —
  // only a relatedTarget outside the menubar does.)
  const handleTopLevelBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    if (!menuBarRef.current?.contains(event.relatedTarget as Node | null)) {
      setFocusedMenu(null);
    }
  }, []);

  // ============================================
  // EFFECTS
  // ============================================

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };

    if (activeMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [activeMenu]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // An open modal owns the keyboard: the whole handler stands down —
      // F10 must not pull focus into the menubar from under a dialog, and
      // the ⌘-commands must not act on the desktop behind one (⌘⌫ used to
      // trash the selection under an AlertDialog's confirm). One shared
      // signal, the same one the desktop shortcuts gate on
      // (utils/modalGate — see desktopKeyboard.ts), not a second mechanism.
      if (isModalOpen()) return;

      // F10 focuses the menubar — the documented menubar shortcut (see
      // focusMenuBar). No modifiers: Shift+F10 stays the context-menu key.
      if (e.key === 'F10' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        focusMenuBar();
        return;
      }

      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta) return;

      // Focus is in a text control: its keys belong to it. The native
      // clipboard/editing shortcuts reach the control untouched, and no
      // menu command fires from under the field (⌘⌫ used to trash the
      // desktop selection while the user was editing text) — the same rule
      // the desktop shortcuts follow (desktopKeyboard.ts).
      if (isTextControlTarget(e.target)) return;

      if (e.key === 'n') {
        e.preventDefault();
        handleNewFolder();
      } else if (e.key === 'o') {
        e.preventDefault();
        handleOpen();
      } else if (e.key === 'w') {
        e.preventDefault();
        handleCloseWindow();
      } else if (e.key === 'i') {
        e.preventDefault();
        handleGetInfo();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        handleTrashSelected();
      } else if (e.key === 'a') {
        e.preventDefault();
        handleSelectAll();
      } else if (e.key === 'x') {
        e.preventDefault();
        handleCut();
      } else if (e.key === 'c') {
        e.preventDefault();
        handleCopy();
      } else if (e.key === 'v') {
        e.preventDefault();
        handlePaste();
      } else if (e.key === 'd') {
        e.preventDefault();
        handleDuplicate();
      } else if (e.key === 'f') {
        e.preventDefault();
        handleFind();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [focusMenuBar, handleNewFolder, handleOpen, handleCloseWindow, handleGetInfo, handleTrashSelected, handleSelectAll, handleCut, handleCopy, handlePaste, handleDuplicate, handleFind]);

  // ============================================
  // OTHER HANDLERS
  // ============================================

  // Menu click handler - toggle or switch menus
  const handleMenuClick = useCallback((menuName: string) => {
    setActiveMenu((current) => (current === menuName ? null : menuName));
  }, []);

  // Menu hover - switch to hovered menu if another is already open
  const handleMenuHover = useCallback((menuName: string) => {
    if (activeMenu && activeMenu !== menuName) {
      setActiveMenu(menuName);
    }
  }, [activeMenu]);

  const handleDropdownItemClick = useCallback((item: MenuItem) => {
    if (item.disabled || item.divider) return;
    if (item.action) {
      item.action();
    }
    setActiveMenu(null);
  }, []);

  // Duplicate skips installed apps (duplicateItems refuses them: they are
  // created and managed by the app install flow), so the command only
  // applies when the selection holds something duplicatable.
  const selectionIsOnlyApps = selectedIds.size > 0 && Array.from(selectedIds)
    .every((id) => items.find((item) => item.id === id)?.type === 'app');

  // ============================================
  // MENU DEFINITIONS
  // ============================================

  const menus: Record<MenuName, MenuItem[]> = {
    apple: [
      { label: 'About EternalOS...', action: handleAbout },
      { divider: true, label: '' },
      { label: 'Settings...', action: handleOpenPreferences },
    ],
    file: [
      { label: 'New Folder', shortcut: '⌘N', action: handleNewFolder },
      { divider: true, label: '' },
      { label: 'Open', shortcut: '⌘O', action: handleOpen, disabled: selectedIds.size === 0 },
      { label: 'Close Window', shortcut: '⌘W', action: handleCloseWindow, disabled: windows.length === 0 },
      { divider: true, label: '' },
      { label: 'Get Info', shortcut: '⌘I', action: handleGetInfo, disabled: selectedIds.size === 0 },
      { label: 'Find...', shortcut: '⌘F', action: handleFind },
      { divider: true, label: '' },
      { label: 'Export Desktop...', action: handleExportDesktop },
    ],
    edit: [
      { label: 'Cut', shortcut: '⌘X', action: handleCut, disabled: selectedIds.size === 0 },
      { label: 'Copy', shortcut: '⌘C', action: handleCopy, disabled: selectedIds.size === 0 },
      { label: 'Paste', shortcut: '⌘V', action: handlePaste, disabled: !hasClipboardItems },
      { label: 'Duplicate', shortcut: '⌘D', action: handleDuplicate, disabled: selectedIds.size === 0 || selectionIsOnlyApps },
      { divider: true, label: '' },
      { label: 'Select All', shortcut: '⌘A', action: handleSelectAll },
    ],
    view: [
      { label: 'Sort by Name', action: handleSortByName },
      { label: 'Sort by Date', action: handleSortByDate },
      { label: 'Sort by Kind', action: handleSortByKind },
      { divider: true, label: '' },
      { label: 'Clean Up', action: handleCleanUp },
    ],
    special: [
      { label: 'Bazaar...', action: handleOpenBazaar },
      { divider: true, label: '' },
      { label: 'About Me...', action: () => {
        const { openWindow } = useWindowStore.getState();
        openWindow({
          id: 'profile-window',
          title: 'About Me',
          position: { x: 150, y: 100 },
          size: { width: 340, height: 420 },
          minimized: false,
          maximized: false,
          contentType: 'profile',
        });
      }},
      { divider: true, label: '' },
      { label: 'Calculator', action: handleOpenCalculator },
      { label: 'Clock', action: handleOpenClock },
      { label: 'Ask Eternal...', action: handleOpenAgentChat, disabled: !isApiConfigured },
      { divider: true, label: '' },
      { label: 'About This Desktop...', action: handleOpenFetch },
      { label: 'Appearance...', action: handleOpenAppearance },
      { label: 'App Skins...', action: handleOpenAppSkins, disabled: !topAppWindowId },
      { label: 'Cursor Creator...', action: handleOpenCursorCreator },
      { label: 'Custom CSS...', action: handleOpenCSSEditor },
      { label: 'Developer Studio...', action: handleOpenDeveloperStudio },
      { label: 'Game Console...', action: handleOpenGameConsole },
      { label: 'Cartridge Studio...', action: handleOpenCartridgeStudio, disabled: !isApiConfigured },

      { label: 'Wallpaper...', action: handleOpenWallpaperPicker },
      { label: 'Settings...', action: handleOpenPreferences },
      { divider: true, label: '' },
      { label: 'Empty Trash...', action: handleEmptyTrash },
      { divider: true, label: '' },
      { label: 'Share Desktop...', action: handleShareDesktop, disabled: !profile?.username },
      { label: 'Preview as Visitor', action: handlePreviewAsVisitor, disabled: !profile?.username },
      { divider: true, label: '' },
      { label: 'Log Out', action: handleLogout, disabled: !isApiConfigured },
    ],
  };

  // Render one top-level menubar entry (the five entries share all keyboard
  // and ARIA wiring; only the label content and the apple class differ).
  const renderTopLevel = (name: MenuName, label: ReactNode) => (
    <div
      ref={(el) => { topItemRefs.current[name] = el; }}
      className={`${styles.menuItem} ${name === 'apple' ? styles.appleMenu : ''} ${activeMenu === name ? styles.active : ''}`}
      role="menuitem"
      tabIndex={focusedMenu === name ? 0 : -1}
      aria-haspopup="menu"
      aria-expanded={activeMenu === name}
      aria-label={name === 'apple' ? 'Apple' : undefined}
      onClick={() => handleMenuClick(name)}
      onMouseEnter={() => handleMenuHover(name)}
      onFocus={() => setFocusedMenu(name)}
      onBlur={handleTopLevelBlur}
      onKeyDown={(event) => handleTopLevelKeyDown(event, name)}
    >
      {label}
      {activeMenu === name && (
        <MenuBarDropdown
          menuName={name}
          items={menus[name]}
          onActivate={handleDropdownItemClick}
          onEscape={handleDropdownEscape}
          onSwitchMenu={handleDropdownSwitch}
        />
      )}
    </div>
  );

  return (
    <div
      className={`${styles.menuBar} menuBar ${barStyle === 'floating' ? styles.floatingBar : barStyle === 'transparent' ? styles.transparentBar : ''}`}
      eos-name="menubar"
      role="menubar"
      aria-label="Main menu"
      ref={menuBarRef}
    >
      {renderTopLevel('apple', <AppleIcon />)}
      {renderTopLevel('file', 'File')}
      {renderTopLevel('edit', 'Edit')}
      {renderTopLevel('view', 'View')}
      {renderTopLevel('special', 'Special')}

      {/* Right side: polybar-style modules (Appearance → Bar & Widgets) */}
      <BarModules onOpenBazaar={handleOpenBazaar} />
    </div>
  );
}

/**
 * Custom EternalOS logo icon for the menu bar
 */
function AppleIcon() {
  return (
    <span className={styles.appleIconSvg}>𐬽𐬻𐬽𐬻𐬽</span>
  );
}
