/**
 * 预设分组 / Preset Groups v0.2.0
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
    // Accept both separated and attached suffixes, e.g. "Model-v1.2" and "万事成真v1.23".
    const rx = /(?:v(?:er(?:sion)?)?\.?\s*|版本\s*)(\d+(?:\.\d+){0,3})(?:\s*[-_.]?\s*(?:alpha|beta|rc)\s*\d*)?\s*$/i;
    const match = noCopy.match(rx);
    if (match && match.index > 0) return { base: noCopy.slice(0, match.index).trim().replace(/[\s_\-【\[（]+$/, ''), version: match[1], raw: original };
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
    theme: 'follow',
    floatingEnabled: false,
    floatingPosition: null,
    presetOrder: {},
    newPresets: [],
    knownPresets: [],
    knownPresetsInitialized: false,
    pendingMatches: [],
});
const ui = {
    ctx: null, data: null, pm: null, native: null, proxy: null, quick: null,
    panel: null, panelOpen: false, tab: 'all', query: '',
    activeName: '', activeValue: '', busy: false, suppressNative: false,
    confirmOpen: false, getCurrentPresetBody: null, getPresetApplicationPromise: null, lastSnapshot: null,
    refreshQueued: false,
    floating: null,
    drawerCheckbox: null,
    sortMode: false,
};
function notify(message, level = 'info') {
    if (window.toastr?.[level]) window.toastr[level](message);
    else console.info(`[预设分组] ${message}`);
}
function save() {
    try { ui.ctx?.saveSettingsDebounced?.(); } catch (err) { console.warn('[预设分组] 保存分组失败', err); }
}
function applyTheme() {
    const theme = ['follow','light','dark'].includes(ui.data?.theme) ? ui.data.theme : 'follow';
    for (const root of [ui.quick, ui.panel, ui.floating, ...document.querySelectorAll('.pg-confirm-backdrop')]) {
        if (root) root.dataset.pgTheme = theme;
    }
}
function setTheme(theme) {
    if (!['follow','light','dark'].includes(theme)) return;
    ui.data.theme = theme; save(); applyTheme();
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
    if (!ui.data.selectedGroups.length) return true;
    const ids = membersFor(name);
    return ui.data.selectedGroups.some(id => id === '__uncategorized__' ? ids.length === 0 : ids.includes(id));
}
function syncGroupOrder() {
    const ids = new Set(ui.data.groups.map(g => g.id));
    const old = Array.isArray(ui.data.groupOrder) ? ui.data.groupOrder : [];
    const next = old.filter(id => ids.has(id));
    const missing = ui.data.groups.filter(g => !next.includes(g.id)).sort((a,b) => collator.compare(a.name, b.name));
    next.push(...missing.map(g => g.id));
    if (JSON.stringify(old) !== JSON.stringify(next)) { ui.data.groupOrder = next; save(); }
    return next;
}
function sortGroups(list = ui.data.groups) {
    const order = syncGroupOrder();
    return [...list].sort((a,b) => order.indexOf(a.id) - order.indexOf(b.id));
}
function presetMembersForGroup(groupId) {
    if (groupId === '__uncategorized__' || groupId === '__independent__') return allNames().filter(name => membersFor(name).length === 0);
    return allNames().filter(name => membersFor(name).includes(groupId));
}
function sortPresetNames(groupId, list) {
    const names = [...new Set(list)];
    const saved = Array.isArray(ui.data.presetOrder?.[groupId]) ? ui.data.presetOrder[groupId] : [];
    const present = new Set(names);
    const ordered = saved.filter(name => present.has(name));
    const fresh = (ui.data.newPresets || []).filter(name => present.has(name) && !ordered.includes(name));
    const missing = names.filter(name => !ordered.includes(name) && !fresh.includes(name)).sort(versionCompare);
    if (!saved.length) return [...fresh, ...names.filter(name => !fresh.includes(name)).sort(versionCompare)];
    return [...fresh, ...ordered, ...missing];
}
function moveGroup(movingId, targetId, after) {
    if (movingId === targetId) return;
    const order = [...syncGroupOrder()];
    if (!order.includes(movingId) || !order.includes(targetId)) return;
    order.splice(order.indexOf(movingId), 1);
    order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, movingId);
    ui.data.groupOrder = order; save(); refreshAll();
}
function movePreset(groupId, movingName, targetName, after) {
    if (!groupId || movingName === targetName) return;
    const order = sortPresetNames(groupId, presetMembersForGroup(groupId));
    if (!order.includes(movingName) || !order.includes(targetName)) return;
    order.splice(order.indexOf(movingName), 1);
    order.splice(order.indexOf(targetName) + (after ? 1 : 0), 0, movingName);
    ui.data.presetOrder[groupId] = order;
    ui.data.newPresets = (ui.data.newPresets || []).filter(name => name !== movingName);
    save(); refreshAll();
}
function makeDragHandle(kind, itemId, groupId = '') {
    const handle = htmlButton('⠿', () => {}, 'pg-drag-handle');
    handle.title = '长按约 2 秒进入排序，再拖动调整位置';
    handle.setAttribute('aria-label', kind === 'group' ? '调整分组顺序' : '调整预设顺序');
    const itemSelector = kind === 'group' ? '.pg-sortable-card' : '.pg-sortable-preset';
    let pointer = null, source = null, destination = null, armed = false, dragging = false;
    let startX = 0, startY = 0, armTimer = null;
    const clearMarks = () => document.querySelectorAll('#pg-panel .pg-dragging, #pg-panel .pg-drop-before, #pg-panel .pg-drop-after, #pg-panel .pg-drag-armed')
        .forEach(el => el.classList.remove('pg-dragging','pg-drop-before','pg-drop-after','pg-drag-armed'));
    const cancelPending = () => { if (armTimer) clearTimeout(armTimer); armTimer = null; };
    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || pointer !== null || !ui.sortMode) return;
        source = handle.closest(itemSelector);
        if (!source) return;
        pointer = event.pointerId; destination = null; armed = false; dragging = false;
        startX = event.clientX; startY = event.clientY;
        try { handle.setPointerCapture(pointer); } catch {}
        armTimer = setTimeout(() => {
            armed = true; handle.classList.add('pg-drag-armed'); source?.classList.add('pg-drag-armed');
        }, 2000);
        event.preventDefault(); event.stopPropagation();
    });
    handle.addEventListener('pointermove', event => {
        if (pointer !== event.pointerId || !source) return;
        const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (!armed) {
            if (distance > 9) { cancelPending(); pointer = null; source = null; destination = null; clearMarks(); }
            return;
        }
        if (!dragging && distance < 6) return;
        dragging = true; clearMarks(); source.classList.add('pg-dragging');
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(itemSelector);
        const sameList = kind === 'group' ? target?.dataset.groupId !== undefined : target?.dataset.groupId === groupId;
        if (target && target !== source && sameList) {
            const rect = target.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            target.classList.add(after ? 'pg-drop-after' : 'pg-drop-before');
            destination = kind === 'group' ? { id: target.dataset.groupId, after } : { name: target.dataset.presetName, after };
        } else destination = null;
        const scroller = source.closest('.pg-content');
        if (scroller) {
            const rect = scroller.getBoundingClientRect();
            if (event.clientY < rect.top + 42) scroller.scrollTop -= 14;
            if (event.clientY > rect.bottom - 42) scroller.scrollTop += 14;
        }
        event.preventDefault();
    });
    function finish(cancel = false) {
        if (pointer === null) return;
        cancelPending();
        const target = destination, wasDragging = dragging;
        pointer = null; source = null; destination = null; armed = false; dragging = false;
        clearMarks();
        if (!cancel && wasDragging && target) {
            if (kind === 'group') moveGroup(itemId, target.id, target.after);
            else movePreset(groupId, itemId, target.name, target.after);
        }
    }
    handle.addEventListener('pointerup', event => {
        if (event.pointerId === pointer) { finish(); event.preventDefault(); event.stopPropagation(); }
    });
    handle.addEventListener('pointercancel', () => finish(true));
    handle.addEventListener('lostpointercapture', () => finish(true));
    handle.addEventListener('keydown', event => {
        if (!['ArrowUp','ArrowDown'].includes(event.key) || !ui.sortMode) return;
        const items = [...document.querySelectorAll('#pg-panel ' + itemSelector)]
            .filter(el => kind === 'group' || el.dataset.groupId === groupId);
        const pos = items.findIndex(el => kind === 'group' ? el.dataset.groupId === itemId : el.dataset.presetName === itemId);
        const next = items[pos + (event.key === 'ArrowUp' ? -1 : 1)];
        if (next) {
            event.preventDefault();
            if (kind === 'group') moveGroup(itemId, next.dataset.groupId, event.key === 'ArrowDown');
            else movePreset(groupId, itemId, next.dataset.presetName, event.key === 'ArrowDown');
        }
    });
    return handle;
}
function makeId() { return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`; }
function addMembership(name, id, selected) {
    const members = new Set(membersFor(name));
    if (selected) members.add(id); else members.delete(id);
    ui.data.memberships[name] = [...members];
    if (selected && (ui.data.newPresets || []).includes(name)) for (const groupId of members) {
        const old = ui.data.presetOrder[groupId] || [];
        ui.data.presetOrder[groupId] = [name, ...old.filter(item => item !== name)];
    }
    ui.data.manualOverrides[name] = true;
    save(); refreshAll();
}
function commonSubstring(a, b) {
    const x = normalized(parseVersion(a).base), y = normalized(parseVersion(b).base);
    if (!x || !y) return '';
    let prev = new Uint16Array(y.length + 1), best = 0, end = 0;
    for (let i = 1; i <= x.length; i++) {
        const row = new Uint16Array(y.length + 1);
        for (let j = 1; j <= y.length; j++) if (x[i - 1] === y[j - 1]) {
            row[j] = prev[j - 1] + 1;
            if (row[j] > best) { best = row[j]; end = i; }
        }
        prev = row;
    }
    return x.slice(end - best, end);
}
function queueMatch(match) {
    const list = ui.data.pendingMatches || (ui.data.pendingMatches = []);
    if (!list.some(item => item.name === match.name && item.groupId === match.groupId && item.otherName === match.otherName)) {
        list.push({ id: makeId(), ...match });
    }
}
function inferGroups() {
    const names = allNames();
    if (!names.length) return;
    let changed = false;
    const known = new Set(Object.keys(ui.data.memberships));
    for (const name of names) {
        if (known.has(name) || ui.data.manualOverrides[name]) continue;
        const candidates = [];
        for (const group of ui.data.groups.filter(item => item.type === 'auto')) {
            const score = similarity(name, group.anchor || group.name);
            if (score >= 0.5) candidates.push({ group, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        if (candidates.length) {
            const best = candidates[0], clear = !candidates[1] || best.score - candidates[1].score > 0.08;
            if (clear && best.score >= 0.85) ui.data.memberships[name] = [best.group.id];
            else {
                queueMatch({ name, groupId: best.group.id, otherName: best.group.anchor || best.group.name, score: best.score });
                ui.data.memberships[name] = [];
            }
            known.add(name); changed = true; continue;
        }
        let best = null, bestScore = 0, tied = false;
        for (const other of names) {
            if (other === name || !known.has(other) || ui.data.manualOverrides[other] || membersFor(other).length) continue;
            const score = similarity(name, other);
            if (score < 0.5) continue;
            if (score > bestScore + 0.03) { best = other; bestScore = score; tied = false; }
            else if (Math.abs(score - bestScore) <= 0.03) tied = true;
        }
        if (best && !tied && bestScore >= 0.85) {
            const common = commonSubstring(name, best);
            const group = { id: makeId(), name: common.length <= 2 ? common + '系列' : common, type: 'auto', anchor: best };
            ui.data.groups.push(group);
            ui.data.memberships[name] = [group.id]; ui.data.memberships[best] = [group.id];
        } else if (best && bestScore >= 0.5) {
            queueMatch({ name, otherName: best, score: bestScore });
            ui.data.memberships[name] = [];
        } else ui.data.memberships[name] = [];
        known.add(name); changed = true;
    }
    if (changed) save();
}
function acceptPendingMatch(id) {
    const match = (ui.data.pendingMatches || []).find(item => item.id === id);
    if (!match) return;
    if (match.groupId && ui.data.groups.some(group => group.id === match.groupId)) {
        const ids = new Set(membersFor(match.name)); ids.add(match.groupId);
        ui.data.memberships[match.name] = [...ids];
    } else if (match.otherName) {
        const common = commonSubstring(match.name, match.otherName);
        const group = { id: makeId(), name: common.length <= 2 ? common + '系列' : common, type: 'auto', anchor: match.otherName, confirmed: true };
        ui.data.groups.push(group);
        ui.data.memberships[match.name] = [group.id]; ui.data.memberships[match.otherName] = [group.id];
    }
    ui.data.pendingMatches = ui.data.pendingMatches.filter(item => item.id !== id);
    save(); refreshAll();
}
function ignorePendingMatch(id) {
    const match = (ui.data.pendingMatches || []).find(item => item.id === id);
    if (!match) return;
    ui.data.manualOverrides[match.name] = true;
    if (!Object.prototype.hasOwnProperty.call(ui.data.memberships, match.name)) ui.data.memberships[match.name] = [];
    ui.data.pendingMatches = ui.data.pendingMatches.filter(item => item.id !== id);
    save(); refreshAll();
}
function syncImportedPresets(initial = false) {
    const names = allNames();
    if (!ui.data.knownPresetsInitialized) {
        ui.data.knownPresets = names; ui.data.knownPresetsInitialized = true; save(); return false;
    }
    const previous = new Set(ui.data.knownPresets || []);
    const added = names.filter(name => !previous.has(name));
    const changed = JSON.stringify(ui.data.knownPresets || []) !== JSON.stringify(names);
    ui.data.knownPresets = names;
    if (added.length) {
        ui.data.newPresets = [...added, ...(ui.data.newPresets || []).filter(name => names.includes(name) && !added.includes(name))];
        for (const name of added) for (const groupId of membersFor(name)) {
            const old = ui.data.presetOrder[groupId] || [];
            ui.data.presetOrder[groupId] = [name, ...old.filter(item => item !== name)];
        }
    }
    if (changed || added.length) save();
    return added.length > 0;
}
function clearNewPreset(name) {
    if (!(ui.data.newPresets || []).includes(name)) return;
    ui.data.newPresets = ui.data.newPresets.filter(item => item !== name); save();
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
        backdrop.dataset.pgTheme = ui.data.theme || 'follow';
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
    ui.quick.dataset.pgTheme = ui.data.theme || 'follow';
    const header = htmlButton('预设分组', () => {
        ui.data.gridOpen = !ui.data.gridOpen; save(); renderQuick();
    }, 'pg-quick-header');
    const count = ui.data.selectedGroups.length;
    header.append(text('span', `${count ? `${count} 已选` : '未筛选'} · ${ui.data.gridOpen ? '⌃' : '⌄'}`, 'pg-quick-meta'));
    ui.quick.append(header);
    if (!ui.data.gridOpen) return;
    const grid = text('div', '', 'pg-quick-grid');
    const groups = [...sortGroups()];
    if (allNames().some(name => membersFor(name).length === 0)) groups.push({ id: '__uncategorized__', name: '未分类', type: 'special' });
    for (const group of groups) {
        const selected = ui.data.selectedGroups.includes(group.id);
        const button = htmlButton(group.name, () => {
            const selectedIds = new Set(ui.data.selectedGroups);
            if (selectedIds.has(group.id)) selectedIds.delete(group.id); else selectedIds.add(group.id);
            ui.data.selectedGroups = [...selectedIds]; save(); refreshAll();
        }, `pg-group-tile${selected ? ' is-active' : ''}`);
        button.title = group.name; button.setAttribute('aria-pressed', String(selected));
        const number = group.id === '__uncategorized__'
            ? allNames().filter(name => membersFor(name).length === 0).length
            : allNames().filter(name => membersFor(name).includes(group.id)).length;
        button.append(text('small', `${number} 项`)); grid.append(button);
    }
    if (!groups.length) grid.append(text('p', '暂无分组，请在独立面板创建。', 'pg-muted'));
    ui.quick.append(grid);
    if (ui.data.selectedGroups.length) {
        const results = text('div', '', 'pg-filter-results');
        const names = allNames().filter(matchesFilter).sort(versionCompare);
        results.append(text('div', `筛选结果 · 共 ${names.length} 个预设`, 'pg-filter-label'));
        const list = text('div', '', 'pg-filter-list');
        for (const name of names) {
            const button = htmlButton(name === ui.activeName ? '✓ ' + name : name, () => {
                clearNewPreset(name); void switchTo(getValueByName(name));
            }, `pg-filter-preset${name === ui.activeName ? ' is-current' : ''}`);
            button.title = name;
            if ((ui.data.newPresets || []).includes(name)) button.append(text('span', '新', 'pg-new-badge'));
            list.append(button);
        }
        if (!names.length) list.append(text('p', '这个组合暂无预设，请去独立面板添加。', 'pg-muted'));
        results.append(list); ui.quick.append(results);
    }
    const footer = text('div', '', 'pg-quick-footer');
    footer.append(text('small', '多选取并集 · 同一预设不重复'));
    if (ui.data.selectedGroups.length) footer.append(htmlButton('清除筛选', () => {
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
    ui.quick.id = 'pg-quick'; ui.quick.dataset.pgTheme = ui.data.theme || 'follow';
    // Only add a sibling panel; never override the native select or its change event.
    select.insertAdjacentElement('afterend', ui.quick);
    refreshAll();
    return true;
}
function openPanel() {
    if (!ui.panel) createPanel();
    ui.panel.hidden = false; ui.panelOpen = true;
    applyTheme(); document.body.classList.add('pg-panel-visible'); renderPanel();
}
function closePanel() {
    if (ui.panel) ui.panel.hidden = true;
    ui.panelOpen = false; document.body.classList.remove('pg-panel-visible');
}
function togglePanel() { ui.panelOpen ? closePanel() : openPanel(); }
function createPanel() {
    const scrim = text('div', '', 'pg-panel-scrim');
    scrim.id = 'pg-panel'; scrim.hidden = true; scrim.dataset.pgTheme = ui.data.theme || 'follow';
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
    scrim.dataset.pgTheme = ui.data.theme || 'follow';
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
function makePresetRow(name, compact = false, groupId = null) {
    const row = text('div', '', 'pg-preset-row');
    if (ui.sortMode && groupId) {
        row.classList.add('pg-sortable-preset'); row.dataset.presetName = name; row.dataset.groupId = groupId;
        row.append(makeDragHandle('preset', name, groupId));
    }
    const select = htmlButton((name === ui.activeName ? '✓ ' : '') + name, () => {
        if (ui.sortMode) return;
        clearNewPreset(name); void switchTo(getValueByName(name));
    }, `pg-preset-name${name === ui.activeName ? ' pg-is-current' : ''}`);
    select.disabled = ui.sortMode; row.append(select);
    if ((ui.data.newPresets || []).includes(name)) row.append(text('span', '新', 'pg-new-badge'));
    const star = htmlButton(ui.data.favorites.includes(name) ? '★' : '☆', () => {
        const set = new Set(ui.data.favorites);
        if (set.has(name)) set.delete(name); else set.add(name);
        ui.data.favorites = [...set]; save(); renderPanelContent();
    }, `pg-star${ui.data.favorites.includes(name) ? ' is-favorite' : ''}`);
    star.title = ui.data.favorites.includes(name) ? '取消收藏' : '收藏预设'; row.append(star);
    if (!compact) row.append(htmlButton('分组', () => showGroupsEditor(name), 'pg-row-assign'));
    return row;
}
function groupCard(group, list, headingRight = '') {
    const section = text('section', '', 'pg-series-card');
    const realGroup = ui.data.groups.some(item => item.id === group.id);
    if (realGroup && ui.sortMode) { section.classList.add('pg-sortable-card'); section.dataset.groupId = group.id; }
    let collapsed = ui.data.collapsed[group.id] !== false;
    const top = text('div', '', 'pg-series-top');
    if (realGroup && ui.sortMode) top.append(makeDragHandle('group', group.id));
    const orderedList = sortPresetNames(group.id, list);
    const makeBody = () => {
        const body = text('div', '', 'pg-series-body'); body.dataset.groupId = group.id;
        for (const name of orderedList) body.append(makePresetRow(name, false, group.id));
        if (!orderedList.length) body.append(text('p', '这个分组还没有预设。可以点「选择预设」添加。', 'pg-empty'));
        return body;
    };
    const head = htmlButton('', () => {
        collapsed = !collapsed; ui.data.collapsed[group.id] = !collapsed; save();
        head.firstElementChild.textContent = `${collapsed ? '▸' : '▾'} ${group.name}`;
        head.setAttribute('aria-expanded', String(!collapsed));
        if (collapsed) section.querySelector(':scope > .pg-series-body')?.remove();
        else section.append(makeBody());
    }, 'pg-series-heading');
    head.setAttribute('aria-expanded', String(!collapsed));
    head.append(text('span', `${collapsed ? '▸' : '▾'} ${group.name}`));
    head.append(text('span', headingRight || `${orderedList.length} 项`, 'pg-count'));
    top.append(head); section.append(top);
    if (!collapsed) section.append(makeBody());
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
    scrim.dataset.pgTheme = ui.data.theme || 'follow';
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
            if (after && (ui.data.newPresets || []).includes(name)) {
                const old = ui.data.presetOrder[group.id] || [];
                ui.data.presetOrder[group.id] = [name, ...old.filter(item => item !== name)];
            }
            ui.data.manualOverrides[name]=true;
        }
        save(); scrim.remove(); refreshAll();
    }, 'pg-primary'));
    dialog.append(actions); scrim.append(dialog); document.body.append(scrim);
    scrim.addEventListener('click',e=>{ if(e.target===scrim) scrim.remove(); });
}
function renderPanel() {
    if (!ui.panel || !ui.panelOpen) return;
    const previousTop = $id('pg-panel-content')?.scrollTop ?? 0;
    const win = ui.panel.querySelector('.pg-window'); win.replaceChildren();
    ui.panel.dataset.pgTheme = ui.data.theme || 'follow';
    const head = text('header', '', 'pg-head');
    const title = text('div', '', 'pg-title');
    title.append(text('strong', '预设分组'), text('small', '分类 · 收藏 · 切换'));
    const actions = text('div', '', 'pg-head-actions');
    const themeWrap = text('div', '', 'pg-theme-wrap');
    const themeButton = htmlButton('', () => {
        const menu = themeWrap.querySelector('.pg-theme-menu');
        if (menu) menu.hidden = !menu.hidden;
    }, 'pg-theme-button');
    themeButton.append(text('i', '', 'fa-solid fa-palette'));
    themeButton.title = '界面主题'; themeButton.setAttribute('aria-label', '选择界面主题');
    const themeMenu = text('div', '', 'pg-theme-menu'); themeMenu.hidden = true;
    for (const [value, label] of [['follow','跟随酒馆'],['light','日间模式'],['dark','夜间模式（灰色）']]) {
        const option = htmlButton(label, () => {
            setTheme(value); themeMenu.hidden = true;
            for (const child of themeMenu.children) child.classList.toggle('is-selected', child.dataset.theme === value);
        }, `pg-theme-option${(ui.data.theme || 'follow') === value ? ' is-selected' : ''}`);
        option.dataset.theme = value; themeMenu.append(option);
    }
    themeWrap.append(themeButton, themeMenu);
    actions.append(themeWrap, htmlButton('×', closePanel, 'pg-close'));
    head.append(title, actions); win.append(head);
    const search = document.createElement('input');
    search.type = 'search'; search.placeholder = '搜索预设名称或版本…';
    search.value = ui.query; search.className = 'pg-search';
    search.addEventListener('input', () => { ui.query = search.value; renderPanelContent(); });
    win.append(search);
    const tabs = text('div', '', 'pg-tabs');
    for (const [key, label] of [['all','全部'],['fav','收藏'],['groups','分类']]) {
        tabs.append(htmlButton(label, () => {
            ui.tab = key;
            for (const button of tabs.children) button.classList.toggle('is-selected', button.dataset.tab === key);
            renderPanelContent();
        }, `pg-tab${ui.tab === key ? ' is-selected' : ''}`));
        tabs.lastChild.dataset.tab = key;
    }
    win.append(tabs);
    const content = text('main', '', 'pg-content'); content.id = 'pg-panel-content'; win.append(content);
    const foot = text('footer', '', 'pg-panel-footer');
    const checked = document.createElement('input'); checked.type = 'checkbox'; checked.checked = ui.data.protection;
    checked.addEventListener('change', () => { ui.data.protection = checked.checked; save(); });
    const label = text('label', '', 'pg-protect');
    label.append(checked, text('span', '切换前检查未保存修改'));
    foot.append(label, text('small', '仅管理 Chat Completion 预设 · v0.2.0')); win.append(foot);
    renderPanelContent();
    const rebuilt = $id('pg-panel-content'); if (rebuilt) rebuilt.scrollTop = previousTop;
    applyTheme();
}
function renderPanelContent() {
    const content = $id('pg-panel-content');
    if (!content) return;
    const oldTop = content.scrollTop; content.replaceChildren();
    if (!ui.native) {
        content.append(text('p', '当前页面还未找到 Chat Completion 预设选择器。请打开 API 连接设置并选择 Chat Completion。', 'pg-muted'));
        return;
    }
    const names = allNames().filter(name => normalized(name).includes(normalized(ui.query)));
    const all = allNames();
    content.append(text('p', `共 ${all.length} 个预设 · ${ui.data.groups.length} 个分组 · 当前：${ui.activeName || '无'}`, 'pg-summary'));
    if (ui.tab !== 'fav') {
        const toolbar = text('div', '', 'pg-content-toolbar');
        toolbar.append(htmlButton(ui.sortMode ? '完成' : '↕', () => {
            ui.sortMode = !ui.sortMode; renderPanelContent();
        }, `pg-sort-toggle${ui.sortMode ? ' is-active' : ''}`));
        toolbar.append(text('small', ui.sortMode ? '排序模式：长按左侧把手约 2 秒后拖动' : '调整分组及分组内预设顺序', 'pg-sort-hint'));
        if (ui.sortMode) toolbar.append(htmlButton('恢复默认排序', () => {
            ui.data.groupOrder = []; ui.data.presetOrder = {}; ui.sortMode = false; save(); refreshAll();
        }, 'pg-reset-sort'));
        content.append(toolbar);
    }
    if (ui.tab === 'fav') {
        const favorites = names.filter(name => ui.data.favorites.includes(name)).sort(collator.compare);
        if (!favorites.length) content.append(text('p', '没有符合条件的收藏预设。', 'pg-empty'));
        for (const name of favorites) content.append(makePresetRow(name));
    } else if (ui.tab === 'groups') {
        content.append(text('p', '在这里创建自己的分组，或把预设加入已有分组。自动识别不确定的匹配会放在「待确认」中。', 'pg-category-help'));
        const controls = text('div', '', 'pg-inline');
        const input = document.createElement('input'); input.placeholder = '输入分组名称'; input.maxLength = 60;
        const create = () => {
            const label = input.value.trim(); if (!label) return;
            if (ui.data.groups.some(group => group.name === label)) return notify('分组名称已经存在', 'warning');
            const group = { id: makeId(), name: label, type: 'manual', anchor: '' };
            ui.data.groups.push(group); ui.data.groupOrder = syncGroupOrder();
            save(); refreshAll(); showGroupMemberPicker(group);
        };
        input.addEventListener('keydown', event => { if (event.key === 'Enter') create(); });
        controls.append(input, htmlButton('＋ 新建分组', create, 'pg-primary')); content.append(controls);
        const pending = ui.data.pendingMatches || [];
        if (pending.length) {
            content.append(text('div', `待确认匹配 · ${pending.length}`, 'pg-category-section'));
            content.append(text('p', '名称相似度达到 50%，但不够确定；确认后才会合并。', 'pg-category-note'));
            for (const match of pending) {
                const card = text('div', '', 'pg-pending-match');
                const other = match.groupId ? (ui.data.groups.find(group => group.id === match.groupId)?.name || match.otherName) : match.otherName;
                card.append(text('div', `${match.name}  ↔  ${other}`, 'pg-pending-title'));
                card.append(text('small', `名称相似度 ${Math.round(match.score * 100)}%`, 'pg-pending-score'));
                const actions = text('div', '', 'pg-pending-actions');
                actions.append(htmlButton('合并为同系列', () => acceptPendingMatch(match.id), 'pg-primary'));
                actions.append(htmlButton('不是同系列', () => ignorePendingMatch(match.id), 'pg-text-btn'));
                card.append(actions); content.append(card);
            }
        }
        for (const [type, title, description] of [
            ['manual','我的分组','自己创建，可添加任意预设'],
            ['auto','自动识别的系列','高可信度自动归组；相似度 50%–84% 的结果等待确认']
        ]) {
            const groups = sortGroups().filter(group => group.type === type);
            content.append(text('div', `${title} · ${groups.length}`, 'pg-category-section'));
            content.append(text('p', description, 'pg-category-note'));
            if (!groups.length) { content.append(text('p', type === 'manual' ? '还没有自建分组。' : '暂无自动识别系列。', 'pg-muted')); continue; }
            for (const group of groups) {
                const groupMembers = names.filter(name => membersFor(name).includes(group.id));
                if (ui.query && !groupMembers.length && !normalized(group.name).includes(normalized(ui.query))) continue;
                const card = groupCard(group, groupMembers, `${groupMembers.length} 项`);
                const actions = text('div', '', 'pg-group-actions');
                actions.append(htmlButton('＋ 选择预设', () => showGroupMemberPicker(group), 'pg-primary pg-add-members'));
                actions.append(htmlButton('改名', () => renameGroup(group), 'pg-text-btn'));
                actions.append(htmlButton('删除', () => deleteGroup(group), 'pg-text-btn pg-danger'));
                card.append(actions); content.append(card);
            }
        }
        const uncategorized = names.filter(name => membersFor(name).length === 0).sort(collator.compare);
        content.append(text('div', '未分类预设', 'pg-category-section'));
        content.append(groupCard({ id: '__uncategorized__', name: '未分类' }, uncategorized, `${uncategorized.length} 项`));
    } else {
        const grouped = new Set();
        for (const group of sortGroups()) {
            const members = names.filter(name => membersFor(name).includes(group.id));
            if (!members.length) continue;
            for (const name of members) grouped.add(name);
            content.append(groupCard(group, members));
        }
        const alone = names.filter(name => !grouped.has(name)).sort(collator.compare);
        if (alone.length) content.append(groupCard({ id: '__independent__', name: '独立预设' }, alone));
        if (!names.length) content.append(text('p', '没有匹配的预设。', 'pg-empty'));
    }
    content.scrollTop = oldTop;
}
function mountFloating() {
    if (!ui.data?.floatingEnabled) { ui.floating?.remove(); ui.floating = null; return; }
    if (ui.floating?.isConnected) { applyTheme(); return; }
    const ball = htmlButton('预', () => {}, 'pg-floating-button');
    ball.id = 'pg-floating'; ball.title = '打开预设分组'; ball.setAttribute('aria-label', '打开预设分组');
    let pointer = null, startX = 0, startY = 0, originLeft = 0, originTop = 0, moved = false;
    ball.addEventListener('click', event => {
        if (ball.dataset.suppressClick === '1') { delete ball.dataset.suppressClick; event.preventDefault(); event.stopPropagation(); return; }
        togglePanel();
    });
    ball.addEventListener('pointerdown', event => {
        if (event.button !== 0 || pointer !== null) return;
        pointer = event.pointerId; moved = false;
        const rect = ball.getBoundingClientRect();
        startX = event.clientX; startY = event.clientY; originLeft = rect.left; originTop = rect.top;
        try { ball.setPointerCapture(pointer); } catch {}
    });
    ball.addEventListener('pointermove', event => {
        if (event.pointerId !== pointer) return;
        if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < 7) return;
        moved = true; ball.classList.add('pg-floating-dragging');
        const left = Math.max(4, Math.min(window.innerWidth - ball.offsetWidth - 4, originLeft + event.clientX - startX));
        const top = Math.max(4, Math.min(window.innerHeight - ball.offsetHeight - 4, originTop + event.clientY - startY));
        ball.style.left = `${left}px`; ball.style.top = `${top}px`; ball.style.right = 'auto'; ball.style.bottom = 'auto';
        event.preventDefault();
    });
    const finish = event => {
        if (pointer === null || (event?.pointerId !== undefined && event.pointerId !== pointer)) return;
        const wasMoved = moved; pointer = null; ball.classList.remove('pg-floating-dragging');
        if (wasMoved) {
            const rect = ball.getBoundingClientRect();
            ui.data.floatingPosition = { left: rect.left, top: rect.top };
            ball.dataset.suppressClick = '1'; save();
        }
        moved = false;
    };
    ball.addEventListener('pointerup', finish); ball.addEventListener('pointercancel', finish); ball.addEventListener('lostpointercapture', finish);
    document.body.append(ball); ui.floating = ball;
    const position = ui.data.floatingPosition;
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
        const left = Math.max(4, Math.min(window.innerWidth - 46, position.left));
        const top = Math.max(4, Math.min(window.innerHeight - 46, position.top));
        ball.style.left = `${left}px`; ball.style.top = `${top}px`; ball.style.right = 'auto'; ball.style.bottom = 'auto';
    }
    applyTheme();
}
function mountMenu() {
    const place = $id('extensions_settings');
    let root = $id('pg-extensions-entry');
    if (root && !root.querySelector('.inline-drawer')) { root.remove(); root = null; }
    if (place && !root) {
        root = text('div', '', 'extension-settings'); root.id = 'pg-extensions-entry';
        const drawer = text('div', '', 'inline-drawer');
        const header = text('div', '', 'inline-drawer-toggle inline-drawer-header');
        header.append(text('b', '预设分组'));
        header.append(text('div', '', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
        const content = text('div', '', 'inline-drawer-content');
        const controls = text('div', '', 'flex-container flexFlowColumn');
        const floatingLabel = text('label', '', 'checkbox_label');
        const floatingText = text('span', '显示悬浮球');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = !!ui.data.floatingEnabled;
        checkbox.addEventListener('change', () => { ui.data.floatingEnabled = checkbox.checked; save(); mountFloating(); });
        floatingLabel.append(floatingText, checkbox);
        const open = text('div', '打开预设分组', 'menu_button'); open.tabIndex = 0; open.setAttribute('role', 'button');
        open.addEventListener('click', togglePanel);
        open.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePanel(); } });
        controls.append(floatingLabel, open); content.append(controls);
        drawer.append(header, content); root.append(drawer); place.append(root);
    }
    ui.drawerCheckbox = root?.querySelector('input[type="checkbox"]') || null;
    if (ui.drawerCheckbox) ui.drawerCheckbox.checked = !!ui.data.floatingEnabled;
    const menu = $id('extensionsMenu');
    if (menu && !$id('pg-menu-entry')) {
        const container = text('div', '', 'extension_container'); container.id = 'pg-menu-container';
        const entry = text('div', '', 'list-group-item flex-container flexGap5');
        entry.id = 'pg-menu-entry'; entry.tabIndex = 0; entry.setAttribute('role', 'button'); entry.title = '打开预设分组';
        entry.append(text('div', '', 'fa-fw fa-solid fa-layer-group extensionsMenuExtensionButton'));
        entry.append(text('span', '预设分组'));
        entry.addEventListener('click', togglePanel);
        entry.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePanel(); } });
        container.append(entry); menu.append(container);
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
    inferGroups(); syncImportedPresets(true); mountFloating(); applyTheme();
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
            if (missing) inferGroups();
            const imported = syncImportedPresets();
            if (missing || imported) refreshAll();
            const value = String(ui.native.value);
            if (value !== ui.activeValue && !ui.busy && !ui.confirmOpen) {
                // Changes from external plugins may bypass the native capture handler.
                syncActive(); refreshAll();
            }
        }
    }, 2200);
    console.info('[预设分组] v0.2.0 已加载');
}
// ST's startup has finished by the time most third-party entrypoints run.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
else void init();