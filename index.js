/**
 * 预设分组 / Preset Groups v0.1.1
 * Browser-only extension for SillyTavern / TauriTavern.
 * Never mutates or deletes a source preset during categorization/filtering.
 */
const SLUG = 'tt_preset_groups_v1';
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const $id = (id) => document.getElementById(id);
const text = (tag, content, cls = '') => {
    const n = document.createElement(tag);
    n.textContent = String(content ?? '');
    if (cls) n.className = cls;
    return n;
};
const htmlButton = (label, handler, cls = '') => {
    const b = text('button', label, cls);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); handler(e); });
    return b;
};
const normalized = (name) => String(name || '').normalize('NFKC').toLowerCase()
    .replace(/[【】\[\]（）()\s·•_\-.—～~:：,，、\/\\]/g, '');
function parseVersion(name) {
    const original = String(name || '').trim();
    const noCopy = original.replace(/\s*\(\d+\)\s*$/, '').trim();
    const rx = /(?:^|[\s\-_【\[(（])(?:v(?:er(?:sion)?)?\.?\s*|版本\s*)(\d+(?:\.\d+){0,3})(?:\s*[-_.]?\s*(?:alpha|beta|rc)\s*\d*)?\s*$/i;
    const match = noCopy.match(rx);
    if (match) return { base: noCopy.slice(0, match.index).trim().replace(/[\s_\-【\[（]+$/, ''), version: match[1], raw: original };
    return { base: noCopy, version: null, raw: original };
}
function longestCommonSpan(a, b) {
    if (!a || !b) return 0;
    let prev = new Uint16Array(b.length + 1), best = 0;
    for (let i = 1; i <= a.length; i++) {
        const row = new Uint16Array(b.length + 1);
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1] === b[j - 1]) {
                row[j] = prev[j - 1] + 1;
                best = Math.max(best, row[j]);
            }
        }
        prev = row;
    }
    return best;
}
function similarity(a, b) {
    const x = normalized(parseVersion(a).base), y = normalized(parseVersion(b).base);
    if (!x || !y || x.length > 300 || y.length > 300) return 0;
    const match = longestCommonSpan(x, y);
    // For two-character titles, one common character is not enough.
    return match < 2 ? 0 : match / Math.max(x.length, y.length);
}
function versionCompare(a, b) {
    const av = parseVersion(a).version, bv = parseVersion(b).version;
    if (av && bv) {
        const x = av.split('.').map(Number), y = bv.split('.').map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
        }
    } else if (av) return -1;
    else if (bv) return 1;
    return collator.compare(a, b);
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort()) {
            if (value[k] !== undefined) out[k] = canonical(value[k]);
        }
        return out;
    }
    return value;
}
const defaults = () => ({
    groups: [], // { id, name, type:'auto'|'manual', anchor }
    groupOrder: [], // persisted drag order for both panel and quick grid
    memberships: {}, // preset name => group id array; manual choices persist
    favorites: [],
    manualOverrides: {}, // names explicitly modified by the user: never auto-reassign
    selectedGroups: [], // quick filter: empty means all
    gridOpen: false,
    collapsed: {},
    protection: true,
});
const ui = {
    ctx: null, data: null, pm: null, native: null, proxy: null, quick: null,
    panel: null, panelOpen: false, tab: 'all', query: '',
    activeName: '', activeValue: '', busy: false, suppressNative: false,
    confirmOpen: false, getCurrentPresetBody: null, getPresetApplicationPromise: null, lastSnapshot: null,
    refreshQueued: false,
};
function notify(message, level = 'info') {
    if (window.toastr?.[level]) window.toastr[level](message);
    else console.info(`[预设分组] ${message}`);
}
function save() {
    try { ui.ctx?.saveSettingsDebounced?.(); } catch (err) { console.warn('[预设分组] 保存分组失败', err); }
}
function getData() {
    const bag = ui.ctx.extensionSettings;
    if (!bag[SLUG] || typeof bag[SLUG] !== 'object') bag[SLUG] = defaults();
    const def = defaults();
    for (const [key, val] of Object.entries(def)) {
        if (bag[SLUG][key] === undefined) bag[SLUG][key] = val;
    }
    return bag[SLUG];
}
function getManager() { return ui.ctx?.getPresetManager?.('openai') || null; }
function getSelectElement() {
    const pm = getManager();
    // The 'select' property may be a jQuery wrapper in ST.
    return pm?.select?.[0] || pm?.select || $id('settings_preset_openai');
}
function originalOptions() {
    const sel = ui.native;
    if (!sel) return [];
    return [...sel.querySelectorAll('option')]
        .filter(o => o.value !== '' && o.textContent.trim())
        .map(o => ({ name: o.textContent.trim(), value: o.value }));
}
function allNames() { return [...new Set(originalOptions().map(o => o.name))]; }
function getNameByValue(value) {
    return originalOptions().find(x => x.value === String(value))?.name || '';
}
function getValueByName(name) {
    return originalOptions().find(x => x.name === name)?.value;
}
function currentName() {
    return ui.pm?.getSelectedPresetName?.() || getNameByValue(ui.native?.value) || '';
}
function membersFor(name) {
    const ids = ui.data.memberships[name];
    return Array.isArray(ids) ? ids.filter(id => ui.data.groups.some(g => g.id === id)) : [];
}
function matchesFilter(name) {
    return !ui.data.selectedGroups.length || membersFor(name).some(id => ui.data.selectedGroups.includes(id));
}
function syncGroupOrder() {
    const ids = new Set(ui.data.groups.map(g => g.id));
    const old = Array.isArray(ui.data.groupOrder) ? ui.data.groupOrder : [];
    const next = old.filter(id => ids.has(id));
    const missing = ui.data.groups.filter(g => !next.includes(g.id))
        .sort((a,b) => collator.compare(a.name, b.name));
    next.push(...missing.map(g => g.id));
    if (JSON.stringify(old) !== JSON.stringify(next)) {
        ui.data.groupOrder = next;
        save();
    }
    return next;
}
function sortGroups(list = ui.data.groups) {
    const order = syncGroupOrder();
    return [...list].sort((a,b) => order.indexOf(a.id) - order.indexOf(b.id));
}
function moveGroup(movingId, targetId, after) {
    if (movingId === targetId) return;
    const order = [...syncGroupOrder()];
    if (!order.includes(movingId) || !order.includes(targetId)) return;
    order.splice(order.indexOf(movingId), 1);
    order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, movingId);
    ui.data.groupOrder = order;
    save(); refreshAll();
}
function makeDragHandle(group) {
    const handle = htmlButton('⠿', () => {}, 'pg-drag-handle');
    handle.title = '按住拖动，上下调整分组顺序（键盘方向键也可以）';
    handle.setAttribute('aria-label', '调整「' + group.name + '」的顺序');
    let dragging = false, pointer = null, source = null, destination = null, startX = 0, startY = 0;
    const clear = () => document.querySelectorAll('#pg-panel .pg-dragging, #pg-panel .pg-drop-before, #pg-panel .pg-drop-after')
        .forEach(el => el.classList.remove('pg-dragging','pg-drop-before','pg-drop-after'));
    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0 || pointer !== null) return;
        source = handle.closest('.pg-sortable-card');
        if (!source) return;
        pointer = e.pointerId;
        dragging = false; destination = null; startX=e.clientX; startY=e.clientY;
        try { handle.setPointerCapture(pointer); } catch {}
        e.preventDefault(); e.stopPropagation();
    });
    handle.addEventListener('pointermove', e => {
        if (pointer !== e.pointerId || !source) return;
        if (!dragging && Math.hypot(e.clientX-startX,e.clientY-startY) < 7) return;
        dragging = true; source.classList.add('pg-dragging');
        document.querySelectorAll('#pg-panel .pg-drop-before, #pg-panel .pg-drop-after')
            .forEach(el => el.classList.remove('pg-drop-before','pg-drop-after'));
        const target = document.elementFromPoint(e.clientX,e.clientY)?.closest('.pg-sortable-card');
        if (target && target !== source && target.dataset.groupId) {
            const rect = target.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height/2;
            target.classList.add(after ? 'pg-drop-after' : 'pg-drop-before');
            destination = { id:target.dataset.groupId, after };
        } else destination = null;
        const scroller = source.closest('.pg-content');
        if (scroller) {
            const rect = scroller.getBoundingClientRect();
            if (e.clientY < rect.top+42) scroller.scrollTop -= 14;
            if (e.clientY > rect.bottom-42) scroller.scrollTop += 14;
        }
        e.preventDefault();
    });
    function finish(cancel = false) {
        if (pointer === null) return;
        const to = destination;
        pointer = null; source = null; destination = null;
        const wasDragging = dragging; dragging = false;
        clear();
        if (!cancel && wasDragging && to) moveGroup(group.id,to.id,to.after);
    }
    handle.addEventListener('pointerup', e => { if (e.pointerId===pointer) { finish(); e.preventDefault(); } });
    handle.addEventListener('pointercancel', () => finish(true));
    handle.addEventListener('lostpointercapture', () => finish(true));
    handle.addEventListener('keydown', e => {
        if (!['ArrowUp','ArrowDown'].includes(e.key)) return;
        const items=[...document.querySelectorAll('#pg-panel .pg-sortable-card')];
        const pos=items.findIndex(it=>it.dataset.groupId===group.id);
        const next=items[pos+(e.key==='ArrowUp'?-1:1)];
        if (next) { e.preventDefault(); moveGroup(group.id,next.dataset.groupId,e.key==='ArrowDown'); }
    });
    return handle;
}
function makeId() { return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`; }
function addMembership(name, id, selected) {
    const members = new Set(membersFor(name));
    if (selected) members.add(id); else members.delete(id);
    ui.data.memberships[name] = [...members];
    ui.data.manualOverrides[name] = true;
    save(); refreshAll();
}
function inferGroups() {
    const names = allNames();
    if (!names.length) return;
    let changed = false;
    const known = new Set(Object.keys(ui.data.memberships));
    for (const name of names) {
        if (known.has(name)) continue;
        const candidates = [];
        for (const g of ui.data.groups.filter(g => g.type === 'auto')) {
            const score = similarity(name, g.anchor || g.name);
            if (score >= 0.5) candidates.push({ group: g, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        // Ambiguous matches remain independent and can be manually classified.
        if (candidates.length && (!candidates[1] || candidates[0].score - candidates[1].score > 0.08)) {
            ui.data.memberships[name] = [candidates[0].group.id]; known.add(name); changed = true;
            continue;
        }
        let best = null, bestScore = 0, tied = false;
        for (const other of names) {
            if (other === name || !known.has(other) || membersFor(other).length || ui.data.manualOverrides[other]) continue;
            const score = similarity(name, other);
            if (score < 0.5) continue;
            if (score > bestScore + 0.03) { best = other; bestScore = score; tied = false; }
            else if (Math.abs(score - bestScore) <= 0.03) tied = true;
        }
        if (best && !tied) {
            const group = { id: makeId(), name: parseVersion(best).base || best, type: 'auto', anchor: best };
            ui.data.groups.push(group);
            ui.data.memberships[name] = [group.id];
            ui.data.memberships[best] = [group.id];
            changed = true;
        } else { ui.data.memberships[name] = []; changed = true; }
        known.add(name);
    }
    if (changed) save();
}
function syncActive() {
    ui.pm = getManager();
    const n = currentName(), v = ui.native?.value;
    if (n) ui.activeName = n;
    if (v !== undefined) ui.activeValue = String(v);
}
function getStoredPreset(name) {
    try {
        const { presets, preset_names } = ui.pm.getPresetList('openai');
        if (typeof preset_names?.[name] === 'undefined') return null;
        return presets?.[preset_names[name]] || null;
    } catch { return null; }
}
const COMPARE_KEYS = [
    'prompts', 'prompt_order', 'temperature', 'top_p', 'top_k', 'top_a',
    'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty',
    'openai_max_context', 'openai_max_tokens', 'names_behavior', 'send_if_empty',
    'impersonation_prompt', 'new_chat_prompt', 'new_group_chat_prompt',
    'new_example_chat_prompt', 'continue_nudge_prompt', 'wi_format',
    'scenario_format', 'personality_format', 'group_nudge_prompt',
    'max_context_unlocked', 'jailbreak_system', 'reasoning_effort',
];
function getDirtyState() {
    if (!ui.data.protection) return 'clean';
    if (!ui.getCurrentPresetBody) return 'unknown';
    const name = ui.activeName || currentName();
    const saved = getStoredPreset(name);
    if (!saved) return 'unknown';
    try {
        const live = ui.getCurrentPresetBody();
        if (!live || typeof live !== 'object') return 'unknown';
        let compared = 0;
        for (const key of COMPARE_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(saved, key) ||
                !Object.prototype.hasOwnProperty.call(live, key)) continue;
            compared++;
            if (JSON.stringify(canonical(saved[key])) !== JSON.stringify(canonical(live[key]))) return 'dirty';
        }
        return compared ? 'clean' : 'unknown';
    } catch (err) {
        console.warn('[预设分组] 检查未保存状态失败', err);
        return 'unknown';
    }
}
function buildConfirm(oldName, newName, state) {
    return new Promise(resolve => {
        ui.confirmOpen = true;
        const backdrop = text('div', '', 'pg-confirm-backdrop');
        backdrop.id = 'pg-confirm';
        const dialog = text('div', '', 'pg-confirm-box');
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
        dialog.append(text('h3', state === 'dirty' ? '当前预设尚未保存' : '无法确认是否已保存'));
        dialog.append(text('p', state === 'dirty'
            ? `「${oldName}」有尚未保存的修改。是否保存后切换至「${newName}」？`
            : `无法可靠判断「${oldName}」是否已经保存。为避免丢失修改，建议先保存。`));
        const choices = text('div', '', 'pg-confirm-actions');
        const finish = answer => { backdrop.remove(); ui.confirmOpen = false; resolve(answer); };
        choices.append(htmlButton('保存并切换', () => finish('save'), 'pg-primary'));
        choices.append(htmlButton('不保存并切换', () => finish('discard'), 'pg-secondary'));
        dialog.append(choices);
        dialog.append(htmlButton('取消切换', () => finish('cancel'), 'pg-cancel'));
        backdrop.append(dialog); document.body.append(backdrop);
    });
}
async function saveCurrent() {
    if (!ui.getCurrentPresetBody || !ui.pm?.savePreset) {
        throw new Error('当前 TT 版本不支持安全保存此预设');
    }
    const oldName = ui.activeName;
    const body = ui.getCurrentPresetBody();
    await ui.pm.savePreset(oldName, body);
    if (ui.getPresetApplicationPromise) await ui.getPresetApplicationPromise();
    if (!getStoredPreset(oldName)) throw new Error('保存后无法读取预设，请检查 TT 的保存结果');
}
async function switchTo(value) {
    if (!ui.native || ui.busy || ui.confirmOpen) return false;
    const name = getNameByValue(value);
    if (!name) { notify('预设不存在，可能刚被删除或重命名', 'warning'); return false; }
    if (name === ui.activeName) return true;
    ui.busy = true;
    try {
        const state = getDirtyState();
        if (ui.data.protection && state !== 'clean') {
            const action = await buildConfirm(ui.activeName, name, state);
            if (action === 'cancel') return false;
            if (action === 'save') await saveCurrent();
        }
        await ui.pm.selectPreset(String(value));
        syncActive();
        renderProxy(); renderPanel();
        return true;
    } catch (err) {
        console.error('[预设分组] 切换失败', err);
        notify(`切换未完成：${err.message || err}`, 'error');
        return false;
    } finally {
        ui.busy = false;
        renderProxy(); renderPanel();
    }
}
function onNativeChangeCapture(event) {
    if (event.target !== ui.native || ui.suppressNative || ui.busy || ui.confirmOpen) return;
    const target = String(ui.native.value);
    if (!ui.activeName || target === ui.activeValue) return;
    const dirtyState = getDirtyState();
    if (ui.data.protection && dirtyState !== 'clean') {
        // Native event interception before upstream handler; restore original selection.
        event.stopImmediatePropagation(); event.preventDefault();
        ui.native.value = ui.activeValue;
        void switchTo(target);
    }
    // For clean state the original handler runs untouched.
}
function onPresetChanged(event) {
    // Pending async preset application is completed by PRESET_CHANGED in recent ST.
    syncActive(); inferGroups(); queueRefresh();
}
function queueRefresh() {
    if (ui.refreshQueued) return;
    ui.refreshQueued = true;
    setTimeout(() => {
        ui.refreshQueued = false;
        if (!ui.native?.isConnected) mountNative();
        inferGroups(); refreshAll();
    }, 150);
}
function renderProxy() {
    // Compatibility: never hide, clone or rewrite #settings_preset_openai.
    // Other extensions (e.g. preset editors/workshops) use its actual DOM and events.
    if (ui.native) ui.native.classList.remove('pg-source-hidden');
    const stale = $id('pg-filtered-preset-select');
    if (stale) stale.remove();
}
function renderQuick() {
    if (!ui.quick) return;
    ui.quick.replaceChildren();
    const header = htmlButton('预设分组', () => {
        ui.data.gridOpen = !ui.data.gridOpen; save(); renderQuick();
    }, 'pg-quick-header');
    const count = ui.data.selectedGroups.length;
    header.append(text('span', `${count ? `${count} 已选` : '全部'} · ${ui.data.gridOpen ? '⌃' : '⌄'}`, 'pg-quick-meta'));
    ui.quick.append(header);
    if (!ui.data.gridOpen) return;
    const grid = text('div', '', 'pg-quick-grid');
    const groups = sortGroups();
    for (const g of groups) {
        const selected = ui.data.selectedGroups.includes(g.id);
        const b = htmlButton(g.name, () => {
            const s = new Set(ui.data.selectedGroups);
            if (s.has(g.id)) s.delete(g.id); else s.add(g.id);
            ui.data.selectedGroups = [...s]; save(); refreshAll();
        }, `pg-group-tile${selected ? ' is-active' : ''}`);
        b.title = g.name;
        b.setAttribute('aria-pressed', String(selected));
        const num = allNames().filter(n => membersFor(n).includes(g.id)).length;
        b.append(text('small', `${num} 项`));
        grid.append(b);
    }
    if (!groups.length) grid.append(text('p', '暂无分组，请在独立面板创建。', 'pg-muted'));
    ui.quick.append(grid);
    if (ui.data.selectedGroups.length) {
        const results = text('div', '', 'pg-filter-results');
        const names = allNames().filter(matchesFilter).sort(collator.compare);
        results.append(text('div', `筛选结果 · ${names.length} 个预设`, 'pg-filter-label'));
        const list = text('div', '', 'pg-filter-list');
        for (const name of names) {
            const b = htmlButton(name === ui.activeName ? '✓ ' + name : name,
                () => void switchTo(getValueByName(name)),
                `pg-filter-preset${name === ui.activeName ? ' is-current' : ''}`);
            b.title = name;
            list.append(b);
        }
        if (!names.length) list.append(text('p', '这个组合暂无预设，请去独立面板添加。', 'pg-muted'));
        results.append(list); ui.quick.append(results);
    }
    const footer = text('div', '', 'pg-quick-footer');
    footer.append(text('small', '多选取并集 · 同一预设不重复'));
    footer.append(htmlButton('显示全部', () => {
        ui.data.selectedGroups = []; save(); refreshAll();
    }, 'pg-text-btn'));
    ui.quick.append(footer);
}
function mountNative() {
    const select = getSelectElement();
    if (!(select instanceof HTMLSelectElement)) return false;
    if (ui.native === select && ui.quick?.isConnected) return true;
    ui.native = select;
    ui.pm = getManager();
    ui.activeValue = String(select.value);
    ui.activeName = currentName();
    renderProxy();
    if (ui.quick) ui.quick.remove();
    ui.quick = text('div', '', 'pg-quick');
    ui.quick.id = 'pg-quick';
    // Only add a sibling panel; never override the native select or its change event.
    select.insertAdjacentElement('afterend', ui.quick);
    refreshAll();
    return true;
}
function openPanel() {
    if (!ui.panel) createPanel();
    ui.panel.hidden = false; ui.panelOpen = true;
    document.body.classList.add('pg-panel-visible'); renderPanel();
}
function closePanel() {
    if (ui.panel) ui.panel.hidden = true;
    ui.panelOpen = false; document.body.classList.remove('pg-panel-visible');
}
function togglePanel() { ui.panelOpen ? closePanel() : openPanel(); }
function createPanel() {
    const scrim = text('div', '', 'pg-panel-scrim');
    scrim.id = 'pg-panel'; scrim.hidden = true;
    scrim.addEventListener('click', e => { if (e.target === scrim) closePanel(); });
    const windowBox = text('section', '', 'pg-window');
    windowBox.setAttribute('role', 'dialog'); windowBox.setAttribute('aria-label', '预设分组管理');
    scrim.append(windowBox); document.body.append(scrim); ui.panel = scrim;
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && ui.panelOpen && !ui.confirmOpen) closePanel();
    });
}
function showGroupsEditor(name) {
    const scrim = text('div', '', 'pg-confirm-backdrop');
    const dialog = text('div', '', 'pg-editor-dialog');
    dialog.append(text('h3', '所属分组'));
    dialog.append(text('p', name, 'pg-editor-name'));
    const choices = text('div', '', 'pg-editor-groups');
    function draw() {
        choices.replaceChildren();
        for (const group of sortGroups()) {
            const line = text('label', '', 'pg-checkline');
            const check = document.createElement('input'); check.type = 'checkbox';
            check.checked = membersFor(name).includes(group.id);
            check.addEventListener('change', () => addMembership(name, group.id, check.checked));
            line.append(check, text('span', group.name)); choices.append(line);
        }
        if (!ui.data.groups.length) choices.append(text('p', '暂时没有分组。先创建一个吧。', 'pg-muted'));
    }
    draw(); dialog.append(choices);
    const newRow = text('div', '', 'pg-inline');
    const input = document.createElement('input'); input.placeholder = '创建新分组'; input.maxLength = 60;
    const add = htmlButton('创建并加入', () => {
        const nameNew = input.value.trim();
        if (!nameNew) return;
        const existing = ui.data.groups.find(g => g.name === nameNew);
        if (existing) { addMembership(name, existing.id, true); }
        else {
            const group = { id: makeId(), name: nameNew, type: 'manual', anchor: name };
            ui.data.groups.push(group); addMembership(name, group.id, true);
        }
        input.value = ''; draw();
    }, 'pg-primary');
    newRow.append(input, add); dialog.append(newRow);
    dialog.append(htmlButton('完成', () => { scrim.remove(); refreshAll(); }, 'pg-cancel'));
    scrim.append(dialog); document.body.append(scrim);
    scrim.addEventListener('click', e => { if (e.target === scrim) scrim.remove(); });
}
function makePresetRow(name, compact = false) {
    const row = text('div', '', 'pg-preset-row');
    const prefix = name === ui.activeName ? '✓ ' : '';
    row.append(htmlButton(prefix + name, () => void switchTo(getValueByName(name)),
        `pg-preset-name${name === ui.activeName ? ' pg-is-current' : ''}`));
    const star = htmlButton(ui.data.favorites.includes(name) ? '★' : '☆', () => {
        const s = new Set(ui.data.favorites);
        if (s.has(name)) s.delete(name); else s.add(name);
        ui.data.favorites = [...s]; save(); renderPanel();
    }, `pg-star${ui.data.favorites.includes(name) ? ' is-favorite' : ''}`);
    star.title = ui.data.favorites.includes(name) ? '取消收藏' : '收藏预设';
    row.append(star);
    if (!compact) row.append(htmlButton('分组', () => showGroupsEditor(name), 'pg-row-assign'));
    return row;
}
function groupCard(group, list, headingRight = '') {
    const section = text('section', '', 'pg-series-card');
    const sortable = ui.data.groups.some(g => g.id === group.id);
    if (sortable) { section.classList.add('pg-sortable-card'); section.dataset.groupId = group.id; }
    const collapsed = ui.data.collapsed[group.id] !== false;
    const top = text('div', '', 'pg-series-top');
    if (sortable) top.append(makeDragHandle(group));
    const head = htmlButton('', () => {
        ui.data.collapsed[group.id] = !collapsed; save(); renderPanel();
    }, 'pg-series-heading');
    head.append(text('span', `${collapsed ? '▸' : '▾'} ${group.name}`));
    head.append(text('span', headingRight || `${list.length} 项`, 'pg-count'));
    top.append(head); section.append(top);
    if (!collapsed) {
        const body = text('div', '', 'pg-series-body');
        for (const name of list) body.append(makePresetRow(name));
        if (!list.length) body.append(text('p', '这个分组还没有预设。可以点「选择预设」添加。', 'pg-empty'));
        section.append(body);
    }
    return section;
}
function renameGroup(group) {
    const newName = window.prompt('修改分组名称', group.name);
    if (newName === null) return;
    const cleaned = newName.trim();
    if (!cleaned || ui.data.groups.some(g=>g.id!==group.id && g.name===cleaned))
        return notify('名称不能为空或与现有分组重复', 'warning');
    group.name=cleaned; save(); refreshAll();
}
function deleteGroup(group) {
    if (!window.confirm(`只删除分组「${group.name}」？其中的预设不会被删除。`)) return;
    ui.data.groups = ui.data.groups.filter(x=>x.id!==group.id);
    ui.data.groupOrder = ui.data.groupOrder.filter(id=>id!==group.id);
    ui.data.selectedGroups = ui.data.selectedGroups.filter(id=>id!==group.id);
    for (const [name,members] of Object.entries(ui.data.memberships)) {
        if (members.includes(group.id)) ui.data.manualOverrides[name] = true;
        ui.data.memberships[name] = members.filter(id=>id!==group.id);
    }
    save(); refreshAll();
}
function showGroupMemberPicker(group) {
    const scrim = text('div', '', 'pg-confirm-backdrop');
    const dialog = text('section', '', 'pg-editor-dialog pg-member-picker');
    dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true');
    const header = text('div', '', 'pg-picker-head');
    const labels = text('div', '', 'pg-picker-title');
    labels.append(text('h3', `选择预设 · ${group.name}`),
        text('p', '勾选即加入，取消勾选即移出。可以一次添加多个预设。'));
    header.append(labels, htmlButton('×', () => scrim.remove(), 'pg-picker-x'));
    dialog.append(header);
    const all = allNames().sort(collator.compare);
    const chosen = new Set(all.filter(n => membersFor(n).includes(group.id)));
    const search = document.createElement('input');
    search.type='search'; search.placeholder='搜索要添加的预设…'; search.className='pg-picker-search';
    dialog.append(search);
    const info = text('p', '', 'pg-picker-count'); dialog.append(info);
    const list = text('div', '', 'pg-picker-list'); dialog.append(list);
    function draw() {
        list.replaceChildren();
        const names=all.filter(n => normalized(n).includes(normalized(search.value)));
        info.textContent = `已选 ${chosen.size} / 共 ${all.length} 个预设`;
        for (const name of names) {
            const line = text('label', '', 'pg-checkline');
            const check = document.createElement('input'); check.type='checkbox';
            check.checked=chosen.has(name);
            check.addEventListener('change', () => {
                check.checked ? chosen.add(name) : chosen.delete(name);
                info.textContent = `已选 ${chosen.size} / 共 ${all.length} 个预设`;
            });
            line.append(check, text('span',name)); list.append(line);
        }
        if (!names.length) list.append(text('p','没有匹配的预设。','pg-muted'));
    }
    search.addEventListener('input', draw); draw();
    const actions=text('div','','pg-picker-actions');
    actions.append(htmlButton('取消', () => scrim.remove(), 'pg-secondary'));
    actions.append(htmlButton('保存分组', () => {
        for (const name of all) {
            const before=membersFor(name).includes(group.id), after=chosen.has(name);
            if (before===after) continue;
            const ids=new Set(membersFor(name));
            after ? ids.add(group.id) : ids.delete(group.id);
            ui.data.memberships[name]=[...ids];
            ui.data.manualOverrides[name]=true;
        }
        save(); scrim.remove(); refreshAll();
    }, 'pg-primary'));
    dialog.append(actions); scrim.append(dialog); document.body.append(scrim);
    scrim.addEventListener('click',e=>{ if(e.target===scrim) scrim.remove(); });
}
function renderPanel() {
    if (!ui.panel || !ui.panelOpen) return;
    const win = ui.panel.querySelector('.pg-window');
    win.replaceChildren();
    const head = text('header', '', 'pg-head');
    const title = text('div', '', 'pg-title');
    title.append(text('strong', '预设分组'), text('small', '分类 · 收藏 · 切换'));
    head.append(title, htmlButton('×', closePanel, 'pg-close'));
    win.append(head);
    const search = document.createElement('input');
    search.type = 'search'; search.placeholder = '搜索预设名称或版本…';
    search.value = ui.query; search.className = 'pg-search';
    search.addEventListener('input', () => {
        ui.query = search.value;
        // Rerender only content to preserve input focus / mobile keyboard.
        renderPanelContent();
    });
    win.append(search);
    const tabs = text('div', '', 'pg-tabs');
    for (const [k, label] of [['all', '全部'], ['fav', '收藏'], ['groups', '分类']]) {
        tabs.append(htmlButton(label, () => {
            ui.tab = k; for (const b of tabs.children) b.classList.toggle('is-selected', b.dataset.tab === k);
            renderPanelContent();
        }, `pg-tab${ui.tab === k ? ' is-selected' : ''}`));
        tabs.lastChild.dataset.tab = k;
    }
    win.append(tabs);
    const content = text('main', '', 'pg-content'); content.id = 'pg-panel-content';
    win.append(content);
    const foot = text('footer', '', 'pg-panel-footer');
    const checked = document.createElement('input'); checked.type = 'checkbox';
    checked.checked = ui.data.protection;
    checked.addEventListener('change', () => { ui.data.protection = checked.checked; save(); });
    const label = text('label', '', 'pg-protect');
    label.append(checked, text('span', '切换前检查未保存修改'));
    foot.append(label, text('small', '仅管理 Chat Completion 预设 · v0.1.1'));
    win.append(foot);
    renderPanelContent();
}
function renderPanelContent() {
    const content = $id('pg-panel-content');
    if (!content) return;
    // Preserve existing scroll location when searching/re-rendering.
    const oldTop = content.scrollTop;
    content.replaceChildren();
    if (!ui.native) {
        content.append(text('p', '当前页面还未找到 Chat Completion 预设选择器。请打开 API 连接设置并选择 Chat Completion。', 'pg-muted'));
        return;
    }
    const names = allNames().filter(n => normalized(n).includes(normalized(ui.query)));
    const all = allNames();
    const count = text('p', `共 ${all.length} 个预设 · ${ui.data.groups.length} 个分组 · 当前：${ui.activeName || '无'}`, 'pg-summary');
    content.append(count);
    if (ui.tab === 'fav') {
        const favorites = names.filter(n => ui.data.favorites.includes(n)).sort(collator.compare);
        if (!favorites.length) content.append(text('p', '没有符合条件的收藏预设。', 'pg-empty'));
        for (const name of favorites) content.append(makePresetRow(name));
    } else if (ui.tab === 'groups') {
        const help = text('p','这里管理分组。点击「选择预设」即可批量勾选添加；左侧 ⠿ 按住可拖动排序。','pg-category-help');
        content.append(help);
        const controls = text('div','','pg-inline');
        const input=document.createElement('input'); input.placeholder='输入分组名称'; input.maxLength=60;
        const create=() => {
            const label=input.value.trim();
            if (!label) return;
            if (ui.data.groups.some(g=>g.name===label)) return notify('分组名称已经存在','warning');
            const group={id:makeId(),name:label,type:'manual',anchor:''};
            ui.data.groups.push(group);
            ui.data.groupOrder=syncGroupOrder();
            save(); refreshAll();
            showGroupMemberPicker(group);
        };
        input.addEventListener('keydown',e=>{if(e.key==='Enter') create();});
        controls.append(input,htmlButton('＋ 新建分组',create,'pg-primary'));
        content.append(controls);
        for (const [type,title,description] of [
            ['manual','我的分组','自己创建，可添加任意预设'],
            ['auto','自动识别的系列','按名称相似度整理，也可以手动纠错']
        ]) {
            const groups=sortGroups().filter(g=>g.type===type);
            content.append(text('div',`${title} · ${groups.length}`,'pg-category-section'));
            content.append(text('p',description,'pg-category-note'));
            if (!groups.length) { content.append(text('p',type==='manual'?'还没有自建分组。':'暂无自动识别系列。','pg-muted')); continue; }
            for (const group of groups) {
                const groupMembers=names.filter(n=>membersFor(n).includes(group.id)).sort(versionCompare);
                if (ui.query && !groupMembers.length && !normalized(group.name).includes(normalized(ui.query))) continue;
                const card=groupCard(group,groupMembers,`${groupMembers.length} 项`);
                const actions=text('div','','pg-group-actions');
                actions.append(htmlButton('＋ 选择预设',()=>showGroupMemberPicker(group),'pg-primary pg-add-members'));
                actions.append(htmlButton('改名',()=>renameGroup(group),'pg-text-btn'));
                actions.append(htmlButton('删除',()=>deleteGroup(group),'pg-text-btn pg-danger'));
                card.append(actions); content.append(card);
            }
        }
        const uncategorized=names.filter(n=>membersFor(n).length===0).sort(collator.compare);
        content.append(text('div','未分类预设','pg-category-section'));
        content.append(groupCard({id:'no-group',name:'未分类'},uncategorized,`${uncategorized.length} 项`));
    } else {
        const grouped = new Set();
        for (const g of sortGroups()) {
            const members = names.filter(n => membersFor(n).includes(g.id)).sort(versionCompare);
            if (!members.length) continue;
            for (const name of members) grouped.add(name);
            content.append(groupCard(g, members));
        }
        const alone = names.filter(n => !grouped.has(n)).sort(collator.compare);
        if (alone.length) content.append(groupCard({ id: 'alone', name: '独立预设' }, alone));
        if (names.length === 0) content.append(text('p', '没有匹配的预设。', 'pg-empty'));
    }
    content.scrollTop = oldTop;
}
function mountMenu() {
    const place = $id('extensions_settings');
    if (place && !$id('pg-extensions-entry')) {
        const card = text('div', '', 'extension_container pg-extension-entry');
        card.id = 'pg-extensions-entry';
        const bar = htmlButton('▤ 预设分组', togglePanel, 'pg-extension-toggle');
        card.append(bar, text('small', '分类、收藏、切换 Chat Completion 预设', 'pg-muted'));
        place.append(card);
    }
    // The drawer menu is optional and varies across TT themes/versions.
    const menu = $id('extensionsMenu');
    if (menu && !$id('pg-menu-entry')) {
        const b = htmlButton('▤ 预设分组', togglePanel, 'pg-menu-entry');
        b.id = 'pg-menu-entry'; menu.append(b);
    }
}
function refreshAll() {
    syncActive(); renderProxy(); renderQuick(); renderPanel();
}
async function init() {
    if (!window.SillyTavern?.getContext) {
        console.warn('[预设分组] 未找到 SillyTavern 上下文'); return;
    }
    ui.ctx = SillyTavern.getContext();
    ui.data = getData();
    try {
        const openaiModule = await import('../../../openai.js');
        if (typeof openaiModule.getChatCompletionPreset === 'function')
            ui.getCurrentPresetBody = openaiModule.getChatCompletionPreset;
        if (typeof openaiModule.getPresetApplicationPromise === 'function')
            ui.getPresetApplicationPromise = openaiModule.getPresetApplicationPromise;
    } catch (err) {
        console.warn('[预设分组] 预设快照接口不可用，切换时将进行安全提示', err);
    }
    mountMenu(); mountNative(); createPanel();
    const { eventSource, event_types } = ui.ctx;
    if (eventSource && event_types) {
        if (event_types.PRESET_CHANGED) eventSource.on(event_types.PRESET_CHANGED, onPresetChanged);
        if (event_types.MAIN_API_CHANGED) eventSource.on(event_types.MAIN_API_CHANGED, queueRefresh);
        if (event_types.PRESET_DELETED) eventSource.on(event_types.PRESET_DELETED, queueRefresh);
    }
    // Lightweight fallback for delayed TT panels, theme-driven DOM replacement,
    // newly imported presets, and API changes that do not emit a standardized event.
    setInterval(() => {
        mountMenu();
        if (!ui.native?.isConnected) mountNative();
        if (ui.native) {
            const names = allNames();
            const missing = names.some(n => !Object.prototype.hasOwnProperty.call(ui.data.memberships, n));
            if (missing) { inferGroups(); refreshAll(); }
            const value = String(ui.native.value);
            if (value !== ui.activeValue && !ui.busy && !ui.confirmOpen) {
                // Changes from external plugins may bypass the native capture handler.
                syncActive(); refreshAll();
            }
        }
    }, 2200);
    console.info('[预设分组] v0.1.1 已加载');
}
// ST's startup has finished by the time most third-party entrypoints run.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
else void init();