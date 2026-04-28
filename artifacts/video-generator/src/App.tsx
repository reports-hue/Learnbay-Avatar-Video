import { useState, useRef } from "react";

const PLATFORMS = [
  "YouTube Shorts (9:16, 20–30 sec)",
  "Instagram Reels (9:16, 20–30 sec)",
  "Facebook Reels (9:16, 20–30 sec)",
  "YouTube Video (16:9, 60–90 sec)",
  "Landscape Video (16:9, 30–60 sec)",
];

const PLATFORM_VALUES: Record<string, string> = {
  "YouTube Shorts (9:16, 20–30 sec)": "YouTube Shorts",
  "Instagram Reels (9:16, 20–30 sec)": "Instagram Reels",
  "Facebook Reels (9:16, 20–30 sec)": "Facebook Reels",
  "YouTube Video (16:9, 60–90 sec)": "YouTube Video",
  "Landscape Video (16:9, 30–60 sec)": "Landscape Video",
};

type Step = "idle" | "script" | "voice" | "edit" | "done";

const STEPS: { key: Step; label: string }[] = [
  { key: "script", label: "Script" },
  { key: "voice", label: "Voice" },
  { key: "edit", label: "Editing" },
  { key: "done", label: "Done" },
];

function stepIndex(step: Step): number {
  return STEPS.findIndex((s) => s.key === step);
}

export default function App() {
  const [topic, setTopic] = useState("");
  const [platform, setPlatform] = useState(PLATFORMS[0]);
  const [step, setStep] = useState<Step>("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  async function generate() {
    if (!topic.trim()) return;
    setLoading(true);
    setError(null);
    setScript(null);
    setVideoUrl(null);
    setStep("script");

    try {
      const platformKey = PLATFORM_VALUES[platform] ?? platform;

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim(), platform: platformKey }),
      });

      setStep("voice");

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((data as { error?: string }).error ?? res.statusText);
      }

      setStep("edit");
      const data = await res.json() as { success: boolean; script: string; videoUrl: string };
      setStep("done");
      setScript(data.script);
      setVideoUrl(data.videoUrl + "?t=" + Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("idle");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-12 pb-20">
      {/* Header */}
      <header className="flex flex-col items-center gap-3 mb-10">
        <img
          src="/api/assets/logo.png"
          alt="Libraryminds"
          className="h-14 object-contain"
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-violet-400 bg-clip-text text-transparent">
          Libraryminds Video Generator
        </h1>
        <p className="text-muted-foreground text-sm">
          AI-powered video creation — script, voice, captions, all automatic
        </p>
      </header>

      {/* Card */}
      <div className="w-full max-w-[560px] bg-card border border-border rounded-xl p-8 space-y-5">

        {/* Topic */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            Video Topic
          </label>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && generate()}
            placeholder="e.g. 5 productivity tips for remote workers"
            disabled={loading}
            className="w-full bg-background border border-border rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition disabled:opacity-50"
          />
        </div>

        {/* Platform */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            Platform
          </label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            disabled={loading}
            className="w-full bg-background border border-border rounded-lg px-4 py-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition disabled:opacity-50 cursor-pointer"
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p} className="bg-card">
                {p}
              </option>
            ))}
          </select>
        </div>

        {/* Generate Button */}
        <button
          onClick={generate}
          disabled={loading || !topic.trim()}
          className="w-full bg-primary hover:bg-primary/90 active:scale-[0.98] text-primary-foreground font-bold py-3.5 rounded-lg text-sm tracking-wide transition-all disabled:opacity-50 disabled:cursor-not-allowed mt-2"
        >
          {loading ? "Generating…" : "Generate Video"}
        </button>

        {/* Progress Steps */}
        {(loading || step === "done") && (
          <div className="pt-2 space-y-4">
            <div className="grid grid-cols-4 gap-1.5">
              {STEPS.map(({ key, label }) => {
                const current = stepIndex(step);
                const idx = stepIndex(key);
                const isDone = current > idx || step === "done";
                const isActive = current === idx && step !== "done" && step !== "idle";
                return (
                  <div
                    key={key}
                    className={[
                      "text-center text-xs font-semibold py-2 rounded-md border transition-all",
                      isDone
                        ? "border-emerald-500 text-emerald-400 bg-emerald-500/10"
                        : isActive
                        ? "border-primary text-primary bg-primary/10"
                        : "border-border text-muted-foreground bg-background",
                    ].join(" ")}
                  >
                    {isDone ? "✓ " : ""}{label}
                  </div>
                );
              })}
            </div>
            <p className="text-center text-sm text-muted-foreground">
              {step === "done" ? (
                <span className="text-emerald-400 font-semibold">Video ready!</span>
              ) : (
                <>
                  <span className="spinner" />
                  {step === "script" && "Generating AI script…"}
                  {step === "voice" && "Synthesising voice…"}
                  {step === "edit" && "Assembling video with FFmpeg…"}
                </>
              )}
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/60 rounded-lg px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Result */}
        {script && videoUrl && (
          <div className="space-y-4 pt-2">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">
                Generated Script
              </p>
              <div className="bg-background border border-border rounded-lg p-4 text-sm text-muted-foreground leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap">
                {script}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">
                Your Video
              </p>
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                playsInline
                className="w-full rounded-lg bg-black block mb-3"
              />
              <a
                href={videoUrl}
                download="libraryminds-video.mp4"
                className="inline-block bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg px-6 py-2.5 text-sm transition-colors"
              >
                Download Video
              </a>
            </div>
          </div>
        )}

        {/* Asset notice */}
        {!loading && !videoUrl && (
          <div className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 text-xs text-muted-foreground leading-relaxed">
            <span className="text-foreground font-semibold">Required assets</span> — place these in the{" "}
            <code className="text-primary">assets/</code> folder on the server before generating:
            <br />
            <code>avatar.mp4</code>, <code>bg_vertical.mp4</code>, <code>bg_horizontal.mp4</code>,{" "}
            <code>logo.png</code>, <code>music.mp3</code>
            <br />
            <br />
            Missing assets are skipped gracefully so you can generate without them.
          </div>
        )}
      </div>
    </div>
  );
}
