//! The shoal palette, from the dashboard's design tokens.

use gpui::{Hsla, Window, WindowAppearance, rgb};

use crate::controller::Tone;

pub const SANS: &str = "Geist";
pub const MONO: &str = "Geist Mono";

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    /// The window behind everything.
    pub abyss: Hsla,
    /// The sidebar and footer.
    pub trench: Hsla,
    /// Cards and lists.
    pub shelf: Hsla,
    /// Selected and hovered rows.
    pub reef: Hsla,
    pub line: Hsla,
    pub line_strong: Hsla,
    pub text: Hsla,
    pub secondary: Hsla,
    pub tertiary: Hsla,
    /// The accent: working, online, primary actions.
    pub lumen: Hsla,
    /// Text on lumen.
    pub lumen_ink: Hsla,
    pub amber: Hsla,
    pub coral: Hsla,
    pub current: Hsla,
}

impl Theme {
    pub fn of(window: &Window) -> Self {
        match window.appearance() {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::dark(),
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::light(),
        }
    }

    fn dark() -> Self {
        Self {
            abyss: rgb(0x07_0b_10).into(),
            trench: rgb(0x0b_11_18).into(),
            shelf: rgb(0x10_18_21).into(),
            reef: rgb(0x16_21_2d).into(),
            line: rgb(0x21_30_41).into(),
            line_strong: rgb(0x2f_43_57).into(),
            text: rgb(0xe6_ed_f3).into(),
            secondary: rgb(0x9a_ab_bd).into(),
            tertiary: rgb(0x6b_7d_90).into(),
            lumen: rgb(0x3f_e0_d0).into(),
            lumen_ink: rgb(0x03_22_1f).into(),
            amber: rgb(0xf2_b5_4a).into(),
            coral: rgb(0xff_7a_6b).into(),
            current: rgb(0x6a_a8_ff).into(),
        }
    }

    fn light() -> Self {
        Self {
            abyss: rgb(0xf6_f8_fa).into(),
            trench: rgb(0xed_f1_f5).into(),
            shelf: rgb(0xff_ff_ff).into(),
            reef: rgb(0xee_f2_f6).into(),
            line: rgb(0xd6_de_e6).into(),
            line_strong: rgb(0xb9_c6_d3).into(),
            text: rgb(0x0b_11_18).into(),
            secondary: rgb(0x3d_4c_5c).into(),
            tertiary: rgb(0x5b_6b_7c).into(),
            lumen: rgb(0x0b_7f_74).into(),
            lumen_ink: rgb(0xff_ff_ff).into(),
            amber: rgb(0x9a_62_00).into(),
            coral: rgb(0xc2_41_2f).into(),
            current: rgb(0x25_63_c9).into(),
        }
    }

    pub fn tone(&self, tone: Tone) -> Hsla {
        match tone {
            Tone::Good => self.lumen,
            Tone::Busy => self.amber,
            Tone::Idle => self.tertiary,
            Tone::Problem => self.coral,
        }
    }
}

/// A tint of `color` for backgrounds.
pub fn wash(color: Hsla) -> Hsla {
    color.opacity(0.12)
}

/// A tint of `color` for borders.
pub fn edge(color: Hsla) -> Hsla {
    color.opacity(0.32)
}
