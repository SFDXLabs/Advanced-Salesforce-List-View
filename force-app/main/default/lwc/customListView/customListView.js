import { LightningElement, api, track, wire } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import {
  getObjectInfo,
  getPicklistValuesByRecordType,
} from "lightning/uiObjectInfoApi";
import getRecords from "@salesforce/apex/CustomListViewController.getRecords";
import getRecordCount from "@salesforce/apex/CustomListViewController.getRecordCount";

export default class CustomListView extends LightningElement {
  @api objectApiName = "Account";
  @api componentTitle = "";
  @api iconName = "standard:list_view";
  @api backgroundColor = "#FFFFFF";
  @api fieldsToDisplay = "Name,Type,Industry";
  @api whereClause = "";
  @api recordsPerPage = 25;
  @api showSearch = false;
  @api showRowNumbers = false;
  @api sortableFields = "";
  @api filterFields = "";

  @track records = [];
  @track columns = [];
  @track isLoading = false;
  @track error = null;
  @track searchTerm = "";

  @track currentPage = 1;
  @track totalRecords = 0;
  @track totalPages = 1;

  @track sortedBy = null;
  @track sortedDirection = "asc";
  _sortableSet = new Set();

  @track showFilterPanel = false;
  // filterOptions now stores both picklist and date/datetime configs
  // shape: { [api]: { kind: 'picklist'|'date'|'datetime', options?, label? } }
  filterOptions = {};
  // For picklists (existing): { [api]: Set(values) }
  selectedFilters = {};
  // For date/datetime fields: { [api]: { mode, date, start, end, dateTimeStart, dateTimeEnd } }
  dateFilterState = {};

  _objectInfo;
  recordTypeId;
  _picklistsByRt = null;

  _searchTimeout;
  _applyTimeout;

  // Caches to avoid unnecessary work
  _lastEffectiveWhere = null;
  _lastPageSize = null;

  // UI options for modes (used in HTML)
  get dateModeOptions() {
    return [
      { label: "On", value: "on" },
      { label: "Between", value: "between" },
    ];
  }
  get dateTimeModeOptions() {
    return [
      { label: "On (calendar day)", value: "on" },
      { label: "Between", value: "between" },
    ];
  }

  // Disable Apply if any date/datetime "between" has only one side filled or invalid range
  get applyDisabled() {
    // Validate date/datetime ranges
    for (const api of Object.keys(this.dateFilterState || {})) {
      const st = this.dateFilterState[api];
      if (!st) continue;

      if (st.mode === "between") {
        // Date
        if (st.start || st.end) {
          if (!st.start || !st.end) return true;
          if (st.start > st.end) return true;
        }
        // DateTime
        if (st.dateTimeStart || st.dateTimeEnd) {
          if (!st.dateTimeStart || !st.dateTimeEnd) return true;
          // Compare by Date objects
          const a = new Date(st.dateTimeStart);
          const b = new Date(st.dateTimeEnd);
          if (isNaN(a.getTime()) || isNaN(b.getTime())) return true;
          if (a.getTime() > b.getTime()) return true;
        }
      }
    }
    return false;
  }

  get displayTitle() {
    return this.componentTitle || `${this.objectApiName} Records`;
  }
  get displayIcon() {
    return this.iconName || "standard:list_view";
  }
  get hasRecords() {
    return this.records && this.records.length > 0;
  }
  get showPagination() {
    return this.totalPages > 1;
  }
  get isPreviousDisabled() {
    return this.currentPage <= 1;
  }
  get isNextDisabled() {
    return this.currentPage >= this.totalPages;
  }
  get paginationInfo() {
    const startRecord = (this.currentPage - 1) * this.recordsPerPage + 1;
    const endRecord = Math.min(
      this.currentPage * this.recordsPerPage,
      this.totalRecords
    );
    return `${startRecord}-${endRecord} of ${this.totalRecords}`;
  }
  get datatableProps() {
    return {
      keyField: "Id",
      data: this.records,
      columns: this.columns,
      hideCheckboxColumn: true,
      showRowNumberColumn: this.showRowNumbers,
      resizeColumnDisabled: false,
      wrapTextMaxLines: 2,
      sortedBy: this.sortedBy || undefined,
      sortedDirection: this.sortedDirection,
    };
  }
  get hasFilterableFields() {
    return Object.keys(this.filterOptions).length > 0;
  }
  get filtersDisabled() {
    return !this._objectInfo || (!this._picklistsByRt && !this.hasFilterableFields);
  }
  get showPageSize() {
    return true;
  }
  get pageSizeOptions() {
    return [
      { label: "10", value: 10 },
      { label: "25", value: 25 },
      { label: "50", value: 50 },
      { label: "100", value: 100 },
    ];
  }

  get filterFieldList() {
    // returns a normalized list including type-specific helpers for the template
    const list = [];
    for (const api of Object.keys(this.filterOptions)) {
      const cfg = this.filterOptions[api];
      const fi = this._objectInfo.fields[api];
      const label = fi?.label || this.formatFieldName(api);

      if (cfg.kind === "picklist") {
        list.push({
          apiName: api,
          label,
          kindIsPicklist: true,
          options: cfg.options,
          selectedValues: Array.from(this.selectedFilters[api] || []),
        });
      } else if (cfg.kind === "date") {
        const st = this.dateFilterState[api] || {};
        list.push({
          apiName: api,
          label,
          kindIsDate: true,
          state: {
            ...st,
            modeIsOn: st.mode === "on",
            modeIsBetween: st.mode === "between",
          },
        });
      } else if (cfg.kind === "datetime") {
        const st = this.dateFilterState[api] || {};
        list.push({
          apiName: api,
          label,
          kindIsDateTime: true,
          state: {
            ...st,
            modeIsOn: st.mode === "on",
            modeIsBetween: st.mode === "between",
          },
        });
      }
    }
    return list;
  }

  @wire(getObjectInfo, { objectApiName: "$objectApiName" })
  wiredObjectInfo({ error, data }) {
    if (data) {
      this._objectInfo = data;
      this.recordTypeId = data.defaultRecordTypeId;
      this._initSortableSet();
      this.setupColumns();
    } else if (error) {
      this.handleError("Failed to load object information", error);
    }
  }

  @wire(getPicklistValuesByRecordType, {
    objectApiName: "$objectApiName",
    recordTypeId: "$recordTypeId",
  })
  wiredPicklists({ error, data }) {
    if (data) {
      this._picklistsByRt = data;
    } else {
      this._picklistsByRt = null;
    }
    if (this._objectInfo) {
      this._initFilterOptions();
      this.loadRecords();
    }
  }

  renderedCallback() {
    this.applyIconStyling();
  }

  applyIconStyling() {
    const iconContainer = this.template.querySelector(".custom-icon-container");
    if (iconContainer && this.displayIcon) {
      const iconType = this.displayIcon.split(":")[0];
      let bgColor = "#706e6b";
      switch (iconType) {
        case "standard":
          bgColor = "#5867E8";
          break;
        case "utility":
          bgColor = "#706e6b";
          break;
        case "custom":
          bgColor = "#E27058";
          break;
        case "action":
          bgColor = "#54698D";
          break;
        default:
          bgColor = "#706e6b";
      }
      iconContainer.style.setProperty("--icon-bg-color", bgColor);
      iconContainer.style.backgroundColor = bgColor;
    }
  }

  _initSortableSet() {
    const fieldsList = (this.fieldsToDisplay || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const sortableList = (this.sortableFields || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const allowed = new Set(fieldsList);
    this._sortableSet = new Set(sortableList.filter((f) => allowed.has(f)));

    if (this.sortedBy && !this._sortableSet.has(this.sortedBy)) {
      this.sortedBy = null;
      this.sortedDirection = "asc";
    }
  }

  _initFilterOptions() {
    this.filterOptions = {};
    this.selectedFilters = this.selectedFilters || {};
    this.dateFilterState = this.dateFilterState || {};

    const displaySet = new Set(
      (this.fieldsToDisplay || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );

    const configured = (this.filterFields || "")
      .split(",")
      .map((s) => s.trim())
      .filter((f) => f && displaySet.has(f));

    const byRt = this._picklistsByRt?.picklistFieldValues;
    const byObj = this._objectInfo?.picklistFieldValues;

    configured.forEach((api) => {
      const fi = this._objectInfo?.fields?.[api];
      if (!fi) return;

      // Picklist / MultiPicklist
      if (fi.dataType === "Picklist" || fi.dataType === "MultiselectPicklist") {
        const source = byRt?.[api]?.values || byObj?.[api]?.values || [];
        if (Array.isArray(source) && source.length > 0) {
          this.filterOptions[api] = {
            kind: "picklist",
            options: source.map((v) => ({ label: v.label, value: v.value })),
          };
          if (!this.selectedFilters[api]) this.selectedFilters[api] = new Set();
        }
        return;
      }

      // Date / DateTime
      if (fi.dataType === "Date" || fi.dataType === "DateTime") {
        this.filterOptions[api] = {
          kind: fi.dataType === "Date" ? "date" : "datetime",
          label: fi.label || this.formatFieldName(api),
        };
        if (!this.dateFilterState[api]) {
          this.dateFilterState[api] = {
            mode: "on", // 'on' | 'between'
            // for Date:
            date: "",
            start: "",
            end: "",
            // for DateTime:
            dateTimeStart: "",
            dateTimeEnd: "",
          };
        }
        return;
      }

      // Other data types are ignored for filter UI
    });
  }

  setupColumns() {
    if (!this._objectInfo || !this.fieldsToDisplay) return;

    const fieldList = this.fieldsToDisplay
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);

    this.columns = fieldList.map((fieldName) => {
      const fieldInfo = this._objectInfo.fields[fieldName];
      return {
        label: fieldInfo?.label || this.formatFieldName(fieldName),
        fieldName: fieldName,
        type: this.getColumnType(fieldInfo?.dataType),
        sortable: this._sortableSet.has(fieldName),
        wrapText: true,
        typeAttributes: this.getTypeAttributes(fieldInfo?.dataType, fieldName),
        cellAttributes: {
          alignment: this.getCellAlignment(fieldInfo?.dataType),
        },
      };
    });
  }

  formatFieldName(fieldName) {
    return fieldName
      .replace(/__c$/, "")
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (str) => str.toUpperCase())
      .trim();
  }

  getColumnType(dataType) {
    const typeMapping = {
      Currency: "currency",
      Date: "date-local",
      DateTime: "date",
      Email: "email",
      Phone: "phone",
      Url: "url",
      Percent: "percent",
      Boolean: "boolean",
      Double: "number",
      Integer: "number",
      Long: "number",
      Reference: "text",
    };
    return typeMapping[dataType] || "text";
  }

  getCellAlignment(dataType) {
    const rightAlign = ["Currency", "Double", "Integer", "Long", "Percent"];
    const centerAlign = ["Boolean", "Date", "DateTime"];
    if (rightAlign.includes(dataType)) return "right";
    if (centerAlign.includes(dataType)) return "center";
    return "left";
  }

  getTypeAttributes(dataType) {
    switch (dataType) {
      case "Currency":
        return {
          currencyCode: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        };
      case "Percent":
        return { minimumFractionDigits: 0, maximumFractionDigits: 1 };
      case "Date":
        return { year: "numeric", month: "short", day: "2-digit" };
      case "DateTime":
        return {
          year: "numeric",
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        };
      case "Double":
      case "Integer":
      case "Long":
        return { minimumFractionDigits: 0, maximumFractionDigits: 2 };
      default:
        return undefined;
    }
  }

  _buildOrderBy() {
    if (this.sortedBy && this._sortableSet.has(this.sortedBy)) {
      const dir =
        this.sortedDirection?.toUpperCase() === "DESC" ? "DESC" : "ASC";
      return `${this.sortedBy} ${dir}`;
    }
    return "CreatedDate DESC";
  }

  buildFilterClause() {
    if (!this._objectInfo) return "";

    const parts = [];

    // Picklist filters
    for (const api of Object.keys(this.selectedFilters)) {
      const set = this.selectedFilters[api];
      if (!set || set.size === 0) continue;

      const fi = this._objectInfo.fields[api];
      if (!fi) continue;
      if (fi.dataType !== "Picklist" && fi.dataType !== "MultiselectPicklist") {
        continue;
      }

      const values = Array.from(set).map((v) => `'${v.replace(/'/g, "\\'")}'`);
      if (fi.dataType === "MultiselectPicklist") {
        parts.push(`INCLUDES(${api}, (${values.join(", ")}))`);
      } else {
        parts.push(`${api} IN (${values.join(", ")})`);
      }
    }

    // Date / DateTime filters
    if (this.dateFilterState) {
      for (const api of Object.keys(this.dateFilterState)) {
        const fi = this._objectInfo.fields[api];
        if (!fi) continue;

        const kind = fi.dataType; // 'Date' or 'DateTime'
        const st = this.dateFilterState[api];
        if (!st) continue;

        if (kind === "Date") {
          if (st.mode === "on" && st.date) {
            parts.push(`${api} = ${this._soqlDate(st.date)}`);
          } else if (st.mode === "between" && st.start && st.end) {
            const start =
              st.start <= st.end ? st.start : st.end; // normalize
            const end = st.end >= st.start ? st.end : st.start;
            parts.push(
              `(${api} >= ${this._soqlDate(start)} AND ${api} <= ${this._soqlDate(end)})`
            );
          }
        } else if (kind === "DateTime") {
          if (st.mode === "on" && st.date) {
            const start = this._startOfLocalDayISO(st.date);
            const end = this._endOfLocalDayISO(st.date);
            parts.push(
              `(${api} >= ${this._soqlDateTime(start)} AND ${api} <= ${this._soqlDateTime(end)})`
            );
          } else if (st.mode === "between" && st.dateTimeStart && st.dateTimeEnd) {
            const a = new Date(st.dateTimeStart);
            const b = new Date(st.dateTimeEnd);
            const startISO = (a <= b ? a : b).toISOString();
            const endISO = (b >= a ? b : a).toISOString();
            parts.push(
              `(${api} >= ${this._soqlDateTime(startISO)} AND ${api} <= ${this._soqlDateTime(endISO)})`
            );
          }
        }
      }
    }

    return parts.join(" AND ");
  }

  _normalizeWhere(where) {
    return (where || "")
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .trim();
  }

  async loadRecords() {
    this.isLoading = true;
    this.error = null;

    try {
      // Build effective WHERE
      let whereClause = this.whereClause || "";

      if (this.searchTerm && this.showSearch) {
        const searchClause = this.buildSearchClause();
        if (searchClause) {
          whereClause = whereClause
            ? `(${whereClause}) AND (${searchClause})`
            : searchClause;
        }
      }

      const filterClause = this.buildFilterClause();
      if (filterClause) {
        whereClause = whereClause
          ? `(${whereClause}) AND (${filterClause})`
          : filterClause;
      }

      const effectiveWhere = this._normalizeWhere(whereClause);
      const pageSizeChanged = this._lastPageSize !== this.recordsPerPage;
      const whereChanged = effectiveWhere !== this._lastEffectiveWhere;

      // Decide whether to refresh count
      const needCount = whereChanged || pageSizeChanged;

      // Adjust current page if filters/search changed
      if (whereChanged) {
        this.currentPage = 1;
      }

      const offset = Math.max(0, (this.currentPage - 1) * this.recordsPerPage);
      const orderBy = this._buildOrderBy();

      if (needCount) {
        const [countVal, recs] = await Promise.all([
          getRecordCount({
            objectName: this.objectApiName,
            whereClause: effectiveWhere,
          }),
          getRecords({
            objectName: this.objectApiName,
            fields: this.fieldsToDisplay,
            whereClause: effectiveWhere,
            limitClause: this.recordsPerPage,
            offsetClause: offset,
            orderBy,
          }),
        ]);
        this.totalRecords = countVal || 0;
        this.totalPages = Math.max(
          1,
          Math.ceil(this.totalRecords / this.recordsPerPage)
        );
        if (this.currentPage > this.totalPages) {
          this.currentPage = 1;
          const offset2 = 0;
          this.records =
            (await getRecords({
              objectName: this.objectApiName,
              fields: this.fieldsToDisplay,
              whereClause: effectiveWhere,
              limitClause: this.recordsPerPage,
              offsetClause: offset2,
              orderBy,
            })) || [];
        } else {
          this.records = recs || [];
        }
      } else {
        this.records =
          (await getRecords({
            objectName: this.objectApiName,
            fields: this.fieldsToDisplay,
            whereClause: effectiveWhere,
            limitClause: this.recordsPerPage,
            offsetClause: offset,
            orderBy,
          })) || [];
      }

      // Update caches
      this._lastEffectiveWhere = effectiveWhere;
      this._lastPageSize = this.recordsPerPage;
    } catch (error) {
      this.handleError("Failed to load records", error);
      this.records = [];
      this.totalRecords = 0;
      this.totalPages = 1;
      this.currentPage = 1;
      this._lastEffectiveWhere = null;
    } finally {
      this.isLoading = false;
    }
  }

  buildSearchClause() {
    if (!this.searchTerm?.trim() || !this._objectInfo) return "";

    const fieldList = this.fieldsToDisplay
      .split(",")
      .map((field) => field.trim());
    const searchableFields = fieldList.filter((fieldName) => {
      const fieldInfo = this._objectInfo.fields[fieldName];
      return fieldInfo && this.isSearchableField(fieldInfo.dataType);
    });

    if (searchableFields.length === 0) return "";

    const escaped = this.searchTerm
      .trim()
      .replace(/'/g, "\\'")
      .replace(/%/g, "\\%");
    const conditions = searchableFields.map(
      (field) => `${field} LIKE '%${escaped}%'`
    );
    return conditions.join(" OR ");
  }

  isSearchableField(dataType) {
    return [
      "String",
      "TextArea",
      "LongTextArea",
      "Email",
      "Phone",
      "Url",
      "Picklist",
      "MultiselectPicklist",
    ].includes(dataType);
  }

  handleSort(event) {
    const { fieldName: sortedBy, sortDirection } = event.detail || {};
    if (!sortedBy || !this._sortableSet.has(sortedBy)) return;

    this.sortedBy = sortedBy;
    this.sortedDirection = sortDirection || "asc";
    this.currentPage = 1;
    this.loadRecords();
  }

  toggleFilterPanel() {
    this.showFilterPanel = !this.showFilterPanel;
  }

  handleFilterChange(event) {
    const api = event.target.name;
    const values = new Set(event.detail.value || []);
    this.selectedFilters[api] = values;
  }

  clearAllFilters() {
    // Picklists
    for (const api of Object.keys(this.selectedFilters)) {
      this.selectedFilters[api].clear();
    }
    // Dates/DateTimes
    if (this.dateFilterState) {
      for (const api of Object.keys(this.dateFilterState)) {
        this.dateFilterState[api] = {
          mode: "on",
          date: "",
          start: "",
          end: "",
          dateTimeStart: "",
          dateTimeEnd: "",
        };
      }
    }
  }

  applyFilters() {
    // Close immediately for better perceived speed
    this.showFilterPanel = false;

    // Small debounce to absorb rapid clicks
    clearTimeout(this._applyTimeout);
    this._applyTimeout = setTimeout(() => {
      // When filters change, force a re-count by resetting the where cache
      this._lastEffectiveWhere = null;
      this.currentPage = 1;
      this.loadRecords();
    }, 250);
  }

  handleDateFilterModeChange(event) {
    const api = event.target.dataset.api;
    const mode = event.detail.value; // 'on' | 'between'
    if (!api) return;
    if (!this.dateFilterState[api]) {
      this.dateFilterState[api] = {
        mode: "on",
        date: "",
        start: "",
        end: "",
        dateTimeStart: "",
        dateTimeEnd: "",
      };
    }
    this.dateFilterState[api].mode = mode;
  }

  handleDateFilterChange(event) {
    const api = event.target.dataset.api;
    const name = event.target.name; // 'date','start','end','dateTimeStart','dateTimeEnd'
    const value = event.detail.value;
    if (!api || !name) return;
    if (!this.dateFilterState[api]) {
      this.dateFilterState[api] = {
        mode: "on",
        date: "",
        start: "",
        end: "",
        dateTimeStart: "",
        dateTimeEnd: "",
      };
    }
    this.dateFilterState[api][name] = value;
  }

  handleSearch(event) {
    this.searchTerm = event.target.value;
    this.currentPage = 1;
    this.debounceSearch();
  }

  debounceSearch() {
    clearTimeout(this._searchTimeout);
    this._searchTimeout = setTimeout(() => {
      // Force recount when search changes
      this._lastEffectiveWhere = null;
      this.loadRecords();
    }, 500);
  }

  handlePrevious() {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.loadRecords();
    }
  }
  handleNext() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.loadRecords();
    }
  }
  handleFirstPage() {
    if (this.currentPage !== 1) {
      this.currentPage = 1;
      this.loadRecords();
    }
  }
  handleLastPage() {
    if (this.currentPage !== this.totalPages) {
      this.currentPage = this.totalPages;
      this.loadRecords();
    }
  }

  handlePageKeydown(event) {
    if (event.key === "Enter") {
      this.handlePageChange(event);
    }
  }
  handlePageChange(event) {
    const val = Number(event.target.value);
    if (!Number.isFinite(val)) return;
    const page = Math.max(1, Math.min(this.totalPages, Math.trunc(val)));
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.loadRecords();
    } else {
      event.target.value = this.currentPage;
    }
  }
  handlePageSizeChange(event) {
    const size = Number(event.detail.value);
    if (!Number.isFinite(size) || size <= 0) return;
    this.recordsPerPage = size;
    this.currentPage = 1;
    // Force recount when page size changes
    this._lastEffectiveWhere = null;
    this.loadRecords();
  }

  handleRowAction(event) {
    const actionName = event.detail?.action?.name;
    const rowId = event.detail?.row?.Id;
    switch (actionName) {
      case "view":
        this.navigateToRecord(rowId);
        break;
      case "edit":
        this.editRecord(rowId);
        break;
      default:
        break;
    }
  }

  navigateToRecord(recordId) {
    this.dispatchEvent(
      new CustomEvent("recordview", {
        detail: { recordId },
      })
    );
  }

  editRecord(recordId) {
    this.dispatchEvent(
      new CustomEvent("recordedit", {
        detail: { recordId },
      })
    );
  }

  handleError(message, error) {
    // eslint-disable-next-line no-console
    console.error(message, error);
    const errorMessage =
      error?.body?.message || error?.message || "Unknown error occurred";
    this.error = `${message}: ${errorMessage}`;

    this.dispatchEvent(
      new ShowToastEvent({
        title: "Error",
        message: this.error,
        variant: "error",
        mode: "sticky",
      })
    );
  }

  @api
  refreshData() {
    this.handleRefresh();
  }

  @api
  clearSearch() {
    this.searchTerm = "";
    const searchInput = this.template.querySelector('input[type="search"]');
    if (searchInput) {
      searchInput.value = "";
    }
    this.currentPage = 1;
    // Force recount after clearing search
    this._lastEffectiveWhere = null;
    this.loadRecords();
  }

  handleRefresh() {
    this.currentPage = 1;
    // Force recount on manual refresh
    this._lastEffectiveWhere = null;
    this.loadRecords();
  }

  // ========= SOQL helpers for Date/DateTime formatting =========

  _soqlDate(yyyyMmDd) {
    // expects 'YYYY-MM-DD' for Date fields; SOQL accepts date literals without quotes
    if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) {
      return "NULL";
    }
    return `${yyyyMmDd}`;
  }

  _soqlDateTime(isoString) {
    // Accept a Date or ISO-like string; output 'YYYY-MM-DDTHH:mm:ssZ'
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "NULL";
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    const mm = pad(d.getUTCMonth() + 1);
    const dd = pad(d.getUTCDate());
    const hh = pad(d.getUTCHours());
    const mi = pad(d.getUTCMinutes());
    const ss = pad(d.getUTCSeconds());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
  }

  _startOfLocalDayISO(yyyyMmDd) {
    // 'YYYY-MM-DD' in local time at 00:00:00.000 -> ISO string
    const d = new Date(`${yyyyMmDd}T00:00:00`);
    return d.toISOString();
  }

  _endOfLocalDayISO(yyyyMmDd) {
    // 'YYYY-MM-DD' in local time at 23:59:59.999 -> ISO string
    const d = new Date(`${yyyyMmDd}T23:59:59.999`);
    return d.toISOString();
  }
}