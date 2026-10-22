# Example data

The JSON files in this directory use deliberately invented numbers and dates. They demonstrate formats and scoring behavior; they are not personal health records, provider account exports, or training targets.

- `recovery/normalized-good-day.json` demonstrates a `FULL` recommendation on 2026-04-13.
- `recovery/normalized-bad-day.json` demonstrates a `LIGHT` recommendation on 2026-04-14.
- `oura/` demonstrates minimal provider-shaped responses and baseline inputs for offline normalization. `sleep-response.json` represents the merged sleep data consumed by the adapter, rather than a complete raw Oura API response.

Use a separate demo workspace when ingesting these files. Never replace them with real wearable exports, identifiers, lab results, or credentials.
