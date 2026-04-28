export const PLATFORMS = [
  { label: "YouTube Shorts (9:16 · 20–30s)", value: "YouTube Shorts" },
  { label: "Instagram Reels (9:16 · 20–30s)", value: "Instagram Reels" },
  { label: "Facebook Reels (9:16 · 20–30s)", value: "Facebook Reels" },
  { label: "YouTube Video (16:9 · 60–90s)", value: "YouTube Video" },
  { label: "Landscape Video (16:9 · 30–60s)", value: "Landscape Video" },
];

export const SCRIPT_STYLES = [
  { value: "viral",       label: "Viral Hook",  emoji: "⚡", desc: "Scroll-stopping opener" },
  { value: "listicle",    label: "Listicle",    emoji: "📋", desc: "Numbered tips format" },
  { value: "story",       label: "Story",       emoji: "📖", desc: "Personal narrative arc" },
  { value: "educational", label: "Educational", emoji: "🎓", desc: "Teach & explain" },
  { value: "sales",       label: "Sales",       emoji: "💰", desc: "Problem → Solution" },
];

export const AVATARS: Record<string, { label: string; emoji: string; styles: string[] }> = {
  lisa:  { label: "Lisa",  emoji: "👩",   styles: ["graceful-sitting", "casual-sitting", "technical-sitting", "graceful-standing", "casual-standing"] },
  harry: { label: "Harry", emoji: "👨",   styles: ["business", "casual"] },
  jeff:  { label: "Jeff",  emoji: "🧑",   styles: ["business"] },
  lori:  { label: "Lori",  emoji: "👩‍💼",  styles: ["graceful-sitting", "casual-sitting", "technical-sitting"] },
  max:   { label: "Max",   emoji: "🧔",   styles: ["formal"] },
};

export const VOICES = [
  { value: "en-US-AvaMultilingualNeural", label: "Ava – Warm & Natural (US)" },
  { value: "en-US-AriaNeural",            label: "Aria – Professional (US)" },
  { value: "en-US-JennyNeural",           label: "Jenny – Friendly (US)" },
  { value: "en-US-GuyNeural",             label: "Guy – Casual Male (US)" },
  { value: "en-US-DavisNeural",           label: "Davis – Conversational Male" },
  { value: "en-GB-SoniaNeural",           label: "Sonia – British English" },
  { value: "en-AU-NatashaNeural",         label: "Natasha – Australian English" },
];

export const VOICE_STYLES: Record<string, { value: string; label: string }[]> = {
  "en-US-AriaNeural":  [{ value: "chat", label: "Chat" }, { value: "empathetic", label: "Empathetic" }, { value: "narration-professional", label: "Professional" }, { value: "newscast-casual", label: "Newscast" }],
  "en-US-JennyNeural": [{ value: "assistant", label: "Assistant" }, { value: "chat", label: "Chat" }, { value: "customerservice", label: "Helpful" }, { value: "newscast", label: "Newscast" }],
  "en-US-GuyNeural":   [{ value: "narration-professional", label: "Professional" }, { value: "newscast", label: "Newscast" }],
  "en-US-DavisNeural": [{ value: "chat", label: "Chat" }, { value: "cheerful", label: "Cheerful" }, { value: "excited", label: "Excited" }, { value: "friendly", label: "Friendly" }],
  "en-GB-SoniaNeural": [{ value: "cheerful", label: "Cheerful" }, { value: "sad", label: "Sad" }],
};

export const CAPTION_STYLES = [
  { value: "animated", label: "Animated", emoji: "✨", desc: "Word-by-word highlight" },
  { value: "static",   label: "Subtitles", emoji: "💬", desc: "Standard captions" },
  { value: "none",     label: "None",      emoji: "🚫", desc: "No captions" },
];

export const SCENE_PRESETS = [
  { label: "Auto AI",   value: "auto",      emoji: "✨", bg1: null,      bg2: null,      accent: null },
  { label: "Creator",   value: "creator",   emoji: null, bg1: "#0D1B2A", bg2: "#1A3A5C", accent: "#4A9FFF" },
  { label: "Corporate", value: "corporate", emoji: null, bg1: "#1A1A2E", bg2: "#2D2B55", accent: "#8B5CF6" },
  { label: "Tech",      value: "tech",      emoji: null, bg1: "#0F1117", bg2: "#1B3359", accent: "#00D9FF" },
  { label: "Lifestyle", value: "lifestyle", emoji: null, bg1: "#1A0A1E", bg2: "#3D1A5A", accent: "#E879F9" },
  { label: "Business",  value: "business",  emoji: null, bg1: "#0B1A1A", bg2: "#0D3330", accent: "#10B981" },
  { label: "Custom",    value: "custom",    emoji: "🎨", bg1: null,      bg2: null,      accent: null },
  { label: "Image URL", value: "image",     emoji: "🖼️", bg1: null,      bg2: null,      accent: null },
];
