import * as utils from './script_utilities.js';
import * as dbUtils from './script_db_helper.js';
import { initRecordModal } from './script_recordModal.js';
import { initMoveRecords } from './script_moveRecords.js';
import { initNav } from './script_nav.js';

//can't use env var on client-side js file, so make sure this is 'false' when checking in to GitHub
var debugLogging = false

// Page-level state
let gameId = null;
let gameNameFriendly = null;
let linkToGamePage = null;
let sectionGroupId = null;
let sectionGroupFriendlyName = null;
let showHidden = false;

/** Last painted checklist (section preference order); used to re-render when display toggles change without refetch. */
let checklistViewCache = {
    sections: [],
    recordsBySection: [],
    options: {},
};

// Template references (cached on load)
let sectionHeaderTemplate = null;
let sectionBodyTemplate = null;
let checklistItemTemplate = null;

$(document).ready(async function () {
    // Cache template references
    sectionHeaderTemplate = document.getElementById('section-header-template');
    sectionBodyTemplate = document.getElementById('section-body-template');
    checklistItemTemplate = document.getElementById('checklist-item-template');

    // Read query params — no 'var' so we set the module-level variables
    gameId = utils.getQueryParam('gameId');
    sectionGroupId = utils.getQueryParam('sectionGroupId');
    console.log('sectionGroupId: ' + sectionGroupId);

    // Fetch game data, section group data, and sections in parallel
    const [gameData, sectionGroupData, sections] = await Promise.all([
        dbUtils.getGameData(gameId),
        dbUtils.getSectionGroupById(sectionGroupId),
        dbUtils.getSectionsBySectionGroupId(sectionGroupId, showHidden)
    ]);

    gameNameFriendly = gameData.FriendlyName;
    linkToGamePage = '/game?id=' + gameId;
    console.log('sectionGroupData:', sectionGroupData);
    sectionGroupFriendlyName = sectionGroupData.FriendlyName;

    // Populate static page elements (these already exist in the HTML)
    document.title = gameNameFriendly + ' 100% Completion Checklist';
    document.getElementById('game-name').textContent = gameNameFriendly;
    document.getElementById('section-group-name').textContent = sectionGroupFriendlyName;
    const descriptionEl = document.getElementById('section-group-description');
    if (sectionGroupData.Description) {
        descriptionEl.textContent = sectionGroupData.Description;
    } else {
        descriptionEl.style.display = 'none';
    }

    // Initialize slide-out nav
    initNav({ currentPage: 'checklist', gameId, gameNameFriendly });

    // Fetch all section records in parallel
    const allRecordsBySection = await fetchAllRecords(sections, showHidden);
    paintChecklist(sections, allRecordsBySection, { startExpanded: false, filterValue: null });
    updateAllSectionsCompletion();
    updateTotalCompletion();

    // Event delegation for checkbox changes
    // https://chatgpt.com/share/67c0f24e-db90-8004-be01-0dec495fc388
    // This prevents multiple event bindings by using event delegation.
    // The event is attached to the parent element and delegated to the children.
    $('#grid-checklist-container').on('change', 'input.completion-checkbox', updateCompletion);

    // Event delegation for section header clicks (toggle collapse)
    // Ignore clicks on the add button
    $('#grid-checklist-container').on('click', '.section-header', function (e) {
        if ($(e.target).closest('.section-add-btn, .section-edit-desc-btn, .section-reorder-btn, .section-move-records-btn').length) return;
        $(this).next('.section').slideToggle(250);
        $(this).toggleClass('open');
    });

    // Event delegation for add-record button in section headers
    $('#grid-checklist-container').on('click', '.section-add-btn', function (e) {
        e.stopPropagation();
        const header = $(this).closest('.section-header');
        const sectionId = header.data('sectionId');
        const sectionName = header.find('.section-header-text').data('sectionTitle');
        window._recordModal.openForAdd(sectionId, sectionName);
    });

    // Event delegation for edit-record button on checklist items
    $('#grid-checklist-container').on('click', '.checklist-edit-btn', function (e) {
        e.stopPropagation();
        const recordId = $(this).closest('[data-record-id]').data('recordId');
        if (recordId) window._recordModal.openForEdit(recordId);
    });

    // --- REORDER SECTIONS ---
    document.getElementById('reorder-sections-btn').addEventListener('click', () => {
        window.location.href = `/reorder_sections?gameId=${gameId}&sectionGroupId=${sectionGroupId}`;
    });

    // --- REORDER RECORDS (per section) ---
    $('#grid-checklist-container').on('click', '.section-reorder-btn', function (e) {
        e.stopPropagation();
        const header = $(this).closest('.section-header');
        const sectionId = header.data('sectionId');
        window.location.href = `/reorder_records?gameId=${gameId}&sectionId=${sectionId}&sectionGroupId=${sectionGroupId}`;
    });

    // --- SECTION MODAL (add + edit) ---
    const sectionEditModalHTML = `
        <div id="section-edit-modal" class="modal hidden">
            <div class="modal-content">
                <span class="close-modal">&times;</span>
                <h3 id="section-edit-modal-title">Edit Section</h3>
                <form id="section-edit-form" class="add-record-container">
                    <label class="add-record hidden" id="section-single-name-row">Name:<input type="text" id="section-edit-name" class="add-record"></label>
                    <label class="add-record" id="section-multi-names-row">Name(s) (one per line):<textarea id="section-edit-names" class="add-record" rows="6" required></textarea></label>
                    <label class="add-record">Description:<textarea id="section-edit-description" class="add-record" rows="3" maxlength="250"></textarea></label>
                    <label class="add-record">List Order:<input type="number" id="section-edit-listorder" class="add-record" min="0" required></label>
                    <label class="modern-checkbox add-record">
                        <input type="checkbox" id="section-edit-hidden">
                        <span class="checkmark"></span>
                        Hidden
                    </label>
                    <div class="button-container">
                        <button type="submit" class="save-button">Save</button>
                        <button type="button" id="section-delete-btn" class="delete-button hidden">Delete Section</button>
                    </div>
                    <div id="section-modal-message" class="error-message hidden"></div>
                </form>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', sectionEditModalHTML);

    const sectionEditModal = document.getElementById('section-edit-modal');
    const sectionSingleNameRow = document.getElementById('section-single-name-row');
    const sectionMultiNamesRow = document.getElementById('section-multi-names-row');
    const sectionEditNameInput = document.getElementById('section-edit-name');
    const sectionEditNamesInput = document.getElementById('section-edit-names');

    function setSectionNameFieldsVisible(isAdd) {
        sectionSingleNameRow.classList.toggle('hidden', isAdd);
        sectionMultiNamesRow.classList.toggle('hidden', !isAdd);
        sectionEditNameInput.required = !isAdd;
        sectionEditNamesInput.required = isAdd;
    }
    const sectionDeleteButton = document.getElementById('section-delete-btn');
    const sectionModalMessage = document.getElementById('section-modal-message');
    let sectionInitialState = null;

    function captureSectionFormState() {
        return JSON.stringify([
            document.getElementById('section-edit-name').value,
            document.getElementById('section-edit-names').value,
            document.getElementById('section-edit-description').value,
            document.getElementById('section-edit-listorder').value,
            document.getElementById('section-edit-hidden').checked
        ]);
    }

    function sectionFormIsDirty() {
        return sectionInitialState !== null && captureSectionFormState() !== sectionInitialState;
    }

    function setSectionModalMessage(message) {
        if (!message) {
            sectionModalMessage.textContent = '';
            sectionModalMessage.classList.add('hidden');
            return;
        }
        sectionModalMessage.textContent = message;
        sectionModalMessage.classList.remove('hidden');
    }

    function closeSectionModal(force = false) {
        if (!force && sectionFormIsDirty()) {
            if (!confirm('You have unsaved changes. Discard them?')) return;
        }
        setSectionModalMessage('');
        sectionEditModal.classList.add('hidden');
        sectionInitialState = null;
    }

    sectionEditModal.querySelector('.close-modal').addEventListener('click', () => closeSectionModal());
    window.addEventListener('click', (e) => { if (e.target === sectionEditModal) closeSectionModal(); });

    let sectionModalMode = null;
    let editingSectionId = null;
    let editingSectionHeader = null;

    // Open for ADD
    document.getElementById('add-section-btn').addEventListener('click', async () => {
        sectionModalMode = 'add';
        editingSectionId = null;
        editingSectionHeader = null;

        const sections = await dbUtils.getSectionsBySectionGroupId(sectionGroupId, showHidden);
        const maxOrder = sections.reduce((max, s) => Math.max(max, s.ListOrder || 0), 0);

        document.getElementById('section-edit-modal-title').textContent = 'Add Section';
        setSectionNameFieldsVisible(true);
        document.getElementById('section-edit-name').value = '';
        document.getElementById('section-edit-names').value = '';
        document.getElementById('section-edit-description').value = '';
        document.getElementById('section-edit-listorder').value = maxOrder + 1;
        document.getElementById('section-edit-hidden').checked = false;
        sectionDeleteButton.classList.add('hidden');
        setSectionModalMessage('');
        sectionEditModal.classList.remove('hidden');
        sectionInitialState = captureSectionFormState();
    });

    // Open for EDIT
    $('#grid-checklist-container').on('click', '.section-edit-desc-btn', function (e) {
        e.stopPropagation();
        sectionModalMode = 'edit';
        const header = $(this).closest('.section-header');
        editingSectionId = header.data('sectionId');
        editingSectionHeader = header;

        document.getElementById('section-edit-modal-title').textContent = `Edit: ${header.data('sectionName')}`;
        setSectionNameFieldsVisible(false);
        document.getElementById('section-edit-name').value = header.data('sectionName') || '';
        document.getElementById('section-edit-names').value = '';
        document.getElementById('section-edit-description').value = header.data('sectionDescription') || '';
        document.getElementById('section-edit-listorder').value = header.data('sectionListOrder') || 0;
        document.getElementById('section-edit-hidden').checked = !!header.data('sectionHidden');
        sectionDeleteButton.classList.remove('hidden');
        setSectionModalMessage('');
        sectionEditModal.classList.remove('hidden');
        sectionInitialState = captureSectionFormState();
    });

    // Save (handles both add and edit)
    document.getElementById('section-edit-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        setSectionModalMessage('');

        const name = document.getElementById('section-edit-name').value.trim();
        const names = document.getElementById('section-edit-names').value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        const description = document.getElementById('section-edit-description').value.trim() || null;
        const listOrder = parseInt(document.getElementById('section-edit-listorder').value) || 0;
        const hidden = document.getElementById('section-edit-hidden').checked ? 1 : 0;

        if (sectionModalMode === 'add') {
            if (names.length === 0) {
                alert('Please enter at least one section name.');
                return;
            }
            await dbUtils.insertMultipleGameSections(
                names.map((sectionName) => ({
                    sectionName,
                    gameId,
                    listOrder,
                    recordOrderPreference: 'completed-order-name',
                    hidden,
                    sectionGroupId,
                    description
                }))
            );
        } else {
            await dbUtils.updateGameSection(editingSectionId, gameId, {
                sectionName: name || null,
                description,
                listOrder,
                recordOrderPreference: editingSectionHeader.data('sectionRecordOrderPreference'),
                hidden
            });
        }

        closeSectionModal(true);

        const freshSections = await dbUtils.getSectionsBySectionGroupId(sectionGroupId, showHidden);
        const allRecords = await fetchAllRecords(freshSections, showHidden);
        paintChecklist(freshSections, allRecords, { startExpanded: false, expandSectionId: editingSectionId });
        updateAllSectionsCompletion();
        updateTotalCompletion();
    });

    sectionDeleteButton.addEventListener('click', async () => {
        if (!editingSectionId) return;

        const [visibleRecords, hiddenRecords] = await Promise.all([
            dbUtils.getRecordsBySectionIdV2(
                editingSectionId,
                editingSectionHeader?.data('sectionRecordOrderPreference') || null,
                '0'
            ),
            dbUtils.getRecordsBySectionIdV2(
                editingSectionId,
                editingSectionHeader?.data('sectionRecordOrderPreference') || null,
                '1'
            )
        ]);
        if ((Array.isArray(visibleRecords) && visibleRecords.length > 0) ||
            (Array.isArray(hiddenRecords) && hiddenRecords.length > 0)) {
            setSectionModalMessage('This section has records and cannot be deleted.');
            return;
        }

        if (!confirm('Delete this section? This cannot be undone.')) return;

        const result = await dbUtils.deleteGameSection(editingSectionId, gameId);
        if (!result) {
            setSectionModalMessage('Failed to delete section.');
            return;
        }

        closeSectionModal(true);
        const freshSections = await dbUtils.getSectionsBySectionGroupId(sectionGroupId, showHidden);
        const allRecords = await fetchAllRecords(freshSections, showHidden);
        paintChecklist(freshSections, allRecords, { startExpanded: false });
        updateAllSectionsCompletion();
        updateTotalCompletion();
    });

    // --- DETAIL MODAL (shows description + long description on tap) ---
    const detailModalHTML = `
        <div id="detail-modal" class="modal hidden">
            <div class="modal-content detail-modal-content">
                <span class="close-modal">&times;</span>
                <h3 id="detail-modal-title"></h3>
                <div id="detail-modal-description" class="detail-section hidden">
                    <h4>Description</h4>
                    <p id="detail-modal-desc-text"></p>
                </div>
                <div id="detail-modal-long-description" class="detail-section hidden">
                    <h4>Long Description</h4>
                    <p id="detail-modal-longdesc-text"></p>
                </div>
                <p id="detail-modal-empty" class="detail-empty hidden">No description available.</p>
                <div class="button-container">
                    <button type="button" id="detail-modal-edit-btn" class="edit-button">Edit Record</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', detailModalHTML);

    const detailModal = document.getElementById('detail-modal');
    const detailModalEditButton = document.getElementById('detail-modal-edit-btn');
    let detailModalRecordId = null;
    detailModal.querySelector('.close-modal').addEventListener('click', () => detailModal.classList.add('hidden'));
    window.addEventListener('click', (e) => { if (e.target === detailModal) detailModal.classList.add('hidden'); });
    detailModalEditButton.addEventListener('click', () => {
        if (!detailModalRecordId) return;
        detailModal.classList.add('hidden');
        if (window._recordModal) {
            window._recordModal.openForEdit(detailModalRecordId);
        }
    });

    // Open detail modal when clicking on a label that has details
    $('#grid-checklist-container').on('click', '.label.has-details', function (e) {
        e.stopPropagation();
        const item = $(this).closest('[data-record-id]')[0];
        if (!item) return;
        detailModalRecordId = item.dataset.recordId || null;

        const name = this.textContent;
        const desc = item.dataset.description || '';
        const longDesc = item.dataset.longDescription || '';

        document.getElementById('detail-modal-title').textContent = name;

        const descSection = document.getElementById('detail-modal-description');
        const longDescSection = document.getElementById('detail-modal-long-description');
        const emptyMsg = document.getElementById('detail-modal-empty');

        if (desc) {
            document.getElementById('detail-modal-desc-text').textContent = desc;
            descSection.classList.remove('hidden');
        } else {
            descSection.classList.add('hidden');
        }

        if (longDesc) {
            document.getElementById('detail-modal-longdesc-text').textContent = longDesc;
            longDescSection.classList.remove('hidden');
        } else {
            longDescSection.classList.add('hidden');
        }

        emptyMsg.classList.toggle('hidden', !!(desc || longDesc));

        detailModal.classList.remove('hidden');
    });

    // --- FILTER AND TOGGLE LOGIC ---
    $('#container').on('input', '#filter-input', applyFilterAndRender);
    $('#container').on('change', '#show-hidden-toggle', async function () {
        showHidden = $(this).is(':checked');
        const currentFilter = $('#filter-input').val().toLowerCase();
        if (currentFilter) {
            await applyFilterAndRender();
            return;
        }
        const sections = await dbUtils.getSectionsBySectionGroupId(sectionGroupId, showHidden);
        const allRecordsBySection = await fetchAllRecords(sections, showHidden);
        paintChecklist(sections, allRecordsBySection, { startExpanded: false });
        updateAllSectionsCompletion();
        updateTotalCompletion();
    });
    function onChecklistDisplayOptionsChanged() {
        repaintChecklistFromCache();
        updateAllSectionsCompletion();
        updateTotalCompletion();
        applyHideCompletedToDOM();
        if ($('#expand-all-toggle').is(':checked')) {
            applyExpandAllToDOM();
        }
    }
    $('#container').on('change', '#sort-by-name-toggle', onChecklistDisplayOptionsChanged);
    $('#container').on('change', '#defer-complete-sections-toggle', onChecklistDisplayOptionsChanged);
    $('#container').on('change', '#hide-completed-toggle', applyHideCompletedToDOM);
    $('#container').on('change', '#expand-all-toggle', applyExpandAllToDOM);

    async function applyFilterAndRender() {
        const filterValue = $('#filter-input').val().toLowerCase();
        // Re-fetch sections and records
        const sections = await dbUtils.getSectionsBySectionGroupId(sectionGroupId, showHidden);
        const allRecordsBySection = await fetchAllRecords(sections, showHidden);

        // Filter records by name/description
        const filteredSections = [];
        const filteredRecordsBySection = [];
        sections.forEach((section, sectionIndex) => {
            let records = allRecordsBySection[sectionIndex] || [];
            let filteredRecords = !filterValue ? records : records.filter(record => {
                return (record.Name && record.Name.toLowerCase().includes(filterValue)) ||
                       (record.Description && record.Description.toLowerCase().includes(filterValue));
            });
            if (filteredRecords.length > 0) {
                filteredSections.push(section);
                filteredRecordsBySection.push(filteredRecords);
            }
        });

        // Expand matching sections only while a filter is active; clearing search collapses all.
        paintChecklist(filteredSections, filteredRecordsBySection, {
            startExpanded: !!filterValue,
            filterValue: filterValue || null,
        });
        updateAllSectionsCompletion();
        updateTotalCompletion();
        applyHideCompletedToDOM();
        if ($('#expand-all-toggle').is(':checked')) {
            applyExpandAllToDOM();
        }
    }

    // --- ADD/EDIT RECORD MODAL (shared module) ---
    const recordModal = initRecordModal({
        gameId,
        defaultAlreadyCompleted: 0,
        onSave: async (savedSectionId) => {
            await refreshChecklistAfterRecordChange(savedSectionId);
        },
        getRecordIdsForSection: (recordSectionId) => {
            const sectionIndex = checklistViewCache.sections.findIndex(
                (section) => String(section.ID) === String(recordSectionId)
            );
            if (sectionIndex < 0) return [];
            const displayRecords = recordsWithDisplayOrder(checklistViewCache.recordsBySection);
            return (displayRecords[sectionIndex] || []).map((record) => record.ID);
        },
    });

    // Wire up the + button in section headers
    window._recordModal = recordModal;

    async function refreshChecklistAfterRecordChange(expandSectionId = null) {
        const currentFilter = $('#filter-input').val().toLowerCase();
        if (currentFilter) {
            await applyFilterAndRender();
            return;
        }

        const sections = await dbUtils.getSectionsBySectionGroupId(sectionGroupId, showHidden);
        const allRecordsBySection = await fetchAllRecords(sections, showHidden);
        paintChecklist(sections, allRecordsBySection, {
            startExpanded: false,
            expandSectionId,
        });
        updateAllSectionsCompletion();
        updateTotalCompletion();
    }

    function findRecordInCache(recordId) {
        for (const arr of checklistViewCache.recordsBySection) {
            if (!Array.isArray(arr)) continue;
            for (const r of arr) {
                if (String(r.ID) === String(recordId)) return r;
            }
        }
        return null;
    }

    const moveRecords = initMoveRecords({
        gameId,
        getCurrentSectionGroupId: () => sectionGroupId,
        getShowHidden: () => showHidden,
        findRecordById: findRecordInCache,
        onMoved: () => refreshChecklistAfterRecordChange(),
    });
    moveRecords.bind(document.getElementById('grid-checklist-container'));
    window._moveRecords = moveRecords;
});


/*************************************** DATA FETCHING ***************************************/

function recordIsHidden(record) {
    return Number(record?.Hidden) === 1;
}

function sectionIsHidden(section) {
    return Number(section?.Hidden) === 1;
}

// Toggle off => non-hidden records only; toggle on => all records (visible + hidden) so hidden sections show their full content.
// Sections list still comes from getSectionsBySectionGroupId (merged visible + hidden sections when toggle on).
async function fetchAllRecords(sections, includeHidden = false) {
    const recordFilter = includeHidden ? 'all' : '0';
    const recordsPromises = sections.map(section =>
        dbUtils.getRecordsBySectionIdV2(section.ID, section.RecordOrderPreference || null, recordFilter)
            .catch(err => {
                console.error(`Failed to load records for section ${section.Name} (ID: ${section.ID})`, err);
                return [];
            })
    );
    const bySection = await Promise.all(recordsPromises);
    if (debugLogging || dbUtils.isAvDebugRecordsEnabled()) {
        let total = 0;
        let hidden1 = 0;
        bySection.forEach((recs) => {
            if (!Array.isArray(recs)) return;
            total += recs.length;
            hidden1 += recs.filter((r) => recordIsHidden(r)).length;
        });
        console.log('[AV_DEBUG_RECORDS] fetchAllRecords', {
            sectionCount: sections.length,
            recordApiHiddenFilter: recordFilter,
            totalRows: total,
            hiddenEq1: hidden1,
        });
    }
    return bySection;
}


/*************************************** RENDERING ***************************************/

function isSortByNameOverrideEnabled() {
    const el = document.getElementById('sort-by-name-toggle');
    return !!(el && el.checked);
}

/** Case-insensitive name order (matches record sort in this view). */
function localeCompareName(a, b) {
    return (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
}

function isDeferCompleteSectionsEnabled() {
    const el = document.getElementById('defer-complete-sections-toggle');
    return !!(el && el.checked);
}

function getHideCompleted() {
    // checked = show completed, unchecked = hide completed
    return !$('#hide-completed-toggle').is(':checked');
}

function applyHideCompletedToDOM() {
    const hideCompleted = getHideCompleted();
    $('.section').each(function () {
        $(this).find('.grid-item-1-row, .grid-item-2-row').each(function () {
            const checkboxes = $(this).find('input.completion-checkbox');
            const numTotal = checkboxes.length;
            const numChecked = checkboxes.filter(':checked').length;
            if (hideCompleted && numTotal > 0 && numTotal === numChecked) {
                $(this).hide();
            } else {
                $(this).show();
            }
        });
    });
}

function applyExpandAllToDOM() {
    const expandAll = $('#expand-all-toggle').is(':checked');
    $('.section').each(function () {
        if (expandAll) {
            $(this).slideDown(250);
            $(this).prev('.section-header').addClass('open');
        } else {
            $(this).slideUp(250);
            $(this).prev('.section-header').removeClass('open');
        }
    });
}

/** Section is 100% done when every record that has checkboxes is fully completed. */
function isSectionFullyComplete(records) {
    if (!Array.isArray(records) || records.length === 0) return false;
    let anyCheckboxes = false;
    for (const r of records) {
        const total = Number(r.NumberOfCheckboxes) || 0;
        if (total === 0) continue;
        anyCheckboxes = true;
        const done = Number(r.NumberAlreadyCompleted) || 0;
        if (done < total) return false;
    }
    return anyCheckboxes;
}

/** Single checklist row: all checkboxes satisfied (rows with 0 checkboxes count as not "completed" for ordering). */
function isRecordFullyComplete(record) {
    const total = Number(record.NumberOfCheckboxes) || 0;
    if (total === 0) return false;
    const done = Number(record.NumberAlreadyCompleted) || 0;
    return done >= total;
}

function patchRecordCompletionInCache(recordId, numberAlreadyCompleted) {
    if (recordId == null || recordId === '') return;
    const n = parseInt(numberAlreadyCompleted, 10);
    if (Number.isNaN(n)) return;
    for (const arr of checklistViewCache.recordsBySection) {
        if (!Array.isArray(arr)) continue;
        for (const r of arr) {
            if (String(r.ID) === String(recordId)) {
                r.NumberAlreadyCompleted = n;
                return;
            }
        }
    }
}

function shallowCloneRecordsBySection(recordsBySection) {
    return recordsBySection.map((arr) => (Array.isArray(arr) ? arr.slice() : []));
}

function recordsWithDisplayOrder(recordsBySection) {
    if (!isSortByNameOverrideEnabled()) return recordsBySection;
    return recordsBySection.map((arr) => {
        if (!Array.isArray(arr)) return [];
        return [...arr]
            .map((r, i) => ({ r, i }))
            .sort((a, b) => {
                const ca = isRecordFullyComplete(a.r);
                const cb = isRecordFullyComplete(b.r);
                if (ca !== cb) return ca ? 1 : -1;
                const byName = localeCompareName(a.r.Name, b.r.Name);
                if (byName !== 0) return byName;
                return a.i - b.i;
            })
            .map(({ r }) => r);
    });
}

/** Updates the view cache and paints (applies optional name-only sort for display). */
function paintChecklist(sections, allRecordsBySection, options = {}) {
    window._moveRecords?.exitMoveSelectMode();
    checklistViewCache.sections = sections;
    checklistViewCache.recordsBySection = shallowCloneRecordsBySection(allRecordsBySection);
    const { expandSectionIds: _omitExpand, ...persistOptions } = options;
    checklistViewCache.options = { ...persistOptions };
    const displayRecords = recordsWithDisplayOrder(checklistViewCache.recordsBySection);
    renderChecklist(sections, displayRecords, options);
}

function getExpandedSectionIdsFromDom() {
    return [...document.querySelectorAll('.section-header.open')]
        .map((el) => el.dataset.sectionId)
        .filter((id) => id != null && id !== '');
}

function repaintChecklistFromCache() {
    const { sections, recordsBySection, options } = checklistViewCache;
    if (!sections || !recordsBySection) return;
    const expandedIds = getExpandedSectionIdsFromDom();
    const displayRecords = recordsWithDisplayOrder(recordsBySection);
    const paintOptions = { ...options };
    if (expandedIds.length) {
        paintOptions.expandSectionIds = expandedIds;
    } else {
        delete paintOptions.expandSectionIds;
    }
    renderChecklist(sections, displayRecords, paintOptions);
}

// Single unified render function — replaces both processData() and renderFilteredChecklist()
function renderChecklist(sections, allRecordsBySection, options) {
    const { startExpanded = false, filterValue = null, expandSectionId = null, expandSectionIds = null } = options;
    const expandedIdSet =
        Array.isArray(expandSectionIds) && expandSectionIds.length > 0
            ? new Set(expandSectionIds.map((id) => String(id)))
            : null;
    const gridContainer = document.getElementById('grid-checklist-container');
    gridContainer.innerHTML = '';

    const fragment = document.createDocumentFragment();

    // cacheSectionIndex = index into checklistViewCache.sections / recordsBySection (stable).
    // data-section on DOM = visual row index (for checkboxes); they differ when sections are reordered.
    let renderPairs = sections.map((section, i) => ({
        section,
        records: allRecordsBySection[i] || [],
        cacheSectionIndex: i,
    }));
    // With "Show hidden", skip empty non-hidden sections; keep hidden sections even when they have no rows.
    if (showHidden) {
        renderPairs = renderPairs.filter((p) => p.records.length > 0 || sectionIsHidden(p.section));
    }

    const sortSectionsByName = isSortByNameOverrideEnabled();
    const deferCompleteSections = isDeferCompleteSectionsEnabled();
    if (sortSectionsByName || deferCompleteSections) {
        renderPairs = renderPairs
            .map((p, i) => ({ p, i }))
            .sort((a, b) => {
                if (deferCompleteSections) {
                    const ca = isSectionFullyComplete(a.p.records);
                    const cb = isSectionFullyComplete(b.p.records);
                    if (ca !== cb) return ca ? 1 : -1;
                }
                if (sortSectionsByName) {
                    const byName = localeCompareName(a.p.section.Name, b.p.section.Name);
                    if (byName !== 0) return byName;
                }
                return a.i - b.i;
            })
            .map(({ p }) => p);
    }

    renderPairs.forEach((pair, sectionIndex) => {
        const section = pair.section;
        const sectionTitle = section.Name;
        const sectionTitleClean = utils.createSlug(sectionTitle);

        // Clone and populate section header template
        const headerClone = sectionHeaderTemplate.content.cloneNode(true);
        const headerDiv = headerClone.querySelector('.section-header');
        if (sectionIsHidden(section)) {
            headerDiv.classList.add('section-header--hidden');
        }
        headerDiv.dataset.section = sectionIndex;
        headerDiv.dataset.cacheSectionIndex = String(pair.cacheSectionIndex);
        headerDiv.dataset.sectionId = section.ID;
        headerDiv.dataset.sectionDescription = section.Description || '';
        headerDiv.dataset.sectionListOrder = section.ListOrder;
        headerDiv.dataset.sectionRecordOrderPreference = section.RecordOrderPreference || '';
        headerDiv.dataset.sectionHidden = section.Hidden || 0;
        headerDiv.dataset.sectionName = section.Name || '';

        const headerText = headerClone.querySelector('.section-header-text');
        headerText.dataset.section = sectionIndex;
        headerText.dataset.cacheSectionIndex = String(pair.cacheSectionIndex);
        headerText.dataset.sectionTitle = sectionTitle;
        headerText.dataset.sectionTitleClean = sectionTitleClean;
        headerText.textContent = sectionTitle + ' (0%)';

        // Set open state based on whether sections start expanded or this specific section should expand
        const shouldExpand =
            startExpanded ||
            (expandSectionId != null && String(section.ID) === String(expandSectionId)) ||
            (expandedIdSet && expandedIdSet.has(String(section.ID)));
        if (shouldExpand) {
            headerDiv.classList.add('open');
        }
        if (isSectionFullyComplete(pair.records)) {
            headerDiv.classList.add('section-header--complete');
        }

        // Clone and populate section body template
        const bodyClone = sectionBodyTemplate.content.cloneNode(true);
        const bodyDiv = bodyClone.querySelector('.section');
        bodyDiv.dataset.section = sectionIndex;
        bodyDiv.dataset.sectionId = section.ID;
        bodyDiv.dataset.cacheSectionIndex = String(pair.cacheSectionIndex);
        bodyDiv.style.display = shouldExpand ? 'block' : 'none';

        // Populate with records
        const records = pair.records;
        if (records.length === 0) {
            const noRecords = document.createElement('div');
            noRecords.className = 'no-records';
            noRecords.textContent = 'No checklist items found for this section.';
            bodyDiv.appendChild(noRecords);
        } else {
            records.forEach((record, recordIndex) => {
                bodyDiv.appendChild(
                    createChecklistItem(record, recordIndex, sectionIndex, sectionTitleClean, filterValue)
                );
            });
        }

        fragment.appendChild(headerClone);
        fragment.appendChild(bodyClone);
    });

    gridContainer.appendChild(fragment);
    applyHideCompletedToDOM();
}


// Create a single checklist item by cloning the template
function createChecklistItem(record, recordIndex, sectionIndex, sectionTitleClean, filterValue) {
    const clone = checklistItemTemplate.content.cloneNode(true);

    const recordName = record.Name;
    const recordDescription = record.Description || '';
    const recordLongDescription = record.LongDescription || '';
    const totalCheckboxes = record.NumberOfCheckboxes || 0;
    const completedCheckboxes = record.NumberAlreadyCompleted || 0;
    const recordNameClean = utils.createSlug(recordName);

    const itemDiv = clone.querySelector('.checklist-item');
    itemDiv.className = 'grid-item-1-row checklist-item';
    itemDiv.dataset.recordId = record.ID;

    // Store descriptions as data attributes for the detail modal
    if (recordDescription) itemDiv.dataset.description = recordDescription;
    if (recordLongDescription) itemDiv.dataset.longDescription = recordLongDescription;

    // Populate label only (description is shown on tap via modal)
    const labelDiv = clone.querySelector('.label');
    const descDiv = clone.querySelector('.description');
    descDiv.remove(); // description no longer shown inline

    // Add a subtle indicator if the record has description content
    if (recordDescription || recordLongDescription) {
        labelDiv.classList.add('has-details');
    }

    if (filterValue) {
        const re = new RegExp(`(${filterValue.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
        labelDiv.innerHTML = recordName.replace(re, '<mark>$1</mark>');
    } else {
        labelDiv.textContent = recordName;
    }

    // Create checkbox elements
    const column2 = clone.querySelector('.column2');
    for (let i = 1; i <= totalCheckboxes; i++) {
        column2.appendChild(
            createCheckbox(sectionIndex, recordIndex, i, totalCheckboxes, i <= completedCheckboxes, sectionTitleClean, recordNameClean, record.ID)
        );
    }

    return clone;
}


// Create a single checkbox input element with all data attributes
function createCheckbox(sectionIndex, itemIndex, checkboxNumber, totalCheckboxes, isChecked, sectionTitleClean, itemNameClean, recordId) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';

    const checkboxName = createStorageItemName(gameId, sectionTitleClean, itemNameClean, checkboxNumber);
    checkbox.className = 'completion-checkbox checkbox-' + checkboxName;

    checkbox.dataset.section = sectionIndex;
    checkbox.dataset.item = itemIndex;
    checkbox.dataset.numCheckboxClicked = checkboxNumber;
    checkbox.dataset.numTotalCheckboxes = totalCheckboxes;
    checkbox.dataset.sectionTitleClean = sectionTitleClean;
    checkbox.dataset.itemNameClean = itemNameClean;
    checkbox.dataset.recordId = recordId;
    checkbox.checked = isChecked;

    return checkbox;
}


function createStorageItemName(gameName, sectionNameClean, itemNameClean, i) {
    return `${gameName}--checkbox--${sectionNameClean}--${itemNameClean}--${i}`;
}


/*************************************** CHECKBOX INTERACTION ***************************************/

function updateCompletion() {
    const sectionIndex = $(this).data('section');
    const itemIndex = $(this).data('item');
    const checkboxNum = $(this).data('numCheckboxClicked');
    const sectionTitleClean = $(this).data('sectionTitleClean');
    const itemNameClean = $(this).data('itemNameClean');
    const recordId = $(this).data('recordId');

    if (debugLogging) {
        console.log("updateCompletion called - sectionIndex " + sectionIndex + ". itemIndex " + itemIndex + ". checkboxNum " + checkboxNum +
            ". sectionTitleClean " + sectionTitleClean + ". itemNameClean " + itemNameClean + ". recordId " + recordId);
    }

    var sectionHeaderTextDiv = $(`span.section-header-text[data-section="${sectionIndex}"]`);
    const sectionTitle = sectionHeaderTextDiv.attr('data-section-title');
    if (debugLogging) console.log('sectionTitle: ' + sectionTitle);

    const checkboxItemName = $(this).closest('.grid-item-2-row, .grid-item-1-row').find('.label').text().trim();
    if (debugLogging) console.log("checkboxItemName:", checkboxItemName);

    const checkboxNumberClicked = $(this).attr('data-num-checkbox-clicked');
    const numberOfCheckboxes = $(this).attr('data-num-total-checkboxes');
    if (debugLogging) console.log('checkboxNumberClicked: ' + checkboxNumberClicked);
    if (debugLogging) console.log('numberOfCheckboxes: ' + numberOfCheckboxes);

    let action = '';
    const recordCheckboxes = $(this)
        .closest('.grid-item-2-row, .grid-item-1-row')
        .find('input.completion-checkbox');

    if ($(this).is(':checked')) {
        if (debugLogging) console.log('this item is checked. CheckboxNum: ' + checkboxNum);
        recordCheckboxes
            .filter(function () {
                return Number($(this).data('numCheckboxClicked')) <= Number(checkboxNum);
            })
            .prop('checked', true);
        action = 'added';
    } else {
        if (debugLogging) console.log('this item is not checked. CheckboxNum: ' + checkboxNum);
        recordCheckboxes
            .filter(function () {
                return Number($(this).data('numCheckboxClicked')) >= Number(checkboxNum);
            })
            .prop('checked', false);
        action = 'removed';
    }

    var numberAlreadyCompleted = "";

    if (action) {
        if (action === "added") {
            numberAlreadyCompleted = checkboxNumberClicked;
        }
        else {
            if (checkboxNumberClicked === 1) numberAlreadyCompleted = 0;
            else numberAlreadyCompleted = checkboxNumberClicked - 1;
        }
        dbUtils.updateRecordCompletion(recordId, numberAlreadyCompleted);
        patchRecordCompletionInCache(recordId, numberAlreadyCompleted);
    }

    if (isDeferCompleteSectionsEnabled()) {
        repaintChecklistFromCache();
        updateAllSectionsCompletion();
        updateTotalCompletion();
        applyHideCompletedToDOM();
        if ($('#expand-all-toggle').is(':checked')) {
            applyExpandAllToDOM();
        }
    } else {
        updateSectionCompletion(sectionIndex);
        updateTotalCompletion();
    }
}


/*************************************** COMPLETION TRACKING ***************************************/

function updateSectionCompletion(sectionIndex) {
    const sectionHeaderTextDiv = $(`span.section-header-text[data-section="${sectionIndex}"]`);
    const checkboxes = $(`input[data-section="${sectionIndex}"]`);
    const checkedCheckboxes = checkboxes.filter(':checked').length;
    const totalCheckboxes = checkboxes.length;
    const sectionCompletion = `${checkedCheckboxes}/${totalCheckboxes}`;

    const sectionTitle = sectionHeaderTextDiv.attr('data-section-title');

    let displayText = `${sectionTitle} (${sectionCompletion})`;
    if (totalCheckboxes > 0) {
        const sectionCompletionPercent = ((checkedCheckboxes / totalCheckboxes) * 100).toFixed(2);
        displayText += ` (${sectionCompletionPercent}%)`;
    }

    sectionHeaderTextDiv.text(displayText);

    // Update data attributes used in total completion
    const sectionHeaderDiv = $(`div.section-header[data-section="${sectionIndex}"]`);
    sectionHeaderDiv.attr("checked-checkboxes", checkedCheckboxes);
    sectionHeaderDiv.attr("total-checkboxes", totalCheckboxes);

    const cacheIdxAttr = sectionHeaderTextDiv.attr('data-cache-section-index');
    const cacheIdx =
        cacheIdxAttr !== undefined && cacheIdxAttr !== ''
            ? parseInt(cacheIdxAttr, 10)
            : sectionIndex;
    const recs = Number.isFinite(cacheIdx)
        ? checklistViewCache.recordsBySection?.[cacheIdx]
        : undefined;
    const fullyComplete = Array.isArray(recs) && isSectionFullyComplete(recs);
    sectionHeaderDiv.toggleClass('section-header--complete', fullyComplete);
}


function updateTotalCompletion() {
    try {
        if (debugLogging) console.log('updateTotalCompletion - made it here');
        let totalCompletionPercent = 0;
        var totalCompletionText = '';
        const sections = $('div.section-header');
        const totalSections = sections.length;
        if (debugLogging) console.log('updateTotalCompletion - totalSections ' + totalSections);

        var totalCheckedCheckboxes = 0;
        var totalCheckboxes = 0;
        sections.each(function () {
            var sectionCheckedCheckboxesInt = parseInt($(this).attr('checked-checkboxes'));
            var sectionTotalCheckboxesInt = parseInt($(this).attr('total-checkboxes'));
            if (debugLogging) console.log('sectionCheckedCheckboxesInt ' + sectionCheckedCheckboxesInt);
            if (debugLogging) console.log('sectionTotalCheckboxesInt ' + sectionTotalCheckboxesInt);

            totalCheckedCheckboxes = totalCheckedCheckboxes + sectionCheckedCheckboxesInt;
            totalCheckboxes = totalCheckboxes + sectionTotalCheckboxesInt;
            if (debugLogging) console.log('totalCheckedCheckboxes ' + totalCheckedCheckboxes);
            if (debugLogging) console.log('totalCheckboxes ' + totalCheckboxes);
        });
        totalCompletionText = totalCheckedCheckboxes + '/' + totalCheckboxes;
        if (totalCheckboxes === 0) {
            $('#total-completion').text(`Total Completion: (${totalCompletionText}) 0%`);
            return;
        }
        totalCompletionPercent = ((totalCheckedCheckboxes / totalCheckboxes) * 100).toFixed(2);
        $('#total-completion').text(`Total Completion: (${totalCompletionText}) ${totalCompletionPercent}%`);
    } catch (error) {
        console.error(error);
        $('#total-completion').text(`Total Completion: 0.00%`);
    }
}

function updateAllSectionsCompletion() {
    $('span.section-header-text').each(function () {
        const sectionIndex = $(this).data('section');
        updateSectionCompletion(sectionIndex);
    });
}
