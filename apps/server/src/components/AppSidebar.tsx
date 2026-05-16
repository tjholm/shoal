import { Link, useRouterState } from "@tanstack/react-router";
import {
  AudioLines,
  BrainCircuit,
  ImageIcon,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  PanelLeft,
  Users,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";

export interface NavItem {
  title: string;
  url: "/" | "/workers" | "/chat" | "/images" | "/audio" | "/members" | "/api-keys";
  icon: LucideIcon;
}

export const navItems: NavItem[] = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Workers", url: "/workers", icon: BrainCircuit },
  { title: "Chat", url: "/chat", icon: MessageSquare },
  { title: "Images", url: "/images", icon: ImageIcon },
  { title: "Audio", url: "/audio", icon: AudioLines },
  { title: "Members", url: "/members", icon: Users },
  { title: "API Keys", url: "/api-keys", icon: KeyRound },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return item.url === "/" ? pathname === "/" : pathname.startsWith(item.url);
}

export function AppSidebar() {
  const { location } = useRouterState();

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    asChild
                    isActive={isNavItemActive(item, location.pathname)}
                  >
                    <Link to={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <CollapseToggle />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function CollapseToggle() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <SidebarMenuButton
      onClick={toggleSidebar}
      tooltip={collapsed ? "Expand" : "Collapse"}
    >
      <PanelLeft />
      <span>{collapsed ? "Expand" : "Collapse"}</span>
    </SidebarMenuButton>
  );
}
