import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Globe, Sparkles, Save, RotateCcw, Building2, AlertCircle,
  Check, Loader2, Link2,
} from "lucide-react";
import type { BrandProfile, BrandAnalysisResult } from "@/lib/types";
import { VOICES, VOICE_STYLES, AVATARS, SCRIPT_STYLES, CAPTION_STYLES, SCENE_PRESETS } from "@/lib/config";
import { cn } from "@/lib/utils";

interface Props {
  brand: BrandProfile;
  updateBrand: (changes: Partial<BrandProfile>) => void;
  resetBrand: () => void;
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="label-xs">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          className="w-9 h-9 rounded-lg border border-border cursor-pointer bg-transparent" />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="input flex-1 font-mono text-xs" />
      </div>
    </div>
  );
}

function Section({ title, children, badge }: { title: string; children: React.ReactNode; badge?: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {badge && <Badge variant="secondary" className="text-[10px]">{badge}</Badge>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="label-xs">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function BrandSettings({ brand, updateBrand, resetBrand }: Props) {
  const [websiteUrl, setWebsiteUrl] = useState(brand.websiteUrl || "");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeSuccess, setAnalyzeSuccess] = useState(false);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState<BrandProfile>({ ...brand });

  const hasChanges = JSON.stringify(form) !== JSON.stringify(brand) || websiteUrl !== brand.websiteUrl;

  function setF(key: keyof BrandProfile, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function analyzeWebsite() {
    const url = websiteUrl.trim();
    if (!url) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeSuccess(false);

    try {
      const res = await fetch("/api/analyze-brand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ websiteUrl: url }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as BrandAnalysisResult;

      setForm((prev) => ({
        ...prev,
        websiteUrl: url,
        companyName: data.companyName || prev.companyName,
        tagline: data.tagline || prev.tagline,
        description: data.description || prev.description,
        logoUrl: data.logoUrl || prev.logoUrl,
        primaryColor: /^#[0-9a-fA-F]{6}$/.test(data.primaryColor ?? "") ? data.primaryColor : prev.primaryColor,
        secondaryColor: /^#[0-9a-fA-F]{6}$/.test(data.secondaryColor ?? "") ? data.secondaryColor : prev.secondaryColor,
        tone: data.tone || prev.tone,
        defaultCta: data.suggestedCta || prev.defaultCta,
      }));
      setAnalyzeSuccess(true);
      setTimeout(() => setAnalyzeSuccess(false), 4000);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  function save() {
    updateBrand({ ...form, websiteUrl });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function handleReset() {
    if (window.confirm("Reset all brand settings to defaults?")) {
      resetBrand();
      setForm({ ...brand });
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">Brand Settings</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Configure your company identity for all videos</p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {hasChanges && (
            <Button onClick={handleReset} variant="ghost" size="sm" className="text-muted-foreground">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </Button>
          )}
          <Button onClick={save} size="sm" className={saved ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}>
            {saved ? <><Check className="w-4 h-4" /> Saved!</> : <><Save className="w-4 h-4" /> Save Profile</>}
          </Button>
        </div>
      </div>

      {/* ── Website Analyzer ── */}
      <div className="bg-violet-50 border border-violet-100 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-primary">AI Brand Analyzer</h3>
          <Badge variant="secondary" className="text-[10px]">Auto-detect</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Enter your website URL and AI will automatically extract your brand name, colors, description, and logo.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="url"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !analyzing && analyzeWebsite()}
              placeholder="https://yourcompany.com"
              className="input pl-9 bg-white"
            />
          </div>
          <Button onClick={analyzeWebsite} disabled={analyzing || !websiteUrl.trim()} className="flex-shrink-0">
            {analyzing ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing…</>
            ) : (
              <><Sparkles className="w-4 h-4" /> Analyze</>
            )}
          </Button>
        </div>

        {analyzing && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Fetching and analyzing your website…</p>
            <Progress value={undefined} className="h-1 animate-pulse" />
          </div>
        )}
        {analyzeSuccess && (
          <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
            Brand profile populated from {(() => { try { return new URL(websiteUrl).hostname; } catch { return websiteUrl; } })()}. Review and save.
          </div>
        )}
        {analyzeError && (
          <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
            <span>{analyzeError}</span>
          </div>
        )}
      </div>

      {/* ── Company Identity ── */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-5">
        <Section title="Company Identity">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Company Name">
              <input type="text" value={form.companyName} onChange={(e) => setF("companyName", e.target.value)}
                placeholder="Libraryminds" className="input" />
            </Field>
            <Field label="Tagline">
              <input type="text" value={form.tagline} onChange={(e) => setF("tagline", e.target.value)}
                placeholder="Learn. Create. Inspire." className="input" />
            </Field>
          </div>

          <Field label="Brand Description" hint="Used by AI when crafting your video scripts">
            <textarea value={form.description} onChange={(e) => setF("description", e.target.value)}
              placeholder="1–2 sentences about your company, products, and audience…"
              rows={3} className="input resize-none" />
          </Field>

          <Field label="Voice Tone">
            <div className="flex flex-wrap gap-2">
              {["professional", "casual", "energetic", "trustworthy", "creative"].map((t) => (
                <button key={t} onClick={() => setF("tone", t)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg border text-xs font-medium capitalize transition-all",
                    form.tone === t ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >{t}</button>
              ))}
            </div>
          </Field>
        </Section>
      </div>

      {/* ── Visual Identity ── */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-5">
        <Section title="Visual Identity">
          <Field label="Brand Logo URL" hint="Displayed in the top-right of every video">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input type="url" value={form.logoUrl} onChange={(e) => setF("logoUrl", e.target.value)}
                  placeholder="https://example.com/logo.png" className="input pl-9" />
              </div>
              {form.logoUrl && (
                <div className="w-10 h-10 rounded-lg border border-border bg-gray-50 flex items-center justify-center overflow-hidden flex-shrink-0">
                  <img src={form.logoUrl} alt="logo preview" className="w-full h-full object-contain"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                      const p = e.currentTarget.parentElement;
                      if (p) p.innerHTML = '<span class="text-muted-foreground text-[10px]">Error</span>';
                    }}
                  />
                </div>
              )}
            </div>
          </Field>

          <div className="grid grid-cols-3 gap-4">
            <ColorInput label="Primary / Accent" value={form.primaryColor} onChange={(v) => setF("primaryColor", v)} />
            <ColorInput label="Secondary" value={form.secondaryColor} onChange={(v) => setF("secondaryColor", v)} />
            <ColorInput label="Background" value={form.backgroundColor} onChange={(v) => setF("backgroundColor", v)} />
          </div>

          {/* Color preview strip */}
          <div className="rounded-lg overflow-hidden h-8 flex shadow-sm">
            <div className="flex-[2]" style={{ background: `linear-gradient(135deg, ${form.backgroundColor}, ${form.secondaryColor})` }} />
            <div className="flex-1" style={{ background: form.primaryColor }} />
          </div>

          <Field label="Default Call to Action" hint="Shown as lower-third text in every video">
            <input type="text" value={form.defaultCta} onChange={(e) => setF("defaultCta", e.target.value)}
              placeholder="Visit yourcompany.com today!" className="input" />
          </Field>
        </Section>
      </div>

      {/* ── Default Video Settings ── */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-5">
        <Section title="Default Video Settings" badge="Optional">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Default Voice">
              <select value={form.defaultVoice} onChange={(e) => { setF("defaultVoice", e.target.value); setF("defaultVoiceStyle", ""); }}
                className="input cursor-pointer text-xs">
                {VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </Field>
            <Field label="Voice Emotion">
              {(() => {
                const opts = VOICE_STYLES[form.defaultVoice] ?? [];
                return (
                  <select value={form.defaultVoiceStyle} onChange={(e) => setF("defaultVoiceStyle", e.target.value)}
                    disabled={opts.length === 0} className="input cursor-pointer text-xs disabled:opacity-40">
                    <option value="">Default</option>
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                );
              })()}
            </Field>
          </div>

          <Field label="Default Avatar">
            <div className="grid grid-cols-5 gap-2">
              {Object.entries(AVATARS).map(([key, { label, emoji }]) => (
                <button key={key} onClick={() => { setF("defaultAvatar", key); setF("defaultAvatarStyle", AVATARS[key]?.styles[0] ?? ""); }}
                  className={cn(
                    "flex flex-col items-center gap-1 py-2.5 rounded-lg border text-xs font-medium transition-all",
                    form.defaultAvatar === key ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >
                  <span className="text-lg">{emoji}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </Field>

          <Separator />

          <Field label="Default Script Style">
            <div className="grid grid-cols-5 gap-2">
              {SCRIPT_STYLES.map((s) => (
                <button key={s.value} onClick={() => setF("defaultScriptStyle", s.value)}
                  className={cn(
                    "flex flex-col items-center gap-1 py-2.5 rounded-lg border text-xs font-medium transition-all",
                    form.defaultScriptStyle === s.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >
                  <span className="text-base">{s.emoji}</span>
                  <span className="text-center leading-tight">{s.label}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Default Scene Preset">
            <div className="grid grid-cols-4 gap-2">
              {SCENE_PRESETS.map((p) => (
                <button key={p.value} onClick={() => setF("defaultScenePreset", p.value)}
                  className={cn(
                    "flex flex-col items-center gap-1 py-2.5 rounded-lg border text-xs font-medium transition-all",
                    form.defaultScenePreset === p.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >
                  {p.emoji ? <span className="text-base">{p.emoji}</span> : (
                    <span className="flex gap-0.5">
                      <span className="w-4 h-4 rounded-l-full" style={{ background: p.bg1! }} />
                      <span className="w-4 h-4 rounded-r-full" style={{ background: p.bg2! }} />
                    </span>
                  )}
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Default Caption Style">
            <div className="flex gap-2">
              {CAPTION_STYLES.map((c) => (
                <button key={c.value} onClick={() => setF("defaultCaptionStyle", c.value)}
                  className={cn(
                    "flex-1 flex flex-col items-center gap-1 py-2 rounded-lg border text-xs font-medium transition-all",
                    form.defaultCaptionStyle === c.value ? "border-primary bg-violet-50 text-primary" : "border-border bg-white text-muted-foreground hover:border-primary/40"
                  )}
                >
                  <span className="text-base">{c.emoji}</span>
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
          </Field>
        </Section>
      </div>

      {/* ── Sticky save bar ── */}
      <div className="sticky bottom-6 bg-white border border-border rounded-xl px-5 py-4 flex items-center justify-between shadow-lg shadow-gray-200/60">
        <div className="text-sm text-muted-foreground">
          {hasChanges ? "You have unsaved changes" : "All changes saved"}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setForm({ ...brand })}>Discard</Button>
          <Button size="sm" onClick={save} className={saved ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}>
            {saved ? <><Check className="w-4 h-4" /> Saved!</> : <><Save className="w-4 h-4" /> Save Profile</>}
          </Button>
        </div>
      </div>
    </div>
  );
}
