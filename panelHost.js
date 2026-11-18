/**
 * 页面内浮动面板宿主（由 background 在点击工具栏图标时注入）
 *
 * 注入是幂等的：
 *   首次注入 → 创建浮窗并展开
 *   再次注入 → 按「展开 → 收纳成球 → 再展开」循环切换
 *
 * 三态：
 *   closed     无任何 UI（点了 × 之后）
 *   open       浮窗（24px 拖拽条 + iframe 承载 sidepanel.html）
 *   collapsed  48px 悬浮球
 *
 * 设计约束：
 *   - 挂在当前标签页内，切标签页即不可见
 *   - 浮层不占位、不挤压 B 站原有布局
 *   - 收纳只隐藏容器，iframe 不销毁，聊天流式与输入内容都不会中断
 *   - 位置、尺寸写入 chrome.storage.local，下次沿用
 */
(() => {
    "use strict";

    const HOST_KEY = "__bilitatoFloatPanelHost";
    const TAB_KEY = "__bilitatoFloatPanelTabId";
    const GEOMETRY_KEY = "floatPanelGeometry";

    // 重复注入时只做状态切换，绝不重建 DOM（重建会丢 iframe 里的会话）
    if (window[HOST_KEY]) {
        try {
            window[HOST_KEY].toggle();
        } catch (_) {}
        return;
    }

    const BAR_HEIGHT = 30;
    const MIN_WIDTH = 340;
    const MIN_HEIGHT = 420;
    const MARGIN = 12;
    const BALL_SIZE = 48;
    const BALL_GAP = 18;
    const DEFAULT_WIDTH = 400;
    const DEFAULT_HEIGHT = 720;
    const DRAG_THRESHOLD = 4;

    const geometry = {
        width: 0,
        height: 0,
        x: null,
        y: null,
        ballX: null,
        ballY: null
    };

    let mode = "closed";
    let shadowHost = null;
    let shadow = null;
    let panelEl = null;
    let frameEl = null;
    let barEl = null;
    let ballEl = null;
    let theme = "light";
    let saveTimer = 0;
    let frameLoaded = false;

    /* ---------------- 几何 ---------------- */

    function viewportWidth() {
        return Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    }

    function viewportHeight() {
        return Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    }

    function fillDefaults() {
        const vw = viewportWidth();
        const vh = viewportHeight();
        if (!geometry.width) {
            geometry.width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, vw - MARGIN * 2));
        }
        if (!geometry.height) {
            geometry.height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, vh - 120));
        }
        if (geometry.x == null) geometry.x = Math.max(MARGIN, vw - geometry.width - 24);
        if (geometry.y == null) geometry.y = Math.min(72, Math.max(MARGIN, vh - geometry.height - MARGIN));
        if (geometry.ballX == null) geometry.ballX = Math.max(MARGIN, vw - BALL_SIZE - BALL_GAP);
        if (geometry.ballY == null) geometry.ballY = Math.max(MARGIN, vh * 0.35);
    }

    function clampPanel() {
        const vw = viewportWidth();
        const vh = viewportHeight();
        geometry.width = Math.min(Math.max(geometry.width, MIN_WIDTH), Math.max(MIN_WIDTH, vw - MARGIN * 2));
        geometry.height = Math.min(Math.max(geometry.height, MIN_HEIGHT), Math.max(MIN_HEIGHT, vh - MARGIN * 2));
        geometry.x = Math.min(Math.max(geometry.x, MARGIN), Math.max(MARGIN, vw - geometry.width - MARGIN));
        geometry.y = Math.min(Math.max(geometry.y, MARGIN), Math.max(MARGIN, vh - geometry.height - MARGIN));
    }

    function clampBall() {
        const vw = viewportWidth();
        const vh = viewportHeight();
        geometry.ballX = Math.min(Math.max(geometry.ballX, MARGIN), Math.max(MARGIN, vw - BALL_SIZE - MARGIN));
        geometry.ballY = Math.min(Math.max(geometry.ballY, MARGIN), Math.max(MARGIN, vh - BALL_SIZE - MARGIN));
    }

    function applyPanelStyle() {
        if (!panelEl) return;
        panelEl.style.left = `${Math.round(geometry.x)}px`;
        panelEl.style.top = `${Math.round(geometry.y)}px`;
        panelEl.style.width = `${Math.round(geometry.width)}px`;
        panelEl.style.height = `${Math.round(geometry.height)}px`;
    }

    function applyBallStyle() {
        if (!ballEl) return;
        ballEl.style.left = `${Math.round(geometry.ballX)}px`;
        ballEl.style.top = `${Math.round(geometry.ballY)}px`;
    }

    function saveGeometry() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = 0;
            try {
                chrome.storage.local.set({
                    [GEOMETRY_KEY]: {
                        width: Math.round(geometry.width),
                        height: Math.round(geometry.height),
                        x: Math.round(geometry.x),
                        y: Math.round(geometry.y),
                        ballX: Math.round(geometry.ballX),
                        ballY: Math.round(geometry.ballY)
                    }
                });
            } catch (_) {}
        }, 300);
    }

    async function loadGeometry() {
        try {
            const stored = await chrome.storage.local.get(GEOMETRY_KEY);
            const saved = stored?.[GEOMETRY_KEY];
            if (saved && typeof saved === "object") {
                if (Number(saved.width) > 0) geometry.width = Number(saved.width);
                if (Number(saved.height) > 0) geometry.height = Number(saved.height);
                if (Number.isFinite(Number(saved.x))) geometry.x = Number(saved.x);
                if (Number.isFinite(Number(saved.y))) geometry.y = Number(saved.y);
                if (Number.isFinite(Number(saved.ballX))) geometry.ballX = Number(saved.ballX);
                if (Number.isFinite(Number(saved.ballY))) geometry.ballY = Number(saved.ballY);
            }
        } catch (_) {}
        fillDefaults();
        clampPanel();
        clampBall();
    }

    /* ---------------- 主题 ---------------- */

    function resolveTheme(themeMode) {
        const value = String(themeMode || "system");
        if (value === "dark") return "dark";
        if (value === "light") return "light";
        return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
    }

    function applyTheme() {
        if (!shadowHost) return;
        panelEl?.setAttribute("data-theme", theme);
        ballEl?.setAttribute("data-theme", theme);
    }

    async function loadTheme() {
        try {
            const stored = await chrome.storage.local.get("settings");
            theme = resolveTheme(stored?.settings?.themeMode);
        } catch (_) {
            theme = resolveTheme("system");
        }
        applyTheme();
    }

    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", async () => {
        await loadTheme();
    });

    try {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "local" || !changes?.settings) return;
            theme = resolveTheme(changes.settings.newValue?.themeMode);
            applyTheme();
        });
    } catch (_) {}

    /* ---------------- 样式 ---------------- */

    const STYLE_TEXT = `
        * { box-sizing: border-box; }

        .panel {
            position: fixed;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border-radius: 14px;
            background: #ffffff;
            color: #18191c;
            box-shadow: 0 14px 44px rgba(0, 0, 0, 0.26), 0 0 0 1px rgba(0, 0, 0, 0.07);
            pointer-events: auto;
            font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
            transition: opacity 0.14s ease, transform 0.18s ease;
        }
        .panel.is-hidden {
            opacity: 0;
            pointer-events: none;
            transform: translateX(200vw);
        }
        .panel[data-theme="dark"] {
            background: #1e2026;
            color: #e6e9ef;
            box-shadow: 0 14px 44px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08);
        }

        .bar {
            flex: 0 0 ${BAR_HEIGHT}px;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 4px 0 9px;
            background: #f6f7f8;
            border-bottom: 1px solid #e7e9ec;
            cursor: grab;
            user-select: none;
            touch-action: none;
        }
        .bar:active { cursor: grabbing; }
        .panel[data-theme="dark"] .bar {
            background: #24262d;
            border-bottom-color: #33363e;
        }

        .grip {
            width: 6px;
            height: 12px;
            flex: 0 0 auto;
            background-image: radial-gradient(circle, #b9bec7 1px, transparent 1.2px);
            background-size: 3px 3px;
            background-position: 0 center;
            opacity: 0.85;
        }
        .panel[data-theme="dark"] .grip {
            background-image: radial-gradient(circle, #4a5160 1px, transparent 1.2px);
        }

        .bar-actions {
            display: flex;
            gap: 2px;
            flex: 0 0 auto;
            margin-left: auto;
        }
        .bar-btn {
            width: 22px;
            height: 22px;
            padding: 0;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: #838994;
            font: inherit;
            font-size: 14px;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: background 0.12s ease, color 0.12s ease;
        }
        .bar-btn:hover { background: rgba(0, 0, 0, 0.07); color: #18191c; }
        .bar-btn[data-act="close"]:hover { background: rgba(245, 63, 63, 0.12); color: #f53f3f; }
        .panel[data-theme="dark"] .bar-btn { color: #9099a8; }
        .panel[data-theme="dark"] .bar-btn:hover { background: rgba(255, 255, 255, 0.1); color: #f0f2f5; }

        .frame {
            flex: 1 1 auto;
            width: 100%;
            min-height: 0;
            border: 0;
            display: block;
            background: #ffffff;
        }
        .panel[data-theme="dark"] .frame { background: #1e2026; }

        .resizer {
            position: absolute;
            right: 0;
            bottom: 0;
            width: 16px;
            height: 16px;
            cursor: nwse-resize;
            touch-action: none;
            opacity: 0.55;
            background:
                linear-gradient(135deg, transparent 44%, currentColor 44%, currentColor 52%, transparent 52%),
                linear-gradient(135deg, transparent 66%, currentColor 66%, currentColor 74%, transparent 74%);
            color: #b9bec7;
        }
        .resizer:hover { opacity: 1; }
        .panel[data-theme="dark"] .resizer { color: #4a5160; }

        .ball {
            position: fixed;
            width: ${BALL_SIZE}px;
            height: ${BALL_SIZE}px;
            padding: 0;
            border: 0;
            border-radius: 50%;
            background: #ffffff;
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(0, 0, 0, 0.06);
            display: none;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            pointer-events: auto;
            touch-action: none;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .ball.is-visible { display: flex; }
        .ball:hover {
            transform: scale(1.06);
            box-shadow: 0 9px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(0, 0, 0, 0.07);
        }
        .ball:active { transform: scale(0.97); }
        .ball[data-theme="dark"] {
            background: #24262d;
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
        }
        .ball img {
            width: 28px;
            height: 28px;
            pointer-events: none;
            -webkit-user-drag: none;
        }
    `;

    /* ---------------- DOM ---------------- */

    function frameUrl() {
        const base = chrome.runtime.getURL("sidepanel.html");
        const tabId = Number(window[TAB_KEY] || 0);
        return tabId > 0 ? `${base}?tabId=${tabId}` : base;
    }

    function createDom() {
        if (shadowHost && shadowHost.isConnected) return;

        shadowHost = document.createElement("div");
        shadowHost.id = "bilitato-float-panel-root";
        // all: initial 打头，先清掉页面可能命中的样式，再逐项覆盖
        shadowHost.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
        shadow = shadowHost.attachShadow({ mode: "open" });
        shadow.innerHTML = `
            <style>${STYLE_TEXT}</style>
            <div class="panel is-hidden" data-theme="light" role="dialog" aria-label="Bilitato 面板">
                <div class="bar">
                    <span class="grip" aria-hidden="true"></span>
                    <div class="bar-actions">
                        <button type="button" class="bar-btn" data-act="collapse" title="收纳为悬浮球" aria-label="收纳为悬浮球">&#8722;</button>
                        <button type="button" class="bar-btn" data-act="close" title="关闭面板" aria-label="关闭面板">&#215;</button>
                    </div>
                </div>
                <iframe class="frame" title="Bilitato" allow="clipboard-write; clipboard-read"></iframe>
                <div class="resizer" title="拖拽调整大小"></div>
            </div>
            <button type="button" class="ball" data-theme="light" title="展开 Bilitato" aria-label="展开 Bilitato">
                <img alt="">
            </button>
        `;

        panelEl = shadow.querySelector(".panel");
        frameEl = shadow.querySelector(".frame");
        barEl = shadow.querySelector(".bar");
        ballEl = shadow.querySelector(".ball");
        // 关掉再打开时是全新的 iframe，src 与加载标记都必须重置
        frameLoaded = false;
        ballEl.querySelector("img").src = chrome.runtime.getURL("assets/icons/icon48.png");

        (document.body || document.documentElement).appendChild(shadowHost);

        bindBarDrag();
        bindResizer();
        bindBall();

        shadow.querySelector('[data-act="collapse"]').addEventListener("click", (event) => {
            event.stopPropagation();
            collapse();
        });
        shadow.querySelector('[data-act="close"]').addEventListener("click", (event) => {
            event.stopPropagation();
            close();
        });
    }

    window.addEventListener("resize", () => {
        if (!shadowHost || !panelEl) return;
        fillDefaults();
        clampPanel();
        clampBall();
        applyPanelStyle();
        applyBallStyle();
    });

    function ensureFrame() {
        if (!frameEl || frameLoaded) return;
        frameEl.src = frameUrl();
        frameLoaded = true;
    }

    /* ---------------- 拖拽 ---------------- */

    function bindBarDrag() {
        barEl.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            if (event.target.closest("[data-act]")) return;
            event.preventDefault();
            barEl.setPointerCapture(event.pointerId);
            const origin = { px: event.clientX, py: event.clientY, x: geometry.x, y: geometry.y };
            const onMove = (ev) => {
                geometry.x = origin.x + (ev.clientX - origin.px);
                geometry.y = origin.y + (ev.clientY - origin.py);
                clampPanel();
                applyPanelStyle();
            };
            const onEnd = (ev) => {
                barEl.removeEventListener("pointermove", onMove);
                barEl.removeEventListener("pointerup", onEnd);
                barEl.removeEventListener("pointercancel", onEnd);
                try { barEl.releasePointerCapture(ev.pointerId); } catch (_) {}
                saveGeometry();
            };
            barEl.addEventListener("pointermove", onMove);
            barEl.addEventListener("pointerup", onEnd);
            barEl.addEventListener("pointercancel", onEnd);
        });
    }

    function bindResizer() {
        const handle = shadow.querySelector(".resizer");
        handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            handle.setPointerCapture(event.pointerId);
            const origin = {
                px: event.clientX,
                py: event.clientY,
                w: geometry.width,
                h: geometry.height
            };
            const onMove = (ev) => {
                geometry.width = origin.w + (ev.clientX - origin.px);
                geometry.height = origin.h + (ev.clientY - origin.py);
                clampPanel();
                applyPanelStyle();
            };
            const onEnd = (ev) => {
                handle.removeEventListener("pointermove", onMove);
                handle.removeEventListener("pointerup", onEnd);
                handle.removeEventListener("pointercancel", onEnd);
                try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
                saveGeometry();
            };
            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onEnd);
            handle.addEventListener("pointercancel", onEnd);
        });
    }

    function bindBall() {
        ballEl.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            ballEl.setPointerCapture(event.pointerId);
            const origin = {
                px: event.clientX,
                py: event.clientY,
                x: geometry.ballX,
                y: geometry.ballY,
                moved: false
            };
            const onMove = (ev) => {
                const dx = ev.clientX - origin.px;
                const dy = ev.clientY - origin.py;
                if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) origin.moved = true;
                geometry.ballX = origin.x + dx;
                geometry.ballY = origin.y + dy;
                clampBall();
                applyBallStyle();
            };
            const onEnd = (ev) => {
                ballEl.removeEventListener("pointermove", onMove);
                ballEl.removeEventListener("pointerup", onEnd);
                ballEl.removeEventListener("pointercancel", onEnd);
                try { ballEl.releasePointerCapture(ev.pointerId); } catch (_) {}
                if (origin.moved) {
                    saveGeometry();
                } else {
                    expand();
                }
            };
            ballEl.addEventListener("pointermove", onMove);
            ballEl.addEventListener("pointerup", onEnd);
            ballEl.addEventListener("pointercancel", onEnd);
        });
    }

    /* ---------------- 状态 ---------------- */

    function open() {
        createDom();
        fillDefaults();
        clampPanel();
        applyPanelStyle();
        applyBallStyle();
        applyTheme();
        ensureFrame();
        mode = "open";
        panelEl.classList.remove("is-hidden");
        ballEl.classList.remove("is-visible");
    }

    function collapse() {
        if (mode !== "open") return;
        mode = "collapsed";
        if (!panelEl || !ballEl) return;
        clampBall();
        applyBallStyle();
        panelEl.classList.add("is-hidden");
        ballEl.classList.add("is-visible");
        saveGeometry();
    }

    function expand() {
        if (!shadowHost || !shadowHost.isConnected) {
            open();
            return;
        }
        mode = "open";
        clampPanel();
        applyPanelStyle();
        panelEl.classList.remove("is-hidden");
        ballEl.classList.remove("is-visible");
    }

    function close() {
        mode = "closed";
        ballEl?.classList.remove("is-visible");
        if (shadowHost) shadowHost.remove();
        shadowHost = null;
        shadow = null;
        panelEl = null;
        frameEl = null;
        barEl = null;
        ballEl = null;
    }

    function toggle() {
        if (mode === "closed") open();
        else if (mode === "open") collapse();
        else expand();
    }

    window[HOST_KEY] = {
        toggle,
        open,
        close,
        collapse,
        expand,
        get mode() {
            return mode;
        }
    };

    // 注入即展开：先读几何与主题，避免闪一下默认位置
    loadGeometry().then(() => {
        open();
        return loadTheme();
    });
})();
