import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Film, Download, Trash2, Search, Plus, Clock } from "lucide-react";
import type { VideoEntry, Page } from "@/lib/types";
import { SCRIPT_STYLES } from "@/lib/config";
import { cn } from "@/lib/utils";

interface Props {
  library: VideoEntry[];
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

export function VideoLibrary({ library, removeVideo, setPage }: Props) {
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filtered = query.trim()
    ? library.filter((v) =>
        v.topic.toLowerCase().includes(query.toLowerCase()) ||
        v.platform.toLowerCase().includes(query.toLowerCase())
      )
    : library;

  function handleDelete(id: string) {
    if (confirmDelete === id) {
      removeVideo(id);
      setConfirmDelete(null);
    } else {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Video Library</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {library.length} video{library.length !== 1 ? "s" : ""} generated
          </p>
        </div>
        <Button onClick={() => setPage("create")} size="sm">
          <Plus className="w-4 h-4" /> Create New
        </Button>
      </div>

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

function VideoCard({ video, confirmDelete, onDelete }: {
  video: VideoEntry;
  confirmDelete: string | null;
  onDelete: () => void;
}) {
  const [mediaError, setMediaError] = useState(false);

  return (
    <div className="bg-white border border-border rounded-xl overflow-hidden group hover:border-primary/30 hover:shadow-sm transition-all">
      {/* Thumbnail / preview */}
      <div className="aspect-video bg-gray-100 relative overflow-hidden">
        {!mediaError && video.thumbnailUrl ? (
          <div className="w-full h-full relative">
            <img
              src={video.thumbnailUrl}
              alt={video.topic}
              className="w-full h-full object-cover"
              onError={() => setMediaError(true)}
            />
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
              <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
                <Film className="w-5 h-5 text-white" />
              </div>
            </div>
          </div>
        ) : !mediaError ? (
          <video
            src={video.videoUrl}
            className="w-full h-full object-cover"
            preload="metadata"
            muted
            onError={() => setMediaError(true)}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Film className="w-7 h-7 opacity-30" />
            <span className="text-xs opacity-50">Video unavailable</span>
          </div>
        )}

        {/* Brand theme color strip */}
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
          <a href={video.videoUrl} download={`libraryminds-${video.id}.mp4`} className="flex-1">
            <Button size="sm" variant="outline" className="w-full text-xs gap-1.5">
              <Download className="w-3.5 h-3.5" /> Download
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
