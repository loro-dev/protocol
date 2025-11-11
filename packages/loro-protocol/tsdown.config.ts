import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  sourcemap: true,
  dts: true,
  hash: false,
  clean: true,
  target: "es2020",
});
