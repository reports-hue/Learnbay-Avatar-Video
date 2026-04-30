import esbuild from "esbuild";
const stubLoggerPlugin = {
  name: "stub-logger",
  setup(b) {
    b.onResolve({ filter: /lib\/logger(\.[jt]s)?$/ }, () => ({
      path: "/tmp/_stub_logger_module.mjs",
    }));
  },
};
await esbuild.build({
  entryPoints: ["/tmp/_test_statpopin.ts"],
  outdir: "/tmp/test_dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  external: ["fluent-ffmpeg", "ffmpeg-static", "microsoft-cognitiveservices-speech-sdk"],
  plugins: [stubLoggerPlugin],
  logLevel: "warning",
});
console.log("bundled");
