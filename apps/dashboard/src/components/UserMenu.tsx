import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { authClient } from "../lib/auth-client";
import { evictCollectionsExcept } from "../lib/collections";
import { type ThemeMode, useTheme } from "../lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface User {
  name: string;
  email: string;
  image?: string | null;
}

const THEME_OPTIONS: Array<{
  value: ThemeMode;
  label: string;
  Icon: typeof Sun;
}> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "auto", label: "System", Icon: Monitor },
];

export function UserMenu({ user }: { user: User }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [theme, setTheme] = useTheme();

  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: "/sign-in" });
    evictCollectionsExcept(null);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account"
          className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line-strong bg-reef font-mono text-xs text-foam hover:border-mist/50"
        >
          {user.image ? (
            <img src={user.image} alt="" className="size-full object-cover" />
          ) : (
            (initials || "?").charAt(0)
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col">
            <span className="text-sm font-semibold">{user.name}</span>
            <span className="text-xs text-muted-foreground">{user.email}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Theme
        </DropdownMenuLabel>
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => setTheme(value)}
            className="gap-2"
          >
            <Icon className="size-4" />
            <span className="flex-1">{label}</span>
            {theme === value && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut} className="gap-2">
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
