import { useState } from "react";

const PLATFORMS = [
  { label: "YouTube Shorts (9:16, 20–30 sec)", value: "YouTube Shorts" },
  { label: "Instagram Reels (9:16, 20–30 sec)", value: "Instagram Reels" },
  { label: "Facebook Reels (9:16, 20–30 sec)", value: "Facebook Reels" },
  { label: "YouTube Video (16:9, 60–90 sec)", value: "YouTube Video" },
  { label: "Landscape Video (16:9, 30–60 sec)", value: "Landscape Video" },
];

const AVATARS: Record<string, { label: string; emoji: string; styles: string[] }> = {
  lisa: {
    label: "Lisa",
    emoji: "👩",
    styles: ["graceful-sitting", "casual-sitting", "technical-sitting", "graceful-standing", "casual-standing"],
  },
  harry: {
    label: "Harry",
    emoji: "👨",
    styles: ["business", "casual"],
  },
  jeff: {
    label: "Jeff",
    emoji: "🧑",
    styles: ["business"],
  },
  lori: {
    label: "Lori",
    emoji: "👩‍💼",
    styles: ["graceful-sitting", "casual-sitting", "technical-sitting"],
  },
  max: {
    label: "Max",
    emoji: "🧔",
    styles: ["formal"],
  },
};

const VOICES = [
  { value: "en-US-AvaMultilingualNeural", label: "Ava – Warm & Natural (US)" },
  { value: "en-US-AriaNeural", label: "Aria – Professional (US)" },
  { value: "en-US-JennyNeural", label: "Jenny – Friendly (US)" },
  { value: "en-US-GuyNeural", label: "Guy – Casual Male (US)" },
  { value: "en-US-DavisNeural", label: "Davis – Conversational Male (US)" },
  { value: "en-GB-SoniaNeural", label: "Sonia – British English" },
  { value: "en-AU-NatashaNeural", label: "Natasha – Australian English" },
];

const BG_PRESETS = [
  { label: "Auto AI", value: "auto", emoji: "✨" },
  { label: "Dark Blue", value: "#0D1B2AFF", emoji: null },
  { label: "Navy", value: "#1A1A2EFF", emoji: null },
  { label: "Black", value: "#000000FF", emoji: null },
  { label: "White", value: "#FFFFFFFF", emoji: null },
  { label: "Custom", value: "custom", emoji: "🎨" },
  { label: "Image URL", value: "image", emoji: "🖼️" },
];

type Step = "idle" | "script" | "avatar" | "processing" | "done";

const STEPS: { key: Step; label: string }[] = [
  { key: "script", label: "Script" },
  { key: "avatar", label: "Avatar" },
  { key: "processing", label: "Processing" },
  { key: "done", label: "Done" },
];

interface BrandTheme {
  bgColor1: string;
  bgColor2: string;
  accentColor: string;
}

function stepIndex(step: Step): number {
  return STEPS.findIndex((s) => s.key === step);
}

function StyleTag({ label }: { label: string }) {
  return (
    <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-primary/15 text-primary border border-primary/30">
      {label}
    </span>
  );
}

function ColorSwatch({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="w-4 h-4 rounded-full border border-white/20 flex-shrink-0"
        style={{ background: color }}
      />
      <span className="text-[11px] text-muted-foreground font-mono">{label}</span>
    </div>
  );
}

export default function App() {
  const [topic, setTopic] = useState("");
  const [platform, setPlatform] = useState("YouTube Shorts");
  const [avatar, setAvatar] = useState("lisa");
  const [avatarStyle, setAvatarStyle] = useState("graceful-sitting");
  const [voice, setVoice] = useState("en-US-AvaMultilingualNeural");
  const [bgType, setBgType] = useState("auto");
  const [customColor, setCustomColor] = useState("#1a1a2e");
  const [bgImageUrl, setBgImageUrl] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#4A9FFF");
  const [cta, setCta] = useState("");

  const [step, setStep] = useState<Step>("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [brandTheme, setBrandTheme] = useState<BrandTheme | null>(null);

  const currentStyles = AVATARS[avatar]?.styles ?? [];

  function handleAvatarChange(char: string) {
    setAvatar(char);
    setAvatarStyle(AVATARS[char]?.styles[0] ?? "");
  }

  function getBackgroundColor(): string | undefined {
    if (bgType === "auto" || bgType === "image") return undefined;
    if (bgType === "custom") {
      const hex = customColor.startsWith("#") ? customColor : "#" + customColor;
      return hex.length === 7 ? hex + "FF" : hex;
    }
    return bgType;
  }

  function getBackgroundImage(): string | undefined {
    return bgType === "image" && bgImageUrl.trim() ? bgImageUrl.trim() : undefined;
  }

  async function generate() {
    if (!topic.trim()) return;
    setLoading(true);
    setError(null);
    setScript(null);
    setVideoUrl(null);
    setBrandTheme(null);
    setStep("script");

    try {
      const payload: Record<string, string | boolean | undefined> = {
        topic: topic.trim(),
        platform,
        avatar,
        avatarStyle,
        voice,
        backgroundColor: getBackgroundColor(),
        bgImageUrl: getBackgroundImage(),
        logoUrl: logoUrl.trim() || undefined,
        primaryColor: primaryColor || undefined,
        cta: cta.trim() || undefined,
        autoBackground: bgType === "auto",
      };

      Object.keys(payload).forEach((k) => {
        if (payload[k] === undefined) delete payload[k];
      });

      setStep("avatar");

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        throw new Error(data.error ?? res.statusText);
      }

      setStep("processing");
      const data = await res.json() as { success: boolean; script: string; videoUrl: string; brandTheme?: BrandTheme };
      setStep("done");
      setScript(data.script);
      setVideoUrl(data.videoUrl + "?t=" + Date.now());
      if (data.brandTheme) setBrandTheme(data.brandTheme);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("idle");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-10 pb-20">
      {/* Header */}
      <header className="flex flex-col items-center gap-2 mb-8">
        <img
          src="/api/assets/logo.png"
          alt="Libraryminds"
          className="h-12 object-contain"
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white via-violet-300 to-violet-500 bg-clip-text text-transparent">
          Libraryminds Video Generator
        </h1>
        <p className="text-muted-foreground text-sm text-center max-w-sm">
          Realistic AI avatar videos — powered by Azure AI, just like HeyGen
        </p>
      </header>

      <div className="w-full max-w-[600px] space-y-4">
        {/* Main card */}
        <div className="bg-card border border-border rounded-xl p-7 space-y-5">
          <div className="space-y-1.5">
            <label className="label-xs">Video Topic</label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && generate()}
              placeholder="e.g. 5 tips to grow your personal brand in 2025"
              disabled={loading}
              className="input"
            />
          </div>

          <div className="space-y-1.5">
            <label className="label-xs">Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              disabled={loading}
              className="input cursor-pointer"
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value} className="bg-card">{p.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Avatar card */}
        <div className="bg-card border border-border rounded-xl p-7 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span className="text-primary">👤</span> Avatar
            </h2>
            <StyleTag label="Powered by Azure AI" />
          </div>

          <div className="space-y-1.5">
            <label className="label-xs">Avatar Character</label>
            <div className="grid grid-cols-5 gap-2">
              {Object.entries(AVATARS).map(([key, { label, emoji }]) => (
                <button
                  key={key}
                  disabled={loading}
                  onClick={() => handleAvatarChange(key)}
                  className={[
                    "flex flex-col items-center gap-1.5 py-3 rounded-lg border text-xs font-medium transition-all",
                    avatar === key
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                  ].join(" ")}
                >
                  <span className="text-xl">{emoji}</span>
                  <span className="truncate w-full text-center">{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="label-xs">Avatar Style</label>
            <div className="flex flex-wrap gap-2">
              {currentStyles.map((s) => (
                <button
                  key={s}
                  disabled={loading}
                  onClick={() => setAvatarStyle(s)}
                  className={[
                    "px-3 py-1.5 rounded-lg border text-xs font-medium transition-all capitalize",
                    avatarStyle === s
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/40",
                    loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                  ].join(" ")}
                >
                  {s.replace(/-/g, " ")}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="label-xs">Voice</label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={loading}
              className="input cursor-pointer"
            >
              {VOICES.map((v) => (
                <option key={v.value} value={v.value} className="bg-card">{v.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Background & Brand card */}
        <div className="bg-card border border-border rounded-xl p-7 space-y-5">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <span className="text-primary">🎨</span> Background & Branding
          </h2>

          {/* Background presets */}
          <div className="space-y-2">
            <label className="label-xs">Background</label>
            <div className="grid grid-cols-4 gap-2">
              {BG_PRESETS.map((bg) => (
                <button
                  key={bg.value}
                  disabled={loading}
                  onClick={() => setBgType(bg.value)}
                  className={[
                    "flex flex-col items-center gap-1.5 py-2.5 rounded-lg border text-xs font-medium transition-all",
                    bgType === bg.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/40",
                    loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                  ].join(" ")}
                >
                  {bg.emoji ? (
                    <span className="text-lg">{bg.emoji}</span>
                  ) : (
                    <span
                      className="w-6 h-6 rounded-full border border-border"
                      style={{ background: bg.value.slice(0, 7) }}
                    />
                  )}
                  {bg.label}
                </button>
              ))}
            </div>

            {bgType === "auto" && (
              <p className="text-xs text-muted-foreground bg-primary/5 border border-primary/20 rounded-lg px-3 py-2">
                ✨ AI will choose a professional gradient background based on your topic — no manual setup needed.
              </p>
            )}

            {bgType === "custom" && (
              <div className="flex items-center gap-3 mt-2">
                <input
                  type="color"
                  value={customColor}
                  onChange={(e) => setCustomColor(e.target.value)}
                  disabled={loading}
                  className="w-10 h-10 rounded-lg border border-border cursor-pointer bg-transparent disabled:opacity-50"
                />
                <input
                  type="text"
                  value={customColor}
                  onChange={(e) => setCustomColor(e.target.value)}
                  placeholder="#1a1a2e"
                  disabled={loading}
                  className="input flex-1"
                />
              </div>
            )}

            {bgType === "image" && (
              <input
                type="url"
                value={bgImageUrl}
                onChange={(e) => setBgImageUrl(e.target.value)}
                placeholder="https://example.com/background.jpg"
                disabled={loading}
                className="input mt-2"
              />
            )}
          </div>

          {/* Logo URL */}
          <div className="space-y-1.5">
            <label className="label-xs">Brand Logo URL (optional)</label>
            <input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://example.com/logo.png"
              disabled={loading}
              className="input"
            />
            <p className="text-xs text-muted-foreground">Logo will appear in the top-right corner</p>
          </div>

          {/* Accent colour (shown only when not in auto mode, or as override) */}
          <div className="space-y-1.5">
            <label className="label-xs">
              Brand Accent Color
              {bgType === "auto" && (
                <span className="ml-1.5 text-muted-foreground font-normal">(overrides AI pick)</span>
              )}
            </label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                disabled={loading}
                className="w-10 h-10 rounded-lg border border-border cursor-pointer bg-transparent disabled:opacity-50"
              />
              <input
                type="text"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                placeholder="#4A9FFF"
                disabled={loading}
                className="input flex-1"
              />
            </div>
            <p className="text-xs text-muted-foreground">Accent line &amp; CTA text color</p>
          </div>

          {/* CTA */}
          <div className="space-y-1.5">
            <label className="label-xs">Call to Action — optional</label>
            <input
              type="text"
              value={cta}
              onChange={(e) => setCta(e.target.value)}
              placeholder="e.g. Visit libraryminds.com | Try for free today!"
              disabled={loading}
              className="input"
            />
            <p className="text-xs text-muted-foreground">Shown in the lower-third of the video</p>
          </div>
        </div>

        {/* Generate button */}
        <button
          onClick={generate}
          disabled={loading || !topic.trim()}
          className="w-full bg-primary hover:bg-primary/90 active:scale-[0.98] text-primary-foreground font-bold py-4 rounded-xl text-sm tracking-wide transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
        >
          {loading ? "Generating your avatar video…" : "Generate Avatar Video"}
        </button>

        {/* Progress */}
        {(loading || step === "done") && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="grid grid-cols-4 gap-2">
              {STEPS.map(({ key, label }) => {
                const current = stepIndex(step);
                const idx = stepIndex(key);
                const isDone = current > idx || step === "done";
                const isActive = current === idx && step !== "done" && step !== "idle";
                return (
                  <div
                    key={key}
                    className={[
                      "text-center text-xs font-semibold py-2.5 rounded-lg border transition-all",
                      isDone
                        ? "border-emerald-500 text-emerald-400 bg-emerald-500/10"
                        : isActive
                        ? "border-primary text-primary bg-primary/10"
                        : "border-border text-muted-foreground bg-background",
                    ].join(" ")}
                  >
                    {isDone ? "✓ " : isActive ? "⟳ " : ""}{label}
                  </div>
                );
              })}
            </div>
            <p className="text-center text-sm text-muted-foreground">
              {step === "done" ? (
                <span className="text-emerald-400 font-semibold">Avatar video is ready!</span>
              ) : step === "script" ? (
                <><span className="spinner" /> Generating AI script &amp; brand theme…</>
              ) : step === "avatar" ? (
                <><span className="spinner" /> Azure is rendering your avatar — this takes 2–5 min…</>
              ) : (
                <><span className="spinner" /> Applying gradient, branding &amp; finalizing…</>
              )}
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/60 rounded-xl px-4 py-4 text-sm text-red-400">
            <p className="font-semibold mb-1">Generation failed</p>
            <p className="text-xs opacity-80">{error}</p>
          </div>
        )}

        {/* Result */}
        {script && videoUrl && (
          <div className="bg-card border border-border rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <span className="text-emerald-400">✓</span> Your Avatar Video
              </h2>
              {brandTheme && (
                <div className="flex items-center gap-2">
                  <ColorSwatch color={brandTheme.bgColor1} label={brandTheme.bgColor1} />
                  <span className="text-muted-foreground text-xs">→</span>
                  <ColorSwatch color={brandTheme.bgColor2} label={brandTheme.bgColor2} />
                  <ColorSwatch color={brandTheme.accentColor} label="accent" />
                </div>
              )}
            </div>

            <video
              src={videoUrl}
              controls
              playsInline
              className="w-full rounded-lg bg-black block"
            />

            <div className="flex gap-3">
              <a
                href={videoUrl}
                download="libraryminds-avatar-video.mp4"
                className="flex-1 text-center bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg px-4 py-2.5 text-sm transition-colors"
              >
                Download MP4
              </a>
              <button
                onClick={generate}
                disabled={loading}
                className="flex-1 text-center bg-secondary hover:bg-secondary/70 text-secondary-foreground font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors border border-border disabled:opacity-50"
              >
                Regenerate
              </button>
            </div>

            <details className="group">
              <summary className="label-xs cursor-pointer select-none flex items-center gap-1">
                <span className="group-open:rotate-90 inline-block transition-transform">▶</span> View Generated Script
              </summary>
              <div className="mt-2 bg-background border border-border rounded-lg p-4 text-sm text-muted-foreground leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">
                {script}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
