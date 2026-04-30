import esbuild from "esbuild";
const stub = { name:"s", setup(b){b.onResolve({filter:/lib\/logger(\.[jt]s)?$/},()=>({path:"/tmp/_stub_logger_module.mjs"}))} };
await esbuild.build({
  entryPoints:["/tmp/_e2e_statpopin.ts"],
  outfile:"/tmp/test_dist/_e2e.mjs",
  bundle:true, platform:"node", format:"esm", target:"node20",
  banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
  external:["fluent-ffmpeg","ffmpeg-static","microsoft-cognitiveservices-speech-sdk"],
  plugins:[stub], logLevel:"warning"
});
console.log("bundled");
