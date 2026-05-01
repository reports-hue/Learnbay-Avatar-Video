import { useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, Clock, X, RotateCcw } from "lucide-react";
import type { VideoEntry } from "@/lib/types";
import { SCRIPT_STYLES } from "@/lib/config";

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function styleLabel(val: string) {
  return SCRIPT_STYLES.find((s) => s.value === val)?.label ?? val;
}

const URL_REGEX =
  /\b((?:https?:\/\/|www\.)[^\s]+|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|io|co|app|ai|net|org|dev|me|tv|xyz|so|gg|sh)(?:\/[^\s]*)?)/i;

function parseCta(cta: string): { headline: string; url: string | null } {
  const trimmed = cta.trim();
  if (!trimmed) return { headline: "", url: null };
  const m = trimmed.match(URL_REGEX);
  if (!m) return { headline: trimmed, url: null };
  const url = m[0];
  const before = trimmed.slice(0, m.index ?? 0).trim();
  const after = trimmed.slice((m.index ?? 0) + url.length).trim();
  const headline = (before + " " + after).trim().replace(/[\s|·,;:-]+$/g, "").trim();
  return { headline: headline || "Visit us", url };
}

export function VideoModal({ video, onClose }: { video: VideoEntry; onClose: () => void }) {
  const [ended, setEnded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const ctaParsed = video.cta ? parseCta(video.cta) : null;

  function handleReplay() {
    setEnded(false);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl overflow-hidden shadow-2xl w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate pr-4">{video.topic}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <Badge variant="secondary" className="text-[10px] py-0">{video.platform}</Badge>
              <Badge variant="outline" className="text-[10px] py-0">{styleLabel(video.scriptStyle)}</Badge>
              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />{formatDate(video.createdAt)}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-gray-100 hover:text-foreground transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative bg-black">
          <video
            ref={videoRef}
            src={video.videoUrl}
            controls={!ended}
            autoPlay
            playsInline
            className="w-full max-h-[70vh] object-contain"
            onEnded={() => setEnded(true)}
            onPlay={() => setEnded(false)}
          />

          {ended && ctaParsed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white">
              {video.logoUrl && (
                <img
                  src={video.logoUrl}
                  alt=""
                  className="h-16 w-auto max-w-[200px] object-contain mb-6"
                />
              )}
              <p
                className="text-2xl font-bold text-gray-900 text-center px-6"
                style={{ fontFamily: "Arial, 'Liberation Sans', sans-serif" }}
              >
                {ctaParsed.headline}
              </p>
              {ctaParsed.url && (
                <p
                  className="mt-3 text-base text-gray-500 text-center px-6"
                  style={{ fontFamily: "Arial, 'Liberation Sans', sans-serif" }}
                >
                  {ctaParsed.url}
                </p>
              )}
              <button
                onClick={handleReplay}
                className="mt-8 flex items-center gap-2 text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Replay
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-gray-50">
          {video.brandTheme && (
            <div className="flex items-center gap-1 mr-auto">
              {[video.brandTheme.bgColor1, video.brandTheme.bgColor2, video.brandTheme.accentColor].map((c, i) => (
                <span key={i} className="w-3 h-3 rounded-full border border-border" style={{ background: c }} />
              ))}
            </div>
          )}
          <a href={video.videoUrl} download={`libraryminds-${video.id}.mp4`}>
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5">
              <Download className="w-3.5 h-3.5" /> Download MP4
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}
