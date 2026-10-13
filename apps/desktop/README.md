# @shoal/desktop

Optional system-tray app for running a shoal worker on a desktop. Built with
[Electrobun](https://framework.blackboard.sh/electrobun/) on the Bun main
process. The worker itself never depends on this app; everything the tray does
is also available from the `shoal` CLI.

With [Bun](https://bun.sh) installed, from this directory (or `bun run dev:desktop` from the repo root, which also loads `.env`):

```sh
bun install     # the `electrobun` dev dependency fetches the pinned Hutch on first use
bun run dev     # build, launch and rebuild on change
bun run dev:hmr # same, with the window served by Vite (hot reload)
bun run build   # stable release build for this OS
```

With [Hutch](https://framework.blackboard.sh/electrobun/guides/hutch/) installed
(it comes with the repo's `nix develop`), `hutch run install`, `hutch run dev`,
`hutch run dev:hmr` and `hutch run build` do the same.

The window (`src/mainview`) is React on Vite, styled with the shared design
system in `@shoal/ui` (`packages/ui`), the same one the dashboard uses.

On Linux the tray needs a StatusNotifierItem host (KDE, most bars; on GNOME
the AppIndicator extension).
