//! The window: a sidebar and the page it selects, or the first-run setup.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use gpui::{
    App, Bounds, Context, Div, Entity, FontWeight, KeyBinding, SharedString, Stateful,
    Subscription, Task, TitlebarOptions, Window, WindowBounds, WindowControlArea, WindowHandle,
    WindowOptions, actions, div, point, prelude::*, px, size, svg,
};
use shoal_worker::Connection;

use super::settings::SettingsPage;
use super::setup::{Connected, SetupPage};
use super::theme::{MONO, SANS, Theme};
use super::widgets::glyph;
use crate::controller::Controller;

actions!(main_window, [Save, FocusNext, FocusPrevious, Close]);

/// How many per-second samples a job's sparkline shows.
const RATE_SAMPLES: usize = 40;

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("enter", Save, Some("TextField")),
        KeyBinding::new("tab", FocusNext, None),
        KeyBinding::new("shift-tab", FocusPrevious, None),
        KeyBinding::new("secondary-w", Close, None),
    ]);
}

pub fn open(controller: Entity<Controller>, cx: &mut App) -> Option<WindowHandle<MainWindow>> {
    let bounds = Bounds::centered(None, size(px(980.), px(700.)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(760.), px(520.))),
        titlebar: Some(TitlebarOptions {
            title: Some("Shoal".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(16.), px(18.))),
        }),
        app_id: Some("io.shoal.desktop".to_owned()),
        ..WindowOptions::default()
    };
    cx.open_window(options, |window, cx| cx.new(|cx| MainWindow::new(controller, window, cx)))
        .inspect_err(|error| tracing::error!("couldn't open the window: {error}"))
        .ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Overview,
    Models,
    Activity,
    Settings,
}

pub struct MainWindow {
    pub(super) controller: Entity<Controller>,
    pub(super) page: Page,
    settings: Entity<SettingsPage>,
    setup: Option<Entity<SetupPage>>,
    /// Whether the pause durations are showing.
    pub(super) choosing_pause: bool,
    /// Each running job's recent output rate, sampled every second.
    pub(super) rates: HashMap<String, Rate>,
    _subscriptions: Vec<Subscription>,
    _ticker: Task<()>,
}

#[derive(Debug, Default)]
pub(super) struct Rate {
    last: u64,
    pub samples: VecDeque<f32>,
}

impl MainWindow {
    fn new(controller: Entity<Controller>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let settings = cx.new(|cx| SettingsPage::new(controller.clone(), cx));
        let mut subscriptions = vec![
            cx.observe(&controller, |_, _, cx| cx.notify()),
            cx.observe_window_appearance(window, |_, _, cx| cx.notify()),
        ];
        let setup = controller.read(cx).needs_setup().then(|| {
            let setup = cx.new(|cx| SetupPage::new(controller.clone(), window, cx));
            subscriptions.push(cx.subscribe(&setup, |this, _, Connected, cx| {
                this.setup = None;
                this.page = Page::Overview;
                cx.notify();
            }));
            setup
        });
        let ticker = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this.update(cx, MainWindow::tick).is_err() {
                    break;
                }
            }
        });
        Self {
            controller,
            page: Page::Overview,
            settings,
            setup,
            choosing_pause: false,
            rates: HashMap::new(),
            _subscriptions: subscriptions,
            _ticker: ticker,
        }
    }

    /// Samples each running job's output, and redraws so times keep moving.
    #[expect(clippy::cast_precision_loss, reason = "chunks per second are small")]
    fn tick(&mut self, cx: &mut Context<Self>) {
        let jobs = &self.controller.read(cx).state().jobs;
        self.rates.retain(|id, _| jobs.iter().any(|job| &job.id == id));
        for job in jobs {
            let rate = self.rates.entry(job.id.clone()).or_default();
            rate.samples.push_back(job.chunks.saturating_sub(rate.last) as f32);
            rate.last = job.chunks;
            if rate.samples.len() > RATE_SAMPLES {
                rate.samples.pop_front();
            }
        }
        if !jobs.is_empty() {
            cx.notify();
        }
    }

    pub(super) fn go(&mut self, page: Page, cx: &mut Context<Self>) {
        self.page = page;
        cx.notify();
    }

    fn sidebar(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let controller = self.controller.read(cx);
        let models = controller.state().inventory.models.len();
        let name = match controller.settings().name.as_str() {
            "" => "This computer".to_owned(),
            name => name.to_owned(),
        };
        let place = match &controller.state().connection {
            Connection::Online { worker_id } => {
                format!(
                    "{} · {}",
                    controller.server_host(),
                    worker_id.get(..8).unwrap_or(worker_id)
                )
            }
            _ => controller.server_host().to_owned(),
        };
        let current = self.page;
        let item = |page: Page, icon: &'static str, label: &'static str, count: Option<usize>| {
            nav_item(page, icon, label, current == page, count, theme)
        };
        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(210.))
            .h_full()
            .bg(theme.trench)
            .border_r_1()
            .border_color(theme.line)
            .px_3()
            .pb_3()
            .child(div().h(px(46.)).window_control_area(WindowControlArea::Drag))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px_2()
                    .pb(px(22.))
                    .child(glyph(24., theme.secondary, Some(theme.lumen)))
                    .child(
                        div()
                            .font_family(MONO)
                            .text_size(px(17.))
                            .font_weight(FontWeight::MEDIUM)
                            .child("shoal"),
                    ),
            )
            .child(
                div().flex().flex_col().gap_0p5().children(
                    [
                        item(Page::Overview, "icons/overview.svg", "Overview", None),
                        item(Page::Models, "icons/models.svg", "Models", Some(models)),
                        item(Page::Activity, "icons/activity.svg", "Activity", None),
                        item(Page::Settings, "icons/settings.svg", "Settings", None),
                    ]
                    .into_iter()
                    .zip([Page::Overview, Page::Models, Page::Activity, Page::Settings])
                    .map(|(item, page)| {
                        item.on_click(cx.listener(move |this, _, _, cx| this.go(page, cx)))
                    }),
                ),
            )
            .child(
                div()
                    .mt_auto()
                    .pt_3()
                    .px_2()
                    .border_t_1()
                    .border_color(theme.line)
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).truncate().child(name))
                    .child(
                        div()
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme.tertiary)
                            .truncate()
                            .child(place),
                    ),
            )
    }
}

fn nav_item(
    page: Page,
    icon: &'static str,
    label: &'static str,
    active: bool,
    count: Option<usize>,
    theme: Theme,
) -> Stateful<Div> {
    let color = if active { theme.text } else { theme.secondary };
    div()
        .id(SharedString::from(format!("nav-{page:?}")))
        .flex()
        .items_center()
        .gap(px(10.))
        .h(px(32.))
        .px(px(10.))
        .rounded_md()
        .cursor_pointer()
        .text_sm()
        .text_color(color)
        .when(active, |this| this.bg(theme.reef))
        .hover(move |style| style.bg(theme.reef).text_color(theme.text))
        .child(svg().path(icon).size(px(16.)).flex_none().text_color(color))
        .child(label)
        .when_some(count, |this, count| {
            this.child(
                div()
                    .ml_auto()
                    .font_family(MONO)
                    .text_xs()
                    .text_color(theme.tertiary)
                    .child(count.to_string()),
            )
        })
}

impl Render for MainWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);
        let root = div()
            .key_context("MainWindow")
            .on_action(|_: &FocusNext, window, _| window.focus_next())
            .on_action(|_: &FocusPrevious, window, _| window.focus_prev())
            .on_action(|_: &Close, window, _| window.remove_window())
            .flex()
            .size_full()
            .bg(theme.abyss)
            .text_color(theme.text)
            .font_family(SANS)
            .text_size(px(13.));
        if let Some(setup) = &self.setup {
            return root.child(setup.clone());
        }
        let page = match self.page {
            Page::Overview => self.overview(theme, cx).into_any_element(),
            Page::Models => self.models(theme, cx).into_any_element(),
            Page::Activity => self.activity(theme, cx).into_any_element(),
            Page::Settings => self.settings.clone().into_any_element(),
        };
        root.child(self.sidebar(theme, cx)).child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(div().h(px(14.)).flex_none().window_control_area(WindowControlArea::Drag))
                .child(page),
        )
    }
}
