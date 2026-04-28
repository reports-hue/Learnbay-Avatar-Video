import { useState } from "react";

// ─────────────────────────────────────────────
// Configuration data
// ─────────────────────────────────────────────

const PLATFORMS = [
  { label: "YouTube Shorts (9:16, 20–30 sec)", value: "YouTube Shorts" },
  { label: "Instagram Reels (9:16, 20–30 sec)", value: "Instagram Reels" },
  { label: "Facebook Reels (9:16, 20–30 sec)", value: "Facebook Reels" },
  { label: "YouTube Video (16:9, 60–90 sec)", value: "YouTube Video" },
  { label: "Landscape Video (16:9, 30–60 sec)", value: "Landscape Video" },
];

const SCRIPT_STYLES = [
  { value: "viral",       label: "Viral Hook",    emoji: "⚡", desc: "Scroll-stopping opener" },
  { value: "listicle",    label: "Listicle",      emoji: "📋", desc: "Numbered tips format" },
  { value: "story",       label: "Story",         emoji: "📖", desc: "Personal narrative arc" },
  { value: "educational", label: "Educational",   emoji: "🎓", desc: "Teach & explain" },
  { value: "sales",       label: "Sales",         emoji: "💰", desc: "Problem → Solution" },
];

const AVATARS: Record<string, { label: string; emoji: string; styles: string[] }> = {
  lisa: { label: "Lisa", emoji: "👩", styles: ["graceful-sitting", "casual-sitting", "technical-sitting", "graceful-standing", "casual-standing"] },
  harry: { label: "Harry", emoji: "👨", styles: ["business", "casual"] },
  jeff: { label: "Jeff", emoji: "🧑", styles: ["business"] },
  lori: { label: "Lori", emoji: "👩‍💼", styles: ["graceful-sitting", "casual-sitting", "technical-sitting"] },
  max: { label: "Max", emoji: "🧔", styles: ["formal"] },
};

const VOICES = [
  { value: "en-US-AvaMultilingualNeural",  label: "Ava – Warm & Natural (US)" },
  { value: "en-US-AriaNeural",             label: "Aria – Professional (US)" },
  { value: "en-US-JennyNeural",            label: "Jenny – Friendly (US)" },
  { value: "en-US-GuyNeural",              label: "Guy – Casual Male (US)" },
  { value: "en-US-DavisNeural",            label: "Davis – Conversational Male (US)" },
  { value: "en-GB-SoniaNeural",            label: "Sonia – British English" },
  { value: "en-AU-NatashaNeural",          label: "Natasha – Australian English" },
];

const VOICE_STYLES: Record<string, { value: string; label: string }[]> = {
  "en-US-AriaNeural":    [{ value: "chat", label: "Chat" }, { value: "empathetic", label: "Empathetic" }, { value: "narration-professional", label: "Professional" }, { value: "newscast-casual", label: "Newscast" }, { value: "customerservice", label: "Helpful" }],
  "en-US-JennyNeural":   [{ value: "assistant", label: "Assistant" }, { value: "chat", label: "Chat" }, { value: "customerservice", label: "Helpful" }, { value: "newscast", label: "Newscast" }],
  "en-US-GuyNeural":     [{ value: "narration-professional", label: "Professional" }, { value: "newscast", label: "Newscast" }],
  "en-US-DavisNeural":   [{ value: "chat", label: "Chat" }, { value: "cheerful", label: "Cheerful" }, { value: "excited", label: "Excited" }, { value: "friendly", label: "Friendly" }, { value: "hopeful", label: "Hopeful" }],
  "en-GB-SoniaNeural":   [{ value: "cheerful", label: "Cheerful" }, { value: "sad", label: "Sad" }],
};

const CAPTION_STYLES = [
  { value: "animated", label: "Animated", emoji: "✨", desc: "Word-by-word highlight" },
  { value: "static",   label: "Subtitles", emoji: "💬", desc: "Standard captions" },
  { value: "none",     label: "None",      emoji: "🚫", desc: "No captions" },
];

const SCENE_PRESETS = [
  { label: "Auto AI",   value: "auto",      emoji: "✨",  bg1: null,      bg2: null,      accent: null },
  { label: "Creator",   value: "creator",   emoji: null, bg1: "#0D1B2A", bg2: "#1A3A5C", accent: "#4A9FFF" },
  { label: "Corporate", value: "corporate", emoji: null, bg1: "#1A1A2E", bg2: "#2D2B55", accent: "#8B5CF6" },
  { label: "Tech",      value: "tech",      emoji: null, bg1: "#0F1117", bg2: "#1B3359", accent: "#00D9FF" },
  { label: "Lifestyle", value: "lifestyle", emoji: null, bg1: "#1A0A1E", bg2: "#3D1A5A", accent: "#E879F9" },
  { label: "Business",  value: "business",  emoji: null, bg1: "#0B1A1A", bg2: "#0D3330", accent: "#10B981" },
  { label: "Custom",    value: "custom",    emoji: "🎨", bg1: null,      bg2: null,      accent: null },
  { label: "Image URL", value: "image",     emoji: "🖼️", bg1: null,      bg2: null,      accent: null },
];

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface BrandTheme { bgColor1: string; bgColor2: string; accentColor: string }
interface ProgressState { step: string; percent: number; message: string }

// ─────────────────────────────────────────────
// Small components
// ─────────────────────────────────────────────

function Tag({ label }: { label: string }) {
  return (
    <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-primary/15 text-primary border border-primary/30">
      {label}
    </span>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="w-3.5 h-3.5 rounded-full border border-white/20 inline-block flex-shrink-0" style={{ background: color }} />;
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return <div className="bg-card border border-border rounded-xl p-7 space-y-5">{children}</div>;
}

function SectionTitle({ emoji, label, badge }: { emoji: string; label: string; badge?: string }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <span className="text-primary">{emoji}</span> {label}
      </h2>
      {badge && <Tag label={badge} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────

export default function App() {
  // Content
  const [topic, setTopic] = useState("");
  const [platform, setPlatform] = useState("YouTube Shorts");
  const [scriptStyle, setScriptStyle] = useState("viral");

  // Avatar
  const [avatar, setAvatar] = useState("lisa");
  const [avatarStyle, setAvatarStyle] = useState("graceful-sitting");
  const [voice, setVoice] = useState("en-US-AvaMultilingualNeural");
  const [voiceStyle, setVoiceStyle] = useState("");

  // Scene / Background
  const [scenePreset, setScenePreset] = useState("auto");
  const [customBg1, setCustomBg1] = useState("#1a1a2e");
  const [bgImageUrl, setBgImageUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#4A9FFF");

  // Captions
  const [captionStyle, setCaptionStyle] = useState("animated");

  // Branding
  const [logoUrl, setLogoUrl] = useState("");
  const [cta, setCta] = useState("");

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [brandTheme, setBrandTheme] = useState<BrandTheme | null>(null);

  const availableVoiceStyles = VOICE_STYLES[voice] ?? [];
  const selectedPreset = SCENE_PRESETS.find((p) => p.value === scenePreset);

  function handleAvatarChange(char: string) {
    setAvatar(char);
    setAvatarStyle(AVATARS[char]?.styles[0] ?? "");
  }

  function handleVoiceChange(v: string) {
    setVoice(v);
    setVoiceStyle("");
  }

  function handlePresetChange(p: string) {
    setScenePreset(p);
    const preset = SCENE_PRESETS.find((x) => x.value === p);
    if (preset?.accent) setPrimaryColor(preset.accent);
  }

  function getPayload() {
    const preset = SCENE_PRESETS.find((p) => p.value === scenePreset);
    const autoBackground = scenePreset === "auto";
    let backgroundColor: string | undefined;
    let gradientColor2: string | undefined;

    if (scenePreset === "custom") {
      const hex = customBg1.startsWith("#") ? customBg1 : "#" + customBg1;
      backgroundColor = hex.length === 7 ? hex + "FF" : hex;
    } else if (scenePreset === "image" || scenePreset === "auto") {
      backgroundColor = undefined;
    } else if (preset?.bg1) {
      backgroundColor = preset.bg1 + "FF";
      gradientColor2 = preset.bg2 ?? undefined;
    }

    return {
      topic: topic.trim(),
      platform,
      scriptStyle,
      avatar,
      avatarStyle,
      voice,
      voiceStyle: voiceStyle || undefined,
      backgroundColor,
      gradientColor2,
      bgImageUrl: scenePreset === "image" && bgImageUrl.trim() ? bgImageUrl.trim() : undefined,
      logoUrl: logoUrl.trim() || undefined,
      primaryColor: primaryColor || undefined,
      cta: cta.trim() || undefined,
      captionStyle,
      autoBackground,
    };
  }

  async function generate() {
    if (!topic.trim()) return;
    setLoading(true);
    setError(null);
    setScript(null);
    setVideoUrl(null);
    setBrandTheme(null);
    setProgress({ step: "start", percent: 0, message: "Starting up…" });

    const payload = getPayload();
    // Remove undefined keys
    const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));

    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanPayload),
      });

      if (!resp.body) throw new Error("No response stream");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
              if (currentEvent === "progress") {
                setProgress(data as unknown as ProgressState);
                if (data.script) setScript(data.script as string);
              } else if (currentEvent === "done") {
                setVideoUrl((data.videoUrl as string) + "?t=" + Date.now());
                if (data.script) setScript(data.script as string);
                if (data.brandTheme) setBrandTheme(data.brandTheme as BrandTheme);
                setProgress({ step: "done", percent: 100, message: "Your video is ready!" });
              } else if (currentEvent === "error") {
                throw new Error((data.message as string) ?? "Unknown error");
              }
              currentEvent = "";
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message !== "Unexpected token") {
                throw parseErr;
              }
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    } finally {
      setLoading(false);
    }
  }

  const isDone = !loading && !!videoUrl;

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
          AI avatar videos with animated captions, gradient scenes &amp; voice emotion — powered by Azure AI
        </p>
      </header>

      <div className="w-full max-w-[600px] space-y-4">

        {/* ── Content Card ── */}
        <SectionCard>
          <SectionTitle emoji="✍️" label="Content" />

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
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={loading} className="input cursor-pointer">
              {PLATFORMS.map((p) => <option key={p.value} value={p.value} className="bg-card">{p.label}</option>)}
            </select>
          </div>

          <div className="space-y-2">
            <label className="label-xs">Script Style</label>
            <div className="grid grid-cols-5 gap-2">
              {SCRIPT_STYLES.map((s) => (
                <button
                  key={s.value}
                  disabled={loading}
                  onClick={() => setScriptStyle(s.value)}
                  title={s.desc}
                  className={[
                    "flex flex-col items-center gap-1 py-2.5 rounded-lg border text-[11px] font-medium transition-all",
                    scriptStyle === s.value ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/40",
                    loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                  ].join(" ")}
                >
                  <span className="text-base">{s.emoji}</span>
                  <span className="leading-tight text-center">{s.label}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{SCRIPT_STYLES.find((s) => s.value === scriptStyle)?.desc}</p>
          </div>
        </SectionCard>

        {/* ── Avatar Card ── */}
        <SectionCard>
          <SectionTitle emoji="👤" label="Avatar" badge="Powered by Azure AI" />

          <div className="space-y-1.5">
            <label className="label-xs">Character</label>
            <div className="grid grid-cols-5 gap-2">
              {Object.entries(AVATARS).map(([key, { label, emoji }]) => (
                <button key={key} disabled={loading} onClick={() => handleAvatarChange(key)}
                  className={["flex flex-col items-center gap-1.5 py-3 rounded-lg border text-xs font-medium transition-all",
                    avatar === key ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"].join(" ")}
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
              {AVATARS[avatar]?.styles.map((s) => (
                <button key={s} disabled={loading} onClick={() => setAvatarStyle(s)}
                  className={["px-3 py-1.5 rounded-lg border text-xs font-medium transition-all capitalize",
                    avatarStyle === s ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/40",
                    loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"].join(" ")}
                >
                  {s.replace(/-/g, " ")}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="label-xs">Voice</label>
              <select value={voice} onChange={(e) => handleVoiceChange(e.target.value)} disabled={loading} className="input cursor-pointer text-xs">
                {VOICES.map((v) => <option key={v.value} value={v.value} className="bg-card">{v.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="label-xs">
                Voice Emotion
                {availableVoiceStyles.length === 0 && <span className="ml-1 text-[10px] text-muted-foreground">(not available)</span>}
              </label>
              <select
                value={voiceStyle}
                onChange={(e) => setVoiceStyle(e.target.value)}
                disabled={loading || availableVoiceStyles.length === 0}
                className="input cursor-pointer text-xs disabled:opacity-40"
              >
                <option value="" className="bg-card">Default</option>
                {availableVoiceStyles.map((s) => <option key={s.value} value={s.value} className="bg-card">{s.label}</option>)}
              </select>
            </div>
          </div>
        </SectionCard>

        {/* ── Scene Card ── */}
        <SectionCard>
          <SectionTitle emoji="🎬" label="Scene & Branding" />

          {/* Scene Presets */}
          <div className="space-y-2">
            <label className="label-xs">Scene Preset</label>
            <div className="grid grid-cols-4 gap-2">
              {SCENE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  disabled={loading}
                  onClick={() => handlePresetChange(preset.value)}
                  className={[
                    "flex flex-col items-center gap-1.5 py-2.5 rounded-lg border text-xs font-medium transition-all",
                    scenePreset === preset.value ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/40",
                    loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                  ].join(" ")}
                >
                  {preset.emoji ? (
                    <span className="text-lg">{preset.emoji}</span>
                  ) : (
                    <span className="flex gap-0.5 items-center">
                      <span className="w-5 h-5 rounded-l-full" style={{ background: preset.bg1! }} />
                      <span className="w-5 h-5 rounded-r-full" style={{ background: preset.bg2! }} />
                    </span>
                  )}
                  <span className="leading-none">{preset.label}</span>
                </button>
              ))}
            </div>

            {scenePreset === "auto" && (
              <p className="text-xs text-muted-foreground bg-primary/5 border border-primary/20 rounded-lg px-3 py-2">
                ✨ AI selects a professional gradient background tailored to your topic.
              </p>
            )}
            {scenePreset === "custom" && (
              <div className="flex items-center gap-3 mt-1">
                <input type="color" value={customBg1} onChange={(e) => setCustomBg1(e.target.value)} disabled={loading}
                  className="w-9 h-9 rounded-lg border border-border cursor-pointer bg-transparent disabled:opacity-50" />
                <input type="text" value={customBg1} onChange={(e) => setCustomBg1(e.target.value)} placeholder="#1a1a2e" disabled={loading} className="input flex-1 text-sm" />
              </div>
            )}
            {scenePreset === "image" && (
              <input type="url" value={bgImageUrl} onChange={(e) => setBgImageUrl(e.target.value)}
                placeholder="https://example.com/background.jpg" disabled={loading} className="input mt-1" />
            )}
            {selectedPreset && !selectedPreset.emoji && selectedPreset.bg1 && (
              <p className="text-xs text-muted-foreground">
                Gradient: <span className="font-mono">{selectedPreset.bg1}</span> → <span className="font-mono">{selectedPreset.bg2}</span> · Accent: <span className="font-mono">{selectedPreset.accent}</span>
              </p>
            )}
          </div>

          {/* Caption Style */}
          <div className="space-y-2">
            <label className="label-xs">Captions</label>
            <div className="flex gap-2">
              {CAPTION_STYLES.map((c) => (
                <button
                  key={c.value}
                  disabled={loading}
                  onClick={() => setCaptionStyle(c.value)}
                  title={c.desc}
                  className={[
                    "flex-1 flex flex-col items-center gap-1 py-2.5 rounded-lg border text-xs font-medium transition-all",
                    captionStyle === c.value ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/40",
                    loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                  ].join(" ")}
                >
                  <span className="text-base">{c.emoji}</span>
                  <span>{c.label}</span>
                  <span className="text-[10px] opacity-60 leading-none">{c.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Logo */}
          <div className="space-y-1.5">
            <label className="label-xs">Brand Logo URL (optional)</label>
            <input type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://example.com/logo.png" disabled={loading} className="input" />
            <p className="text-xs text-muted-foreground">Appears in the top-right corner</p>
          </div>

          {/* Accent color */}
          <div className="space-y-1.5">
            <label className="label-xs">
              Accent Color
              {scenePreset === "auto" && <span className="ml-1.5 text-[10px] text-muted-foreground">(leave blank to let AI pick)</span>}
            </label>
            <div className="flex items-center gap-3">
              <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} disabled={loading}
                className="w-9 h-9 rounded-lg border border-border cursor-pointer bg-transparent disabled:opacity-50" />
              <input type="text" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} placeholder="#4A9FFF" disabled={loading} className="input flex-1" />
            </div>
            <p className="text-xs text-muted-foreground">Caption highlight color, accent bar &amp; CTA text</p>
          </div>

          {/* CTA */}
          <div className="space-y-1.5">
            <label className="label-xs">Call to Action — optional</label>
            <input type="text" value={cta} onChange={(e) => setCta(e.target.value)}
              placeholder="Visit libraryminds.com | Try free today!" disabled={loading} className="input" />
            <p className="text-xs text-muted-foreground">Shown in the lower-third area</p>
          </div>
        </SectionCard>

        {/* ── Generate button ── */}
        <button
          onClick={generate}
          disabled={loading || !topic.trim()}
          className="w-full bg-primary hover:bg-primary/90 active:scale-[0.98] text-primary-foreground font-bold py-4 rounded-xl text-sm tracking-wide transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/20"
        >
          {loading ? "Generating your video…" : "Generate Avatar Video"}
        </button>

        {/* ── Progress / Status ── */}
        {(loading || isDone) && progress && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            {/* Progress bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{progress.message}</span>
                <span className="font-mono">{progress.percent}%</span>
              </div>
              <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-700"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>

            {/* Step pills */}
            {(() => {
              const PHASE_LABELS: Record<string, string> = {
                start: "Starting",
                script: "Script",
                script_done: "Script ✓",
                avatar_start: "Avatar",
                avatar_done: "Avatar ✓",
                done: "Done ✓",
              };
              const phases = ["script_done", "avatar_start", "avatar_done", "done"];
              const phaseIndex = phases.indexOf(progress.step);
              return (
                <div className="flex gap-2">
                  {[
                    { key: "script_done", label: "Script" },
                    { key: "avatar_start", label: "Avatar" },
                    { key: "avatar_done", label: "Branding" },
                    { key: "done", label: "Done" },
                  ].map(({ key, label }, idx) => {
                    const isComplete = phaseIndex > idx || progress.step === "done";
                    const isActive = phases[idx] === progress.step || (progress.step === "script" && idx === 0);
                    return (
                      <div key={key} className={[
                        "flex-1 text-center text-[11px] font-semibold py-2 rounded-lg border transition-all",
                        isComplete ? "border-emerald-500 text-emerald-400 bg-emerald-500/10"
                          : isActive ? "border-primary text-primary bg-primary/10"
                          : "border-border text-muted-foreground bg-background",
                      ].join(" ")}>
                        {isComplete ? "✓ " : isActive ? "⟳ " : ""}{label}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Live script preview */}
            {script && loading && (
              <details>
                <summary className="text-xs text-muted-foreground cursor-pointer select-none">Preview script ▾</summary>
                <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs text-muted-foreground max-h-28 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                  {script}
                </div>
              </details>
            )}
          </div>
        )}

        {/* ── Error ── */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/60 rounded-xl px-4 py-4 text-sm text-red-400">
            <p className="font-semibold mb-1">Generation failed</p>
            <p className="text-xs opacity-80">{error}</p>
          </div>
        )}

        {/* ── Result ── */}
        {script && videoUrl && (
          <div className="bg-card border border-border rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <span className="text-emerald-400">✓</span> Your Avatar Video
              </h2>
              {brandTheme && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Swatch color={brandTheme.bgColor1} />
                  <span>→</span>
                  <Swatch color={brandTheme.bgColor2} />
                  <Swatch color={brandTheme.accentColor} />
                  <span className="font-mono">{brandTheme.accentColor}</span>
                </div>
              )}
            </div>

            <video src={videoUrl} controls playsInline className="w-full rounded-lg bg-black block" />

            <div className="flex gap-3">
              <a href={videoUrl} download="libraryminds-avatar-video.mp4"
                className="flex-1 text-center bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg px-4 py-2.5 text-sm transition-colors">
                Download MP4
              </a>
              <button onClick={generate} disabled={loading}
                className="flex-1 text-center bg-secondary hover:bg-secondary/70 text-secondary-foreground font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors border border-border disabled:opacity-50">
                Regenerate
              </button>
            </div>

            <details className="group">
              <summary className="label-xs cursor-pointer select-none flex items-center gap-1">
                <span className="group-open:rotate-90 inline-block transition-transform">▶</span> View Script
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
