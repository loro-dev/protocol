import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "client/index": "src/client/index.ts",
    "server/index": "src/server/index.ts",
  },
  format: ["esm", "cjs"],
  sourcemap: true,
  hash: false,
  dts: true,
  clean: true,
  target: "es2020",
});
