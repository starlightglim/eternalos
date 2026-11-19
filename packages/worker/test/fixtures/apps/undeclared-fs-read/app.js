window.eternal.fs.readText('/notes.txt').then((text) => {
  document.getElementById('out').textContent = text;
}).catch(() => {});
