# @shoal/desktop

Optional system-tray app for running a shoal worker on a desktop. Built with
[Electrobun](https://framework.blackboard.sh/electrobun/) on the Bun main
process. The worker itself never depends on this app; everything the tray does
is also available from the `shoal` CLI.

From the repo root, inside `nix develop` (or with
[Hutch](https://framework.blackboard.sh/electrobun/guides/hutch/) installed):

```sh
cd apps/desktop
hutch run install   # runs `bun install` for the workspace
hutch run dev       # build, launch and rebuild on change
hutch run dev:hmr   # same, with the window served by Vite (hot reload)
hutch run build     # stable release build for this OS
```

The window (`src/mainview`) is React on Vite, styled with the shared design
system in `@shoal/ui` (`packages/ui`), the same one the dashboard uses.

On Linux the tray needs a StatusNotifierItem host (KDE, most bars; on GNOME
the AppIndicator extension).
