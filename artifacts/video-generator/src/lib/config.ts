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

export interface AvatarCharacter {
  label: string;
  gender: "F" | "M";
  desc: string;
  gradient: [string, string];
  textColor: string;
  styles: string[];
}

export const AVATARS: Record<string, AvatarCharacter> = {
  lisa: {
    label: "Lisa",
    gender: "F",
    desc: "Professional presenter",
    gradient: ["#6366F1", "#8B5CF6"],
    textColor: "#fff",
    styles: ["graceful-sitting", "casual-sitting", "technical-sitting", "graceful-standing", "casual-standing"],
  },
  harry: {
    label: "Harry",
    gender: "M",
    desc: "Business executive",
    gradient: ["#0F172A", "#1E40AF"],
    textColor: "#fff",
    styles: ["business", "casual"],
  },
  jeff: {
    label: "Jeff",
    gender: "M",
    desc: "Casual content creator",
    gradient: ["#065F46", "#047857"],
    textColor: "#fff",
    styles: ["business"],
  },
  lori: {
    label: "Lori",
    gender: "F",
    desc: "Corporate professional",
    gradient: ["#831843", "#BE185D"],
    textColor: "#fff",
    styles: ["graceful-sitting", "casual-sitting", "technical-sitting"],
  },
  max: {
    label: "Max",
    gender: "M",
    desc: "Tech expert",
    gradient: ["#1C1917", "#292524"],
    textColor: "#fff",
    styles: ["formal"],
  },
};

// Quick-select popular voices (shown before user browses all)
export const QUICK_VOICES = [
  { value: "en-US-AvaMultilingualNeural",  label: "Ava",    locale: "en-US", desc: "Warm & Natural · US English",    gender: "Female", isHD: true },
  { value: "en-US-AndrewMultilingualNeural", label: "Andrew", locale: "en-US", desc: "Confident Male · US English",    gender: "Male",   isHD: true },
  { value: "en-US-EmmaNeural",             label: "Emma",   locale: "en-US", desc: "Expressive · US English",         gender: "Female", isHD: false },
  { value: "en-US-AriaNeural",             label: "Aria",   locale: "en-US", desc: "Professional · US English",       gender: "Female", isHD: false },
  { value: "en-US-DavisNeural",            label: "Davis",  locale: "en-US", desc: "Conversational Male · US English",gender: "Male",   isHD: false },
  { value: "en-IN-NeerjaNeural",           label: "Neerja", locale: "en-IN", desc: "Indian English · Female",          gender: "Female", isHD: false },
  { value: "en-IN-PrabhatNeural",          label: "Prabhat",locale: "en-IN", desc: "Indian English · Male",            gender: "Male",   isHD: false },
  { value: "hi-IN-SwaraNeural",            label: "Swara",  locale: "hi-IN", desc: "Hindi · Female",                  gender: "Female", isHD: false },
  { value: "hi-IN-MadhurNeural",           label: "Madhur", locale: "hi-IN", desc: "Hindi · Male",                    gender: "Male",   isHD: false },
  { value: "en-GB-SoniaNeural",            label: "Sonia",  locale: "en-GB", desc: "British English · Female",        gender: "Female", isHD: false },
  { value: "en-AU-NatashaNeural",          label: "Natasha",locale: "en-AU", desc: "Australian English · Female",     gender: "Female", isHD: false },
  { value: "fr-FR-DeniseNeural",           label: "Denise", locale: "fr-FR", desc: "French · Female",                 gender: "Female", isHD: false },
  { value: "de-DE-KatjaNeural",            label: "Katja",  locale: "de-DE", desc: "German · Female",                 gender: "Female", isHD: false },
  { value: "es-ES-ElviraNeural",           label: "Elvira", locale: "es-ES", desc: "Spanish (Spain) · Female",        gender: "Female", isHD: false },
  { value: "ja-JP-NanamiNeural",           label: "Nanami", locale: "ja-JP", desc: "Japanese · Female",               gender: "Female", isHD: false },
  { value: "zh-CN-XiaoxiaoNeural",         label: "Xiaoxiao",locale:"zh-CN", desc: "Chinese Mandarin · Female",       gender: "Female", isHD: false },
  { value: "ar-SA-ZariyahNeural",          label: "Zariyah",locale: "ar-SA", desc: "Arabic · Female",                 gender: "Female", isHD: false },
  { value: "ko-KR-SunHiNeural",            label: "SunHi",  locale: "ko-KR", desc: "Korean · Female",                 gender: "Female", isHD: false },
];

// Voice emotion styles - only for supported voices
export const VOICE_STYLES: Record<string, { value: string; label: string }[]> = {
  "en-US-AriaNeural":              [{ value: "chat", label: "Chat" }, { value: "empathetic", label: "Empathetic" }, { value: "narration-professional", label: "Professional" }, { value: "newscast-casual", label: "Newscast" }],
  "en-US-JennyNeural":             [{ value: "assistant", label: "Assistant" }, { value: "chat", label: "Chat" }, { value: "customerservice", label: "Helpful" }, { value: "newscast", label: "Newscast" }],
  "en-US-GuyNeural":               [{ value: "narration-professional", label: "Professional" }, { value: "newscast", label: "Newscast" }],
  "en-US-DavisNeural":             [{ value: "chat", label: "Chat" }, { value: "cheerful", label: "Cheerful" }, { value: "excited", label: "Excited" }, { value: "friendly", label: "Friendly" }],
  "en-GB-SoniaNeural":             [{ value: "cheerful", label: "Cheerful" }, { value: "sad", label: "Sad" }],
  "en-US-AvaMultilingualNeural":   [{ value: "chat", label: "Chat" }, { value: "cheerful", label: "Cheerful" }],
  "en-US-AndrewMultilingualNeural":[{ value: "chat", label: "Chat" }, { value: "excited", label: "Excited" }],
  "en-US-EmmaNeural":              [{ value: "chat", label: "Chat" }, { value: "cheerful", label: "Cheerful" }, { value: "excited", label: "Excited" }],
  "en-US-BrianNeural":             [{ value: "chat", label: "Chat" }, { value: "friendly", label: "Friendly" }],
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
