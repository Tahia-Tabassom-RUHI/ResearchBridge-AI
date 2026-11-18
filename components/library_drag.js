// The list keeps native buttons and checkboxes for keyboard navigation. A mouse
// or pen drag can start anywhere else on a paper row, including its title.
const bridgeKey = Symbol.for("researchbridge.library.pointer");

export default function (component) {
    // Streamlit re-renders the component when a checkbox changes. Keep the
    // pointer stream on the document and deliver the drop through the current renderer.
    const previous = window[bridgeKey];
    if (previous) {
        return previous.attach(component);
    }
    const bridge = {component};
    window[bridgeKey] = bridge;
    const controller = new AbortController();
    const options = {capture: true, signal: controller.signal};

    // Streamlit wraps layout blocks in auto-sized elements. Size both scrollers
    // from their rendered position, including wrapped folder names and actions.
    function sizePanes() {
        const page = document.querySelector(".st-key-library_page");
        const list = page?.querySelector(".st-key-library_list");
        const main = page?.closest('[data-testid="stMain"]');
        if (list && main) {
            const top = Math.ceil(list.getBoundingClientRect().top + main.scrollTop);
            page.style.setProperty("--library-pane-top", top + "px");
        }
    }
    const resize = new ResizeObserver(sizePanes);
    const page = document.querySelector(".st-key-library_page");
    if (page) for (const child of page.children) resize.observe(child);
    window.addEventListener("resize", sizePanes, options);
    sizePanes();
    let gesture = null;
    let target = null;
    let ghost = null;
    let suppressClick = false;
    let clickTimer;

    function keyed(element, prefix) {
        const marker = "st-key-" + prefix;
        const node = element?.closest('[class*="' + marker + '"]');
        const key = Array.from(node?.classList || []).find(c => c.startsWith(marker));
        return key?.slice(marker.length);
    }
    function aim(e) {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const id = keyed(hit, "folder_");
        const button = bridge.component.data.folders.includes(id)
            ? hit.closest('[class*="st-key-folder_"]').querySelector("button") : null;
        if (button !== target) {
            target?.removeAttribute("data-folder-drop-active");
            target = button;
            target?.setAttribute("data-folder-drop-active", "");
        }
        return button ? id : null;
    }
    function end() {
        target?.removeAttribute("data-folder-drop-active");
        target = null;
        ghost?.remove();
        ghost = null;
        if (gesture && document.documentElement.hasPointerCapture(gesture.pointer)) {
            document.documentElement.releasePointerCapture(gesture.pointer);
        }
        gesture = null;
    }
    document.addEventListener("pointerdown", e => {
        if (!bridge.component.data.folders.length || !e.isPrimary || e.button !== 0 || e.pointerType === "touch" ||
            e.target.closest("label,input,[role=checkbox]")) return;
        const handle = keyed(e.target, "librow_");
        if (!Object.hasOwn(bridge.component.data.papers, handle)) return;
        gesture = {handle, pointer:e.pointerId, x:e.clientX, y:e.clientY,
                   row:e.target.closest('[class*="st-key-librow_"]')};
    }, options);
    document.addEventListener("pointermove", e => {
        if (!gesture || e.pointerId !== gesture.pointer) return;
        if (!ghost) {
            if (Math.hypot(e.clientX-gesture.x, e.clientY-gesture.y) < 6) return;
            document.documentElement.setPointerCapture(e.pointerId);
            const {data} = bridge.component;
            ghost = document.createElement("div");
            ghost.className = "library-drag-label";
            ghost.textContent = data.selected.includes(data.papers[gesture.handle]) && data.selected.length > 1
                ? data.selected.length + " papers" : gesture.row.querySelector("button p").textContent;
            document.body.appendChild(ghost);
        }
        e.preventDefault();
        ghost.style.transform = "translate("+(e.clientX+12)+"px,"+(e.clientY+12)+"px)";
        aim(e);
    }, options);
    document.addEventListener("pointerup", e => {
        if (!gesture || e.pointerId !== gesture.pointer) return;
        if (ghost) {
            const folder = aim(e);
            suppressClick = true;
            clearTimeout(clickTimer);
            clickTimer = setTimeout(() => { suppressClick = false; }, 0);
            if (folder) bridge.component.setTriggerValue("move", {handle:gesture.handle, folder});
        }
        end();
    }, options);
    document.addEventListener("click", e => {
        if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, options);
    document.addEventListener("pointercancel", end, options);
    // A checkbox losing focus to the title is part of starting a group drag.
    window.addEventListener("blur", end, {signal: controller.signal});
    bridge.attach = renderer => {
        clearTimeout(bridge.cleanup);
        bridge.component = renderer;
        sizePanes();
        return () => {
            if (bridge.component !== renderer) return;
            bridge.cleanup = setTimeout(() => {
                resize.disconnect();
                controller.abort();
                clearTimeout(clickTimer);
                end();
                delete window[bridgeKey];
            }, 250);
        };
    };
    return bridge.attach(component);
}
