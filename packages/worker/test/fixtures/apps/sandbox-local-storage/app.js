// Any localStorage access throws a SecurityError in the sandboxed iframe
// (opaque origin). Use window.eternal.storage instead.
const Prefs = {
  load() {
    try {
      return JSON.parse(localStorage.getItem('prefs') || '{}');
    } catch {
      return {};
    }
  },
  save(prefs) {
    localStorage.setItem('prefs', JSON.stringify(prefs));
  },
};

Prefs.save({ theme: 'dark' });
