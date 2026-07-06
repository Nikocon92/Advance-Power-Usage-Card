const CARD_TAG = "advance-power-usage-card";
const EDITOR_TAG = "advance-power-usage-card-editor";

const DEFAULT_COLOR_STOPS = [
  { position: 0, color: "#0085ff" },
  { position: 40, color: "#00bf6f" },
  { position: 65, color: "#ffda00" },
  { position: 82, color: "#ff8a00" },
  { position: 100, color: "#ff2b2b" },
];

const DEFAULTS = {
  title: "Power Usage",
  currency_symbol: "$",
  rate_unit_label: "p/kWh",
  power_unit: "W",
  max_power: 3000,
  decimal_places: 2,
  rate_is_subunit: false,
  auto_calculate_daily_cost: true,
  history_update_interval_sec: 300,
  bar_color_stops: DEFAULT_COLOR_STOPS,
  bar_style: "arrow",
};
const POWER_ENTITY_UNITS = new Set(["w", "kw", "mw", "gw"]);
const CURRENCY_CODES = ["usd", "eur", "gbp", "aud", "cad", "nzd", "sek", "nok", "dkk", "chf"];
const CURRENCY_SYMBOL_PATTERN = /[€£$¥₩₹]/;
const BAR_UNFILLED_COLOR = "rgba(26,54,85,0.35)";

function toNumberOrNull(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localMidnightIso(date = new Date()) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0,
  ).toISOString();
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeColorStops(stops) {
  if (!Array.isArray(stops)) {
    return DEFAULT_COLOR_STOPS.map((s) => ({ ...s }));
  }

  const normalized = stops
    .slice(0, 5)
    .map((stop) => {
      const positionRaw = toNumberOrNull(stop?.position);
      const color = String(stop?.color || "").trim();
      if (positionRaw == null || color === "") return null;

      const snapped = Math.round(positionRaw / 10) * 10;
      const clamped = Math.max(0, Math.min(100, snapped));
      return { position: clamped, color };
    })
    .filter(Boolean)
    .sort((a, b) => a.position - b.position);

  if (normalized.length < 2) {
    return DEFAULT_COLOR_STOPS.map((s) => ({ ...s }));
  }

  return normalized;
}

function gradientFromStops(stops) {
  const safeStops = normalizeColorStops(stops);
  const parts = safeStops.map((stop) => `${stop.color} ${stop.position}%`);
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

function hexToRgb(hex) {
  const clean = hex.replace(/^#/, "");
  const full = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean;
  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(full);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

function lerpColor(colorA, colorB, t) {
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const blue = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${blue})`;
}

function colorAtRatio(stops, ratio) {
  const safeStops = normalizeColorStops(stops);
  const pct = ratio * 100;

  if (pct <= safeStops[0].position) return safeStops[0].color;
  if (pct >= safeStops[safeStops.length - 1].position) return safeStops[safeStops.length - 1].color;

  for (let i = 0; i < safeStops.length - 1; i += 1) {
    const a = safeStops[i];
    const b = safeStops[i + 1];
    if (pct >= a.position && pct <= b.position) {
      const t = (b.position === a.position) ? 0 : (pct - a.position) / (b.position - a.position);
      return lerpColor(a.color, b.color, t);
    }
  }

  return safeStops[safeStops.length - 1].color;
}

class AdvancePowerUsageCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = undefined;
    this._hass = undefined;
    this._historyDailyCostByEntity = {};
    this._historyFetchInFlight = null;
    this._lastHistoryFetchMs = 0;
    this._historyDayKey = "";
    this._resizeObserver = null;
  }

  connectedCallback() {
    this._ensureResizeObserver();
    this._updateScale();
  }

  disconnectedCallback() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.channels)) {
      throw new Error("Invalid configuration: channels[] is required.");
    }

    if (!config.total_power_entity && config.channels.length === 0) {
      throw new Error("Provide total_power_entity or at least one channel.");
    }

    this._config = {
      ...DEFAULTS,
      ...config,
      channels: config.channels,
      bar_color_stops: normalizeColorStops(config.bar_color_stops),
    };

    this._render();
    this._scheduleHistoryRefresh(true);
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    this._scheduleHistoryRefresh(false);
  }

  getCardSize() {
    const channelCount = this._config?.channels?.length ?? 0;
    return Math.max(4, channelCount + 3);
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return {
      title: "Power Usage",
      total_power_entity: "sensor.home_power",
      rate_entity: "sensor.electricity_rate",
      rate_unit_label: "p/kWh",
      currency_symbol: "$",
      max_power: 6000,
      total_max_power: 6000,
      auto_calculate_daily_cost: true,
      bar_color_stops: DEFAULT_COLOR_STOPS,
      channels: [
        {
          name: "Washing Machine",
          power_entity: "sensor.washing_machine_power",
          max_power: 2500,
        },
      ],
    };
  }

  _isDarkMode() {
    if (this._hass?.themes && typeof this._hass.themes.darkMode === "boolean") {
      return this._hass.themes.darkMode;
    }

    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  _ensureResizeObserver() {
    if (this._resizeObserver) {
      return;
    }

    this._resizeObserver = new ResizeObserver(() => this._updateScale());
    this._resizeObserver.observe(this);
  }

  _updateScale() {
    const width = this.getBoundingClientRect().width || 760;
    const scale = Math.max(0.64, Math.min(1, width / 760));
    this.style.setProperty("--apuc-scale", scale.toFixed(3));
  }

  _getStateNumber(entityId, fallback = 0) {
    if (!this._hass || !entityId) return fallback;

    const state = this._hass.states[entityId];
    if (!state) return fallback;

    const parsed = toNumberOrNull(state.state);
    return parsed == null ? fallback : parsed;
  }

  _formatNumber(value, decimals = 2) {
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  _clamp01(value) {
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
  }

  _rateToCurrencyPerKwh(rate) {
    if (this._config.rate_is_subunit) {
      return rate / 100;
    }
    return rate;
  }

  _collectHistoryEntitiesNeedingCost() {
    if (!this._config) return [];

    const entities = [];
    this._config.channels.forEach((channel) => {
      if (!channel.power_entity) return;
      if (channel.daily_cost_entity) return;
      entities.push(channel.power_entity);
    });

    return [...new Set(entities)];
  }

  async _scheduleHistoryRefresh(force) {
    if (!this._hass || !this._config) return;
    if (!this._config.auto_calculate_daily_cost) return;

    const entities = this._collectHistoryEntitiesNeedingCost();
    if (entities.length === 0) return;

    const now = Date.now();
    const currentDay = localDayKey();
    const staleMs = Number(this._config.history_update_interval_sec) * 1000;
    const shouldRefresh =
      force ||
      this._historyDayKey !== currentDay ||
      now - this._lastHistoryFetchMs > staleMs;

    if (!shouldRefresh || this._historyFetchInFlight) return;

    this._historyFetchInFlight = this._refreshHistoryDailyCosts(entities)
      .catch(() => {
        // Ignore transient API failures and keep prior values.
      })
      .finally(() => {
        this._historyFetchInFlight = null;
      });
  }

  async _refreshHistoryDailyCosts(entities) {
    if (!this._hass || entities.length === 0) return;

    const startIso = localMidnightIso();
    const endIso = new Date().toISOString();
    const filterEntityId = encodeURIComponent(entities.join(","));
    const query =
      `history/period/${encodeURIComponent(startIso)}` +
      `?filter_entity_id=${filterEntityId}` +
      `&end_time=${encodeURIComponent(endIso)}` +
      "&minimal_response&no_attributes";

    const history = await this._hass.callApi("GET", query);
    if (!Array.isArray(history)) return;

    const dailyByEntity = {};
    history.forEach((series, index) => {
      if (!Array.isArray(series) || series.length === 0) {
        return;
      }

      const fallbackEntity = entities[index];
      const firstState = series.find((entry) => entry && typeof entry === "object");
      const entityId = firstState?.entity_id || fallbackEntity;
      if (!entityId) return;

      const energyKwh = this._integrateSeriesKwh(series);
      const rateRaw = this._findRateForPowerEntity(entityId);
      const ratePerKwh = this._rateToCurrencyPerKwh(rateRaw);
      dailyByEntity[entityId] = energyKwh * ratePerKwh;
    });

    this._historyDailyCostByEntity = {
      ...this._historyDailyCostByEntity,
      ...dailyByEntity,
    };
    this._historyDayKey = localDayKey();
    this._lastHistoryFetchMs = Date.now();
    this._render();
  }

  _findRateForPowerEntity(powerEntityId) {
    const channel = this._config.channels.find(
      (item) => item.power_entity === powerEntityId,
    );

    if (channel?.rate_entity) {
      return this._getStateNumber(channel.rate_entity, 0);
    }

    return this._getStateNumber(this._config.rate_entity, 0);
  }

  _integrateSeriesKwh(series) {
    const now = Date.now();
    let prevPowerW = null;
    let prevTs = null;
    let wattHours = 0;

    for (let i = 0; i < series.length; i += 1) {
      const entry = series[i];
      if (!entry || typeof entry !== "object") continue;

      const value = toNumberOrNull(entry.state);
      if (value == null) continue;

      const tsRaw = entry.last_changed || entry.last_updated;
      const ts = tsRaw ? Date.parse(tsRaw) : NaN;
      if (!Number.isFinite(ts)) continue;

      if (prevPowerW != null && prevTs != null && ts > prevTs) {
        const dtHours = (ts - prevTs) / 3600000;
        wattHours += prevPowerW * dtHours;
      }

      prevPowerW = value;
      prevTs = ts;
    }

    if (prevPowerW != null && prevTs != null && now > prevTs) {
      const dtHours = (now - prevTs) / 3600000;
      wattHours += prevPowerW * dtHours;
    }

    return wattHours / 1000;
  }

  _buildRow(channel, mainRatePerKwh) {
    const power = this._getStateNumber(channel.power_entity, 0);
    const rowMax = channel.max_power ?? this._config.max_power;
    const ratio = this._clamp01(rowMax > 0 ? power / rowMax : 0);

    const rowRateRaw = channel.rate_entity
      ? this._getStateNumber(channel.rate_entity, 0)
      : this._getStateNumber(this._config.rate_entity, 0);

    const rowRate = channel.rate_entity
      ? this._rateToCurrencyPerKwh(rowRateRaw)
      : mainRatePerKwh;

    const instantCost = (power / 1000) * rowRate;

    let totalCost = 0;
    if (channel.daily_cost_entity) {
      totalCost = this._getStateNumber(channel.daily_cost_entity, 0);
    } else if (channel.power_entity) {
      totalCost = this._historyDailyCostByEntity[channel.power_entity] ?? 0;
    }

    return {
      name: channel.name || channel.power_entity || "Channel",
      ratio,
      instantCost,
      totalCost,
    };
  }

  _render() {
    if (!this._config || !this._hass || !this.shadowRoot) return;

    this._ensureResizeObserver();
    this._updateScale();
    this.style.setProperty("--arrow-color", this._isDarkMode() ? "#ffffff" : "#111111");

    const totalPower = this._config.total_power_entity
      ? this._getStateNumber(this._config.total_power_entity, 0)
      : this._config.channels.reduce(
          (sum, c) => sum + this._getStateNumber(c.power_entity, 0),
          0,
        );

    const rateRaw = this._getStateNumber(this._config.rate_entity, 0);
    const ratePerKwh = this._rateToCurrencyPerKwh(rateRaw);

    const totalInstantCost = (totalPower / 1000) * ratePerKwh;
    const totalMax = this._config.total_max_power ?? this._config.max_power;
    const totalRatio = this._clamp01(totalMax > 0 ? totalPower / totalMax : 0);

    const rows = this._config.channels.map((channel) =>
      this._buildRow(channel, ratePerKwh),
    );

    const totalCost = this._config.total_cost_entity
      ? this._getStateNumber(this._config.total_cost_entity, 0)
      : rows.reduce((sum, row) => sum + row.totalCost, 0);

    const decimals = this._config.decimal_places;
    const currency = this._config.currency_symbol;
    const gradient = gradientFromStops(this._config.bar_color_stops);
    const barStyle = this._config.bar_style || "arrow";
    const stops = this._config.bar_color_stops;

    const rowHtml = rows
      .map(
        (row) => {
          const fillPct = (row.ratio * 100).toFixed(2);
          const barInnerHtml = barStyle === "scale"
            ? `<div class="bar bar-scale" style="background: linear-gradient(90deg, ${colorAtRatio(stops, row.ratio)} ${fillPct}%, ${BAR_UNFILLED_COLOR} ${fillPct}%);"></div>`
            : `<div class="bar"></div><div class="arrow" style="left: calc(${fillPct}% - var(--arrow-half))"></div>`;
          return `
          <div class="row">
            <div class="name" title="${htmlEscape(row.name)}">${htmlEscape(row.name)}</div>
            <div class="bar-wrap">
              ${barInnerHtml}
            </div>
            <div class="cost-hour">${currency}${this._formatNumber(row.instantCost, decimals)}/hr</div>
            <div class="cost-total">${currency}${this._formatNumber(row.totalCost, decimals)}</div>
          </div>
        `;
        },
      )
      .join("");

    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="wrap">
          <div class="summary">
            <div class="line"><span>Total Consumption:</span> ${this._formatNumber(totalPower, 0)}${this._config.power_unit}</div>
            <div class="line"><span>Current Cost Rate:</span> ${currency}${this._formatNumber(totalInstantCost, decimals)}/hr</div>
            <div class="line"><span>Total Cost:</span> ${currency}${this._formatNumber(totalCost, decimals)}</div>
          </div>

          <div class="right-panel">
            <div class="summary-bar-wrap">
              ${barStyle === "scale"
                ? `<div class="bar bar-scale" style="background: linear-gradient(90deg, ${colorAtRatio(stops, totalRatio)} ${(totalRatio * 100).toFixed(2)}%, ${BAR_UNFILLED_COLOR} ${(totalRatio * 100).toFixed(2)}%);"></div>`
                : `<div class="bar"></div><div class="arrow" style="left: calc(${(totalRatio * 100).toFixed(2)}% - var(--arrow-half))"></div>`
              }
            </div>
            <div class="rate">${this._formatNumber(rateRaw, 2)} ${this._config.rate_unit_label}</div>
          </div>

          <div class="channels">
            ${rowHtml}
          </div>
        </div>
      </ha-card>

      <style>
        :host {
          --apuc-scale: 1;
          --space-1: calc(4px * var(--apuc-scale));
          --space-2: calc(8px * var(--apuc-scale));
          --space-3: calc(12px * var(--apuc-scale));
          --space-4: calc(16px * var(--apuc-scale));
          --summary-size: calc(34px * var(--apuc-scale));
          --row-size: calc(34px * var(--apuc-scale));
          --arrow-size: calc(10px * var(--apuc-scale));
          --arrow-half: calc(var(--arrow-size) * 0.9);
          --arrow-color: #111111;
          --bar-gradient: ${gradient};
        }

        ha-card {
          padding: var(--space-4);
          overflow: hidden;
        }

        .wrap {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(170px, 42%);
          gap: var(--space-2) var(--space-4);
          align-items: start;
          width: 100%;
        }

        .summary {
          min-width: 0;
          font-size: clamp(14px, calc(24px * var(--apuc-scale)), 24px);
          line-height: 1.2;
          display: grid;
          gap: var(--space-1);
        }

        .summary .line span {
          font-weight: 600;
        }

        .right-panel {
          min-width: 0;
          display: grid;
          gap: var(--space-2);
          align-content: start;
        }

        .summary-bar-wrap {
          width: 100%;
        }

        .rate {
          justify-self: end;
          font-size: clamp(12px, calc(20px * var(--apuc-scale)), 20px);
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }

        .channels {
          grid-column: 1 / -1;
          display: grid;
          gap: var(--space-3);
          margin-top: var(--space-1);
          min-width: 0;
        }

        .row {
          display: grid;
          grid-template-columns: 25% 50% 12.5% 12.5%;
          gap: var(--space-2);
          align-items: center;
          min-width: 0;
        }

        .name {
          font-size: clamp(12px, calc(16px * var(--apuc-scale)), 16px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }

        .cost-hour,
        .cost-total {
          font-size: clamp(11px, calc(15px * var(--apuc-scale)), 15px);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-align: right;
        }

        .bar-wrap,
        .summary-bar-wrap {
          position: relative;
          height: var(--row-size);
          display: flex;
          align-items: center;
          min-width: 0;
        }

        .summary-bar-wrap {
          height: var(--summary-size);
        }

        .bar {
          width: 100%;
          height: 100%;
          border-radius: calc(10px * var(--apuc-scale));
          border: max(2px, calc(3px * var(--apuc-scale))) solid #1a3655;
          background: var(--bar-gradient);
          box-sizing: border-box;
        }

        .arrow {
          position: absolute;
          bottom: calc(-1 * var(--arrow-size) * 1.5);
          width: 0;
          height: 0;
          border-left: var(--arrow-size) solid transparent;
          border-right: var(--arrow-size) solid transparent;
          border-bottom: calc(var(--arrow-size) * 1.8) solid var(--arrow-color);
          filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.55));
        }

        @media (max-width: 820px) {
          .wrap {
            grid-template-columns: 1fr;
          }

          .rate {
            justify-self: start;
          }
        }

        @media (max-width: 560px) {
          .row {
            grid-template-columns: minmax(0, 1fr);
            gap: var(--space-1);
            padding-bottom: calc(var(--space-2) + 2px);
          }

          .bar-wrap {
            width: 100%;
          }

          .cost-hour,
          .cost-total {
            font-size: clamp(12px, calc(14px * var(--apuc-scale)), 14px);
            text-align: left;
          }
        }
      </style>
    `;
  }
}

class AdvancePowerUsageCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {
      ...AdvancePowerUsageCard.getStubConfig(),
      channels: [...AdvancePowerUsageCard.getStubConfig().channels],
      bar_color_stops: normalizeColorStops(
        AdvancePowerUsageCard.getStubConfig().bar_color_stops,
      ),
    };

    this._entityIdsCache = [];
    this._entitySignature = "";
    this._pendingEntityRefresh = false;
    this._channelOpenStates = [];
    this._stopsOpen = true;
    this._draggingChannelIndex = -1;
    this._dropTargetIndex = -1;
    this._dropPosition = "after";
    this._dragJustFinished = false;

    this._handleInput = this._handleInput.bind(this);
    this._handleColorLive = this._handleColorLive.bind(this);
    this._handleClick = this._handleClick.bind(this);
    this._handleToggle = this._handleToggle.bind(this);
    this._handleDragStart = this._handleDragStart.bind(this);
    this._handleDragOver = this._handleDragOver.bind(this);
    this._handleDrop = this._handleDrop.bind(this);
    this._handleDragEnd = this._handleDragEnd.bind(this);
    this._handleFocusOut = this._handleFocusOut.bind(this);
    this._handleValueChanged = this._handleValueChanged.bind(this);
  }

  set hass(hass) {
    this._hass = hass;
    const signature = this._entityStateSignature();
    if (signature === this._entitySignature) {
      return;
    }

    this._entitySignature = signature;
    this._entityIdsCache = this._collectEntityIds();

    if (this._isEditing()) {
      this._pendingEntityRefresh = true;
      return;
    }

    this._render();
  }

  connectedCallback() {
    this._entityIdsCache = this._collectEntityIds();
    this._entitySignature = this._entityStateSignature();
    this._render();
    this.shadowRoot.addEventListener("change", this._handleInput);
    this.shadowRoot.addEventListener("input", this._handleColorLive);
    this.shadowRoot.addEventListener("click", this._handleClick);
    this.shadowRoot.addEventListener("toggle", this._handleToggle);
    this.shadowRoot.addEventListener("dragstart", this._handleDragStart);
    this.shadowRoot.addEventListener("dragover", this._handleDragOver);
    this.shadowRoot.addEventListener("drop", this._handleDrop);
    this.shadowRoot.addEventListener("dragend", this._handleDragEnd);
    this.shadowRoot.addEventListener("focusout", this._handleFocusOut);
    this.shadowRoot.addEventListener("value-changed", this._handleValueChanged);
  }

  disconnectedCallback() {
    this.shadowRoot.removeEventListener("change", this._handleInput);
    this.shadowRoot.removeEventListener("input", this._handleColorLive);
    this.shadowRoot.removeEventListener("click", this._handleClick);
    this.shadowRoot.removeEventListener("toggle", this._handleToggle);
    this.shadowRoot.removeEventListener("dragstart", this._handleDragStart);
    this.shadowRoot.removeEventListener("dragover", this._handleDragOver);
    this.shadowRoot.removeEventListener("drop", this._handleDrop);
    this.shadowRoot.removeEventListener("dragend", this._handleDragEnd);
    this.shadowRoot.removeEventListener("focusout", this._handleFocusOut);
    this.shadowRoot.removeEventListener("value-changed", this._handleValueChanged);
  }

  setConfig(config) {
    const channels = Array.isArray(config?.channels) ? config.channels : [];
    this._config = {
      ...AdvancePowerUsageCard.getStubConfig(),
      ...config,
      channels: channels.map((channel) => ({ ...channel })),
      bar_color_stops: normalizeColorStops(config?.bar_color_stops),
    };

    this._channelOpenStates = this._config.channels.map((_, index) =>
      this._channelOpenStates[index] ?? true,
    );

    this._render();
  }

  _collectEntityIds() {
    if (!this._hass || !this._hass.states) return [];
    return Object.keys(this._hass.states).sort((a, b) => a.localeCompare(b));
  }

  _entityStateSignature() {
    const ids = this._collectEntityIds();
    const first = ids[0] || "";
    const last = ids[ids.length - 1] || "";
    return `${ids.length}:${first}:${last}`;
  }

  _isEditing() {
    const active = this.shadowRoot?.activeElement;
    if (!active) return false;
    return active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement;
  }

  _handleFocusOut() {
    if (!this._pendingEntityRefresh) return;
    if (this._isEditing()) return;
    this._pendingEntityRefresh = false;
    this._render();
  }

  _emitChanged() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _numberOrDelete(target, key, value) {
    const parsed = toNumberOrNull(value);
    if (parsed == null) {
      delete target[key];
    } else {
      target[key] = parsed;
    }
  }

  _entityInput(scope, field, value, index) {
    const indexAttr = index == null ? "" : ` data-index=\"${index}\"`;
    return `
      <ha-entity-picker
        data-scope="${scope}"
        data-field="${field}"${indexAttr}
        value="${htmlEscape(this._inputValue(value))}"
      ></ha-entity-picker>
    `;
  }

  _entityFilterForField(field) {
    switch (field) {
      case "power_entity":
      case "total_power_entity":
        return "power";
      case "rate_entity":
        return "rate_per_kwh";
      case "daily_cost_entity":
      case "total_cost_entity":
        return "cost";
      default:
        return "any";
    }
  }

  _positionOptions(selectedValue) {
    const selected = Math.max(0, Math.min(100, Math.round((toNumberOrNull(selectedValue) || 0) / 10) * 10));
    const values = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    return values
      .map((value) => {
        const selectedAttr = value === selected ? " selected" : "";
        return `<option value="${value}"${selectedAttr}>${value}%</option>`;
      })
      .join("");
  }

  _handleColorLive(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "color") return;
    if (target.dataset.scope !== "stop" || target.dataset.field !== "color") return;
    target.style.backgroundColor = target.value;
  }

  _handleInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
      return;
    }

    const field = target.dataset.field;
    if (!field) return;

    if (target.dataset.scope === "root") {
      if (target instanceof HTMLInputElement && target.type === "checkbox") {
        this._config[field] = target.checked;
      } else if (target instanceof HTMLInputElement && target.type === "number") {
        this._numberOrDelete(this._config, field, target.value);
      } else {
        const trimmed = target.value.trim();
        if (trimmed === "") {
          delete this._config[field];
        } else {
          this._config[field] = trimmed;
        }
      }

      this._emitChanged();
      return;
    }

    if (target.dataset.scope === "channel") {
      const index = Number.parseInt(target.dataset.index || "-1", 10);
      if (!Number.isInteger(index) || index < 0 || index >= this._config.channels.length) {
        return;
      }

      const channel = this._config.channels[index];
      if (target instanceof HTMLInputElement && target.type === "number") {
        this._numberOrDelete(channel, field, target.value);
      } else {
        const trimmed = target.value.trim();
        if (trimmed === "") {
          delete channel[field];
        } else {
          channel[field] = trimmed;
        }
      }

      this._emitChanged();
      return;
    }

    if (target.dataset.scope === "stop") {
      const index = Number.parseInt(target.dataset.index || "-1", 10);
      if (!Number.isInteger(index) || index < 0 || index >= this._config.bar_color_stops.length) {
        return;
      }

      const stop = this._config.bar_color_stops[index];
      if (field === "position") {
        stop.position = Math.max(0, Math.min(100, Math.round((toNumberOrNull(target.value) || 0) / 10) * 10));
      }

      if (field === "color") {
        stop.color = target.value || stop.color;
      }

      this._config.bar_color_stops = normalizeColorStops(this._config.bar_color_stops);
      this._render();
      this._emitChanged();
    }
  }

  _handleValueChanged(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.tagName.toLowerCase() !== "ha-entity-picker") {
      return;
    }

    const field = target.dataset.field;
    if (!field) return;

    const value = String(event.detail?.value ?? "").trim();

    if (target.dataset.scope === "root") {
      if (value === "") {
        delete this._config[field];
      } else {
        this._config[field] = value;
      }
      this._emitChanged();
      return;
    }

    if (target.dataset.scope === "channel") {
      const index = Number.parseInt(target.dataset.index || "-1", 10);
      if (!Number.isInteger(index) || index < 0 || index >= this._config.channels.length) {
        return;
      }

      const channel = this._config.channels[index];
      if (value === "") {
        delete channel[field];
      } else {
        channel[field] = value;
      }
      if (field === "power_entity") {
        this._syncEntityPickers();
      }
      this._emitChanged();
    }
  }

  _syncEntityPickers() {
    const pickers = this.shadowRoot?.querySelectorAll("ha-entity-picker");
    if (!pickers) return;

    pickers.forEach((picker) => {
      if (!(picker instanceof HTMLElement)) return;
      picker.hass = this._hass;
      picker.allowCustomEntity = true;
      picker.includeDomains = ["sensor"];
      const value = this._entityValueForPicker(picker);
      picker.value = value;
      picker.entityFilter = (entity) => this._pickerEntityMatchesFilter(picker, entity);
    });
  }

  _selectedChannelPowerEntities(excludedIndex) {
    const selected = new Set();
    this._config.channels.forEach((channel, index) => {
      if (index === excludedIndex) return;
      const entityId = this._inputValue(channel?.power_entity).trim();
      if (entityId !== "") {
        selected.add(entityId);
      }
    });
    return selected;
  }

  _entityValueForPicker(picker) {
    const field = picker.dataset.field;
    if (!field) return "";

    if (picker.dataset.scope === "root") {
      return this._inputValue(this._config[field]).trim();
    }

    if (picker.dataset.scope === "channel") {
      const index = Number.parseInt(picker.dataset.index || "-1", 10);
      if (!Number.isInteger(index) || index < 0 || index >= this._config.channels.length) {
        return "";
      }
      return this._inputValue(this._config.channels[index]?.[field]).trim();
    }

    return "";
  }

  _pickerEntityMatchesFilter(picker, entityOrId) {
    const field = picker.dataset.field || "";
    const filter = this._entityFilterForField(field);
    if (!this._entityMatchesFilter(entityOrId, filter)) {
      return false;
    }

    if (picker.dataset.scope !== "channel" || field !== "power_entity") {
      return true;
    }

    const index = Number.parseInt(picker.dataset.index || "-1", 10);
    const selected = this._selectedChannelPowerEntities(index);
    const entityId = typeof entityOrId === "string" ? entityOrId : entityOrId?.entity_id;
    const currentValue = this._entityValueForPicker(picker);

    return entityId === currentValue || !selected.has(entityId);
  }

  _entityMatchesFilter(entityOrId, filter) {
    if (filter === "any") return true;
    const entityId = typeof entityOrId === "string" ? entityOrId : entityOrId?.entity_id;
    if (!entityId?.startsWith("sensor.")) return false;

    const stateObj =
      typeof entityOrId === "string"
        ? this._hass?.states?.[entityOrId]
        : entityOrId;
    if (!stateObj) return false;

    const unit = String(stateObj.attributes?.unit_of_measurement || "").trim();
    const unitLower = unit.toLowerCase();
    const unitNormalized = unitLower.replace(/\s+/g, "");
    const deviceClass = String(stateObj.attributes?.device_class || "").trim().toLowerCase();
    const stateValue = Number.parseFloat(stateObj.state);
    const isNumberState = Number.isFinite(stateValue);

    if (filter === "power") {
      return (
        isNumberState &&
        (deviceClass === "power" ||
          POWER_ENTITY_UNITS.has(unitNormalized))
      );
    }

    if (filter === "rate_per_kwh") {
      return isNumberState && unitNormalized.includes("/kwh");
    }

    if (filter === "cost") {
      const hasCurrencyIndicator =
        CURRENCY_SYMBOL_PATTERN.test(unit) ||
        CURRENCY_CODES.some((code) => unitLower.includes(code));
      return (
        isNumberState &&
        (deviceClass === "monetary" || hasCurrencyIndicator)
      );
    }

    return true;
  }

  _handleClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.dataset.action;
    if (!action) return;

    if (action === "add-channel") {
      this._config.channels.push({
        name: `Channel ${this._config.channels.length + 1}`,
        power_entity: "",
      });
      this._channelOpenStates.push(true);
      this._render();
      this._emitChanged();
      return;
    }

    if (action === "remove-channel") {
      const index = Number.parseInt(target.dataset.index || "-1", 10);
      if (!Number.isInteger(index) || index < 0 || index >= this._config.channels.length) {
        return;
      }

      this._config.channels.splice(index, 1);
      this._channelOpenStates.splice(index, 1);
      this._render();
      this._emitChanged();
      return;
    }

    if (action === "add-stop") {
      if (this._config.bar_color_stops.length >= 5) return;

      this._config.bar_color_stops.push({
        position: 100,
        color: "#ffffff",
      });

      this._config.bar_color_stops = normalizeColorStops(this._config.bar_color_stops);
      this._render();
      this._emitChanged();
      return;
    }

    if (action === "remove-stop") {
      const index = Number.parseInt(target.dataset.index || "-1", 10);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= this._config.bar_color_stops.length ||
        this._config.bar_color_stops.length <= 2
      ) {
        return;
      }

      this._config.bar_color_stops.splice(index, 1);
      this._config.bar_color_stops = normalizeColorStops(this._config.bar_color_stops);
      this._render();
      this._emitChanged();
    }
  }

  _handleToggle(event) {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement)) return;

    // Dragging should not change fold state; restore previous state immediately.
    if (this._draggingChannelIndex >= 0 || this._dragJustFinished) {
      const scope = target.dataset.scope;
      if (scope === "stops") {
        target.open = this._stopsOpen;
        return;
      }

      if (scope === "channel") {
        const index = Number.parseInt(target.dataset.index || "-1", 10);
        if (Number.isInteger(index) && index >= 0) {
          target.open = this._channelOpenStates[index] !== false;
        }
        return;
      }
    }

    const scope = target.dataset.scope;
    if (scope === "stops") {
      this._stopsOpen = target.open;
      return;
    }

    if (scope === "channel") {
      const index = Number.parseInt(target.dataset.index || "-1", 10);
      if (Number.isInteger(index) && index >= 0) {
        this._channelOpenStates[index] = target.open;
      }
    }
  }

  _handleDragStart(event) {
    const handle = event.target instanceof HTMLElement ? event.target.closest("[data-drag-handle]") : null;
    const row = handle instanceof HTMLElement ? handle.closest("[data-draggable-channel]") : null;
    if (!(row instanceof HTMLElement)) return;

    const index = Number.parseInt(row.dataset.index || "-1", 10);
    if (!Number.isInteger(index) || index < 0) return;

    this._draggingChannelIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    }
    row.classList.add("dragging");
  }

  _handleDragOver(event) {
    const row = event.target instanceof HTMLElement ? event.target.closest("[data-draggable-channel]") : null;
    if (!(row instanceof HTMLElement)) return;
    if (this._draggingChannelIndex < 0) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }

    const rect = row.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    const targetIndex = Number.parseInt(row.dataset.index || "-1", 10);
    if (!Number.isInteger(targetIndex) || targetIndex < 0) return;

    this._dropTargetIndex = targetIndex;
    this._dropPosition = before ? "before" : "after";
    this._applyDropIndicatorClasses();
  }

  _handleDrop(event) {
    const row = event.target instanceof HTMLElement ? event.target.closest("[data-draggable-channel]") : null;
    if (!(row instanceof HTMLElement)) return;
    if (this._draggingChannelIndex < 0) return;

    event.preventDefault();
    const from = this._draggingChannelIndex;
    const baseIndex =
      this._dropTargetIndex >= 0
        ? this._dropTargetIndex
        : Number.parseInt(row.dataset.index || "-1", 10);
    if (!Number.isInteger(baseIndex) || baseIndex < 0 || baseIndex >= this._config.channels.length) {
      return;
    }

    let to = this._dropPosition === "before" ? baseIndex : baseIndex + 1;
    if (to > from) {
      to -= 1;
    }
    if (to < 0) to = 0;
    if (to > this._config.channels.length - 1) to = this._config.channels.length - 1;
    if (to === from) {
      this._clearDropIndicators();
      return;
    }

    const [movedChannel] = this._config.channels.splice(from, 1);
    this._config.channels.splice(to, 0, movedChannel);

    const [movedOpen] = this._channelOpenStates.splice(from, 1);
    this._channelOpenStates.splice(to, 0, movedOpen);

    this._render();
    this._emitChanged();
  }

  _handleDragEnd() {
    this._dragJustFinished = true;
    this._draggingChannelIndex = -1;
    this._clearDropIndicators();
    setTimeout(() => {
      this._dragJustFinished = false;
    }, 0);
  }

  _clearDropIndicators() {
    this._dropTargetIndex = -1;
    this._dropPosition = "after";
    const nodes = this.shadowRoot.querySelectorAll(".dragging,.drop-before,.drop-after");
    nodes.forEach((node) => {
      node.classList.remove("dragging");
      node.classList.remove("drop-before");
      node.classList.remove("drop-after");
    });
  }

  _applyDropIndicatorClasses() {
    const rows = this.shadowRoot.querySelectorAll("[data-draggable-channel]");
    rows.forEach((rowNode) => {
      if (!(rowNode instanceof HTMLElement)) return;

      rowNode.classList.remove("drop-before");
      rowNode.classList.remove("drop-after");

      const rowIndex = Number.parseInt(rowNode.dataset.index || "-1", 10);
      if (rowIndex !== this._dropTargetIndex) {
        return;
      }

      rowNode.classList.add(this._dropPosition === "before" ? "drop-before" : "drop-after");
    });
  }

  _inputValue(value) {
    return value == null ? "" : String(value);
  }

  _channelTitle(channel, index) {
    const named = this._inputValue(channel?.name).trim();
    if (named) return named;
    const entity = this._inputValue(channel?.power_entity).trim();
    if (entity) return entity;
    return `Channel ${index + 1}`;
  }

  _render() {
    const config = this._config;
    const stopRows = config.bar_color_stops
      .map(
        (stop, index) => `
          <div class="stop-row">
            <label>Position
              <select data-scope="stop" data-index="${index}" data-field="position">
                ${this._positionOptions(stop.position)}
              </select>
            </label>
            <label>Color
              <input type="color" data-scope="stop" data-index="${index}" data-field="color" value="${htmlEscape(stop.color)}" style="background-color: ${htmlEscape(stop.color)};" />
            </label>
            <button type="button" data-action="remove-stop" data-index="${index}" ${config.bar_color_stops.length <= 2 ? "disabled" : ""}>Remove</button>
          </div>
        `,
      )
      .join("");

    const channelRows = config.channels
      .map(
        (channel, index) => {
          const title = this._channelTitle(channel, index);
          const openAttr = this._channelOpenStates[index] === false ? "" : "open";
          return `
            <details class="channel-row" data-scope="channel" data-index="${index}" data-draggable-channel ${openAttr}>
              <summary class="row-head">
                <span class="channel-title">${htmlEscape(title)}</span>
                <span class="row-actions">
                  <span class="drag-handle" data-drag-handle draggable="true" title="Drag to reorder" aria-hidden="true">
                    <span></span><span></span><span></span>
                  </span>
                  <button type="button" data-action="remove-channel" data-index="${index}">Remove</button>
                </span>
              </summary>
              <div class="grid channel-grid">
                <label>Name
                  <input data-scope="channel" data-index="${index}" data-field="name" value="${htmlEscape(this._inputValue(channel.name))}" />
                </label>
                <label>Power Entity
                  ${this._entityInput("channel", "power_entity", channel.power_entity, index)}
                </label>
                <label>Max Power (W)
                  <input type="number" step="any" data-scope="channel" data-index="${index}" data-field="max_power" value="${htmlEscape(this._inputValue(channel.max_power))}" />
                </label>
                <label>Daily Cost Entity
                  ${this._entityInput("channel", "daily_cost_entity", channel.daily_cost_entity, index)}
                </label>
                <label>Rate Entity (optional)
                  ${this._entityInput("channel", "rate_entity", channel.rate_entity, index)}
                </label>
              </div>
            </details>
          `;
        },
      )
      .join("");

    const gradientPreview = gradientFromStops(config.bar_color_stops);
    const stopsOpenAttr = this._stopsOpen ? "open" : "";

    this.shadowRoot.innerHTML = `
      <div class="editor">
        <div class="grid">
          <label>Title
            <input data-scope="root" data-field="title" value="${htmlEscape(this._inputValue(config.title))}" />
          </label>
          <label>Total Power Entity
            ${this._entityInput("root", "total_power_entity", config.total_power_entity)}
          </label>
          <label>Total Cost Entity
            ${this._entityInput("root", "total_cost_entity", config.total_cost_entity)}
          </label>
          <label>Rate Entity
            ${this._entityInput("root", "rate_entity", config.rate_entity)}
          </label>
          <label>Rate Unit Label
            <input data-scope="root" data-field="rate_unit_label" value="${htmlEscape(this._inputValue(config.rate_unit_label))}" />
          </label>
          <label>Currency Symbol
            <input data-scope="root" data-field="currency_symbol" value="${htmlEscape(this._inputValue(config.currency_symbol))}" />
          </label>
          <label>Default Max Power (W)
            <input type="number" step="any" data-scope="root" data-field="max_power" value="${htmlEscape(this._inputValue(config.max_power))}" />
          </label>
          <label>Total Max Power (W)
            <input type="number" step="any" data-scope="root" data-field="total_max_power" value="${htmlEscape(this._inputValue(config.total_max_power))}" />
          </label>
          <label>Decimal Places
            <input type="number" step="1" min="0" data-scope="root" data-field="decimal_places" value="${htmlEscape(this._inputValue(config.decimal_places))}" />
          </label>
          <label>History Refresh Seconds
            <input type="number" step="1" min="30" data-scope="root" data-field="history_update_interval_sec" value="${htmlEscape(this._inputValue(config.history_update_interval_sec))}" />
          </label>
          <label>Bar Style
            <select data-scope="root" data-field="bar_style">
              <option value="arrow" ${config.bar_style !== "scale" ? "selected" : ""}>Arrow (full gradient bar)</option>
              <option value="scale" ${config.bar_style === "scale" ? "selected" : ""}>Scale (percentage fill)</option>
            </select>
          </label>
        </div>

        <label class="checkbox">
          <input type="checkbox" data-scope="root" data-field="rate_is_subunit" ${config.rate_is_subunit ? "checked" : ""} />
          Rate entity is in subunit (e.g. cents/pence)
        </label>

        <label class="checkbox">
          <input type="checkbox" data-scope="root" data-field="auto_calculate_daily_cost" ${config.auto_calculate_daily_cost !== false ? "checked" : ""} />
          Auto-calculate daily cost from history when daily_cost_entity is not set
        </label>

        <details data-scope="stops" ${stopsOpenAttr}>
          <summary class="section-head">
            <h3>Bar Colors</h3>
            <button type="button" data-action="add-stop" ${config.bar_color_stops.length >= 5 ? "disabled" : ""}>Add Stop</button>
          </summary>
          <p class="help">Up to 5 stops. Position is constrained to 10% increments.</p>
          <div class="preview" style="background: ${gradientPreview};"></div>
          <div class="stops">
            ${stopRows}
          </div>
        </details>

        <div class="channels-header">
          <h3>Channels</h3>
          <button type="button" data-action="add-channel">Add Channel</button>
        </div>

        <div class="channels">
          ${channelRows}
        </div>
      </div>

      <style>
        :host {
          display: block;
        }

        .editor {
          display: grid;
          gap: 12px;
          padding: 4px 0;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 10px;
        }

        label {
          display: grid;
          gap: 6px;
          font-size: 13px;
        }

        input,
        ha-entity-picker,
        select {
          width: 100%;
          box-sizing: border-box;
        }

        input,
        select {
          padding: 8px;
          border-radius: 8px;
          border: 1px solid var(--divider-color, #5f5f5f);
          background: var(--card-background-color, #1c1c1c);
          color: var(--primary-text-color, #fff);
        }

        input[type="color"] {
          padding: 2px;
          cursor: pointer;
        }

        .checkbox {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .checkbox input {
          width: auto;
        }

        details {
          border: 1px solid var(--divider-color, #5f5f5f);
          border-radius: 10px;
          padding: 8px 10px;
        }

        summary {
          cursor: pointer;
          list-style: none;
          position: relative;
          padding-left: 18px;
        }

        summary::before {
          content: "▸";
          position: absolute;
          left: 0;
          top: 50%;
          transform: translateY(-50%);
          font-size: 12px;
          opacity: 0.9;
          transition: transform 0.16s ease;
        }

        details[open] > summary::before {
          transform: translateY(-50%) rotate(90deg);
        }

        summary::-webkit-details-marker {
          display: none;
        }

        .section-head,
        .channels-header,
        .row-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        .channel-title {
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }

        .row-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .drag-handle {
          width: 14px;
          display: inline-grid;
          gap: 2px;
          align-items: center;
          justify-items: stretch;
          opacity: 0.85;
          cursor: grab;
        }

        .drag-handle:active {
          cursor: grabbing;
        }

        .drag-handle > span {
          height: 2px;
          background: currentColor;
          border-radius: 2px;
        }

        h3 {
          margin: 0;
          font-size: 15px;
        }

        .help {
          margin: 8px 0;
          font-size: 12px;
          opacity: 0.8;
        }

        button {
          border: 1px solid var(--divider-color, #5f5f5f);
          border-radius: 8px;
          background: transparent;
          color: var(--primary-text-color, #fff);
          padding: 6px 10px;
          cursor: pointer;
        }

        button:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }

        .preview {
          height: 22px;
          border-radius: 8px;
          border: 1px solid var(--divider-color, #5f5f5f);
        }

        .stops,
        .channels {
          display: grid;
          gap: 10px;
          margin-top: 8px;
        }

        .stop-row {
          border: 1px solid var(--divider-color, #5f5f5f);
          border-radius: 10px;
          padding: 10px;
          display: grid;
          grid-template-columns: 1fr 1fr auto;
          gap: 8px;
          align-items: end;
        }

        .channel-row {
          transition: opacity 0.15s ease, box-shadow 0.15s ease;
        }

        .channel-row.dragging {
          opacity: 0.5;
        }

        .channel-row.drop-before {
          box-shadow: inset 0 3px 0 0 #4da3ff;
        }

        .channel-row.drop-after {
          box-shadow: inset 0 -3px 0 0 #4da3ff;
        }

        .channel-grid {
          margin-top: 8px;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        }

        @media (max-width: 620px) {
          .stop-row {
            grid-template-columns: 1fr;
          }
        }
      </style>
    `;
    this._syncEntityPickers();
  }
}

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, AdvancePowerUsageCard);
}

if (!customElements.get(EDITOR_TAG)) {
  customElements.define(EDITOR_TAG, AdvancePowerUsageCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Advance Power Usage Card",
  description:
    "Power and cost bars with responsive scaling, history daily cost, visual editor dropdowns, and configurable bar colors.",
  preview: true,
});
