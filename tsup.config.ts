import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "http/app": "src/http/app.ts",
  },
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: false,
});
