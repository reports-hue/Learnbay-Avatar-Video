import { useState, useEffect, useCallback } from "react";
import type { BrandProfile, VideoEntry } from "./types";
import { DEFAULT_BRAND } from "./types";

const BRAND_KEY = "lm_brand_v1";
const LIBRARY_KEY = "lm_library_v1";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage errors
  }
}

export function useBrandProfile(): [BrandProfile, (update: Partial<BrandProfile>) => void, () => void] {
  const [profile, setProfile] = useState<BrandProfile>(() => ({
    ...DEFAULT_BRAND,
    ...readJson<Partial<BrandProfile>>(BRAND_KEY, {}),
  }));

  const update = useCallback((changes: Partial<BrandProfile>) => {
    setProfile((prev) => {
      const next = { ...prev, ...changes };
      writeJson(BRAND_KEY, next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    writeJson(BRAND_KEY, DEFAULT_BRAND);
    setProfile(DEFAULT_BRAND);
  }, []);

  return [profile, update, reset];
}

export function useVideoLibrary(): [VideoEntry[], (entry: VideoEntry) => void, (id: string) => void] {
  const [library, setLibrary] = useState<VideoEntry[]>(() =>
    readJson<VideoEntry[]>(LIBRARY_KEY, [])
  );

  const addEntry = useCallback((entry: VideoEntry) => {
    // Write synchronously FIRST so the video is saved even if the React
    // render that follows throws an error (which would skip the state updater).
    const current = readJson<VideoEntry[]>(LIBRARY_KEY, []);
    // Deduplicate by id
    const deduped = current.filter((v) => v.id !== entry.id);
    const next = [entry, ...deduped].slice(0, 50);
    writeJson(LIBRARY_KEY, next);
    setLibrary(next);
  }, []);

  const removeEntry = useCallback((id: string) => {
    setLibrary((prev) => {
      const next = prev.filter((v) => v.id !== id);
      writeJson(LIBRARY_KEY, next);
      return next;
    });
  }, []);

  return [library, addEntry, removeEntry];
}
