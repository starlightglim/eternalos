// Wrangler bundles `*.wasm` imports as compiled WebAssembly modules.
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
