const CARD_TAG = "advance-power-usage-card";

const DEFAULTS = {
  title: "Power Usage",
  currency_symbol: "$",
  rate_unit_label: "p/kWh",
  power_unit: "W",
  max_power: 3000,
  decimal_places: 2,
};

class AdvancePowerUsageCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = undefined;
    this._hass = undefined;
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
    };

    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    const channelCount = this._config?.channels?.length ?? 0;
    return Math.max(4, channelCount + 3);
  }

  static getStubConfig() {
    return {
      title: "Power Usage",
      total_power_entity: "sensor.home_power",
      rate_entity: "sensor.electricity_rate",
      rate_unit_label: "p/kWh",
      currency_symbol: "$",
      max_power: 6000,
      channels: [
        {
          name: "Washing Machine",
          power_entity: "sensor.washing_machine_power",
          max_power: 2500,
        },
      ],
    };
  }

  _getStateNumber(entityId, fallback = 0) {
    if (!this._hass || !entityId) return fallback;

    const state = this._hass.states[entityId];
    if (!state) return fallback;

    const raw = Number.parseFloat(state.state);
    return Number.isFinite(raw) ? raw : fallback;
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
    // Keep this configurable for regions using pence/cents in the rate entity.
    if (this._config.rate_is_subunit) {
      return rate / 100;
    }
    return rate;
  }

  _buildRow(channel, mainRatePerKwh) {
    const power = this._getStateNumber(channel.power_entity, 0);
    const rowMax = channel.max_power ?? this._config.max_power;
    const ratio = this._clamp01(rowMax > 0 ? power / rowMax : 0);

    const rowRateRaw = channel.rate_entity
      ? this._getStateNumber(channel.rate_entity, 0)
      : mainRatePerKwh;

    const rowRate = channel.rate_entity
      ? this._rateToCurrencyPerKwh(rowRateRaw)
      : mainRatePerKwh;

    const instantCost = (power / 1000) * rowRate;

    let totalCost = 0;
    if (channel.daily_cost_entity) {
      totalCost = this._getStateNumber(channel.daily_cost_entity, 0);
    }

    return {
      name: channel.name || channel.power_entity || "Channel",
      power,
      ratio,
      instantCost,
      totalCost,
    };
  }

  _render() {
    if (!this._config || !this._hass || !this.shadowRoot) return;

    const totalPower = this._config.total_power_entity
      ? this._getStateNumber(this._config.total_power_entity, 0)
      : this._config.channels.reduce(
          (sum, c) => sum + this._getStateNumber(c.power_entity, 0),
          0,
        );

    const rateRaw = this._getStateNumber(this._config.rate_entity, 0);
    const ratePerKwh = this._rateToCurrencyPerKwh(rateRaw);

    const totalInstantCost = (totalPower / 1000) * ratePerKwh;
    const totalCost = this._config.total_cost_entity
      ? this._getStateNumber(this._config.total_cost_entity, 0)
      : 0;

    const totalMax = this._config.total_max_power ?? this._config.max_power;
    const totalRatio = this._clamp01(totalMax > 0 ? totalPower / totalMax : 0);

    const rows = this._config.channels.map((channel) =>
      this._buildRow(channel, ratePerKwh),
    );

    const decimals = this._config.decimal_places;
    const currency = this._config.currency_symbol;

    const rowHtml = rows
      .map(
        (row) => `
          <div class="row">
            <div class="name">${row.name}</div>
            <div class="bar-wrap">
              <div class="bar"></div>
              <div class="arrow" style="left: calc(${(row.ratio * 100).toFixed(2)}% - 9px)"></div>
            </div>
            <div class="cost-hour">${currency}${this._formatNumber(row.instantCost, decimals)}/hr</div>
            <div class="cost-total">${currency}${this._formatNumber(row.totalCost, decimals)}</div>
          </div>
        `,
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
          <div class="summary-bar-wrap">
            <div class="bar"></div>
            <div class="arrow" style="left: calc(${(totalRatio * 100).toFixed(2)}% - 9px)"></div>
          </div>
          <div class="rate">${this._formatNumber(rateRaw, 2)} ${this._config.rate_unit_label}</div>

          <div class="channels">
            ${rowHtml}
          </div>
        </div>
      </ha-card>

      <style>
        ha-card {
          padding: 16px;
        }

        .wrap {
          display: grid;
          grid-template-columns: 1fr auto;
          column-gap: 16px;
          row-gap: 10px;
          align-items: center;
        }

        .summary {
          grid-column: 1;
          display: grid;
          row-gap: 4px;
          min-width: 260px;
          font-size: 24px;
          line-height: 1.2;
        }

        .summary .line span {
          font-weight: 500;
        }

        .rate {
          grid-column: 2;
          justify-self: end;
          font-size: 20px;
          font-weight: 600;
          white-space: nowrap;
        }

        .summary-bar-wrap {
          grid-column: 2;
          width: min(320px, 40vw);
        }

        .channels {
          grid-column: 1 / -1;
          display: grid;
          row-gap: 10px;
          margin-top: 8px;
        }

        .row {
          display: grid;
          grid-template-columns: minmax(120px, 1.2fr) minmax(200px, 4fr) auto auto;
          align-items: center;
          gap: 8px;
        }

        .name {
          font-size: 16px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .cost-hour,
        .cost-total {
          font-size: 15px;
          white-space: nowrap;
        }

        .bar-wrap,
        .summary-bar-wrap {
          position: relative;
          height: 38px;
          display: flex;
          align-items: center;
        }

        .bar {
          width: 100%;
          height: 100%;
          border-radius: 10px;
          border: 3px solid #1a3655;
          background: linear-gradient(
            90deg,
            #0085ff 0%,
            #00bf6f 40%,
            #ffda00 65%,
            #ff8a00 82%,
            #ff2b2b 100%
          );
        }

        .arrow {
          position: absolute;
          bottom: -16px;
          width: 0;
          height: 0;
          border-left: 10px solid transparent;
          border-right: 10px solid transparent;
          border-bottom: 18px solid #111;
          filter: drop-shadow(0 1px 0 rgba(255, 255, 255, 0.6));
        }

        @media (max-width: 900px) {
          .wrap {
            grid-template-columns: 1fr;
          }

          .summary,
          .summary-bar-wrap,
          .rate,
          .channels {
            grid-column: 1;
          }

          .summary {
            font-size: 20px;
          }

          .rate {
            justify-self: start;
            font-size: 17px;
          }

          .summary-bar-wrap {
            width: 100%;
          }

          .row {
            grid-template-columns: 1fr;
            gap: 4px;
            padding-bottom: 12px;
          }

          .bar-wrap {
            width: 100%;
          }
        }
      </style>
    `;
  }
}

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, AdvancePowerUsageCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Advance Power Usage Card",
  description: "Power and cost bars with configurable channels.",
  preview: true,
});
