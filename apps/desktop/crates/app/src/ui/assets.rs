use std::borrow::Cow;

use gpui::{AssetSource, Result, SharedString};

/// The SVGs and fonts built into the binary.
pub struct Assets;

const SVGS: [(&str, &[u8]); 7] = [
    ("glyph-fish.svg", include_bytes!("../../assets/glyph-fish.svg")),
    ("glyph-hub.svg", include_bytes!("../../assets/glyph-hub.svg")),
    ("icons/overview.svg", include_bytes!("../../assets/icons/overview.svg")),
    ("icons/models.svg", include_bytes!("../../assets/icons/models.svg")),
    ("icons/activity.svg", include_bytes!("../../assets/icons/activity.svg")),
    ("icons/settings.svg", include_bytes!("../../assets/icons/settings.svg")),
    ("icons/lock.svg", include_bytes!("../../assets/icons/lock.svg")),
];

/// Geist and Geist Mono, under the SIL Open Font License (`assets/fonts/OFL.txt`).
pub const FONTS: [&[u8]; 5] = [
    include_bytes!("../../assets/fonts/Geist-Regular.ttf"),
    include_bytes!("../../assets/fonts/Geist-Medium.ttf"),
    include_bytes!("../../assets/fonts/Geist-SemiBold.ttf"),
    include_bytes!("../../assets/fonts/GeistMono-Regular.ttf"),
    include_bytes!("../../assets/fonts/GeistMono-Medium.ttf"),
];

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(SVGS.iter().find(|(name, _)| *name == path).map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(SVGS
            .iter()
            .filter(|(name, _)| name.starts_with(path))
            .map(|(name, _)| (*name).into())
            .collect())
    }
}
