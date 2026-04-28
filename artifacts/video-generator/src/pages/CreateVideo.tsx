import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  ChevronLeft, ChevronRight, Sparkles, Check, Download,
  Library, RotateCcw, Building2, AlertCircle,
  Volume2, VolumeX, Play, Loader2, Zap, Gauge,
} from "lucide-react";
import type { BrandProfile, VideoEntry, Page } from "@/lib/types";
import { PLATFORMS, SCRIPT_STYLES, AVATARS, VOICES, VOICE_STYLES, CAPTION_STYLES, SCENE_PRESETS } from "@/lib/config";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────
type Pacing = "slow" | "natural" | "fast";
interface ProgressState { step: string; percent: number; message: string }
interface BrandTheme { bgColor1: string; bgColor2: string; accentColor: string }
interface GenerationResult {
  videoId: string; videoUrl: string; thumbnailUrl?: string;
  script: string; brandTheme: BrandTheme;
}

const STEPS = [
  { id: 1, label: "Content" },
  { id: 2, label: "Brand" },
  { id: 3, label: "Avatar" },
  { id: 4, label: "Generate" },
];

const PACING_OPTIONS: { value: Pacing; label: string; desc: string }[] = [
  { value: "slow", label: "Slow", desc: "0.88×" },
  { value: "natural", label: "Natural", desc: "0.95×" },
  { value: "fast", label: "Fast", desc: "1.05×" },
];

// ─── Sub-components ──────────────────────────────────────────────
function Pill({ active, disabled, onClick, children, className }: {
  active: boolean; disabled?: boolean; onClick: () => void;
  children: React.ReactNode; className?: string;
}) {
  return (
    <button disabled={disabled} onClick={onClick}
      className={cn(
        "px-3 py-1.5 rounded-lg border text-xs font-medium transition-all",
        active ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40",
        disabled && "opacity-50 cursor-not-allowed", className
      )}
    >{children}</button>
  );
}

function ColorInput({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label className="label-xs">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
          className="w-9 h-9 rounded-lg border border-border cursor-pointer bg-transparent disabled:opacity-50" />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="input flex-1 font-mono text-xs" />
      </div>
    </div>
  );
}

function SLabel({ children }: { children: React.ReactNode }) {
  return <p className="label-xs mb-2">{children}</p>;
}

function StepBar({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-1 mb-8">
      {STEPS.map((s, i) => (
        <div key={s.id} className="flex items-center gap-1 flex-1 last:flex-initial">
          <div className={cn(
            "flex items-center gap-2 whitespace-nowrap",
            step === s.id ? "text-primary" : step > s.id ? "text-emerald-600" : "text-muted-foreground"
          )}>
            <div className={cn(
              "w-6 h-6 rounded-full border-2 flex items-center justify-center text-[11px] font-bold flex-shrink-0",
              step === s.id ? "border-primary bg-primary text-white" :
              step > s.id ? "border-emerald-500 bg-emerald-50 text-emerald-600" :
              "border-border text-muted-foreground bg-white"
            )}>
              {step > s.id ? <Check className="w-3 h-3" /> : s.id}
            </div>
            <span className="text-xs font-medium hidden sm:inline">{s.label}</span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={cn("flex-1 h-px mx-1", step > s.id ? "bg-emerald-300" : "bg-border")} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────
interface Props {
  brand: BrandProfile;
  addVideo: (v: VideoEntry) => void;
  setPage: (p: Page) => void;
}

export function CreateVideo({ brand, addVideo, setPage }: Props) {
  const hasBrand = Boolean(brand.companyName);

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1
  const [topic, setTopic] = useState("");
  const [platform, setPlatform] = useState("YouTube Shorts");
  const [scriptStyle, setScriptStyle] = useState(brand.defaultScriptStyle || "viral");

  // Step 2
  const [brandMode, setBrandMode] = useState<"saved" | "custom">(hasBrand ? "saved" : "custom");
  const [scenePreset, setScenePreset] = useState(brand.defaultScenePreset || "auto");
  const [customPrimary, setCustomPrimary] = useState(brand.primaryColor || "#7C3AED");
  const [customBg, setCustomBg] = useState(brand.backgroundColor || "#0D1B2A");
  const [customLogoUrl, setCustomLogoUrl] = useState(brand.logoUrl || "");
  const [customCta, setCustomCta] = useState(brand.defaultCta || "");
  const [bgImageUrl, setBgImageUrl] = useState("");

  // Step 3 — avatar & voice
  const [avatar, setAvatar] = useState(brand.defaultAvatar || "lisa");
  const [avatarStyle, setAvatarStyle] = useState(brand.defaultAvatarStyle || "graceful-sitting");
  const [voice, setVoice] = useState(brand.defaultVoice || "en-US-AvaMultilingualNeural");
  const [voiceStyle, setVoiceStyle] = useState(brand.defaultVoiceStyle || "");
  const [captionStyle, setCaptionStyle] = useState(brand.defaultCaptionStyle || "animated");

  // Step 3 — realism controls
  const [realism, setRealism] = useState(true);
  const [pacing, setPacing] = useState<Pacing>("natural");

  // Voice preview
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [liveScript, setLiveScript] = useState<string | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const voiceStyleOptions = VOICE_STYLES[voice] ?? [];

  function handleAvatarChange(char: string) {
    setAvatar(char);
    setAvatarStyle(AVATARS[char]?.styles[0] ?? "");
  }

  function handleVoiceChange(v: string) {
    setVoice(v);
    setVoiceStyle("");
    stopPreview();
  }

  function handleScenePreset(p: string) {
    setScenePreset(p);
    const pr = SCENE_PRESETS.find((x) => x.value === p);
    if (pr?.accent) setCustomPrimary(pr.accent);
  }

  function stopPreview() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
  }

  async function previewVoice() {
    stopPreview();
    setIsPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch("/api/preview-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setIsPreviewing(false); URL.revokeObjectURL(url); };
      audio.onerror = () => { setIsPreviewing(false); };
      await audio.play();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
      setIsPreviewing(false);
    }
  }

  function buildPayload(): Record<string, unknown> {
    const base = {
      topic: topic.trim(), platform, scriptStyle,
      avatar, avatarStyle, voice,
      voiceStyle: voiceStyle || undefined,
      captionStyle,
      realism,
      pacing,
    };

    if (brandMode === "saved" && hasBrand) {
      return {
        ...base,
        primaryColor: brand.primaryColor,
        backgroundColor: brand.backgroundColor + "FF",
        gradientColor2: brand.secondaryColor,
        logoUrl: brand.logoUrl || undefined,
        cta: brand.defaultCta || undefined,
        autoBackground: false,
      };
    }

    const preset = SCENE_PRESETS.find((p) => p.value === scenePreset);
    const autoBackground = scenePreset === "auto";
    let backgroundColor: string | undefined;
    let gradientColor2: string | undefined;

    if (scenePreset === "custom") {
      backgroundColor = customBg + "FF";
    } else if (preset?.bg1) {
      backgroundColor = preset.bg1 + "FF";
      gradientColor2 = preset.bg2 ?? undefined;
    }

    return {
      ...base,
      primaryColor: customPrimary,
      backgroundColor,
      gradientColor2,
      bgImageUrl: scenePreset === "image" && bgImageUrl ? bgImageUrl : undefined,
      logoUrl: customLogoUrl || undefined,
      cta: customCta || undefined,
      autoBackground,
    };
  }

  async function generate() {
    setIsGenerating(true);
    setGenError(null);
    setResult(null);
    setLiveScript(null);
    setProgress({ step: "start", percent: 0, message: "Starting…" });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const payload = buildPayload();
    const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));

    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanPayload),
        signal: ctrl.signal,
      });

      if (!resp.body) throw new Error("No response stream");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let curEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            curEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
              if (curEvent === "progress") {
                setProgress(data as unknown as ProgressState);
                if (data.script) setLiveScript(data.script as string);
              } else if (curEvent === "done") {
                const r: GenerationResult = {
                  videoId: data.videoId as string,
                  videoUrl: (data.videoUrl as string) + "?t=" + Date.now(),
                  thumbnailUrl: data.thumbnailUrl ? (data.thumbnailUrl as string) + "?t=" + Date.now() : undefined,
                  script: data.script as string,
                  brandTheme: data.brandTheme as BrandTheme,
                };
                setResult(r);
                setLiveScript(r.script);
                setProgress({ step: "done", percent: 100, message: "Video ready!" });
                addVideo({
                  id: r.videoId,
                  topic: topic.trim(),
                  platform,
                  scriptStyle,
                  captionStyle,
                  voice,
                  avatar,
                  videoUrl: data.videoUrl as string,
                  thumbnailUrl: data.thumbnailUrl as string | undefined,
                  script: r.script,
                  brandTheme: r.brandTheme,
                  createdAt: new Date().toISOString(),
                });
              } else if (curEvent === "error") {
                throw new Error((data.message as string) ?? "Generation failed");
              }
              curEvent = "";
            } catch (parseErr) {
              if (parseErr instanceof SyntaxError) continue;
              throw parseErr;
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setGenError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    } finally {
      setIsGenerating(false);
    }
  }

  function resetForm() {
    setStep(1);
    setTopic("");
    setResult(null);
    setProgress(null);
    setLiveScript(null);
    setGenError(null);
    stopPreview();
  }

  const selectedPreset = SCENE_PRESETS.find((p) => p.value === scenePreset);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-foreground">Create Video</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Generate a professional AI avatar video in 4 steps</p>
      </div>

      <StepBar step={step} />

      {/* ──────────────────────────────────── STEP 1 — Content */}
      {step === 1 && (
        <div className="space-y-6">
          <div className="space-y-1.5">
            <SLabel>Video Topic *</SLabel>
            <input
              type="text" value={topic} onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && topic.trim() && setStep(2)}
              placeholder="e.g. 5 tips to grow your personal brand in 2025"
              className="input text-base" autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <SLabel>Platform</SLabel>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="input cursor-pointer">
              {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>

          <div>
            <SLabel>Script Style</SLabel>
            <div className="grid grid-cols-5 gap-2">
              {SCRIPT_STYLES.map((s) => (
                <button key={s.value} onClick={() => setScriptStyle(s.value)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 py-2.5 rounded-lg border text-xs font-medium transition-all",
                    scriptStyle === s.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >
                  <span className="text-lg">{s.emoji}</span>
                  <span className="leading-tight text-center">{s.label}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-2">{SCRIPT_STYLES.find((s) => s.value === scriptStyle)?.desc}</p>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={() => setStep(2)} disabled={!topic.trim()}>
              Next: Brand <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ──────────────────────────────────── STEP 2 — Brand */}
      {step === 2 && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3">
            {[
              { mode: "saved" as const, label: "Use Brand Profile", icon: Building2, desc: hasBrand ? `${brand.companyName} settings` : "Not configured yet", disabled: !hasBrand },
              { mode: "custom" as const, label: "Custom for this video", icon: Sparkles, desc: "Override for this video" },
            ].map(({ mode, label, icon: Icon, desc, disabled }) => (
              <button key={mode} onClick={() => !disabled && setBrandMode(mode)} disabled={disabled}
                className={cn(
                  "flex flex-col items-start gap-2 p-4 rounded-xl border text-left transition-all",
                  brandMode === mode ? "border-primary bg-violet-50" : "border-border bg-white hover:border-primary/30",
                  disabled && "opacity-50 cursor-not-allowed"
                )}
              >
                <div className="flex items-center gap-2 w-full">
                  <Icon className={cn("w-4 h-4 flex-shrink-0", brandMode === mode ? "text-primary" : "text-muted-foreground")} />
                  <span className={cn("text-sm font-semibold", brandMode === mode ? "text-primary" : "text-foreground")}>{label}</span>
                  {brandMode === mode && <Check className="w-3.5 h-3.5 text-primary ml-auto flex-shrink-0" />}
                </div>
                <span className="text-xs text-muted-foreground">{desc}</span>
              </button>
            ))}
          </div>

          {!hasBrand && brandMode === "saved" && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" />
              <div>No brand profile configured. <button className="underline font-medium" onClick={() => setPage("settings")}>Set it up in Brand Settings</button> or use Custom mode.</div>
            </div>
          )}

          {brandMode === "saved" && hasBrand && (
            <div className="bg-white border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-3">
                {brand.logoUrl && (
                  <img src={brand.logoUrl} alt="" className="h-8 w-auto max-w-[80px] rounded object-contain"
                    onError={(e) => (e.currentTarget.style.display = "none")} />
                )}
                <div>
                  <p className="text-sm font-semibold text-foreground">{brand.companyName}</p>
                  {brand.tagline && <p className="text-xs text-muted-foreground">{brand.tagline}</p>}
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {[
                  { label: "Accent", color: brand.primaryColor },
                  { label: "Secondary", color: brand.secondaryColor },
                  { label: "Background", color: brand.backgroundColor },
                ].map(({ label, color }) => (
                  <span key={label} className="flex items-center gap-1.5">
                    <span className="w-4 h-4 rounded-full border border-border" style={{ background: color }} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {brandMode === "custom" && (
            <div className="space-y-5">
              <div>
                <SLabel>Scene Preset</SLabel>
                <div className="grid grid-cols-4 gap-2">
                  {SCENE_PRESETS.map((p) => (
                    <button key={p.value} onClick={() => handleScenePreset(p.value)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 py-3 rounded-lg border text-xs font-medium transition-all",
                        scenePreset === p.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                      )}
                    >
                      {p.emoji ? <span className="text-lg">{p.emoji}</span> : (
                        <span className="flex gap-0.5">
                          <span className="w-4 h-4 rounded-l-full" style={{ background: p.bg1! }} />
                          <span className="w-4 h-4 rounded-r-full" style={{ background: p.bg2! }} />
                        </span>
                      )}
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
                {scenePreset === "image" && (
                  <input type="url" value={bgImageUrl} onChange={(e) => setBgImageUrl(e.target.value)}
                    placeholder="https://example.com/background.jpg" className="input mt-2" />
                )}
                {scenePreset === "auto" && (
                  <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-primary" /> AI picks gradient colors for your topic
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <ColorInput label="Accent Color" value={customPrimary} onChange={setCustomPrimary} />
                {scenePreset === "custom" && (
                  <ColorInput label="Background Color" value={customBg} onChange={setCustomBg} />
                )}
              </div>

              <div className="space-y-1.5">
                <SLabel>Logo URL (optional)</SLabel>
                <input type="url" value={customLogoUrl} onChange={(e) => setCustomLogoUrl(e.target.value)}
                  placeholder="https://example.com/logo.png" className="input" />
              </div>

              <div className="space-y-1.5">
                <SLabel>Call to Action (optional)</SLabel>
                <input type="text" value={customCta} onChange={(e) => setCustomCta(e.target.value)}
                  placeholder="Visit yoursite.com today!" className="input" />
              </div>
            </div>
          )}

          <div className="flex justify-between pt-2">
            <Button variant="outline" onClick={() => setStep(1)}>
              <ChevronLeft className="w-4 h-4" /> Back
            </Button>
            <Button onClick={() => setStep(3)} disabled={brandMode === "saved" && !hasBrand}>
              Next: Avatar <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ──────────────────────────────────── STEP 3 — Avatar & Voice */}
      {step === 3 && (
        <div className="space-y-6">
          {/* Character */}
          <div>
            <SLabel>Character</SLabel>
            <div className="grid grid-cols-5 gap-2">
              {Object.entries(AVATARS).map(([key, { label, emoji }]) => (
                <button key={key} onClick={() => handleAvatarChange(key)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 py-3 rounded-lg border text-xs font-medium transition-all",
                    avatar === key ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >
                  <span className="text-xl">{emoji}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Avatar Style */}
          <div>
            <SLabel>Avatar Style</SLabel>
            <div className="flex flex-wrap gap-2">
              {AVATARS[avatar]?.styles.map((s) => (
                <Pill key={s} active={avatarStyle === s} onClick={() => setAvatarStyle(s)}>
                  {s.replace(/-/g, " ")}
                </Pill>
              ))}
            </div>
          </div>

          {/* Voice + Voice Preview */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <SLabel>Voice</SLabel>
                <select value={voice} onChange={(e) => handleVoiceChange(e.target.value)} className="input cursor-pointer text-xs">
                  {VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <SLabel>Voice Emotion</SLabel>
                <select value={voiceStyle} onChange={(e) => setVoiceStyle(e.target.value)} disabled={voiceStyleOptions.length === 0} className="input cursor-pointer text-xs disabled:opacity-40">
                  <option value="">Default</option>
                  {voiceStyleOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {/* Voice Preview button */}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={previewVoice} disabled={isPreviewing}
                className="gap-2 text-xs">
                {isPreviewing ? (
                  <><Volume2 className="w-3.5 h-3.5 text-primary animate-pulse" /> Playing…</>
                ) : (
                  <><Play className="w-3.5 h-3.5" /> Preview Voice</>
                )}
              </Button>
              {isPreviewing && (
                <Button size="sm" variant="ghost" onClick={stopPreview} className="gap-1.5 text-xs text-muted-foreground">
                  <VolumeX className="w-3.5 h-3.5" /> Stop
                </Button>
              )}
              {previewError && (
                <span className="text-xs text-red-500 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> {previewError}
                </span>
              )}
              {!previewError && !isPreviewing && (
                <span className="text-xs text-muted-foreground">Hear a 5-second sample before generating</span>
              )}
            </div>
          </div>

          {/* Caption Style */}
          <div>
            <SLabel>Caption Style</SLabel>
            <div className="flex gap-2">
              {CAPTION_STYLES.map((c) => (
                <button key={c.value} onClick={() => setCaptionStyle(c.value)}
                  className={cn(
                    "flex-1 flex flex-col items-center gap-1 py-2.5 rounded-lg border text-xs font-medium transition-all",
                    captionStyle === c.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >
                  <span className="text-base">{c.emoji}</span>
                  <span>{c.label}</span>
                  <span className="text-[10px] text-muted-foreground">{c.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Realism Mode + Pacing (production quality controls) ── */}
          <div className="bg-gray-50 border border-border rounded-xl p-4 space-y-4">
            <p className="text-xs font-semibold text-foreground flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-primary" /> Generation Settings
            </p>

            {/* Realism Mode toggle */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">Realism Mode</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Chroma key compositing, color grade, film grain, Ken Burns effect, broadcast-quality audio
                </p>
              </div>
              <button
                onClick={() => setRealism(!realism)}
                className={cn(
                  "relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none",
                  realism ? "bg-primary" : "bg-gray-300"
                )}
                role="switch" aria-checked={realism}
              >
                <span className={cn(
                  "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200",
                  realism ? "translate-x-5" : "translate-x-0"
                )} />
              </button>
            </div>

            {/* Pacing slider */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Gauge className="w-3.5 h-3.5 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Speaking Pace</p>
                <Badge variant="secondary" className="text-[10px] ml-auto">
                  {PACING_OPTIONS.find(p => p.value === pacing)?.label} ({PACING_OPTIONS.find(p => p.value === pacing)?.desc})
                </Badge>
              </div>
              <div className="flex gap-1.5">
                {PACING_OPTIONS.map((p) => (
                  <button key={p.value} onClick={() => setPacing(p.value)}
                    className={cn(
                      "flex-1 py-2 rounded-lg border text-xs font-medium transition-all",
                      pacing === p.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/30"
                    )}
                  >
                    <div>{p.label}</div>
                    <div className="text-[10px] opacity-70">{p.desc}</div>
                  </button>
                ))}
              </div>
              {!realism && (
                <p className="text-[11px] text-amber-600 mt-2 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Pacing only applies in Realism Mode
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-between pt-2">
            <Button variant="outline" onClick={() => setStep(2)}><ChevronLeft className="w-4 h-4" /> Back</Button>
            <Button onClick={() => setStep(4)}>Review & Generate <ChevronRight className="w-4 h-4" /></Button>
          </div>
        </div>
      )}

      {/* ──────────────────────────────────── STEP 4 — Generate */}
      {step === 4 && (
        <div className="space-y-6">
          {!result && (
            <div className="bg-white border border-border rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-foreground">Generation Summary</h3>
              <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-xs">
                {[
                  { label: "Topic", value: topic },
                  { label: "Platform", value: platform },
                  { label: "Style", value: SCRIPT_STYLES.find((s) => s.value === scriptStyle)?.label ?? scriptStyle },
                  { label: "Avatar", value: `${AVATARS[avatar]?.label ?? avatar} · ${avatarStyle.replace(/-/g, " ")}` },
                  { label: "Voice", value: VOICES.find((v) => v.value === voice)?.label.split(" – ")[0] ?? voice },
                  { label: "Captions", value: CAPTION_STYLES.find((c) => c.value === captionStyle)?.label ?? captionStyle },
                  { label: "Brand", value: brandMode === "saved" ? brand.companyName : `Custom · ${selectedPreset?.label ?? scenePreset}` },
                  { label: "Quality", value: realism ? `Realism Mode · ${PACING_OPTIONS.find(p => p.value === pacing)?.label} pace` : "Draft Mode" },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-muted-foreground">{label}</p>
                    <p className="text-foreground font-medium truncate">{value}</p>
                  </div>
                ))}
              </div>
              {realism && (
                <div className="flex items-center gap-1.5 text-xs text-primary bg-violet-50 border border-violet-100 rounded-lg px-3 py-2">
                  <Zap className="w-3.5 h-3.5 flex-shrink-0" />
                  Realism Mode: green screen compositing, color grade, film grain, SSML voice, broadcast audio
                </div>
              )}
            </div>
          )}

          {!result && !isGenerating && (
            <Button size="lg" className="w-full text-base h-12 shadow-sm" onClick={generate} disabled={!topic.trim()}>
              <Sparkles className="w-5 h-5" />
              Generate Avatar Video
            </Button>
          )}

          {/* Progress */}
          {isGenerating && progress && (
            <div className="bg-white border border-border rounded-xl p-5 space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{progress.message}</span>
                  <span className="font-mono tabular-nums font-medium text-foreground">{progress.percent}%</span>
                </div>
                <Progress value={progress.percent} className="h-1.5" />
              </div>

              <div className="grid grid-cols-4 gap-1.5 text-[10px]">
                {[
                  { key: "script_done", label: "Script" },
                  { key: "avatar_start", label: "Avatar" },
                  { key: "avatar_done", label: "Effects" },
                  { key: "done", label: "Done" },
                ].map(({ key, label }, idx) => {
                  const phases = ["script_done", "avatar_start", "avatar_done", "done"];
                  const curIdx = phases.indexOf(progress.step);
                  const isComplete = curIdx > idx;
                  const isActive = phases[idx] === progress.step || (progress.step === "script" && idx === 0);
                  return (
                    <div key={key} className={cn(
                      "text-center font-semibold py-1.5 rounded-lg border transition-all",
                      isComplete ? "border-emerald-300 text-emerald-700 bg-emerald-50" :
                      isActive   ? "border-primary text-primary bg-violet-50" :
                                   "border-border text-muted-foreground bg-gray-50"
                    )}>
                      {isComplete ? "✓ " : isActive ? "⟳ " : ""}{label}
                    </div>
                  );
                })}
              </div>

              {liveScript && (
                <details>
                  <summary className="text-xs text-muted-foreground cursor-pointer select-none">Preview script ▾</summary>
                  <div className="mt-2 bg-gray-50 border border-border rounded-lg p-3 text-xs text-muted-foreground max-h-24 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                    {liveScript}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Error */}
          {genError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 space-y-1">
              <p className="font-semibold flex items-center gap-2"><AlertCircle className="w-4 h-4 text-red-500" /> Generation failed</p>
              <p className="text-xs text-red-600">{genError}</p>
              <Button size="sm" variant="outline" className="mt-2 border-red-200 text-red-600 hover:bg-red-50" onClick={() => setGenError(null)}>
                Try Again
              </Button>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="bg-white border border-border rounded-xl p-5 space-y-5">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-emerald-100 flex items-center justify-center">
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">Video Generated!</h3>
                <div className="ml-auto flex items-center gap-1.5">
                  {[result.brandTheme.bgColor1, result.brandTheme.bgColor2, result.brandTheme.accentColor].map((c, i) => (
                    <span key={i} className="w-3.5 h-3.5 rounded-full border border-border shadow-sm" style={{ background: c }} />
                  ))}
                </div>
              </div>

              {/* Thumbnail preview (if available) */}
              {result.thumbnailUrl && (
                <div className="relative">
                  <img
                    src={result.thumbnailUrl}
                    alt="Video thumbnail"
                    className="w-full rounded-lg object-cover bg-gray-100"
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-12 h-12 rounded-full bg-black/40 flex items-center justify-center backdrop-blur-sm">
                      <Play className="w-5 h-5 text-white ml-0.5" />
                    </div>
                  </div>
                </div>
              )}

              <video src={result.videoUrl} controls playsInline className="w-full rounded-lg bg-black" />

              <div className="flex gap-2">
                <a href={result.videoUrl} download="libraryminds-video.mp4" className="flex-1">
                  <Button className="w-full bg-emerald-600 hover:bg-emerald-700 text-white" size="sm">
                    <Download className="w-4 h-4" /> Download MP4
                  </Button>
                </a>
                <Button variant="outline" size="sm" onClick={() => setPage("library")}>
                  <Library className="w-4 h-4" /> Library
                </Button>
                <Button variant="outline" size="sm" onClick={resetForm}>
                  <RotateCcw className="w-4 h-4" /> New
                </Button>
              </div>

              <details>
                <summary className="text-xs text-muted-foreground cursor-pointer select-none flex items-center gap-1">
                  <span>▶</span> View script
                </summary>
                <div className="mt-2 bg-gray-50 border border-border rounded-lg p-3 text-xs text-muted-foreground leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap">
                  {result.script}
                </div>
              </details>
            </div>
          )}

          {!isGenerating && !result && (
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(3)}><ChevronLeft className="w-4 h-4" /> Back</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
