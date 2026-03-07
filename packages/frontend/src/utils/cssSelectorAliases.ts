const SELECTOR_ALIASES: Array<[RegExp, string]> = [
  [/(?<![A-Za-z0-9_-])\.icon-label\b/g, '.iconLabel'],
  [/(?<![A-Za-z0-9_-])\.window-content\b/g, '.windowContent'],
  [/(?<![A-Za-z0-9_-])\.title-bar\b/g, '.titleBar'],
  [/(?<![A-Za-z0-9_-])\.title-text\b/g, '.titleText'],
  [/(?<![A-Za-z0-9_-])\.desktop-icon\b/g, '.desktopIcon'],
  [/(?<![A-Za-z0-9_-])\.menu-bar\b/g, '.menuBar'],
  [/(?<![A-Za-z0-9_-])\.close-box\b/g, '.closeBox'],
  [/(?<![A-Za-z0-9_-])\.zoom-box\b/g, '.zoomBox'],
  [/(?<![A-Za-z0-9_-])\.collapse-box\b/g, '.collapseBox'],
  [/(?<![A-Za-z0-9_-])\.resize-handle\b/g, '.resizeHandle'],
];

export function normalizeCSSSelectorAliases(css: string): string {
  return SELECTOR_ALIASES.reduce(
    (nextCSS, [pattern, replacement]) => nextCSS.replace(pattern, replacement),
    css
  );
}
