// eternal.fs.save does not exist on the frozen bridge — TypeError at runtime.
window.eternal.fs.save('/notes.txt', 'hello').catch(() => {});
