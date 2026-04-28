import { Film, TrendingUp, Plus, ArrowRight, Building2, Clock, Clapperboard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BrandProfile, VideoEntry, Page } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  brand: BrandProfile;
  library: VideoEntry[];
  setPage: (p: Page) => void;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statsThisWeek(library: VideoEntry[]) {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return library.filter((v) => new Date(v.createdAt).getTime() > weekAgo).length;
}

export function Dashboard({ brand, library, setPage }: Props) {
  const hasBrand = Boolean(brand.companyName);
  const recent = library.slice(0, 4);
  const weekCount = statsThisWeek(library);

  return (
    <div className="space-y-8">
      {/* ── Welcome header ── */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {hasBrand ? `Welcome back${brand.companyName ? `, ${brand.companyName}` : ""}` : "Welcome to Libraryminds"}
        </h1>
        <p className="text-muted-foreground mt-1">
          Create AI-powered avatar videos for your brand in minutes.
        </p>
      </div>

      {/* ── Brand setup CTA (if not configured) ── */}
      {!hasBrand && (
        <div className="bg-amber-950/30 border border-amber-700/40 rounded-xl p-5 flex items-start gap-4">
          <div className="w-9 h-9 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Building2 className="w-4.5 h-4.5 text-amber-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-amber-300">Set up your Brand Profile</h3>
            <p className="text-xs text-amber-400/80 mt-0.5">
              Add your company details, logo, and brand colors. Our AI can auto-detect everything from your website.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setPage("settings")} className="flex-shrink-0 border-amber-700/40 text-amber-300 hover:text-amber-200">
            Set up <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {[
          { label: "Total Videos", value: library.length, icon: Film, color: "text-violet-400" },
          { label: "This Week",    value: weekCount,       icon: TrendingUp, color: "text-emerald-400" },
          { label: "Brand",        value: hasBrand ? "Active" : "Not set",   icon: Building2, color: hasBrand ? "text-emerald-400" : "text-amber-400" },
        ].map((stat) => (
          <div key={stat.label} className="bg-card border border-border rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">{stat.label}</span>
              <stat.icon className={cn("w-3.5 h-3.5", stat.color)} />
            </div>
            <p className={cn("text-2xl font-bold", stat.color)}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* ── Quick create ── */}
      <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 rounded-xl p-6 flex items-center gap-5">
        <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center flex-shrink-0">
          <Clapperboard className="w-6 h-6 text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-foreground">Create a New Video</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Pick a topic, choose your avatar, and let AI generate a professional video in minutes.
          </p>
        </div>
        <Button onClick={() => setPage("create")} className="flex-shrink-0">
          <Plus className="w-4 h-4" /> Create
        </Button>
      </div>

      {/* ── Recent videos ── */}
      {recent.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Recent Videos</h2>
            {library.length > 4 && (
              <button onClick={() => setPage("library")} className="text-xs text-primary hover:underline flex items-center gap-1">
                View all <ArrowRight className="w-3 h-3" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {recent.map((video) => (
              <div key={video.id} className="bg-card border border-border rounded-xl overflow-hidden group hover:border-primary/30 transition-colors">
                <div className="aspect-video bg-background relative overflow-hidden">
                  <video
                    src={video.videoUrl}
                    className="w-full h-full object-cover"
                    preload="metadata"
                    muted
                    onError={(e) => {
                      const el = e.currentTarget.parentElement;
                      if (el) el.innerHTML = `<div class="w-full h-full flex items-center justify-center text-muted-foreground text-xs">Video unavailable</div>`;
                    }}
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
                </div>
                <div className="p-3 space-y-1.5">
                  <p className="text-sm font-medium text-foreground line-clamp-1">{video.topic}</p>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[10px] py-0">{video.platform}</Badge>
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {formatDate(video.createdAt)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {library.length === 0 && (
        <div className="text-center py-16 space-y-3">
          <Film className="w-10 h-10 text-muted-foreground/40 mx-auto" />
          <p className="text-muted-foreground text-sm">No videos yet.</p>
          <Button variant="outline" size="sm" onClick={() => setPage("create")}>
            Create your first video
          </Button>
        </div>
      )}
    </div>
  );
}
