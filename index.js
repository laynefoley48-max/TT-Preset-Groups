/**
 * 预设分组 / Preset Groups v0.2.8
 * Browser-only extension for SillyTavern / TauriTavern.
 * Never mutates or deletes a source preset during categorization/filtering.
 */
const SLUG = 'tt_preset_groups_v1';
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const CLASSIFICATION_ALGORITHM_VERSION = 2;
const COLLAPSE_DEFAULTS_VERSION = 4;
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
    // Only explicit version markers are removed from the canonical comparison base.
    const rx = /(?:v(?:er(?:sion)?)?\.?\s*|版本\s*)(\d+(?:\.\d+){0,3})(?:\s*[-_.]?\s*(?:alpha|beta|rc)\s*\d*)?\s*$/i;
    const match = noCopy.match(rx);
    if (match && match.index > 0) {
        return {
            base: noCopy.slice(0, match.index).trim().replace(/[\s_\-【\[（]+$/, ''),
            version: match[1],
            raw: original,
            explicitVersion: true,
        };
    }
    return { base: noCopy, version: null, raw: original, explicitVersion: false };
}

// Unmarked trailing digits are ambiguous: keep the original and try one optional
// suffix-free variant. Never strip digits from both names in the same comparison.
function comparisonVariants(name) {
    const parsed = parseVersion(name);
    const variants = [{ base: parsed.base, strippedSuffix: false }];
    if (!parsed.explicitVersion) {
        const suffix = parsed.base.match(/(\d+(?:\.\d+)?)$/);
        if (suffix && suffix.index >= 2) {
            const shorter = parsed.base.slice(0, suffix.index).trim();
            if (Array.from(shorter).length >= 2 && shorter !== parsed.base) {
                variants.push({ base: shorter, strippedSuffix: true });
            }
        }
    }
    return variants;
}

function longestCommonSpanInfo(a, b) {
    if (!a || !b) return { length: 0, text: '' };
    let prev = new Uint16Array(b.length + 1), best = 0, end = 0;
    for (let i = 1; i <= a.length; i++) {
        const row = new Uint16Array(b.length + 1);
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1] === b[j - 1]) {
                row[j] = prev[j - 1] + 1;
                if (row[j] > best) { best = row[j]; end = i; }
            }
        }
        prev = row;
    }
    return { length: best, text: a.slice(end - best, end) };
}
function longestCommonSpan(a, b) {
    return longestCommonSpanInfo(a, b).length;
}
function comparePresetNames(a, b) {
    const variantsA = comparisonVariants(a), variantsB = comparisonVariants(b);
    let best = { score: 0, common: '', usedAmbiguousSuffix: false, leftBase: '', rightBase: '', matchedLength: 0 };
    for (const left of variantsA) for (const right of variantsB) {
        if (left.strippedSuffix && right.strippedSuffix) continue;
        const x = normalized(left.base), y = normalized(right.base);
        if (!x || !y || x.length > 300 || y.length > 300) continue;
        const common = longestCommonSpanInfo(x, y);
        if (common.length < 2) continue;
        const score = common.length / Math.max(x.length, y.length);
        const usedAmbiguousSuffix = left.strippedSuffix || right.strippedSuffix;
        if (score > best.score + 0.000001 ||
            (Math.abs(score - best.score) <= 0.000001 && !usedAmbiguousSuffix && best.usedAmbiguousSuffix)) {
            best = {
                score, common: common.text, usedAmbiguousSuffix,
                leftBase: x, rightBase: y, matchedLength: common.length,
            };
        }
    }
    return best;
}
function similarity(a, b) {
    return comparePresetNames(a, b).score;
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
    floatingEnabled: true,
    floatingEnabledUserSet: false,
    floatingPosition: null,
    presetOrder: {},
    newPresets: [],
    knownPresets: [],
    knownPresetsInitialized: false,
    pendingMatches: [],
    floatingSide: null,
    collapseDefaultsVersion: 1,
    classificationAlgorithmVersion: 1,
});
const ui = {
    ctx: null, data: null, pm: null, native: null, proxy: null, quick: null,
    panel: null, panelOpen: false, tab: 'all', query: '',
    activeName: '', activeValue: '', busy: false, suppressNative: false,
    confirmOpen: false, getCurrentPresetBody: null, getPresetApplicationPromise: null, lastSnapshot: null,
    refreshQueued: false,
    pendingPanelFocus: null,
    floating: null,
    drawerCheckbox: null,
    sortMode: false,
    quickPage: 0,
    autoCollapseTimer: null,
    floatingTuckTimer: null,
    floatingResizeHandler: null,
    needsCollapseReset: false,
    needsClassificationRebuild: false,
    helpOpen: false,
    helpScrim: null,
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
    const stored = bag[SLUG];
    const migrateFloatingDefault = !Object.prototype.hasOwnProperty.call(stored, 'floatingEnabledUserSet');
    ui.needsCollapseReset = Number(stored.collapseDefaultsVersion || 0) < COLLAPSE_DEFAULTS_VERSION;
    ui.needsClassificationRebuild = Number(stored.classificationAlgorithmVersion || 0) < CLASSIFICATION_ALGORITHM_VERSION;
    const def = defaults();
    for (const [key, val] of Object.entries(def)) {
        if (stored[key] === undefined) stored[key] = val;
    }
    if (migrateFloatingDefault) {
        stored.floatingEnabled = true;
        stored.floatingEnabledUserSet = false;
    }
    if (!stored.collapsed || typeof stored.collapsed !== 'object') stored.collapsed = {};
    if (!stored.manualOverrides || typeof stored.manualOverrides !== 'object') stored.manualOverrides = {};
    if (!stored.memberships || typeof stored.memberships !== 'object') stored.memberships = {};
    if (!stored.presetOrder || typeof stored.presetOrder !== 'object') stored.presetOrder = {};
    if (!Array.isArray(stored.pendingMatches)) stored.pendingMatches = [];
    if (!Array.isArray(stored.groups)) stored.groups = [];
    if (!Array.isArray(stored.favorites)) stored.favorites = [];
    if (!Array.isArray(stored.selectedGroups)) stored.selectedGroups = [];
    return stored;
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
    handle.title = '拖动调整顺序（方向键也可以）';
    handle.setAttribute('aria-label', kind === 'group' ? '调整分组顺序' : '调整预设顺序');
    const itemSelector = kind === 'group' ? '.pg-sortable-card' : '.pg-sortable-preset';
    let dragging = false, pointer = null, source = null, destination = null;
    let startX = 0, startY = 0;

    const clear = () => document.querySelectorAll(
        '#pg-panel .pg-dragging, #pg-panel .pg-drop-before, #pg-panel .pg-drop-after'
    ).forEach(el => el.classList.remove('pg-dragging', 'pg-drop-before', 'pg-drop-after'));

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || pointer !== null || !ui.sortMode) return;
        source = handle.closest(itemSelector);
        if (!source) return;
        pointer = event.pointerId;
        dragging = false;
        destination = null;
        startX = event.clientX;
        startY = event.clientY;
        try { handle.setPointerCapture(pointer); } catch {}
        event.preventDefault();
        event.stopPropagation();
    });

    handle.addEventListener('pointermove', event => {
        if (pointer !== event.pointerId || !source) return;
        if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 7) return;

        dragging = true;
        source.classList.add('pg-dragging');
        document.querySelectorAll('#pg-panel .pg-drop-before, #pg-panel .pg-drop-after')
            .forEach(el => el.classList.remove('pg-drop-before', 'pg-drop-after'));

        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(itemSelector);
        const sameList = kind === 'group'
            ? !!target?.dataset.groupId &&
                (ui.tab !== 'groups' || target.dataset.groupType === source.dataset.groupType)
            : target?.dataset.groupId === groupId;

        if (target && target !== source && sameList) {
            const rect = target.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            target.classList.add(after ? 'pg-drop-after' : 'pg-drop-before');
            destination = kind === 'group'
                ? { id: target.dataset.groupId, after }
                : { name: target.dataset.presetName, after };
        } else {
            destination = null;
        }

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
        const target = destination;
        const wasDragging = dragging;
        pointer = null;
        source = null;
        destination = null;
        dragging = false;
        clear();

        if (!cancel && wasDragging && target) {
            if (kind === 'group') moveGroup(itemId, target.id, target.after);
            else movePreset(groupId, itemId, target.name, target.after);
        }
    }

    handle.addEventListener('pointerup', event => {
        if (event.pointerId === pointer) {
            finish();
            event.preventDefault();
            event.stopPropagation();
        }
    });
    handle.addEventListener('pointercancel', () => finish(true));
    handle.addEventListener('lostpointercapture', () => finish(true));
    handle.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !ui.sortMode) return;
        const items = [...document.querySelectorAll('#pg-panel ' + itemSelector)]
            .filter(el => kind === 'group' || el.dataset.groupId === groupId);
        const pos = items.findIndex(el => kind === 'group'
            ? el.dataset.groupId === itemId
            : el.dataset.presetName === itemId);
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
    return comparePresetNames(a, b).common;
}
function queueMatch(match) {
    const list = ui.data.pendingMatches || (ui.data.pendingMatches = []);
    const existing = list.find(item => item.name === match.name &&
        item.groupId === (match.groupId || null) && item.otherName === (match.otherName || null));
    if (existing) {
        existing.score = match.score;
        existing.common = match.common || '';
        existing.usedAmbiguousSuffix = !!match.usedAmbiguousSuffix;
        existing.leftBase = match.leftBase || '';
        existing.rightBase = match.rightBase || '';
        return;
    }
    list.push({ id: makeId(), ...match });
}

function inferGroups() {
    const names = allNames();
    if (!names.length) return;
    let changed = false;
    const known = new Set(Object.keys(ui.data.memberships));

    for (const name of names) {
        if (known.has(name) || ui.data.manualOverrides[name]) continue;

        // Re-read the live group list on every pass so a newly created series
        // can also collect later matching presets in the same scan.
        const groupCandidates = ui.data.groups.filter(item => item.type === 'auto').map(group => ({
            group,
            ...comparePresetNames(name, group.anchor || group.name),
            otherName: group.anchor || group.name,
        })).filter(item => item.score >= 0.4).sort((a, b) => b.score - a.score);

        if (groupCandidates.length) {
            const best = groupCandidates[0];
            const clear = !groupCandidates[1] || best.score - groupCandidates[1].score > 0.08;
            if (clear && best.score >= 0.8 && !best.usedAmbiguousSuffix) {
                ui.data.memberships[name] = [best.group.id];
            } else {
                queueMatch({
                    name, groupId: best.group.id, otherName: best.otherName,
                    score: best.score, common: best.common,
                    usedAmbiguousSuffix: best.usedAmbiguousSuffix,
                    leftBase: best.leftBase, rightBase: best.rightBase,
                });
                ui.data.memberships[name] = [];
            }
            known.add(name); changed = true; continue;
        }

        const nameCandidates = [];
        for (const other of names) {
            if (other === name || !known.has(other) || ui.data.manualOverrides[other] || membersFor(other).length) continue;
            const comparison = comparePresetNames(name, other);
            if (comparison.score >= 0.4) nameCandidates.push({ other, ...comparison });
        }
        nameCandidates.sort((a, b) => b.score - a.score);
        if (nameCandidates.length) {
            const best = nameCandidates[0];
            const clear = !nameCandidates[1] || best.score - nameCandidates[1].score > 0.08;
            if (clear && best.score >= 0.8 && !best.usedAmbiguousSuffix) {
                const common = best.common || commonSubstring(name, best.other);
                const group = {
                    id: makeId(),
                    name: common.length <= 2 ? common + '系列' : common,
                    type: 'auto',
                    anchor: best.other,
                };
                ui.data.groups.push(group);
                ui.data.memberships[name] = [group.id];
                ui.data.memberships[best.other] = [group.id];
            } else {
                queueMatch({
                    name, otherName: best.other, score: best.score,
                    common: best.common, usedAmbiguousSuffix: best.usedAmbiguousSuffix,
                    leftBase: best.leftBase, rightBase: best.rightBase,
                });
                ui.data.memberships[name] = [];
            }
        } else {
            ui.data.memberships[name] = [];
        }
        known.add(name); changed = true;
    }
    if (changed) save();
}
function acceptPendingMatch(id) {
    const match = (ui.data.pendingMatches || []).find(item => item.id === id);
    if (!match) return;
    const common = match.common || commonSubstring(match.name, match.otherName || '');
    const fallbackGroupId = match.otherName
        ? membersFor(match.otherName).find(groupId =>
            ui.data.groups.some(group => group.id === groupId && group.type === 'auto'))
        : null;
    const targetGroupId = (match.groupId && ui.data.groups.some(group => group.id === match.groupId))
        ? match.groupId : fallbackGroupId;

    if (targetGroupId) {
        const group = ui.data.groups.find(item => item.id === targetGroupId);
        group.confirmed = true;
        const ids = new Set(membersFor(match.name)); ids.add(targetGroupId);
        ui.data.memberships[match.name] = [...ids];
        ui.data.manualOverrides[match.name] = true;
        if (match.otherName) ui.data.manualOverrides[match.otherName] = true;
    } else if (match.otherName) {
        const group = {
            id: makeId(),
            name: common.length <= 2 ? common + '系列' : common,
            type: 'auto',
            anchor: match.otherName,
            confirmed: true,
        };
        ui.data.groups.push(group);
        const nameIds = new Set(membersFor(match.name)); nameIds.add(group.id);
        const otherIds = new Set(membersFor(match.otherName)); otherIds.add(group.id);
        ui.data.memberships[match.name] = [...nameIds];
        ui.data.memberships[match.otherName] = [...otherIds];
        ui.data.manualOverrides[match.name] = true;
        ui.data.manualOverrides[match.otherName] = true;
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
function reclassifyAutomaticGroups(silent = false) {
    const oldAutoIds = new Set(ui.data.groups
        .filter(group => group.type === 'auto' && !group.confirmed)
        .map(group => group.id));

    // Keep group records as anchors so their IDs, names, order, collapsed state
    // and per-group sorting survive. Only automatic memberships are recalculated.
    for (const [name, memberships] of Object.entries(ui.data.memberships)) {
        if (ui.data.manualOverrides[name]) continue;
        const kept = (Array.isArray(memberships) ? memberships : []).filter(id => !oldAutoIds.has(id));
        if (kept.length) ui.data.memberships[name] = kept;
        else delete ui.data.memberships[name];
    }

    ui.data.pendingMatches = [];
    ui.data.classificationAlgorithmVersion = CLASSIFICATION_ALGORITHM_VERSION;
    ui.needsClassificationRebuild = false;
    inferGroups();

    const manuallyProtected = new Set();
    for (const [name, memberships] of Object.entries(ui.data.memberships)) {
        if (!ui.data.manualOverrides[name]) continue;
        for (const id of memberships) if (oldAutoIds.has(id)) manuallyProtected.add(id);
    }
    const emptyAutoIds = new Set(ui.data.groups
        .filter(group => group.type === 'auto' && !group.confirmed && !manuallyProtected.has(group.id))
        .filter(group => !Object.values(ui.data.memberships).some(ids => Array.isArray(ids) && ids.includes(group.id)))
        .map(group => group.id));
    if (emptyAutoIds.size) {
        ui.data.groups = ui.data.groups.filter(group => !emptyAutoIds.has(group.id));
        ui.data.groupOrder = (ui.data.groupOrder || []).filter(id => !emptyAutoIds.has(id));
        for (const id of emptyAutoIds) {
            delete ui.data.collapsed[id];
            delete ui.data.presetOrder[id];
        }
    }
    syncGroupOrder();
    save();
    if (!silent) notify('已重新识别自动分类；手动分组、手动归属、收藏和排序已保留。', 'success');
    refreshAll();
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
    const header = htmlButton('', () => {
        ui.data.gridOpen = !ui.data.gridOpen; save(); renderQuick();
    }, 'pg-quick-header');
    header.setAttribute('aria-expanded', String(!!ui.data.gridOpen));
    header.title = ui.data.gridOpen ? '收起分组筛选' : '展开分组筛选';
    const count = ui.data.selectedGroups.length;
    const copy = text('span', '', 'pg-quick-copy');
    copy.append(text('span', '预设分组', 'pg-quick-title'));
    const guide = text('span', '', 'pg-quick-guide');
    guide.append(
        text('span', '点击悬浮按钮进行分组'),
        text('span', '悬浮按钮在扩展栏中打开')
    );
    copy.append(guide);
    const tail = text('span', '', 'pg-quick-tail');
    tail.append(
        text('span', count ? `${count} 已选` : '未筛选', 'pg-quick-meta'),
        text('span', '·', 'pg-quick-dot'),
        text('span', ui.data.gridOpen ? '⌃' : '⌄', 'pg-quick-chevron')
    );
    header.append(copy, tail);
    ui.quick.append(header);
    if (!ui.data.gridOpen) return;

    const groups = [...sortGroups()];
    if (allNames().some(name => membersFor(name).length === 0)) {
        groups.push({ id: '__uncategorized__', name: '未分类', type: 'special' });
    }
    const pageSize = 9;
    const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
    ui.quickPage = Math.max(0, Math.min(Number.isInteger(ui.quickPage) ? ui.quickPage : 0, pageCount - 1));
    const pageStart = ui.quickPage * pageSize;
    const pageGroups = groups.slice(pageStart, pageStart + pageSize);

    const grid = text('div', '', 'pg-quick-grid');
    for (const group of pageGroups) {
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

    if (pageCount > 1) {
        const row = text('div', '', 'pg-quick-pagination-row');
        row.append(text('small', '分组', 'pg-pagination-label'));
        const pagination = text('div', '', 'pg-quick-pagination');
        const previous = htmlButton('‹', () => {
            ui.quickPage = Math.max(0, ui.quickPage - 1); renderQuick();
        }, 'pg-page-button');
        previous.disabled = ui.quickPage === 0;
        previous.title = '上一页'; previous.setAttribute('aria-label', '上一页');
        const indicator = text('span', `${ui.quickPage + 1} / ${pageCount}`, 'pg-page-indicator');
        indicator.setAttribute('aria-live', 'polite');
        const next = htmlButton('›', () => {
            ui.quickPage = Math.min(pageCount - 1, ui.quickPage + 1); renderQuick();
        }, 'pg-page-button');
        next.disabled = ui.quickPage >= pageCount - 1;
        next.title = '下一页'; next.setAttribute('aria-label', '下一页');
        pagination.append(previous, indicator, next);
        row.append(pagination); ui.quick.append(row);
    }

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
    clearTimeout(ui.floatingTuckTimer); ui.floatingTuckTimer = null;
    untuckFloating();
    ui.panel.hidden = false; ui.panelOpen = true;
    applyTheme(); document.body.classList.add('pg-panel-visible'); renderPanel();
}
function closePanel() {
    stopAutoCollapseTimer();
    if (ui.panel) ui.panel.hidden = true;
    ui.panelOpen = false; document.body.classList.remove('pg-panel-visible');
    scheduleFloatingTuck();
}
function togglePanel() { ui.panelOpen ? closePanel() : openPanel(); }
function createPanel() {
    const scrim = text('div', '', 'pg-panel-scrim');
    scrim.id = 'pg-panel'; scrim.hidden = true; scrim.dataset.pgTheme = ui.data.theme || 'follow';
    scrim.addEventListener('click', e => { if (e.target === scrim) closePanel(); });
    const activity = () => resetAutoCollapseTimer();
    for (const eventName of ['pointerdown', 'click', 'keydown', 'input', 'scroll', 'wheel', 'touchstart']) {
        scrim.addEventListener(eventName, activity, { capture: true, passive: ['scroll', 'wheel', 'touchstart'].includes(eventName) });
    }
    const windowBox = text('section', '', 'pg-window');
    windowBox.setAttribute('role', 'dialog'); windowBox.setAttribute('aria-label', '预设分组管理');
    scrim.append(windowBox); document.body.append(scrim); ui.panel = scrim;
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && ui.helpOpen) { closeHelp(); return; }
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
    const original = new Set(membersFor(name));
    const chosen = new Set(original);
    const createdGroups = [];
    let committed = false;

    function discardCreatedGroups() {
        if (committed || !createdGroups.length) return;
        const ids = new Set(createdGroups.map(group => group.id));
        ui.data.groups = ui.data.groups.filter(group => !ids.has(group.id));
        ui.data.groupOrder = (ui.data.groupOrder || []).filter(id => !ids.has(id));
        for (const id of ids) {
            delete ui.data.collapsed[id];
            delete ui.data.presetOrder[id];
        }
        save();
    }
    function closeEditor() {
        discardCreatedGroups();
        scrim.remove();
    }
    function draw() {
        choices.replaceChildren();
        for (const group of sortGroups()) {
            const line = text('label', '', 'pg-checkline');
            const check = document.createElement('input'); check.type = 'checkbox';
            check.checked = chosen.has(group.id);
            check.addEventListener('change', () => {
                if (check.checked) chosen.add(group.id);
                else chosen.delete(group.id);
            });
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
        if (existing) {
            chosen.add(existing.id);
        } else {
            const group = { id: makeId(), name: nameNew, type: 'manual', anchor: name };
            ui.data.groups.push(group);
            createdGroups.push(group);
            chosen.add(group.id);
        }
        input.value = ''; draw();
    }, 'pg-primary');
    input.addEventListener('keydown', event => { if (event.key === 'Enter') add.click(); });
    newRow.append(input, add); dialog.append(newRow);
    dialog.append(htmlButton('完成', () => {
        for (const group of createdGroups) {
            if (chosen.has(group.id)) continue;
            ui.data.groups = ui.data.groups.filter(item => item.id !== group.id);
            ui.data.groupOrder = (ui.data.groupOrder || []).filter(id => id !== group.id);
            delete ui.data.collapsed[group.id];
            delete ui.data.presetOrder[group.id];
        }

        const next = [...chosen].filter(id => ui.data.groups.some(group => group.id === id));
        const addedGroupIds = next.filter(id => !original.has(id));
        const removedGroupIds = [...original].filter(id => !next.includes(id));
        const changed = addedGroupIds.length > 0 || removedGroupIds.length > 0;

        for (const id of addedGroupIds) {
            // Put the just-assigned preset at the top and open its destination group.
            ui.data.collapsed[id] = false;
            const old = ui.data.presetOrder[id] || [];
            ui.data.presetOrder[id] = [name, ...old.filter(item => item !== name)];
        }

        if (changed) {
            ui.data.memberships[name] = next;
            ui.data.manualOverrides[name] = true;

            if (['all', 'groups'].includes(ui.tab)) {
                const targetGroupId = addedGroupIds[0]
                    || next[0]
                    || (ui.tab === 'groups' ? '__uncategorized__' : '__independent__');
                ui.data.collapsed[targetGroupId] = false;
                ui.pendingPanelFocus = {
                    tab: ui.tab,
                    groupId: targetGroupId,
                    presetName: name,
                };
            }
        }

        committed = true;
        save();
        scrim.remove();
        if (changed) refreshAll();
    }, 'pg-cancel'));
    scrim.append(dialog); document.body.append(scrim);
    scrim.addEventListener('click', event => {
        if (event.target === scrim) closeEditor();
    });
}
function showTextEditDialog(title, initialValue, placeholder, onSave) {
    const scrim = text('div', '', 'pg-confirm-backdrop');
    scrim.dataset.pgTheme = ui.data.theme || 'follow';
    const dialog = text('section', '', 'pg-editor-dialog pg-name-editor');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.append(text('h3', title));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = initialValue || '';
    input.placeholder = placeholder || '';
    input.maxLength = 100;
    input.className = 'pg-name-editor-input';
    dialog.append(input);

    const actions = text('div', '', 'pg-name-editor-actions');
    let saving = false;
    let saveButton;
    const saveAction = async () => {
        if (saving) return;
        const value = input.value.trim();
        if (!value) return notify('名称不能为空', 'warning');
        saving = true;
        saveButton.disabled = true;
        saveButton.textContent = '保存中…';
        try {
            const result = await onSave(value);
            if (result !== false) scrim.remove();
        } catch (error) {
            console.error('[预设分组] 名称修改失败', error);
            notify(error?.message || '修改失败，请稍后重试', 'error');
        } finally {
            saving = false;
            if (saveButton.isConnected) {
                saveButton.disabled = false;
                saveButton.textContent = '保存';
            }
        }
    };
    actions.append(htmlButton('取消', () => scrim.remove(), 'pg-secondary'));
    saveButton = htmlButton('保存', () => { void saveAction(); }, 'pg-primary');
    actions.append(saveButton);
    dialog.append(actions);
    scrim.append(dialog); document.body.append(scrim);
    scrim.addEventListener('click', event => { if (event.target === scrim) scrim.remove(); });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); void saveAction(); }
        if (event.key === 'Escape') scrim.remove();
    });
    input.focus(); input.select();
}
function ensurePresetOptionWithoutSelecting(name, preset, preferredIndex = null) {
    const manager = ui.pm || getManager();
    if (!manager || !ui.native) throw new Error('当前预设列表不可用');
    const { presets, preset_names } = manager.getPresetList('openai');

    // Chat Completion uses an object of name -> array index. Unlike keyed APIs,
    // deletePreset() removes only that name's mapping and its option; it does
    // NOT splice the preset array. Never shift indexes for this API.
    const hasName = Object.prototype.hasOwnProperty.call(preset_names, name);
    const occupied = index => Object.entries(preset_names).some(
        ([other, value]) => other !== name && Number(value) === index
    );

    let index;
    if (hasName) {
        index = Number(preset_names[name]);
        if (!Number.isInteger(index) || index < 0) throw new Error('预设索引异常，请刷新 TT');
        if (presets[index] === undefined) presets[index] = preset;
    } else {
        const preferred = Number.isInteger(preferredIndex) && preferredIndex >= 0
            ? preferredIndex : null;
        if (preferred !== null && preferred <= presets.length && !occupied(preferred)) {
            index = preferred;
            presets[index] = preset;
        } else {
            index = presets.length;
            presets.push(preset);
        }
        preset_names[name] = index;
    }

    const option = [...ui.native.options].find(item =>
        item.textContent === name || String(item.value) === String(index)
    );
    if (!option || option.textContent !== name) {
        const created = document.createElement('option');
        created.value = String(index);
        created.textContent = name;
        created.selected = false;
        ui.native.append(created);
    } else {
        option.value = String(index);
    }
}
async function retargetPresetReferences(oldName, newName) {
    if (!window.__TAURITAVERN__) return;
    const profileSync = await import('../../../tauritavern/agent/profile-preset-sync.js');
    const skillSync = await import('../../../tauritavern/agent/skill-scope-sync.js');
    await profileSync.retargetAgentProfilesAfterPresetRename({
        apiId: 'openai', oldName, newName,
    });
    await skillSync.retargetPresetSkillsAfterRename({
        apiId: 'openai', oldName, newName,
    });
}
function replacePresetReferencesInSettings(oldName, newName) {
    const moveKey = object => {
        if (Object.prototype.hasOwnProperty.call(object, oldName)) {
            object[newName] = object[oldName];
            delete object[oldName];
        }
    };
    moveKey(ui.data.memberships);
    moveKey(ui.data.manualOverrides);
    ui.data.favorites = [...new Set((ui.data.favorites || []).map(name => name === oldName ? newName : name))];
    ui.data.newPresets = [...new Set((ui.data.newPresets || []).map(name => name === oldName ? newName : name))];
    for (const order of Object.values(ui.data.presetOrder || {})) {
        if (Array.isArray(order)) {
            for (let i = 0; i < order.length; i++) if (order[i] === oldName) order[i] = newName;
        }
    }
    // A group anchor is a historical matching clue, not its visible title.
    // Renaming the anchor preset must not turn e.g. "灰烬之桥" into "1"
    // and break future auto-classification of that original series.
    ui.data.pendingMatches = (ui.data.pendingMatches || []).map(match => ({
        ...match,
        name: match.name === oldName ? newName : match.name,
        otherName: match.otherName === oldName ? newName : match.otherName,
    }));
    ui.data.knownPresets = allNames();
    ui.data.knownPresetsInitialized = true;
    if (ui.activeName === oldName) ui.activeName = newName;
}
async function renamePresetWithoutSwitching(oldName, newName) {
    const manager = ui.pm || getManager();
    if (!manager) throw new Error('没有找到 Chat Completion 预设管理器');
    const oldValue = getValueByName(oldName);
    if (oldValue === undefined) throw new Error('找不到这个预设，可能已经被删除或改名');
    if (String(oldValue) === 'gui') throw new Error('内置 GUI 预设不能重命名');

    const activeName = manager.getSelectedPresetName();
    if (activeName === oldName) {
        if (typeof manager.renamePreset !== 'function') {
            throw new Error('当前 TT 版本没有提供安全的当前预设重命名接口');
        }
        // Native rename triggers a change event while updating its selector.
        // Suppress our unsaved-change interception only for that native transaction.
        if (ui.busy) throw new Error('正在切换预设，请完成当前操作后重试');
        ui.busy = true;
        try {
            await manager.renamePreset(newName);
        } catch (error) {
            syncActive(); refreshAll();
            throw error;
        } finally {
            ui.busy = false;
        }
    } else {
        const storedPreset = getStoredPreset(oldName);
        if (!storedPreset) throw new Error('无法读取该预设的原始配置，已取消重命名');
        const preset = typeof structuredClone === 'function'
            ? structuredClone(storedPreset) : JSON.parse(JSON.stringify(storedPreset));
        const { preset_names } = manager.getPresetList('openai');
        const oldIndex = preset_names[oldName];

        await manager.savePreset(newName, preset, { skipUpdate: true });
        try {
            await retargetPresetReferences(oldName, newName);
        } catch (error) {
            ensurePresetOptionWithoutSelecting(newName, preset);
            throw new Error('新名称已保存，但 TT 的关联引用更新失败；原预设仍保留，请检查后再处理。');
        }

        let removed = false;
        try {
            removed = await manager.deletePreset(oldName);
        } catch (error) {
            ensurePresetOptionWithoutSelecting(oldName, storedPreset, oldIndex);
            ensurePresetOptionWithoutSelecting(newName, preset);
            throw new Error('新名称已保存，但删除旧名称时发生错误；为避免丢失，两个名称暂时都保留。');
        }
        if (!removed) {
            ensurePresetOptionWithoutSelecting(oldName, storedPreset, oldIndex);
            ensurePresetOptionWithoutSelecting(newName, preset);
            throw new Error('新名称已保存，但旧名称删除失败；两个预设暂时都保留，没有覆盖原配置。');
        }
        ensurePresetOptionWithoutSelecting(newName, preset);
    }

    replacePresetReferencesInSettings(oldName, newName);
    save(); refreshAll();
    notify(`已将预设「${oldName}」重命名为「${newName}」`, 'success');
}
function showPresetRenameDialog(name) {
    showTextEditDialog('重命名预设', name, '输入新的预设名称', async newName => {
        const foldName = value => String(value).normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
        if (foldName(newName) === foldName(name)) return true;
        const duplicate = allNames().find(item =>
            item !== name && foldName(item) === foldName(newName));
        if (duplicate) {
            notify('这个预设名称已经存在，请换一个名称', 'warning');
            return false;
        }
        await renamePresetWithoutSwitching(name, newName);
        return true;
    });
}
function makePresetRow(name, compact = false, groupId = null) {
    const row = text('div', '', 'pg-preset-row');
    row.dataset.pgScrollKey = `preset:${name}`;
    if (groupId !== null && groupId !== undefined) row.dataset.pgGroupId = String(groupId);
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
    if (!compact && !ui.sortMode && String(getValueByName(name)) !== 'gui') {
        const rename = htmlButton('✎', () => showPresetRenameDialog(name), 'pg-row-rename');
        rename.title = '重命名预设（不切换）';
        rename.setAttribute('aria-label', `重命名预设：${name}`);
        row.append(rename);
    }
    if (!compact) row.append(htmlButton('分组', () => showGroupsEditor(name), 'pg-row-assign'));
    return row;
}
function groupCard(group, list, headingRight = '') {
    const section = text('section', '', 'pg-series-card');
    const realGroup = ui.data.groups.some(item => item.id === group.id);
    section.dataset.pgScrollKey = `group:${group.id}`;
    section.dataset.pgGroupId = String(group.id);
    if (realGroup) section.dataset.groupType = group.type || '';
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
        resetAutoCollapseTimer();
    }, 'pg-series-heading');
    head.setAttribute('aria-expanded', String(!collapsed));
    head.append(text('span', `${collapsed ? '▸' : '▾'} ${group.name}`));
    head.append(text('span', headingRight || `${orderedList.length} 项`, 'pg-count'));
    top.append(head);
    if (realGroup && !ui.sortMode) {
        const edit = htmlButton('✎', () => renameGroup(group), 'pg-group-rename');
        edit.title = '编辑分组名称';
        edit.setAttribute('aria-label', `编辑分组名称：${group.name}`);
        top.append(edit);
    }
    section.append(top);
    if (!collapsed) section.append(makeBody());
    return section;
}
function renameGroup(group) {
    showTextEditDialog('编辑分组名称', group.name, '输入分组显示名称', value => {
        if (ui.data.groups.some(item => item.id !== group.id && item.name === value)) {
            notify('名称不能为空或与现有分组重复', 'warning');
            return false;
        }
        // Keep the original matching anchor independent from the visible group name.
        if (group.type === 'auto' && !group.anchor) group.anchor = group.name;
        group.name = value;
        group.userRenamed = true;
        if (group.type === 'auto') group.confirmed = true;
        save(); refreshAll();
        return true;
    });
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
    const chosen = new Set(all.filter(name => membersFor(name).includes(group.id)));
    const search = document.createElement('input');
    search.type='search'; search.placeholder='搜索要添加的预设…'; search.className='pg-picker-search';
    dialog.append(search);
    const info = text('p', '', 'pg-picker-count'); dialog.append(info);
    const list = text('div', '', 'pg-picker-list'); dialog.append(list);
    function draw() {
        list.replaceChildren();
        const names = all.filter(name => normalized(name).includes(normalized(search.value)));
        info.textContent = `已选 ${chosen.size} / 共 ${all.length} 个预设`;
        for (const name of names) {
            const line = text('label', '', 'pg-checkline');
            const check = document.createElement('input'); check.type='checkbox';
            check.checked = chosen.has(name);
            check.addEventListener('change', () => {
                check.checked ? chosen.add(name) : chosen.delete(name);
                info.textContent = `已选 ${chosen.size} / 共 ${all.length} 个预设`;
            });
            line.append(check, text('span', name)); list.append(line);
        }
        if (!names.length) list.append(text('p', '没有匹配的预设。', 'pg-muted'));
    }
    search.addEventListener('input', draw); draw();

    const actions = text('div', '', 'pg-picker-actions');
    actions.append(htmlButton('取消', () => scrim.remove(), 'pg-secondary'));
    actions.append(htmlButton('保存分组', () => {
        const addedNames = [];
        const removedNames = [];
        const becameUnassigned = [];
        for (const name of all) {
            const before = membersFor(name).includes(group.id);
            const after = chosen.has(name);
            if (before === after) continue;
            const ids = new Set(membersFor(name));
            after ? ids.add(group.id) : ids.delete(group.id);
            ui.data.memberships[name] = [...ids];
            ui.data.manualOverrides[name] = true;
            if (after) addedNames.push(name);
            else {
                removedNames.push(name);
                if (ids.size === 0) becameUnassigned.push(name);
            }
        }

        if (addedNames.length) {
            const old = ui.data.presetOrder[group.id] || [];
            ui.data.presetOrder[group.id] = [
                ...addedNames,
                ...old.filter(name => !addedNames.includes(name)),
            ];
        }

        if (!addedNames.length && !removedNames.length) {
            scrim.remove();
            return;
        }

        ui.data.collapsed[group.id] = false;
        if (addedNames.length) {
            ui.pendingPanelFocus = {
                tab: ui.tab,
                groupId: group.id,
                presetName: addedNames[0],
            };
        } else if (becameUnassigned.length) {
            const targetId = ui.tab === 'groups' ? '__uncategorized__' : '__independent__';
            ui.data.collapsed[targetId] = false;
            ui.pendingPanelFocus = {
                tab: ui.tab,
                groupId: targetId,
                presetName: becameUnassigned[0],
            };
        } else if (removedNames.length) {
            ui.pendingPanelFocus = { tab: ui.tab, groupId: group.id };
        }

        save(); scrim.remove(); refreshAll();
    }, 'pg-primary'));
    dialog.append(actions); scrim.append(dialog);
    scrim.addEventListener('click', event => {
        if (event.target === scrim) scrim.remove();
    });
}
function closeHelp() {
    if (ui.helpScrim) ui.helpScrim.remove();
    ui.helpScrim = null;
    ui.helpOpen = false;
}
function showHelp() {
    if (ui.helpOpen || ui.confirmOpen) return;
    const scrim = text('div', '', 'pg-confirm-backdrop');
    scrim.dataset.pgTheme = ui.data.theme || 'follow';
    const dialog = text('section', '', 'pg-editor-dialog pg-help-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '预设分组使用说明');

    const head = text('div', '', 'pg-help-head');
    head.append(text('h3', '预设分组 · 使用说明', 'pg-help-title'));
    head.append(htmlButton('×', closeHelp, 'pg-help-close'));
    dialog.append(head);

    const body = text('div', '', 'pg-help-body');
    const addSection = (title, paragraphs) => {
        const section = text('section', '', 'pg-help-section');
        section.append(text('h4', title, 'pg-help-section-title'));
        for (const paragraph of paragraphs) {
            const p = text('p', '', 'pg-help-text');
            if (Array.isArray(paragraph)) {
                p.append(text('strong', paragraph[0]), text('span', paragraph[1]));
            } else {
                p.textContent = paragraph;
            }
            section.append(p);
        }
        body.append(section);
    };

    addSection('1. 全部', [
        '展示所有预设，按分组归类。支持搜索、展开与收起、调整排序，点击预设名称即可切换。'
    ]);
    addSection('2. 收藏', [
        '集中显示已收藏的预设。'
    ]);
    addSection('3. 分类', [
        '支持自动识别同系列预设，也可手动创建分组、添加预设。一个预设可以同时属于多个分组。',
        '对于名称相似但无法确定是否属于同一系列的预设，会列入「待确认合并」，可自行确认合并或排除。',
        '分组标题右侧的铅笔只修改显示名称；自动分组仍使用原始匹配依据，手动分组保留原有成员。'
    ]);
    addSection('4. 编辑与命名', [
        '分组标题右侧的铅笔用于修改分组显示名称。',
        '预设条目右侧的铅笔用于重命名预设。重命名非当前预设时不会切换当前预设；重命名当前预设时保留正在使用的配置。',
        '重命名会同步更新收藏、分组成员、排序和自动分组匹配锚点。'
    ]);
    addSection('5. 亮点', [
        ['安全切换：', '切换前自动检查当前预设是否存在未保存的修改，可选择保存后切换、不保存直接切换或取消操作。'],
        ['智能归类：', '自动识别相似预设系列，减少手动整理工作。'],
        ['灵活分组：', '支持自定义分组，一个预设可同时归属于多个分组。'],
        ['原位编辑：', '修改名称不需要先切换到目标预设。']
    ]);

    dialog.append(body);
    scrim.append(dialog);
    document.body.append(scrim);
    ui.helpScrim = scrim;
    ui.helpOpen = true;
    scrim.addEventListener('click', event => {
        if (event.target === scrim) closeHelp();
    });
}
function capturePanelScroll(content) {
    if (!content) return null;
    const top = content.scrollTop;
    const viewport = content.getBoundingClientRect();
    const anchors = [...content.querySelectorAll('[data-pg-scroll-key]')]
        .map(element => ({
            key: element.dataset.pgScrollKey,
            groupId: element.dataset.pgGroupId || null,
            rect: element.getBoundingClientRect(),
        }))
        .filter(item => item.rect.bottom > viewport.top + 1 && item.rect.top < viewport.bottom - 1)
        .sort((a, b) => Math.abs(a.rect.top - viewport.top) - Math.abs(b.rect.top - viewport.top))
        .slice(0, 12)
        .map(item => ({
            key: item.key,
            groupId: item.groupId,
            offset: item.rect.top - viewport.top,
        }));
    return { top, anchors };
}
function restorePanelScroll(content, snapshot) {
    if (!content || !snapshot) return;
    const nodes = [...content.querySelectorAll('[data-pg-scroll-key]')];
    for (const anchor of snapshot.anchors || []) {
        const matches = nodes.filter(element => element.dataset.pgScrollKey === anchor.key);
        const target = matches.find(element =>
            anchor.groupId && element.dataset.pgGroupId === anchor.groupId) || matches[0];
        if (!target) continue;
        const viewport = content.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        content.scrollTop = Math.max(0, content.scrollTop + rect.top - viewport.top - anchor.offset);
        return;
    }
    content.scrollTop = snapshot.top || 0;
}
function applyPendingPanelFocus(content) {
    const focus = ui.pendingPanelFocus;
    if (!focus) return false;
    ui.pendingPanelFocus = null;
    if (focus.tab && focus.tab !== ui.tab) return false;

    const nodes = [...content.querySelectorAll('[data-pg-scroll-key]')];
    let target = null;
    if (focus.presetName) {
        const rows = nodes.filter(element => element.dataset.pgScrollKey === `preset:${focus.presetName}`);
        target = rows.find(element =>
            !focus.groupId || element.dataset.pgGroupId === String(focus.groupId)) || rows[0] || null;
    }
    if (!target && focus.groupId) {
        target = nodes.find(element => element.dataset.pgScrollKey === `group:${focus.groupId}`) || null;
    }
    if (!target) return false;

    const viewport = content.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    content.scrollTop = Math.max(0, content.scrollTop + rect.top - viewport.top - 12);
    return true;
}
function renderPanel() {
    if (!ui.panel || !ui.panelOpen) return;
    const scrollAnchor = capturePanelScroll($id('pg-panel-content'));
    const win = ui.panel.querySelector('.pg-window'); win.replaceChildren();
    ui.panel.dataset.pgTheme = ui.data.theme || 'follow';
    const head = text('header', '', 'pg-head');
    const title = text('div', '', 'pg-title');
    title.append(text('strong', '预设分组'), text('small', '点击预设即可安全切换'));
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
    const helpButton = htmlButton('说明', showHelp, 'pg-help-button');
    helpButton.title = '查看使用说明';
    helpButton.setAttribute('aria-label', '查看使用说明');
    actions.append(helpButton, themeWrap, htmlButton('×', closePanel, 'pg-close'));
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
    foot.append(label, text('small', '仅管理 Chat Completion 预设 · v0.2.8')); win.append(foot);
    renderPanelContent(scrollAnchor);
    applyTheme();
}
function currentAllGroupIds() {
    const ids = [];
    const grouped = new Set();
    for (const group of sortGroups()) {
        const members = allNames().filter(name => membersFor(name).includes(group.id));
        if (ui.tab === 'groups' || members.length) ids.push(group.id);
        for (const name of members) grouped.add(name);
    }
    if (ui.tab === 'groups') ids.push('__uncategorized__');
    else if (allNames().some(name => !grouped.has(name))) ids.push('__independent__');
    return [...new Set(ids)];
}
function stopAutoCollapseTimer() {
    if (ui.autoCollapseTimer) clearTimeout(ui.autoCollapseTimer);
    ui.autoCollapseTimer = null;
}
function resetAutoCollapseTimer() {
    stopAutoCollapseTimer();
    if (!ui.panelOpen || !['all', 'groups'].includes(ui.tab)) return;
    const hasExpanded = currentAllGroupIds().some(id => ui.data.collapsed[id] === false);
    if (!hasExpanded) return;
    ui.autoCollapseTimer = setTimeout(() => {
        ui.autoCollapseTimer = null;
        if (!ui.panelOpen || !['all', 'groups'].includes(ui.tab)) return;
        for (const id of currentAllGroupIds()) ui.data.collapsed[id] = true;
        save();
        renderPanelContent();
    }, 30000);
}
function setAllGroupsExpanded(expanded) {
    for (const id of currentAllGroupIds()) ui.data.collapsed[id] = !expanded;
    save();
    renderPanelContent();
}
function applyCollapsedDefaults() {
    for (const group of ui.data.groups) ui.data.collapsed[group.id] = true;
    ui.data.collapsed.__independent__ = true;
    ui.data.collapsed.__uncategorized__ = true;
    ui.data.collapseDefaultsVersion = COLLAPSE_DEFAULTS_VERSION;
    ui.needsCollapseReset = false;
    save();
}
function renderPanelContent(scrollAnchor = null) {
    const content = $id('pg-panel-content');
    if (!content) return;
    const anchor = scrollAnchor || capturePanelScroll(content);
    content.replaceChildren();
    if (!ui.native) {
        stopAutoCollapseTimer();
        content.append(text('p', '当前页面还未找到 Chat Completion 预设选择器。请打开 API 连接设置并选择 Chat Completion。', 'pg-muted'));
        return;
    }
    const names = allNames().filter(name => normalized(name).includes(normalized(ui.query)));
    const all = allNames();
    const summary = text('div', '', 'pg-summary');
    summary.append(text('div', `共 ${all.length} 个预设 · ${ui.data.groups.length} 个分组`, 'pg-summary-count'));
    const statusRow = text('div', '', 'pg-summary-status-row');
    const currentName = ui.activeName || '无';
    const current = text('div', `当前预设：${currentName}`, 'pg-summary-current');
    current.title = `当前预设：${currentName}`;
    statusRow.append(current);

    if (['all', 'groups'].includes(ui.tab)) {
        const actions = text('div', '', 'pg-toolbar-actions');
        actions.append(htmlButton(ui.sortMode ? '完成' : '排序', () => {
            ui.sortMode = !ui.sortMode; renderPanelContent();
        }, `pg-sort-toggle${ui.sortMode ? ' is-active' : ''}`));
        actions.append(htmlButton('全部展开', () => setAllGroupsExpanded(true), 'pg-toolbar-small-btn'));
        actions.append(htmlButton('全部收起', () => setAllGroupsExpanded(false), 'pg-toolbar-small-btn'));
        if (ui.sortMode) actions.append(htmlButton('恢复默认', () => {
            ui.data.groupOrder = []; ui.data.presetOrder = {}; ui.sortMode = false; save(); refreshAll();
        }, 'pg-toolbar-small-btn pg-reset-sort'));
        statusRow.append(actions);
    }
    summary.append(statusRow);
    content.append(summary);

    if (ui.tab === 'fav') {
        const favorites = names.filter(name => ui.data.favorites.includes(name)).sort(collator.compare);
        if (!favorites.length) content.append(text('p', '没有符合条件的收藏预设。', 'pg-empty'));
        for (const name of favorites) content.append(makePresetRow(name));
    } else if (ui.tab === 'groups') {
        const intro = text('div', '', 'pg-category-toolbar');
        intro.append(text('p', '在这里创建自己的分组，或把预设加入已有分组。自动识别不确定的匹配会放在「待确认」中。', 'pg-category-help'));
        intro.append(htmlButton('重新识别自动分类', () => reclassifyAutomaticGroups(false), 'pg-reclassify-btn'));
        content.append(intro);
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
            content.append(text('p', '相似度达到40%且至少有两个连续相同字符时列入候选；达到80%且候选唯一时才自动归组。未标记的末尾数字会额外尝试剥离，因此这类匹配需要人工确认。', 'pg-category-note'));
            for (const match of pending) {
                const card = text('div', '', 'pg-pending-match');
                const other = match.groupId ? (ui.data.groups.find(group => group.id === match.groupId)?.anchor || match.otherName) : match.otherName;
                card.append(text('div', `${match.name}  ↔  ${other}`, 'pg-pending-title'));
                const evidence = match.common ? `连续相同「${match.common}」 · ` : '';
                const suffixNote = match.usedAmbiguousSuffix ? ' · 比较时尝试忽略末尾数字' : '';
                card.append(text('small', `${evidence}名称相似度 ${(match.score * 100).toFixed(1).replace(/\.0$/, '')}%${suffixNote}`, 'pg-pending-score'));
                const actions = text('div', '', 'pg-pending-actions');
                actions.append(htmlButton('合并为同系列', () => acceptPendingMatch(match.id), 'pg-primary'));
                actions.append(htmlButton('不是同系列', () => ignorePendingMatch(match.id), 'pg-text-btn'));
                card.append(actions); content.append(card);
            }
        }
        for (const [type, title, description] of [
            ['manual','我的分组','自己创建，可添加任意预设'],
            ['auto','自动识别的系列','80%以上且候选唯一时自动归组；40%–79%进入待确认']
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
    if (!applyPendingPanelFocus(content)) restorePanelScroll(content, anchor);
    if (['all', 'groups'].includes(ui.tab)) resetAutoCollapseTimer();
    else stopAutoCollapseTimer();
}
function clearFloatingTuckTimer() {
    if (ui.floatingTuckTimer) clearTimeout(ui.floatingTuckTimer);
    ui.floatingTuckTimer = null;
}
function untuckFloating() {
    clearFloatingTuckTimer();
    ui.floating?.classList.remove('pg-floating-tucked-left', 'pg-floating-tucked-right');
}
function tuckFloating() {
    if (!ui.floating || !ui.data.floatingSide) return;
    ui.floating.classList.remove('pg-floating-tucked-left', 'pg-floating-tucked-right');
    ui.floating.classList.add(ui.data.floatingSide === 'left' ? 'pg-floating-tucked-left' : 'pg-floating-tucked-right');
}
function scheduleFloatingTuck() {
    clearFloatingTuckTimer();
    if (!ui.floating || !ui.data.floatingSide) return;
    ui.floatingTuckTimer = setTimeout(() => {
        ui.floatingTuckTimer = null;
        if (!ui.panelOpen) tuckFloating();
    }, 1000);
}
function clampFloatingTop(top, height) {
    return Math.max(4, Math.min(Math.max(4, window.innerHeight - height - 4), top));
}
function clampFloatingLeft(left, width) {
    return Math.max(4, Math.min(Math.max(4, window.innerWidth - width - 4), left));
}
function mountFloating() {
    if (!ui.data?.floatingEnabled) {
        clearFloatingTuckTimer();
        if (ui.floatingResizeHandler) {
            window.removeEventListener('resize', ui.floatingResizeHandler);
            ui.floatingResizeHandler = null;
        }
        ui.floating?.remove();
        ui.floating = null;
        return;
    }
    if (ui.floating?.isConnected) { applyTheme(); return; }

    const ball = htmlButton('预', () => {}, 'pg-floating-button');
    ball.id = 'pg-floating';
    ball.title = '打开预设分组';
    ball.setAttribute('aria-label', '打开预设分组');

    let pointer = null, startX = 0, startY = 0, originLeft = 0, originTop = 0;
    let originSide = null, moved = false;

    ball.addEventListener('click', event => {
        if (ball.dataset.suppressClick === '1') {
            delete ball.dataset.suppressClick;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const isTucked = ball.classList.contains('pg-floating-tucked-left') ||
            ball.classList.contains('pg-floating-tucked-right');
        if (isTucked) openPanel();
        else togglePanel();
    });

    ball.addEventListener('pointerdown', event => {
        if (event.button !== 0 || pointer !== null) return;
        clearFloatingTuckTimer();
        pointer = event.pointerId;
        moved = false;
        originSide = ui.data.floatingSide;
        const rect = ball.getBoundingClientRect();
        originLeft = Number.isFinite(ui.data.floatingPosition?.left)
            ? ui.data.floatingPosition.left : rect.left;
        originTop = Number.isFinite(ui.data.floatingPosition?.top)
            ? ui.data.floatingPosition.top : rect.top;
        startX = event.clientX;
        startY = event.clientY;
        try { ball.setPointerCapture(pointer); } catch {}
        // Keep a tucked ball tucked on pointerdown. A tap must reach click;
        // only a real drag expands it, preventing the former two-tap behavior.
    });

    ball.addEventListener('pointermove', event => {
        if (event.pointerId !== pointer) return;
        const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (!moved && distance < 7) return;
        if (!moved) {
            moved = true;
            ball.classList.remove('pg-floating-tucked-left', 'pg-floating-tucked-right');
            ball.classList.add('pg-floating-dragging');
        }
        const left = clampFloatingLeft(originLeft + event.clientX - startX, ball.offsetWidth);
        const top = clampFloatingTop(originTop + event.clientY - startY, ball.offsetHeight);
        ball.style.left = `${left}px`;
        ball.style.top = `${top}px`;
        ball.style.right = 'auto';
        ball.style.bottom = 'auto';
        event.preventDefault();
    });

    const finish = (event, cancelled = false) => {
        if (pointer === null || (event?.pointerId !== undefined && event.pointerId !== pointer)) return;
        const wasMoved = moved;
        pointer = null;
        ball.classList.remove('pg-floating-dragging');

        if (wasMoved && !cancelled) {
            const rect = ball.getBoundingClientRect();
            const leftGap = Math.max(0, rect.left);
            const rightGap = Math.max(0, window.innerWidth - rect.right);
            const side = leftGap <= rightGap ? 'left' : 'right';
            const left = side === 'left' ? 4 : window.innerWidth - ball.offsetWidth - 4;
            const top = clampFloatingTop(rect.top, ball.offsetHeight);

            ball.style.left = `${left}px`;
            ball.style.top = `${top}px`;
            ball.style.right = 'auto';
            ball.style.bottom = 'auto';
            ui.data.floatingSide = side;
            ui.data.floatingPosition = { left, top };
            tuckFloating();
            ball.dataset.suppressClick = '1';
            save();
        } else if (wasMoved && cancelled) {
            ball.style.left = `${originLeft}px`;
            ball.style.top = `${originTop}px`;
            ball.style.right = 'auto';
            ball.style.bottom = 'auto';
            ui.data.floatingSide = originSide;
            if (originSide) tuckFloating();
            else ball.classList.remove('pg-floating-tucked-left', 'pg-floating-tucked-right');
        }
        moved = false;
    };

    ball.addEventListener('pointerup', event => finish(event, false));
    ball.addEventListener('pointercancel', event => finish(event, true));
    ball.addEventListener('lostpointercapture', event => finish(event, true));

    document.body.append(ball);
    ui.floating = ball;

    const saved = ui.data.floatingPosition;
    let left, top;
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        left = clampFloatingLeft(saved.left, ball.offsetWidth);
        top = clampFloatingTop(saved.top, ball.offsetHeight);
    } else {
        // First install: use the old bottom-right default, then tuck it to the edge.
        left = window.innerWidth - ball.offsetWidth - 4;
        top = clampFloatingTop(window.innerHeight - ball.offsetHeight - 108, ball.offsetHeight);
    }

    let side = ['left', 'right'].includes(ui.data.floatingSide) ? ui.data.floatingSide : null;
    if (!side) {
        const leftGap = left;
        const rightGap = window.innerWidth - (left + ball.offsetWidth);
        if (!saved || Math.min(leftGap, rightGap) <= 72) {
            side = leftGap <= rightGap ? 'left' : 'right';
        }
    }
    if (side === 'left') left = 4;
    if (side === 'right') left = window.innerWidth - ball.offsetWidth - 4;

    ball.style.left = `${left}px`;
    ball.style.top = `${top}px`;
    ball.style.right = 'auto';
    ball.style.bottom = 'auto';
    ui.data.floatingSide = side;
    ui.data.floatingPosition = { left, top };
    if (side) tuckFloating();
    save();

    ui.floatingResizeHandler = () => {
        if (!ui.floating?.isConnected || pointer !== null) return;
        const rect = ball.getBoundingClientRect();
        const savedTop = Number.isFinite(ui.data.floatingPosition?.top)
            ? ui.data.floatingPosition.top : rect.top;
        const nextTop = clampFloatingTop(savedTop, ball.offsetHeight);
        let nextLeft;
        if (ui.data.floatingSide === 'left') nextLeft = 4;
        else if (ui.data.floatingSide === 'right') nextLeft = window.innerWidth - ball.offsetWidth - 4;
        else nextLeft = clampFloatingLeft(rect.left, ball.offsetWidth);
        ball.style.left = `${nextLeft}px`;
        ball.style.top = `${nextTop}px`;
        ui.data.floatingPosition = { left: nextLeft, top: nextTop };
        save();
        if (ui.data.floatingSide && !ui.panelOpen) tuckFloating();
    };
    window.addEventListener('resize', ui.floatingResizeHandler, { passive: true });
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
        checkbox.addEventListener('change', () => {
            ui.data.floatingEnabled = checkbox.checked;
            ui.data.floatingEnabledUserSet = true;
            save(); mountFloating();
        });
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
    if (ui.native) {
        if (ui.needsClassificationRebuild) reclassifyAutomaticGroups(true);
        else inferGroups();
    }
    syncImportedPresets(true);
    if (ui.needsCollapseReset) applyCollapsedDefaults();
    mountFloating(); applyTheme();
    const { eventSource, event_types } = ui.ctx;
    if (eventSource && event_types) {
        if (event_types.PRESET_CHANGED) eventSource.on(event_types.PRESET_CHANGED, onPresetChanged);
        if (event_types.MAIN_API_CHANGED) eventSource.on(event_types.MAIN_API_CHANGED, queueRefresh);
        if (event_types.PRESET_DELETED) eventSource.on(event_types.PRESET_DELETED, queueRefresh);
    }
    setInterval(() => {
        mountMenu();
        if (!ui.native?.isConnected) mountNative();
        if (ui.native) {
            if (ui.needsClassificationRebuild) reclassifyAutomaticGroups(true);
            const names = allNames();
            const missing = names.some(n => !Object.prototype.hasOwnProperty.call(ui.data.memberships, n));
            if (missing) inferGroups();
            const imported = syncImportedPresets();
            if (missing || imported) refreshAll();
            const value = String(ui.native.value);
            if (value !== ui.activeValue && !ui.busy && !ui.confirmOpen) {
                syncActive(); refreshAll();
            }
        }
    }, 2200);
    console.info('[预设分组] v0.2.8 已加载');
}
// ST's startup has finished by the time most third-party entrypoints run.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
else void init();