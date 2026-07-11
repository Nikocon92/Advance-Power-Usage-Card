# Advance Power Usage Card

A Home Assistant Lovelace custom card that displays:

- Total live consumption and cost rate
- Total cost for today (optional entity, or sum of calculated channel daily costs)
- A scalable list of per-device channels with gradient bars and live arrow position
- Instantaneous cost per hour and daily cost per channel
- Built-in visual editor and YAML code editor support

The channel list is dynamic, so the card can grow beyond 11 rows.
The layout scales text and bar sizing to fit the available card width.

## HACS Installation

1. Open HACS in Home Assistant.
2. Add this repository as a **Custom repository** with type **Dashboard**.
3. Install **Advance Power Usage Card**.
4. Restart Home Assistant.
5. Add the resource in Settings > Dashboards > Resources if HACS does not auto-add it:
   - URL: `/hacsfiles/advance-power-usage-card/advance-power-usage-card.js`
   - Type: `JavaScript Module`

## Lovelace Example

```yaml
type: custom:advance-power-usage-card
title: Power Usage
total_power_entity: sensor.house_total_power
rate_entity: sensor.electricity_rate
rate_is_subunit: true            # true if rate_entity is pence/cents per kWh
rate_unit_label: p/kWh
currency_symbol: "$"
max_power: 6000
total_max_power: 6000
total_cost_entity: sensor.house_cost_today
decimal_places: 2
auto_calculate_daily_cost: true
show_raw_power_overlay: true
show_other: false        # adds an "Other" row for untracked power
show_sankey: true        # shows a Sankey flow chart below the channel list
history_update_interval_sec: 300
channels:
  - name: Washing Machine
    power_entity: sensor.washing_machine_power
    max_power: 2500
    # daily_cost_entity optional; if omitted, card calculates daily cost from history
    # daily_cost_entity: sensor.washing_machine_cost_today
  - name: Tumble Dryer
    power_entity: sensor.tumble_dryer_power
    max_power: 3000
  - name: Office Desk
    power_entity: sensor.office_desk_power

bar_color_stops:
  - position: 0
    color: "#0085ff"
  - position: 40
    color: "#00bf6f"
  - position: 70
    color: "#ffcc00"
  - position: 90
    color: "#ff4a00"
  - position: 100
    color: "#ff1a1a"
```

## Configuration

| Key | Required | Description |
|---|---|---|
| `type` | Yes | Must be `custom:advance-power-usage-card` |
| `channels` | Yes | Array of channel objects |
| `total_power_entity` | No | Total power entity (if missing, card sums channel power) |
| `rate_entity` | No | Current electricity rate entity |
| `rate_is_subunit` | No | If `true`, divides rate by 100 before cost maths |
| `rate_unit_label` | No | Label shown by current rate (default `p/kWh`) |
| `currency_symbol` | No | Currency symbol (default `$`) |
| `max_power` | No | Default max power for channel bars |
| `total_max_power` | No | Max power for top summary bar |
| `total_cost_entity` | No | Entity for total cost since midnight |
| `decimal_places` | No | Cost formatting precision |
| `auto_calculate_daily_cost` | No | If `true`, computes channel daily cost from power history when `daily_cost_entity` is missing |
| `show_raw_power_overlay` | No | If `true`, overlays each channel bar with its current raw power value in white text |
| `history_update_interval_sec` | No | How often to refresh history-based daily costs (default `300`) |
| `bar_color_stops` | No | Up to 5 global gradient stops for bars (`position` in 10% steps, `color` as CSS color) |
| `show_other` | No | If `true`, shows an "Other" row at the bottom representing untracked power (total minus sum of channel power) |
| `show_sankey` | No | If `true`, shows a Sankey flow chart at the bottom of the card, visualising power flow from the total to each channel. Band colours match the gradient colour bar. |

Channel object keys:

- `name` (optional)
- `power_entity` (recommended)
- `max_power` (optional)
- `daily_cost_entity` (optional; if omitted and auto-calculate is enabled, daily cost is calculated from history)
- `rate_entity` (optional, per-channel override)
- `parent_channel` (optional; set to another channel's `power_entity` to make this channel a child of that parent, so this channel's live power is deducted from the parent channel)

## Visual Editor

This card includes a Lovelace visual editor (`getConfigElement`) so you can configure:

- Global entities and formatting
- History-based daily-cost settings
- Global bar color stops (up to 5)
- Channels (add/remove/edit rows)

Entity fields in the visual editor use the default Home Assistant entity picker, with power/cost/rate fields prefiltered where applicable.

You can still switch to YAML mode at any time.

## Development

```bash
npm install
npm run build
```

This bundles `src/advance-power-usage-card.js` into `advance-power-usage-card.js`.

## Notes

- If `daily_cost_entity` is omitted for a channel and `auto_calculate_daily_cost` is enabled, the card estimates daily cost from that channel power history since local midnight.
- If no `total_power_entity` is set, the card uses the sum of channel power entities.
- If `total_cost_entity` is not set, the card shows the sum of per-channel daily costs.
- Arrow color now follows theme: white in dark mode and black in light mode.

## License

MIT
