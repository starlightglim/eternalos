// The guarded load() below is allowed: a try/catch is the standard way to
// survive the opaque-origin SecurityError. The unguarded save() is what this
// fixture exists to catch — localStorage.setItem throws on every call, so
// nothing ever persists.
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
