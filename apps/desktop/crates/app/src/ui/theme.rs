use gpui::{Hsla, Window, WindowAppearance, rgb};

use crate::controller::Tone;

/// Colours for the system's light or dark appearance.
#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub background: Hsla,
    pub surface: Hsla,
    pub border: Hsla,
    pub text: Hsla,
    pub muted: Hsla,
    pub accent: Hsla,
    pub on_accent: Hsla,
    pub selection: Hsla,
    pub good: Hsla,
    pub busy: Hsla,
    pub idle: Hsla,
    pub problem: Hsla,
}

impl Theme {
    pub fn of(window: &Window) -> Self {
        match window.appearance() {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::dark(),
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::light(),
        }
    }

    fn light() -> Self {
        Self {
            background: rgb(0xf5_f5_f7).into(),
            surface: rgb(0xff_ff_ff).into(),
            border: rgb(0xdc_dc_e0).into(),
            text: rgb(0x1d_1d_1f).into(),
            muted: rgb(0x6e_6e_73).into(),
            accent: rgb(0x2f_6f_ed).into(),
            on_accent: rgb(0xff_ff_ff).into(),
            selection: rgb(0xb3_cd_fb).into(),
            good: rgb(0x2b_a6_4f).into(),
            busy: rgb(0xd9_8e_04).into(),
            idle: rgb(0x8e_8e_93).into(),
            problem: rgb(0xd7_37_2f).into(),
        }
    }

    fn dark() -> Self {
        Self {
            background: rgb(0x1c_1c_1e).into(),
            surface: rgb(0x2c_2c_2e).into(),
            border: rgb(0x3a_3a_3c).into(),
            text: rgb(0xf2_f2_f7).into(),
            muted: rgb(0x98_98_9f).into(),
            accent: rgb(0x40_7c_f6).into(),
            on_accent: rgb(0xff_ff_ff).into(),
            selection: rgb(0x2d_4a_80).into(),
            good: rgb(0x34_c7_59).into(),
            busy: rgb(0xff_b3_40).into(),
            idle: rgb(0x8e_8e_93).into(),
            problem: rgb(0xff_5f_57).into(),
        }
    }

    pub fn tone(&self, tone: Tone) -> Hsla {
        match tone {
            Tone::Good => self.good,
            Tone::Busy => self.busy,
            Tone::Idle => self.idle,
            Tone::Problem => self.problem,
        }
    }
}
