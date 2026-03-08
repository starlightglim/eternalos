import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWindowStore } from '../../stores/windowStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { useAuthStore } from '../../stores/authStore';
import { useClipboardStore } from '../../stores/clipboardStore';
import { useAlertStore } from '../../stores/alertStore';
import { isApiConfigured } from '../../services/api';
import { downloadDesktopExport } from '../../utils/exportDesktop';
import type { MenuItem } from '../../types';
import styles from './MenuBar.module.css';

/**
 * Classic Mac OS-style Menu Bar
 * Features:
 * - Fixed top position, 20px tall, white background
 * - Apple icon + File, Edit, View, Special menus
 * - Click to open dropdown, hover to switch between menus
 * - Inverted colors on hover (black bg, white text)
 * - Keyboard shortcuts display
 */
export function MenuBar() {
  const { windows, closeWindow, getTopWindow, openWindow } = useWindowStore();
  const { selectedIds, addItem, items, deselectAll, selectAll, cleanUp, sortByName, sortByDate, sortByKind, pasteItems, duplicateItems, emptyTrash, getTrashCount } = useDesktopStore();
  const { profile, logout } = useAuthStore();
  const { clipboard, cut, copy, clear: clearClipboard, hasItems: hasClipboardItems } = useClipboardStore();
  const { showConfirm } = useAlertStore();
  const navigate = useNavigate();

  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const menuBarRef = useRef<HTMLDivElement>(null);

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

  const handleOpenWallpaperPicker = useCallback(() => {
    openWindow({
      id: 'wallpaper-picker',
      title: 'Desktop Patterns',
      position: { x: 150, y: 100 },
      size: { width: 320, height: 400 },
      minimized: false,
      maximized: false,
      contentType: 'wallpaper',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenPreferences = useCallback(() => {
    openWindow({
      id: 'preferences-window',
      title: 'Preferences',
      position: { x: 120, y: 80 },
      size: { width: 380, height: 360 },
      minimized: false,
      maximized: false,
      contentType: 'preferences',
    });
    setActiveMenu(null);
  }, [openWindow]);

  const handleOpenAppearance = useCallback(() => {
    openWindow({
      id: 'appearance-panel',
      title: 'Appearance',
      position: { x: 100, y: 60 },
      size: { width: 400, height: 480 },
      minimized: false,
      maximized: false,
      contentType: 'appearance',
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
      position: { x: 140, y: 84 },
      size: { width: 430, height: 380 },
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
  // EFFECTS
  // ============================================

  // Update clock every minute
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

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
      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta) return;

      // Check if focus is on a text-editable element — if so, let the
      // browser handle native clipboard (copy/paste/cut/select-all) and
      // other text-editing shortcuts so users can interact with textareas,
      // inputs, and contenteditable elements normally.
      const active = document.activeElement;
      const isTextEditable =
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement ||
        (active instanceof HTMLElement && active.isContentEditable);

      // These shortcuts should always go to the browser when a text field
      // is focused: cut, copy, paste, select-all, undo, redo, find
      const textNativeKeys = new Set(['x', 'c', 'v', 'a', 'z', 'f']);
      if (isTextEditable && textNativeKeys.has(e.key)) {
        return; // Let browser handle natively
      }

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
  }, [handleNewFolder, handleOpen, handleCloseWindow, handleGetInfo, handleTrashSelected, handleSelectAll, handleCut, handleCopy, handlePaste, handleDuplicate, handleFind]);

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

  // ============================================
  // MENU DEFINITIONS
  // ============================================

  const menus: Record<string, MenuItem[]> = {
    apple: [
      { label: 'About EternalOS...', action: handleAbout },
      { divider: true, label: '' },
      { label: 'Preferences...', action: handleOpenPreferences },
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
      { label: 'Paste', shortcut: '⌘V', action: handlePaste, disabled: !hasClipboardItems() },
      { label: 'Duplicate', shortcut: '⌘D', action: handleDuplicate, disabled: selectedIds.size === 0 },
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
      { label: 'Appearance...', action: handleOpenAppearance },
      { label: 'Custom CSS...', action: handleOpenCSSEditor },
      { label: 'Desktop Patterns...', action: handleOpenWallpaperPicker },
      { label: 'Preferences...', action: handleOpenPreferences },
      { divider: true, label: '' },
      { label: 'Empty Trash...', action: handleEmptyTrash },
      { divider: true, label: '' },
      { label: 'Share Desktop...', action: handleShareDesktop, disabled: !profile?.username },
      { label: 'Preview as Visitor', action: handlePreviewAsVisitor, disabled: !profile?.username },
      { divider: true, label: '' },
      { label: 'Log Out', action: handleLogout, disabled: !isApiConfigured },
    ],
  };

  // Format time for display (12-hour format)
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  // Render a dropdown menu
  const renderDropdown = (menuItems: MenuItem[]) => (
    <div className={styles.dropdown}>
      {menuItems.map((item, index) =>
        item.divider ? (
          <div key={index} className={styles.divider} />
        ) : (
          <div
            key={index}
            className={`${styles.dropdownItem} ${item.disabled ? styles.disabled : ''}`}
            onClick={() => handleDropdownItemClick(item)}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
          </div>
        )
      )}
    </div>
  );

  return (
    <div className={`${styles.menuBar} menuBar`} eos-name="menubar" ref={menuBarRef}>
      {/* Apple Menu */}
      <div
        className={`${styles.menuItem} ${styles.appleMenu} ${activeMenu === 'apple' ? styles.active : ''}`}
        onClick={() => handleMenuClick('apple')}
        onMouseEnter={() => handleMenuHover('apple')}
      >
        <AppleIcon />
        {activeMenu === 'apple' && renderDropdown(menus.apple)}
      </div>

      {/* File Menu */}
      <div
        className={`${styles.menuItem} ${activeMenu === 'file' ? styles.active : ''}`}
        onClick={() => handleMenuClick('file')}
        onMouseEnter={() => handleMenuHover('file')}
      >
        File
        {activeMenu === 'file' && renderDropdown(menus.file)}
      </div>

      {/* Edit Menu */}
      <div
        className={`${styles.menuItem} ${activeMenu === 'edit' ? styles.active : ''}`}
        onClick={() => handleMenuClick('edit')}
        onMouseEnter={() => handleMenuHover('edit')}
      >
        Edit
        {activeMenu === 'edit' && renderDropdown(menus.edit)}
      </div>

      {/* View Menu */}
      <div
        className={`${styles.menuItem} ${activeMenu === 'view' ? styles.active : ''}`}
        onClick={() => handleMenuClick('view')}
        onMouseEnter={() => handleMenuHover('view')}
      >
        View
        {activeMenu === 'view' && renderDropdown(menus.view)}
      </div>

      {/* Special Menu */}
      <div
        className={`${styles.menuItem} ${activeMenu === 'special' ? styles.active : ''}`}
        onClick={() => handleMenuClick('special')}
        onMouseEnter={() => handleMenuHover('special')}
      >
        Special
        {activeMenu === 'special' && renderDropdown(menus.special)}
      </div>

      {/* Clock (right side) */}
      <div className={styles.clock}>{formatTime(currentTime)}</div>
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
