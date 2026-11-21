"""Single-paper and side-by-side editors in Notes."""
from collections import Counter

import streamlit as st

from services import research_matrix
from services.library import catalog


FIELDS = research_matrix.FIELDS
QUICK_FIELDS = ("title", "problem", "methodology", "findings", "limitations", "observations")
DISPLAY_MODES = ("Full Matrix", "Quick Comparison")


def render():
    view = st.radio("Research Matrix view", ("Single Paper", "Compare Papers"),
                    horizontal=True, label_visibility="collapsed", key="matrix_view")
    papers = catalog()
    if not papers and view == "Single Paper":
        st.info("Save a paper in My Library to start a research matrix.")
        show_unsaved_edits()
        return

    titles = Counter(paper["title"] for paper in papers.values())
    labels = {
        paper_id: paper["title"] if titles[paper["title"]] == 1 else f"{paper['title']} · {paper_id}"
        for paper_id, paper in papers.items()
    }
    if view == "Single Paper":
        single_paper(papers, labels)
    else:
        compare_papers(papers, labels)


def save_entries(entries):
    if research_matrix.save(entries):
        st.success("Research matrix saved.")
    else:
        st.error(st.session_state.pop("vault_error"))
        return False
    return True


def single_paper(papers, labels):
    paper_id = st.selectbox("Choose a saved paper", papers, format_func=labels.__getitem__,
                            index=None, key="matrix_single_paper")
    if paper_id is not None and st.button("Save Research Matrix", type="primary"):
        save_cell_drafts(papers, [paper_id])
    show_unsaved_edits()
    if paper_id is not None:
        entry = research_matrix.entry(paper_id, papers[paper_id])
        for field, label in FIELDS.items():
            edit_cell("single", paper_id, field, label, entry[field])


def compare_papers(papers, labels):
    state = st.session_state
    current_id = comparison_picker()
    current = state.research_comparisons.get(current_id)
    state.setdefault("matrix_comparison_name", current["name"] if current else "")
    active = [paper_id for paper_id in state.get("matrix_comparison", ()) if paper_id in papers]
    state.setdefault("matrix_paper_selection", active)
    selected = st.multiselect("Search and select saved papers", papers,
                              format_func=labels.__getitem__, key="matrix_paper_selection")
    active_ids, selected_ids = set(active), set(selected)
    selected_order = [paper_id for paper_id in active if paper_id in selected_ids]
    selected_order.extend(paper_id for paper_id in selected if paper_id not in active_ids)
    if st.button("Compare Selected Papers", type="primary", disabled=not (selected or active)):
        active = state.matrix_comparison = selected_order
    if current:
        st.caption("Editing a saved comparison.")
        if any(paper_id not in papers for paper_id in current["paper_ids"]):
            st.warning("Some papers in this comparison are no longer in My Library.")
    if notice := state.pop("matrix_comparison_notice", None):
        st.success(notice)

    with st.form("matrix_compare", enter_to_submit=False):
        name = st.text_input("Comparison name", key="matrix_comparison_name")
        if current and (name.strip() != current["name"] or selected_order != current["paper_ids"]):
            st.caption("Save Comparison to keep changes to the name, selection, or column order.")
        if st.form_submit_button("Save Comparison", help="Save the name, paper selection, and column order."):
            save_named_comparison(name, selected_order, current_id)

    draft_ids = [paper_id for paper_id in state.get("matrix_cell_drafts", {}) if paper_id in papers]
    with st.container(horizontal=True):
        if active or draft_ids:
            if st.button("Save Comparison Edits", type="primary",
                         help="Save pending matrix edits for all Library papers, including papers outside this comparison."):
                if draft_ids:
                    save_cell_drafts(papers, draft_ids)
                else:
                    st.info("There are no comparison edits to save.")
        if active:
            entries = {paper_id: research_matrix.entry(paper_id, papers[paper_id]) for paper_id in active}
            st.download_button(
                "Export CSV", research_matrix.comparison_csv(entries, {paper_id: papers[paper_id]["title"] for paper_id in active}),
                file_name="research-matrix.csv", mime="text/csv", on_click="ignore",
                help="Download all 14 fields using saved values and the displayed paper order.",
            )
    show_unsaved_edits()
    if not active:
        return

    mode = state.get("matrix_display_mode", DISPLAY_MODES[0])
    with st.container(horizontal=True):
        for option in DISPLAY_MODES:
            if st.button(option, disabled=option == mode, type="primary" if option == mode else "secondary"):
                state.matrix_display_mode = option
                st.rerun()
    st.caption("Scroll sideways to see more papers. CSV includes saved cell values.")
    fields = FIELDS if mode == DISPLAY_MODES[0] else QUICK_FIELDS
    with st.container(key="matrix_grid", gap=None):
        comparison_header(active, labels)
        comparison_cells(active, labels, entries, fields)


def show_unsaved_edits():
    if st.session_state.get("matrix_cell_drafts"):
        st.warning("Unsaved matrix edits. Drafts stay in this session until you save them.")


def save_cell_drafts(papers, paper_ids):
    drafts = st.session_state.setdefault("matrix_cell_drafts", {})
    entries = {
        paper_id: {**research_matrix.entry(paper_id, papers[paper_id]), **drafts.get(paper_id, {})}
        for paper_id in paper_ids
    }
    if save_entries(entries):
        for paper_id in paper_ids:
            drafts.pop(paper_id, None)


def remember_cell(paper_id, field, saved, key):
    drafts = st.session_state.setdefault("matrix_cell_drafts", {})
    value = st.session_state[key]
    if value != saved:
        drafts.setdefault(paper_id, {})[field] = value
    elif paper_id in drafts:
        drafts[paper_id].pop(field, None)
        if not drafts[paper_id]:
            del drafts[paper_id]


def edit_cell(view, paper_id, field, label, saved):
    key = f"matrix_{view}_{paper_id}_{field}"
    value = st.session_state.get("matrix_cell_drafts", {}).get(paper_id, {}).get(field, saved)
    st.text_area(label, value=value, height=88 if view == "single" else 96, key=key,
                 label_visibility="visible" if view == "single" else "collapsed",
                 on_change=remember_cell, args=(paper_id, field, saved, key))


def comparison_picker():
    state = st.session_state
    comparisons = state.research_comparisons
    current_id = state.get("matrix_comparison_id")
    if comparisons:
        names = Counter(comparison["name"] for comparison in comparisons.values())
        labels = {}
        for key, comparison in comparisons.items():
            name = comparison["name"]
            labels[key] = name if names[name] == 1 else f"{name} · {key}"
        selected = st.selectbox("Saved comparisons", comparisons, index=None, key="matrix_saved_comparison",
                                format_func=labels.__getitem__)
    else:
        selected = None
    with st.container(horizontal=True):
        if comparisons:
            st.button("Open Comparison", disabled=selected is None, on_click=open_comparison, args=(selected,))
        st.button("New Comparison", on_click=open_comparison)
        if current_id is not None:
            with st.popover("Delete Comparison"):
                st.text(f'Delete “{comparisons[current_id]["name"]}”?')
                st.caption("Its papers and matrix entries will stay in your Vault.")
                if st.button("Confirm Deletion"):
                    if research_matrix.delete_comparison(current_id):
                        open_comparison()
                        state.matrix_comparison_notice = "Comparison deleted."
                        st.rerun()
                    else:
                        st.error(state.pop("vault_error"))
    return current_id


def open_comparison(comparison_id=None):
    state = st.session_state
    comparison = state.research_comparisons.get(comparison_id, {})
    available = catalog()
    paper_ids = [paper_id for paper_id in comparison.get("paper_ids", []) if paper_id in available]
    state.update(matrix_comparison_id=comparison_id, matrix_comparison_name=comparison.get("name", ""),
                 matrix_comparison=paper_ids, matrix_paper_selection=paper_ids)


def save_named_comparison(name, paper_ids, current_id):
    state = st.session_state
    try:
        comparison_id = research_matrix.save_comparison(name, paper_ids, current_id)
    except ValueError as exc:
        st.error(str(exc))
        return
    if comparison_id is None:
        st.error(state.pop("vault_error"))
        return
    state.update(matrix_comparison_id=comparison_id, matrix_comparison=paper_ids,
                 matrix_comparison_notice="Comparison saved.")
    st.rerun()


def comparison_header(active, labels):
    with st.container(horizontal=True, wrap=False, gap=None):
        with st.container(key="matrix_label_header"):
            st.text("Research field")
        for index, paper_id in enumerate(active):
            with st.container(gap="small"):
                st.text(labels[paper_id])
                with st.container(horizontal=True, gap="xxsmall"):
                    st.button("Move Left", key=f"matrix_left_{paper_id}", disabled=index == 0,
                              help=f"Move {labels[paper_id]} left", on_click=move_column, args=(index, index - 1))
                    st.button("Move Right", key=f"matrix_right_{paper_id}", disabled=index == len(active) - 1,
                              help=f"Move {labels[paper_id]} right", on_click=move_column, args=(index, index + 1))


def move_column(index, target):
    state = st.session_state
    available = catalog()
    order = [paper_id for paper_id in state.matrix_comparison if paper_id in available]
    order[index], order[target] = order[target], order[index]
    state.matrix_comparison = order


def comparison_cells(active, labels, entries, fields):
    for field in fields:
        label = FIELDS[field]
        with st.container(horizontal=True, wrap=False, gap=None, vertical_alignment="center"):
            with st.container(key=f"matrix_label_{field}"):
                st.text(label)
            for paper_id in active:
                edit_cell("compare", paper_id, field, f"{label} · {labels[paper_id]}", entries[paper_id][field])
