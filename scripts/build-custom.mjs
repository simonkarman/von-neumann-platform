import { build } from "esbuild";
await build({
  entryPoints: ["scripts/custom-engine.mjs"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  outfile: "dashboard-base/public/custom/engine.mjs",
});
