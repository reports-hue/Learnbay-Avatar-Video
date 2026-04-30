import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Film, Download, Trash2, Search, Plus, Clock, Play, RefreshCw } from "lucide-react";
import type { VideoEntry, Page } from "@/lib/types";
import { SCRIPT_STYLES } from "@/lib/config";
import { cn } from "@/lib/utils";
import { VideoModal } from "@/components/VideoModal";

interface Props {
  library: VideoEntry[];
  addVideo: (entry: VideoEntry) => void;
  removeVideo: (id: string) => void;
  setPage: (p: Page) => void;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function styleLabel(val: string) {
  return SCRIPT_STYLES.find((s) => s.value === val)?.label ?? val;
}

export function VideoLibrary({ library, addVideo, removeVideo, setPage }: Props) {
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [playingVideo, setPlayingVideo] = useState<VideoEntry | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoverMsg, setRecoverMsg] = useState<string | null>(null);

  // Tombstone list — IDs the user has explicitly deleted. The manual Recover
  // button skips these so deleting a video stays deleted even if the underlying
  // file is still on the server. Stored in localStorage as a JSON array.
  const TOMBSTONE_KEY = "lm.deletedVideoIds";
  function readTombstones(): Set<string> {
    try {
      const raw = localStorage.getItem(TOMBSTONE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
    } catch {
      return new Set();
    }
  }
  function addTombstone(id: string) {
    const t = readTombstones();
    t.add(id);
    try { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify([...t])); } catch { /* quota / private mode — best effort */ }
  }

  // NOTE: There is intentionally no auto-recover effect here. Previously this
  // component fetched /api/videos on every mount and re-added anything missing
  // from the local library, which caused deleted videos to silently reappear
  // after the user generated a new video (Library remounts → effect re-runs).
  // Recovery is now strictly opt-in via the manual "Recover" button below.

  async function recoverVideos() {
    setRecovering(true);
    setRecoverMsg(null);
    try {
      const res = await fetch("/api/videos");
      if (!res.ok) throw new Error("Server error");
      const serverVideos = await res.json() as {
        videoId: string; videoUrl: string;
        thumbnailUrl: string | null; createdAt: string; sizeBytes: number;
      }[];
      const existingIds = new Set(library.map((v) => v.id));
      const tombstones = readTombstones();
      const toAdd = serverVideos.filter((v) => !existingIds.has(v.videoId) && !tombstones.has(v.videoId));
      if (toAdd.length === 0) {
        setRecoverMsg("No new videos found to recover.");
      } else {
        toAdd.forEach((v) => addVideo({
          id: v.videoId,
          topic: "Recovered video",
          platform: "unknown",
          scriptStyle: "viral",
          captionStyle: "animated",
          voice: "",
          avatar: "lisa",
          videoUrl: v.videoUrl,
          thumbnailUrl: v.thumbnailUrl ?? undefined,
          script: "",
          brandTheme: { bgColor1: "#0D1B2A", bgColor2: "#1B2A4A", accentColor: "#7C3AED" },
          createdAt: v.createdAt,
        }));
        setRecoverMsg(`Recovered ${toAdd.length} video${toAdd.length > 1 ? "s" : ""}.`);
      }
    } catch {
      setRecoverMsg("Recovery failed — server may be starting up.");
    } finally {
      setRecovering(false);
    }
  }

  const filtered = query.trim()
    ? library.filter((v) =>
        v.topic.toLowerCase().includes(query.toLowerCase()) ||
        v.platform.toLowerCase().includes(query.toLowerCase())
      )
    : library;

  async function handleDelete(id: string) {
    if (confirmDelete === id) {
      if (playingVideo?.id === id) setPlayingVideo(null);
      addTombstone(id); // belt & braces: keep tombstone even if server delete fails
      removeVideo(id);
      setConfirmDelete(null);
      // Fire-and-forget actual server-side file deletion. We don't await it
      // so the UI feels instant; tombstone protects against re-recovery if
      // this network call fails.
      try {
        await fetch(`/api/videos/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {
        // Non-fatal — tombstone already prevents resurrection
      }
    } else {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
    }
  }

  return (
    <div className="space-y-6">
      {/* Modal */}
      {playingVideo && (
        <VideoModal video={playingVideo} onClose={() => setPlayingVideo(null)} />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Video Library</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {library.length} video{library.length !== 1 ? "s" : ""} generated
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm"
            onClick={recoverVideos}
            disabled={recovering}
            title="Recover videos from server that may not have been saved locally"
          >
            <RefreshCw className={cn("w-4 h-4", recovering && "animate-spin")} />
            {recovering ? "Recovering…" : "Recover"}
          </Button>
          <Button onClick={() => setPage("create")} size="sm">
            <Plus className="w-4 h-4" /> Create New
          </Button>
        </div>
      </div>

      {recoverMsg && (
        <div className="text-sm text-muted-foreground bg-gray-50 border border-border rounded-lg px-4 py-2.5">
          {recoverMsg}
        </div>
      )}

      {/* Search */}
      {library.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by topic or platform…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      {/* Grid */}
      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              confirmDelete={confirmDelete}
              onPlay={() => setPlayingVideo(video)}
              onDelete={() => handleDelete(video.id)}
            />
          ))}
        </div>
      ) : library.length > 0 ? (
        <div className="text-center py-16 space-y-2">
          <Search className="w-8 h-8 text-muted-foreground/40 mx-auto" />
          <p className="text-muted-foreground text-sm">No results for "{query}"</p>
        </div>
      ) : (
        <div className="text-center py-20 space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto">
            <Film className="w-8 h-8 text-muted-foreground/40" />
          </div>
          <div>
            <p className="text-foreground font-medium">No videos yet</p>
            <p className="text-sm text-muted-foreground mt-1">Create your first AI avatar video to get started.</p>
          </div>
          <Button onClick={() => setPage("create")}>
            <Plus className="w-4 h-4" /> Create Video
          </Button>
        </div>
      )}
    </div>
  );
}

function VideoCard({ video, confirmDelete, onPlay, onDelete }: {
  video: VideoEntry;
  confirmDelete: string | null;
  onPlay: () => void;
  onDelete: () => void;
}) {
  const [thumbError, setThumbError] = useState(false);

  return (
    <div className="bg-white border border-border rounded-xl overflow-hidden group hover:border-primary/30 hover:shadow-sm transition-all">
      {/* Thumbnail / preview — click to play */}
      <div
        className="aspect-video bg-gray-100 relative overflow-hidden cursor-pointer"
        onClick={onPlay}
        role="button"
        aria-label={`Play ${video.topic}`}
      >
        {!thumbError && video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt={video.topic}
            className="w-full h-full object-cover"
            onError={() => setThumbError(true)}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground bg-gray-50">
            <Film className="w-7 h-7 opacity-20" />
          </div>
        )}

        {/* Play overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/25 transition-all">
          <div className="w-12 h-12 rounded-full bg-white/90 shadow-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity scale-90 group-hover:scale-100">
            <Play className="w-5 h-5 text-primary ml-0.5" />
          </div>
        </div>

        {/* Brand color strip */}
        {video.brandTheme && (
          <div className="absolute bottom-0 left-0 right-0 h-1 flex">
            <div className="flex-1" style={{ background: video.brandTheme.bgColor1 }} />
            <div className="flex-1" style={{ background: video.brandTheme.accentColor }} />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4 space-y-3">
        <p className="text-sm font-semibold text-foreground line-clamp-2 leading-snug">{video.topic}</p>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px] py-0">{video.platform}</Badge>
          <Badge variant="outline" className="text-[10px] py-0">{styleLabel(video.scriptStyle)}</Badge>
        </div>

        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="w-3 h-3" />
          {formatDate(video.createdAt)}
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="default" className="flex-1 text-xs gap-1.5" onClick={onPlay}>
            <Play className="w-3.5 h-3.5" /> Play
          </Button>
          <a href={video.videoUrl} download={`libraryminds-${video.id}.mp4`}>
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <Download className="w-3.5 h-3.5" />
            </Button>
          </a>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className={cn(
              "text-xs px-2.5 transition-all",
              confirmDelete === video.id
                ? "border border-red-200 text-red-600 bg-red-50 hover:bg-red-100"
                : "text-muted-foreground hover:text-red-500 hover:bg-red-50"
            )}
          >
            {confirmDelete === video.id ? (
              <span className="text-[10px] font-semibold">Confirm?</span>
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
