import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/flock.ts", "src/loro.ts", "src/yjs.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  hash: false,
  external: ["loro-crdt", "loro-protocol"],
});
