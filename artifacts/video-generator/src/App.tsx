import { useState } from "react";
import {
  SidebarProvider, SidebarInset, SidebarTrigger, Sidebar, SidebarContent,
  SidebarHeader, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarMenu,
  SidebarMenuItem, SidebarMenuButton, SidebarSeparator,
} from "@/components/ui/sidebar";
import { useBrandProfile, useVideoLibrary } from "@/lib/storage";
import type { Page } from "@/lib/types";
import { Dashboard } from "@/pages/Dashboard";
import { CreateVideo } from "@/pages/CreateVideo";
import { VideoLibrary } from "@/pages/VideoLibrary";
import { BrandSettings } from "@/pages/BrandSettings";
import { LayoutDashboard, Clapperboard, Film, Building2, ChevronRight, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_MAIN = [
  { id: "dashboard" as Page, label: "Dashboard",     icon: LayoutDashboard },
  { id: "create"    as Page, label: "Create Video",  icon: Clapperboard },
  { id: "library"   as Page, label: "Video Library", icon: Film },
];

const NAV_BOTTOM = [
  { id: "settings" as Page, label: "Brand Settings", icon: Building2 },
];

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [brand, updateBrand, resetBrand] = useBrandProfile();
  const [library, addVideo, removeVideo] = useVideoLibrary();

  const hasBrand = Boolean(brand.companyName);

  return (
    <SidebarProvider defaultOpen={true}>
      {/* ── Sidebar ── */}
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader className="gap-0 pb-2">
          <div className="flex items-center gap-3 px-3 py-4 group-data-[collapsible=icon]:justify-center">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
              <Clapperboard className="w-4 h-4 text-primary-foreground" />
            </div>
            <div className="group-data-[collapsible=icon]:hidden leading-tight">
              <p className="text-sm font-bold text-foreground">Libraryminds</p>
              <p className="text-[10px] text-muted-foreground">Video Generator</p>
            </div>
          </div>

          {/* Quick create button */}
          <div className="px-2 pb-1 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
            <button
              onClick={() => setPage("create")}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold",
                "bg-primary text-primary-foreground transition-all hover:bg-primary/85",
                "group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:h-8 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:justify-center"
              )}
            >
              <Plus className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="group-data-[collapsible=icon]:hidden">New Video</span>
            </button>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_MAIN.map(({ id, label, icon: Icon }) => (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton isActive={page === id} onClick={() => setPage(id)} tooltip={label}>
                      <Icon className="flex-shrink-0" />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarSeparator />
          <SidebarMenu>
            {NAV_BOTTOM.map(({ id, label, icon: Icon }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton isActive={page === id} onClick={() => setPage(id)} tooltip={label}>
                  <Icon className="flex-shrink-0" />
                  <span>{label}</span>
                  {!hasBrand && (
                    <span className="ml-auto flex-shrink-0 w-2 h-2 rounded-full bg-amber-400 group-data-[collapsible=icon]:hidden" />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>

          {/* Brand name at bottom */}
          <div className="px-3 py-3 group-data-[collapsible=icon]:hidden">
            <div className="flex items-center gap-2">
              {brand.logoUrl ? (
                <img src={brand.logoUrl} alt="" className="w-6 h-6 rounded object-contain" onError={(e) => (e.currentTarget.style.display = "none")} />
              ) : (
                <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-3 h-3 text-primary" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground truncate">
                  {brand.companyName || "Set up your brand"}
                </p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {brand.companyName ? (brand.tagline || brand.websiteUrl || "Brand configured") : "Click Brand Settings"}
                </p>
              </div>
              {!hasBrand && (
                <button onClick={() => setPage("settings")} className="flex-shrink-0 text-amber-400 hover:text-amber-300 transition-colors">
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>

      {/* ── Main content ── */}
      <SidebarInset className="overflow-auto bg-background">
        {/* Top bar */}
        <header className="sticky top-0 z-10 flex items-center gap-3 px-6 py-3 border-b border-border bg-background/80 backdrop-blur-sm">
          <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
          <div className="h-4 w-px bg-border" />
          <nav className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>Libraryminds</span>
            <ChevronRight className="w-3 h-3" />
            <span className="text-foreground font-medium capitalize">
              {page === "create" ? "Create Video" : page === "library" ? "Video Library" : page === "settings" ? "Brand Settings" : "Dashboard"}
            </span>
          </nav>
          {brand.companyName && (
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <span className="hidden sm:inline">{brand.companyName}</span>
              <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: brand.primaryColor }}>
                <span className="text-[9px] font-bold text-white">{brand.companyName[0]?.toUpperCase()}</span>
              </div>
            </div>
          )}
        </header>

        <main className="p-6 max-w-5xl mx-auto">
          {page === "dashboard" && (
            <Dashboard brand={brand} library={library} setPage={setPage} />
          )}
          {page === "create" && (
            <CreateVideo brand={brand} addVideo={addVideo} setPage={setPage} />
          )}
          {page === "library" && (
            <VideoLibrary library={library} removeVideo={removeVideo} setPage={setPage} />
          )}
          {page === "settings" && (
            <BrandSettings brand={brand} updateBrand={updateBrand} resetBrand={resetBrand} />
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
