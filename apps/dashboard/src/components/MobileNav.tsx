import { Link, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useState } from "react";
import { isNavItemActive, navItems } from "./AppSidebar";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";

export function MobileNav() {
  const { location } = useRouterState();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Open navigation"
        >
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="rounded-t-lg border-t border-line bg-shelf pb-6 pt-4">
        <SheetHeader className="px-4 pb-2">
          <SheetTitle className="label text-left">
            Navigation
          </SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-1 px-2">
          {navItems.map((item) => {
            const active = isNavItemActive(item, location.pathname);
            return (
              <Link
                key={item.url}
                to={item.url}
                onClick={() => setOpen(false)}
                data-active={active}
                className="flex h-11 items-center gap-3 rounded-sm border border-transparent px-3 text-sm text-mist data-[active=true]:border-line data-[active=true]:bg-reef data-[active=true]:text-foam"
              >
                {item.icon({ active })}
                {item.title}
              </Link>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
