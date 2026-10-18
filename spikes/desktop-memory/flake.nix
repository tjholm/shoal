{
  description = "desktop memory spike: Rust (GPUI) and Deno desktop toolchains";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      # GPUI on Linux dlopens Vulkan, Wayland and xkbcommon; tray-icon needs
      # GTK 3 and an AppIndicator implementation.
      runtimeLibs = with pkgs; [
        vulkan-loader
        wayland
        libxkbcommon
        xorg.libX11
        xorg.libxcb
        xorg.libXcursor
        xorg.libXrandr
        xorg.libXi
        fontconfig
        freetype
        gtk3
        libayatana-appindicator
        xdotool
        openssl
        dbus
      ];
    in
    {
      devShells.x86_64-linux.default = pkgs.mkShell {
        packages = with pkgs; [ rustc cargo pkg-config cmake perl deno ];
        buildInputs = runtimeLibs ++ [ pkgs.alsa-lib pkgs.zstd pkgs.libgit2 ];
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath runtimeLibs;
        shellHook = ''
          export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
        '';
      };
    };
}
