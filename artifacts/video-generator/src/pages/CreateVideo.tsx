import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  ChevronLeft, ChevronRight, Sparkles, Check, Download,
  Library, RotateCcw, Building2, AlertCircle,
  Volume2, VolumeX, Play, Loader2, Zap, Gauge,
  Search, X, Upload, Camera, Globe, Mic2,
} from "lucide-react";
import type { BrandProfile, VideoEntry, Page } from "@/lib/types";
import { PLATFORMS, SCRIPT_STYLES, AVATARS, QUICK_VOICES, VOICE_STYLES, CAPTION_STYLES, SCENE_PRESETS } from "@/lib/config";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────
type Pacing = "slow" | "natural" | "fast";
interface ProgressState { step: string; percent: number; message: string }
interface VoiceEntry {
  value: string;
  label: string;
  locale: string;
  localeName: string;
  gender: "Male" | "Female";
  isHD: boolean;
  isMultilingual: boolean;
  styles: string[];
}
interface ElVoice {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  description?: string;
  preview_url: string;
}
const EL_KEY_LS = "el_api_key";
const getElKey = () => localStorage.getItem(EL_KEY_LS) ?? "";
const PENDING_JOB_KEY = "pending_video_job_id";
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

// ─── Voice Browser Modal ─────────────────────────────────────────
interface VBMProps {
  tab: "azure" | "elevenlabs"; onTabChange: (t: "azure" | "elevenlabs") => void;
  voices: VoiceEntry[] | null; loading: boolean;
  selected: string;
  search: string; onSearchChange: (v: string) => void;
  gender: "all" | "Female" | "Male"; onGenderChange: (v: "all" | "Female" | "Male") => void;
  locale: string; onLocaleChange: (v: string) => void;
  hdOnly: boolean; onHdOnlyChange: (v: boolean) => void;
  onSelect: (v: string) => void;
  onClose: () => void;
  onPreview: (v: string) => void;
  isPreviewing: boolean;
  // ElevenLabs
  elApiKey: string; elKeyInput: string; onElKeyInput: (v: string) => void; onElKeySave: (v: string) => void;
  elVoices: ElVoice[] | null; loadingElVoices: boolean;
  elSearch: string; onElSearchChange: (v: string) => void;
  onFetchElVoices: (key: string) => void;
}

function VoiceBrowserModal(props: VBMProps) {
  const { tab, onTabChange, voices, loading, selected, search, onSearchChange, gender, onGenderChange, locale, onLocaleChange, hdOnly, onHdOnlyChange, onSelect, onClose, onPreview, isPreviewing, elApiKey, elKeyInput, onElKeyInput, onElKeySave, elVoices, loadingElVoices, elSearch, onElSearchChange } = props;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const locales = voices ? [...new Set(voices.map(v => v.locale))].sort() : [];
  const filtered = (voices ?? []).filter(v => {
    if (gender !== "all" && v.gender !== gender) return false;
    if (locale && v.locale !== locale) return false;
    if (hdOnly && !v.isHD) return false;
    if (search) {
      const q = search.toLowerCase();
      return v.label.toLowerCase().includes(q) || v.localeName.toLowerCase().includes(q) || v.locale.toLowerCase().includes(q);
    }
    return true;
  });
  const grouped: Record<string, VoiceEntry[]> = {};
  filtered.forEach(v => {
    if (!grouped[v.locale]) grouped[v.locale] = [];
    grouped[v.locale].push(v);
  });

  const filteredEl = (elVoices ?? []).filter(v =>
    !elSearch || v.name.toLowerCase().includes(elSearch.toLowerCase()) ||
    (v.labels?.accent ?? "").toLowerCase().includes(elSearch.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90vh] sm:max-h-[80vh]" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-border flex-shrink-0">
          <Globe className="w-5 h-5 text-primary" />
          <div className="flex-1">
            <h2 className="text-sm font-bold text-foreground">Voice Browser</h2>
            <p className="text-[11px] text-muted-foreground">
              {tab === "azure"
                ? voices ? `${voices.length} Azure voices across ${locales.length} languages` : "Loading Azure voices…"
                : elVoices ? `${elVoices.length} ElevenLabs voices` : "Connect your ElevenLabs account"
              }
            </p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border flex-shrink-0">
          {(["azure", "elevenlabs"] as const).map(t => (
            <button key={t} onClick={() => onTabChange(t)}
              className={cn("flex-1 py-2.5 text-xs font-semibold transition-all border-b-2 -mb-px",
                tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t === "azure" ? "Azure (643 voices)" : "ElevenLabs"}
            </button>
          ))}
        </div>

        {/* ── Azure tab ── */}
        {tab === "azure" && (
          <>
            <div className="px-4 py-3 border-b border-border flex flex-col gap-2 flex-shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input type="text" value={search} onChange={e => onSearchChange(e.target.value)}
                  placeholder="Search by name, language or locale…"
                  className="w-full pl-8 pr-3 py-2 text-xs border border-border rounded-lg bg-gray-50 focus:outline-none focus:border-primary"
                />
                {search && <button onClick={() => onSearchChange("")} className="absolute right-2.5 top-1/2 -translate-y-1/2"><X className="w-3 h-3 text-muted-foreground" /></button>}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {(["all", "Female", "Male"] as const).map(g => (
                  <button key={g} onClick={() => onGenderChange(g)}
                    className={cn("px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all",
                      gender === g ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                    )}
                  >{g === "all" ? "All genders" : g}</button>
                ))}
                <button onClick={() => onHdOnlyChange(!hdOnly)}
                  className={cn("px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all",
                    hdOnly ? "border-violet-500 bg-violet-50 text-violet-700" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >HD only</button>
                <select value={locale} onChange={e => onLocaleChange(e.target.value)}
                  className="ml-auto text-[11px] border border-border rounded-lg px-2 py-1 bg-white text-muted-foreground focus:outline-none focus:border-primary max-w-[160px]"
                >
                  <option value="">All languages</option>
                  {locales.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 p-4 space-y-4">
              {loading && <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading 600+ voices…</div>}
              {!loading && Object.keys(grouped).length === 0 && <div className="text-center py-12 text-sm text-muted-foreground">No voices match your filters</div>}
              {!loading && Object.entries(grouped).map(([loc, vs]) => (
                <div key={loc}>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                    {vs[0].localeName} <span className="opacity-50">· {loc} · {vs.length} voice{vs.length !== 1 ? "s" : ""}</span>
                  </p>
                  <div className="space-y-1">
                    {vs.map(v => (
                      <div key={v.value}
                        className={cn("flex items-center gap-3 px-3 py-2 rounded-lg border text-xs transition-all cursor-pointer hover:border-primary/40",
                          selected === v.value ? "border-primary bg-violet-50" : "border-transparent hover:bg-gray-50"
                        )}
                        onClick={() => onSelect(v.value)}
                      >
                        <div className={cn("w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0",
                          v.gender === "Female" ? "bg-pink-100 text-pink-600" : "bg-blue-100 text-blue-600"
                        )}>{v.gender === "Female" ? "F" : "M"}</div>
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-foreground">{v.label}</span>
                          {v.isMultilingual && <span className="ml-1.5 text-[9px] text-violet-500 bg-violet-50 px-1 rounded">Multilingual</span>}
                        </div>
                        {v.isHD && <Badge variant="secondary" className="text-[9px] bg-violet-100 text-violet-700 border-0 py-0 h-4">HD</Badge>}
                        {selected === v.value && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                        <button onClick={e => { e.stopPropagation(); onPreview(v.value); }} disabled={isPreviewing}
                          className="p-1 rounded hover:bg-white text-muted-foreground hover:text-primary transition-colors flex-shrink-0 disabled:opacity-30"
                        ><Play className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── ElevenLabs tab ── */}
        {tab === "elevenlabs" && (
          <>
            <div className="px-4 py-3 border-b border-border flex-shrink-0">
              {!elApiKey ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Enter your ElevenLabs API key to access your voices. Your key is saved locally and never stored on our servers.</p>
                  <div className="flex gap-2">
                    <input type="password" value={elKeyInput} onChange={e => onElKeyInput(e.target.value)}
                      placeholder="sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="flex-1 input text-xs font-mono"
                      onKeyDown={e => { if (e.key === "Enter" && elKeyInput.trim()) onElKeySave(elKeyInput.trim()); }}
                    />
                    <Button size="sm" onClick={() => onElKeySave(elKeyInput.trim())} disabled={!elKeyInput.trim() || loadingElVoices}>
                      {loadingElVoices ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Connect"}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">Get your key at <span className="text-primary font-medium">elevenlabs.io/app/settings/api-keys</span></p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-emerald-600 flex items-center gap-1"><Check className="w-3 h-3" /> ElevenLabs connected</span>
                    <button onClick={() => { onElKeySave(""); }} className="text-[10px] text-muted-foreground hover:text-red-500 ml-auto">Disconnect</button>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                    <input type="text" value={elSearch} onChange={e => onElSearchChange(e.target.value)}
                      placeholder="Search voices or accent…"
                      className="w-full pl-8 pr-3 py-2 text-xs border border-border rounded-lg bg-gray-50 focus:outline-none focus:border-primary"
                    />
                    {elSearch && <button onClick={() => onElSearchChange("")} className="absolute right-2.5 top-1/2 -translate-y-1/2"><X className="w-3 h-3 text-muted-foreground" /></button>}
                  </div>
                </div>
              )}
            </div>
            <div className="overflow-y-auto flex-1 p-4 space-y-1">
              {loadingElVoices && <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading ElevenLabs voices…</div>}
              {!loadingElVoices && elApiKey && elVoices?.length === 0 && <div className="text-center py-12 text-sm text-muted-foreground">No voices found. Check your API key.</div>}
              {!loadingElVoices && !elApiKey && (
                <div className="text-center py-12 text-sm text-muted-foreground">Connect your ElevenLabs account above to see your voices.</div>
              )}
              {!loadingElVoices && filteredEl.map(v => {
                const elVal = `el:${v.voice_id}`;
                return (
                  <div key={v.voice_id}
                    className={cn("flex items-center gap-3 px-3 py-2 rounded-lg border text-xs transition-all cursor-pointer hover:border-orange-400/60",
                      selected === elVal ? "border-orange-400 bg-orange-50" : "border-transparent hover:bg-gray-50"
                    )}
                    onClick={() => onSelect(elVal)}
                  >
                    <div className="w-5 h-5 rounded-full bg-orange-100 flex items-center justify-center text-[9px] font-bold text-orange-600 flex-shrink-0">EL</div>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-foreground">{v.name}</span>
                      {v.labels?.accent && <span className="ml-1.5 text-[9px] text-muted-foreground">{v.labels.accent}</span>}
                      {v.category && <span className="ml-1.5 text-[9px] bg-orange-50 text-orange-600 px-1 rounded">{v.category}</span>}
                    </div>
                    {selected === elVal && <Check className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />}
                    <button onClick={e => { e.stopPropagation(); onPreview(elVal); }} disabled={isPreviewing}
                      className="p-1 rounded hover:bg-white text-muted-foreground hover:text-orange-500 transition-colors flex-shrink-0 disabled:opacity-30"
                    ><Play className="w-3 h-3" /></button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="p-4 border-t border-border flex-shrink-0">
          <Button size="sm" variant="outline" className="w-full" onClick={onClose}>Done</Button>
        </div>
      </div>
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
  const [avatar, setAvatar] = useState(() => {
    const saved = brand.defaultAvatar || "lisa";
    return AVATARS[saved] ? saved : "lisa";
  });
  const [avatarStyle, setAvatarStyle] = useState(() => {
    const saved = brand.defaultAvatar || "lisa";
    const initialAvatar = AVATARS[saved] ? saved : "lisa";
    const charStyles = AVATARS[initialAvatar]?.styles ?? [""];
    const brandStyle = brand.defaultAvatarStyle || "";
    return (brandStyle && charStyles.includes(brandStyle)) ? brandStyle : (charStyles[0] ?? "");
  });
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

  // Voice browser modal
  const [showVoiceBrowser, setShowVoiceBrowser] = useState(false);
  const [voiceBrowserTab, setVoiceBrowserTab] = useState<"azure" | "elevenlabs">("azure");
  const [allVoices, setAllVoices] = useState<VoiceEntry[] | null>(null);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceGender, setVoiceGender] = useState<"all" | "Female" | "Male">("all");
  const [voiceLocale, setVoiceLocale] = useState("");
  const [voiceHdOnly, setVoiceHdOnly] = useState(false);

  // ElevenLabs
  const [elApiKey, setElApiKey] = useState(getElKey);
  const [elVoices, setElVoices] = useState<ElVoice[] | null>(null);
  const [loadingElVoices, setLoadingElVoices] = useState(false);
  const [elVoiceSearch, setElVoiceSearch] = useState("");
  const [elKeyInput, setElKeyInput] = useState(getElKey);

  // Custom photo upload (presenter badge in video)
  const [customPhotoUrl, setCustomPhotoUrl] = useState<string | null>(null);
  const [customPhotoPreview, setCustomPhotoPreview] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [liveScript, setLiveScript] = useState<string | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [resumedJob, setResumedJob] = useState(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  function stopPolling() {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }

  function startPolling(jobId: string) {
    stopPolling();
    pollIntervalRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`/api/jobs/${jobId}`);
        if (!resp.ok) {
          if (resp.status === 404) {
            stopPolling();
            setGenError("Job not found. It may have expired — please try again.");
            setIsGenerating(false);
            localStorage.removeItem(PENDING_JOB_KEY);
          }
          return;
        }
        const job = await resp.json() as {
          status: string; step: string; percent: number; message: string;
          script?: string; error?: string;
          result?: { videoId: string; videoUrl: string; thumbnailUrl: string | null; script: string; brandTheme: BrandTheme };
        };

        setProgress({ step: job.step, percent: job.percent, message: job.message });
        if (job.script) setLiveScript(job.script);

        if (job.status === "done" && job.result) {
          stopPolling();
          localStorage.removeItem(PENDING_JOB_KEY);
          const r: GenerationResult = {
            videoId: job.result.videoId,
            videoUrl: job.result.videoUrl + "?t=" + Date.now(),
            thumbnailUrl: job.result.thumbnailUrl ? job.result.thumbnailUrl + "?t=" + Date.now() : undefined,
            script: job.result.script,
            brandTheme: job.result.brandTheme,
          };
          // Save to library FIRST (synchronous write) before any React
          // state updates that could trigger a crashing render.
          addVideo({
            id: r.videoId,
            topic: topic.trim() || "Video",
            platform,
            scriptStyle,
            captionStyle,
            voice,
            avatar,
            videoUrl: job.result.videoUrl,
            thumbnailUrl: job.result.thumbnailUrl ?? undefined,
            script: r.script,
            brandTheme: r.brandTheme,
            createdAt: new Date().toISOString(),
          });
          setResult(r);
          setLiveScript(r.script);
          setProgress({ step: "done", percent: 100, message: "Your video is ready!" });
          setIsGenerating(false);
        } else if (job.status === "failed") {
          stopPolling();
          localStorage.removeItem(PENDING_JOB_KEY);
          setGenError(job.error ?? "Generation failed");
          setProgress(null);
          setIsGenerating(false);
        }
      } catch {
        // network blip — keep polling
      }
    }, 2500);
  }

  // On mount: resume polling if a job was in-progress when page closed
  useEffect(() => {
    const pendingId = localStorage.getItem(PENDING_JOB_KEY);
    if (pendingId) {
      setIsGenerating(true);
      setResumedJob(true);
      setStep(4);
      setProgress({ step: "start", percent: 0, message: "Reconnecting to your video job…" });
      startPolling(pendingId);
    }
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchAllVoices() {
    if (allVoices) { setShowVoiceBrowser(true); return; }
    setShowVoiceBrowser(true);
    setLoadingVoices(true);
    try {
      const res = await fetch("/api/voices");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as VoiceEntry[];
      setAllVoices(data);
    } catch {
      // fallback to quick voices on error
    } finally {
      setLoadingVoices(false);
    }
  }

  async function fetchElVoices(key: string) {
    if (!key.trim()) return;
    setLoadingElVoices(true);
    setElVoices(null);
    try {
      const res = await fetch("/api/elevenlabs/voices", {
        headers: { "x-elevenlabs-key": key.trim() },
      });
      const data = await res.json() as ElVoice[] | { error: string };
      if (!res.ok) throw new Error((data as { error: string }).error ?? `HTTP ${res.status}`);
      setElVoices(data as ElVoice[]);
    } catch (err) {
      setElVoices([]);
      console.error("ElevenLabs voices error:", err);
    } finally {
      setLoadingElVoices(false);
    }
  }

  function saveElApiKey(key: string) {
    setElApiKey(key);
    setElKeyInput(key);
    localStorage.setItem(EL_KEY_LS, key);
    if (key.trim()) fetchElVoices(key.trim());
  }

  async function handlePhotoUpload(file: File) {
    setUploadingPhoto(true);
    setCustomPhotoPreview(URL.createObjectURL(file));
    try {
      const fd = new FormData();
      fd.append("photo", file);
      const res = await fetch("/api/upload-photo", { method: "POST", body: fd });
      const data = await res.json() as { photoUrl?: string; error?: string };
      if (!res.ok || !data.photoUrl) throw new Error(data.error ?? "Upload failed");
      setCustomPhotoUrl(data.photoUrl);
    } catch {
      setCustomPhotoUrl(null);
    } finally {
      setUploadingPhoto(false);
    }
  }

  function clearPhoto() {
    setCustomPhotoUrl(null);
    setCustomPhotoPreview(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
  }

  async function previewVoice() {
    stopPreview();
    setIsPreviewing(true);
    setPreviewError(null);
    try {
      const isEl = voice.startsWith("el:");
      const url = isEl ? "/api/elevenlabs/preview" : "/api/preview-voice";
      const body = isEl
        ? JSON.stringify({ voiceId: voice.slice(3) })
        : JSON.stringify({ voice });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (isEl && elApiKey) headers["x-elevenlabs-key"] = elApiKey;

      const res = await fetch(url, { method: "POST", headers, body });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const audio = new Audio(objUrl);
      audioRef.current = audio;
      audio.onended = () => { setIsPreviewing(false); URL.revokeObjectURL(objUrl); };
      audio.onerror = () => { setIsPreviewing(false); };
      await audio.play();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
      setIsPreviewing(false);
    }
  }

  function buildPayload(): Record<string, unknown> {
    const isEl = voice.startsWith("el:");
    const base = {
      topic: topic.trim(), platform, scriptStyle,
      avatar, avatarStyle, voice,
      voiceStyle: voiceStyle || undefined,
      captionStyle,
      realism,
      pacing,
      customPhotoUrl: customPhotoUrl || undefined,
      elevenLabsKey: isEl && elApiKey ? elApiKey : undefined,
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
        companyName: brand.companyName || undefined,
        companyWebsite: brand.websiteUrl || undefined,
        companyDescription: brand.description || undefined,
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
      companyName: brand.companyName || undefined,
      companyWebsite: brand.websiteUrl || undefined,
      companyDescription: brand.description || undefined,
    };
  }

  async function generate() {
    setIsGenerating(true);
    setGenError(null);
    setResult(null);
    setLiveScript(null);
    setResumedJob(false);
    setProgress({ step: "start", percent: 0, message: "Starting…" });

    const payload = buildPayload();
    const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));

    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanPayload),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
        throw new Error(err.error ?? `HTTP ${resp.status}`);
      }

      const { jobId } = await resp.json() as { jobId: string };
      localStorage.setItem(PENDING_JOB_KEY, jobId);
      startPolling(jobId);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
      setProgress(null);
      setIsGenerating(false);
    }
  }

  function resetForm() {
    stopPolling();
    localStorage.removeItem(PENDING_JOB_KEY);
    setStep(1);
    setTopic("");
    setResult(null);
    setProgress(null);
    setLiveScript(null);
    setGenError(null);
    setIsGenerating(false);
    setResumedJob(false);
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

          {/* ── Character Cards ── */}
          <div>
            <SLabel>Character</SLabel>
            <div className="grid grid-cols-5 gap-2">
              {Object.entries(AVATARS).map(([key, char]) => (
                <button key={key} onClick={() => handleAvatarChange(key)}
                  className={cn(
                    "relative flex flex-col items-center gap-2 py-3 px-1 rounded-xl border-2 text-xs font-medium transition-all overflow-hidden",
                    avatar === key ? "border-primary shadow-md" : "border-border hover:border-primary/40"
                  )}
                >
                  {/* Gradient background */}
                  <div
                    className="absolute inset-0 opacity-90"
                    style={{ background: `linear-gradient(135deg, ${char.gradient[0]}, ${char.gradient[1]})` }}
                  />
                  {/* Content */}
                  <div className="relative z-10 flex flex-col items-center gap-1.5">
                    <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center border border-white/30">
                      <span className="text-xl text-white font-bold">{char.label[0]}</span>
                    </div>
                    <span className="text-white font-semibold text-[11px]">{char.label}</span>
                    <span className={cn(
                      "text-[9px] px-1.5 py-0.5 rounded-full font-medium",
                      char.gender === "F" ? "bg-pink-400/80 text-white" : "bg-blue-400/80 text-white"
                    )}>
                      {char.gender === "F" ? "Female" : "Male"}
                    </span>
                  </div>
                  {/* Selected ring */}
                  {avatar === key && (
                    <div className="absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                      <Check className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                </button>
              ))}
            </div>
            {/* Character description + style count */}
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{AVATARS[avatar]?.label}</span>
              <span>·</span>
              <span>{AVATARS[avatar]?.desc}</span>
              <span>·</span>
              <span>{AVATARS[avatar]?.styles.filter(s => s !== "").length || "default"} {AVATARS[avatar]?.styles.filter(s => s !== "").length ? "styles" : "style"}</span>
            </div>
          </div>

          {/* ── Avatar Style ── */}
          {AVATARS[avatar]?.styles.some((s) => s !== "") && (
            <div>
              <SLabel>Avatar Style</SLabel>
              <div className="flex flex-wrap gap-2">
                {AVATARS[avatar]?.styles.filter((s) => s !== "").map((s) => (
                  <Pill key={s} active={avatarStyle === s} onClick={() => setAvatarStyle(s)}>
                    {s.replace(/-/g, " ")}
                  </Pill>
                ))}
              </div>
            </div>
          )}

          {/* ── Custom Photo Badge ── */}
          <div>
            <SLabel>Presenter Photo Badge <span className="text-muted-foreground font-normal ml-1">(optional)</span></SLabel>
            <div className="flex items-center gap-3">
              {customPhotoPreview ? (
                <div className="relative">
                  <img src={customPhotoPreview} alt="Photo badge" className="w-14 h-14 rounded-xl object-cover border-2 border-primary shadow-sm" />
                  {uploadingPhoto && (
                    <div className="absolute inset-0 rounded-xl bg-black/40 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-white animate-spin" />
                    </div>
                  )}
                  {!uploadingPhoto && (
                    <button onClick={clearPhoto} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-white">
                      <X className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
              ) : (
                <div className="w-14 h-14 rounded-xl border-2 border-dashed border-border bg-gray-50 flex items-center justify-center">
                  <Camera className="w-5 h-5 text-muted-foreground" />
                </div>
              )}
              <div className="flex-1">
                <Button size="sm" variant="outline" className="gap-2 text-xs"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={uploadingPhoto}
                >
                  <Upload className="w-3.5 h-3.5" />
                  {customPhotoPreview ? "Change photo" : "Upload your photo"}
                </Button>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Your photo appears as a corner badge in the final video
                </p>
                <input ref={photoInputRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePhotoUpload(f); }}
                />
              </div>
              {customPhotoUrl && !uploadingPhoto && (
                <span className="text-[10px] text-emerald-600 flex items-center gap-1 flex-shrink-0">
                  <Check className="w-3 h-3" /> Uploaded
                </span>
              )}
            </div>
          </div>

          {/* ── Voice Browser ── */}
          <div className="space-y-3">
            <SLabel>Voice</SLabel>

            {/* Current voice chip + browse button */}
            {(() => {
              const isEl = voice.startsWith("el:");
              const elId = isEl ? voice.slice(3) : null;
              const elVoice = elId ? elVoices?.find(v => v.voice_id === elId) : null;
              const azureVoice = !isEl ? QUICK_VOICES.find(v => v.value === voice) : null;
              return (
                <div className={cn("flex items-center gap-3 p-3 border rounded-xl", isEl ? "bg-orange-50 border-orange-200" : "bg-gray-50 border-border")}>
                  <div className={cn("w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0", isEl ? "bg-orange-100" : "bg-primary/10")}>
                    <Mic2 className={cn("w-4 h-4", isEl ? "text-orange-500" : "text-primary")} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {isEl
                        ? (elVoice?.name ?? `ElevenLabs voice`)
                        : (azureVoice?.label ?? voice.split("-").slice(2).join("-").replace(/Neural$/, ""))
                      }
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {isEl
                        ? (elVoice?.labels?.accent ? `ElevenLabs · ${elVoice.labels.accent}` : "ElevenLabs")
                        : (azureVoice?.desc ?? voice.split("-").slice(0, 2).join("-"))
                      }
                    </p>
                  </div>
                  {isEl && <Badge variant="secondary" className="text-[10px] bg-orange-100 text-orange-600 border-0 flex-shrink-0">EL</Badge>}
                  {!isEl && azureVoice?.isHD && <Badge variant="secondary" className="text-[10px] bg-violet-100 text-violet-700 border-0 flex-shrink-0">HD</Badge>}
                  <Button size="sm" variant="outline" className="gap-1.5 text-xs flex-shrink-0"
                    onClick={() => { setVoiceBrowserTab(isEl ? "elevenlabs" : "azure"); fetchAllVoices(); }}
                  >
                    <Globe className="w-3.5 h-3.5" /> Browse all
                  </Button>
                </div>
              );
            })()}

            {/* Quick-select popular voices */}
            <div>
              <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wide font-medium">Popular voices</p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_VOICES.slice(0, 10).map((v) => (
                  <button key={v.value} onClick={() => handleVoiceChange(v.value)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-all",
                      voice === v.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                    )}
                  >
                    {v.label}
                    <span className="text-[9px] opacity-60">{v.locale}</span>
                    {v.isHD && <span className="text-[8px] bg-violet-100 text-violet-600 px-1 rounded">HD</span>}
                  </button>
                ))}
                <button onClick={fetchAllVoices}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-dashed border-primary/40 bg-violet-50 text-xs font-medium text-primary transition-all hover:border-primary"
                >
                  <Search className="w-3 h-3" /> 600+ voices
                </button>
              </div>
            </div>

            {/* Voice Emotion */}
            {voiceStyleOptions.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Voice Emotion</p>
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={() => setVoiceStyle("")}
                    className={cn("px-2.5 py-1 rounded-full border text-xs font-medium transition-all",
                      !voiceStyle ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                    )}>Default</button>
                  {voiceStyleOptions.map((s) => (
                    <button key={s.value} onClick={() => setVoiceStyle(s.value)}
                      className={cn("px-2.5 py-1 rounded-full border text-xs font-medium transition-all",
                        voiceStyle === s.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                      )}>{s.label}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Voice Preview */}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={previewVoice} disabled={isPreviewing} className="gap-2 text-xs">
                {isPreviewing ? <><Volume2 className="w-3.5 h-3.5 text-primary animate-pulse" /> Playing…</> : <><Play className="w-3.5 h-3.5" /> Preview voice</>}
              </Button>
              {isPreviewing && (
                <Button size="sm" variant="ghost" onClick={stopPreview} className="gap-1.5 text-xs text-muted-foreground">
                  <VolumeX className="w-3.5 h-3.5" /> Stop
                </Button>
              )}
              {previewError && <span className="text-xs text-red-500 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {previewError}</span>}
              {!previewError && !isPreviewing && <span className="text-xs text-muted-foreground">Hear a 5-second sample</span>}
            </div>
          </div>

          {/* ── Caption Style ── */}
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

          {/* ── Realism Mode + Pacing ── */}
          <div className="bg-gray-50 border border-border rounded-xl p-4 space-y-4">
            <p className="text-xs font-semibold text-foreground flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-primary" /> Generation Settings
            </p>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">Realism Mode</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Chroma key, color grade, film grain, Ken Burns, broadcast audio
                </p>
              </div>
              <button onClick={() => setRealism(!realism)}
                className={cn("relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none", realism ? "bg-primary" : "bg-gray-300")}
                role="switch" aria-checked={realism}
              >
                <span className={cn("absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200", realism ? "translate-x-5" : "translate-x-0")} />
              </button>
            </div>
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
                    className={cn("flex-1 py-2 rounded-lg border text-xs font-medium transition-all",
                      pacing === p.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/30"
                    )}
                  >
                    <div>{p.label}</div><div className="text-[10px] opacity-70">{p.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-between pt-2">
            <Button variant="outline" onClick={() => setStep(2)}><ChevronLeft className="w-4 h-4" /> Back</Button>
            <Button onClick={() => setStep(4)}>Review & Generate <ChevronRight className="w-4 h-4" /></Button>
          </div>
        </div>
      )}

      {/* ──────────────────── VOICE BROWSER MODAL ──────────────────── */}
      {showVoiceBrowser && (
        <VoiceBrowserModal
          tab={voiceBrowserTab} onTabChange={setVoiceBrowserTab}
          voices={allVoices} loading={loadingVoices}
          selected={voice}
          search={voiceSearch} onSearchChange={setVoiceSearch}
          gender={voiceGender} onGenderChange={setVoiceGender}
          locale={voiceLocale} onLocaleChange={setVoiceLocale}
          hdOnly={voiceHdOnly} onHdOnlyChange={setVoiceHdOnly}
          onSelect={(v) => { handleVoiceChange(v); setShowVoiceBrowser(false); }}
          onClose={() => setShowVoiceBrowser(false)}
          onPreview={(v) => {
            stopPreview();
            setIsPreviewing(true);
            setPreviewError(null);
            const isEl = v.startsWith("el:");
            const url = isEl ? "/api/elevenlabs/preview" : "/api/preview-voice";
            const body = isEl ? JSON.stringify({ voiceId: v.slice(3) }) : JSON.stringify({ voice: v });
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (isEl && elApiKey) headers["x-elevenlabs-key"] = elApiKey;
            fetch(url, { method: "POST", headers, body })
              .then(r => r.blob()).then(blob => {
                const objUrl = URL.createObjectURL(blob);
                const audio = new Audio(objUrl);
                audioRef.current = audio;
                audio.onended = () => { setIsPreviewing(false); URL.revokeObjectURL(objUrl); };
                return audio.play();
              })
              .catch(() => setIsPreviewing(false));
          }}
          isPreviewing={isPreviewing}
          elApiKey={elApiKey}
          elKeyInput={elKeyInput} onElKeyInput={setElKeyInput}
          onElKeySave={saveElApiKey}
          elVoices={elVoices} loadingElVoices={loadingElVoices}
          elSearch={elVoiceSearch} onElSearchChange={setElVoiceSearch}
          onFetchElVoices={fetchElVoices}
        />
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
                  { label: "Avatar", value: avatarStyle ? `${AVATARS[avatar]?.label ?? avatar} · ${avatarStyle.replace(/-/g, " ")}` : (AVATARS[avatar]?.label ?? avatar) },
                  { label: "Voice", value: voice.startsWith("el:") ? (elVoices?.find(v => v.voice_id === voice.slice(3))?.name ?? "ElevenLabs voice") + " (ElevenLabs)" : (QUICK_VOICES.find((v) => v.value === voice)?.label ?? voice.split("-").slice(2).join("-").replace(/Neural$/, "")) },
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
              {resumedJob && (
                <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>Your video job is still running — reconnected automatically.</span>
                </div>
              )}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{progress.message}</span>
                  <span className="font-mono tabular-nums font-medium text-foreground">{progress.percent}%</span>
                </div>
                <Progress value={progress.percent} className="h-1.5" />
              </div>

              <div className="grid grid-cols-4 gap-1.5 text-[10px]">
                {[
                  { keys: ["script", "script_done", "elevenlabs"], label: "Script" },
                  { keys: ["avatar_start"], label: "Avatar" },
                  { keys: ["avatar_done", "thumbnail"], label: "Effects" },
                  { keys: ["done"], label: "Done" },
                ].map(({ keys, label }, idx) => {
                  const allPhases = ["script", "script_done", "elevenlabs", "avatar_start", "avatar_done", "thumbnail", "done"];
                  const milestones = [0, 3, 4, 6]; // index in allPhases each pill "owns"
                  const curIdx = allPhases.indexOf(progress.step);
                  const isActive = keys.includes(progress.step);
                  const isComplete = curIdx >= 0 && curIdx > (milestones[idx] ?? 99);
                  return (
                    <div key={label} className={cn(
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
                {result.brandTheme && (
                  <div className="ml-auto flex items-center gap-1.5">
                    {[result.brandTheme.bgColor1, result.brandTheme.bgColor2, result.brandTheme.accentColor].filter(Boolean).map((c, i) => (
                      <span key={i} className="w-3.5 h-3.5 rounded-full border border-border shadow-sm" style={{ background: c }} />
                    ))}
                  </div>
                )}
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
