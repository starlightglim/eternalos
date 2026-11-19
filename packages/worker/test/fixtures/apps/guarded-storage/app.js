// Guarded browser-storage idioms must pass validation: feature detects never
// touch the throwing accessor's value, and try/catch is the standard way to
// survive the opaque-origin SecurityError.
const Prefs = {
  probe() {
    return typeof localStorage !== 'undefined' && 'localStorage' in window;
  },
  load() {
    try {
      return JSON.parse(localStorage.getItem('prefs') || '{}');
    } catch {
      return {};
    }
  },
  save(prefs) {
    try {
      localStorage.setItem('prefs', JSON.stringify(prefs));
      return true;
    } catch {
      return false;
    }
  },
};

document.getElementById('out').textContent = Prefs.probe() ? 'probing' : 'no storage';
void Prefs.load;
void Prefs.save;
