export interface BrandProfile {
  companyName: string;
  tagline: string;
  description: string;
  websiteUrl: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  defaultCta: string;
  tone: string;
  defaultVoice: string;
  defaultVoiceStyle: string;
  defaultAvatar: string;
  defaultAvatarStyle: string;
  defaultScriptStyle: string;
  defaultCaptionStyle: string;
  defaultScenePreset: string;
}

export const DEFAULT_BRAND: BrandProfile = {
  companyName: "",
  tagline: "",
  description: "",
  websiteUrl: "",
  logoUrl: "",
  primaryColor: "#7C3AED",
  secondaryColor: "#4A9FFF",
  backgroundColor: "#0D1B2A",
  defaultCta: "Follow Libraryminds",
  tone: "professional",
  defaultVoice: "en-US-AvaMultilingualNeural",
  defaultVoiceStyle: "",
  defaultAvatar: "lisa",
  defaultAvatarStyle: "graceful-sitting",
  defaultScriptStyle: "viral",
  defaultCaptionStyle: "animated",
  defaultScenePreset: "auto",
};

export interface VideoEntry {
  id: string;
  topic: string;
  platform: string;
  scriptStyle: string;
  captionStyle: string;
  voice: string;
  avatar: string;
  videoUrl: string;
  script: string;
  brandTheme: { bgColor1: string; bgColor2: string; accentColor: string };
  createdAt: string;
}

export interface BrandAnalysisResult {
  companyName: string;
  tagline: string;
  description: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  tone: string;
  suggestedCta: string;
}

export type Page = "dashboard" | "create" | "library" | "settings";
