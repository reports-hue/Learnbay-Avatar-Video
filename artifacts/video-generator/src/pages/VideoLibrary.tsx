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
          <Film className="w-12 h-12 text-muted-foreground/30 mx-auto" />
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
  const [videoError, setVideoError] = useState(false);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden group hover:border-primary/30 transition-all">
      {/* Thumbnail / preview */}
      <div className="aspect-video bg-black relative overflow-hidden">
        {!videoError ? (
          <video
            src={video.videoUrl}
            className="w-full h-full object-cover"
            preload="metadata"
            muted
            onError={() => setVideoError(true)}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Film className="w-7 h-7 opacity-40" />
            <span className="text-xs opacity-50">Video unavailable</span>
          </div>
        )}

        {/* Brand theme strip */}
        {video.brandTheme && (
          <div className="absolute bottom-0 left-0 right-0 h-1 flex">
            <div className="flex-1" style={{ background: video.brandTheme.bgColor1 }} />
            <div className="flex-1" style={{ background: video.brandTheme.accentColor }} />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground line-clamp-2 leading-snug">{video.topic}</p>
        </div>

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
                ? "border-destructive text-destructive bg-destructive/10"
                : "text-muted-foreground hover:text-red-400"
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
