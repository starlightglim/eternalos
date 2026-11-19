// Declared fs.read is ["/Photos/**"] — listing /Documents would silently
// return nothing at runtime.
window.eternal.fs.list({ path: '/Documents' }).then((result) => {
  document.getElementById('out').textContent = `${result.items.length} items`;
}).catch(() => {});
