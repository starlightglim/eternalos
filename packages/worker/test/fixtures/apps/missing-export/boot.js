// Only `start` is exported — the importer asks for `init`.
export function start(target) {
  target.textContent = 'started';
}
