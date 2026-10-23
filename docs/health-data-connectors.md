# Health Data Connectors

Health OS separates provider harvesting from health decisions. A connector fetches a provider day and normalizes it into one or both supported consumer contracts:

- **HealthObservationSet v1** records provider-neutral physical metrics, optional proprietary scores, provenance, timestamps, freshness, and baseline coverage.
- **Normalized recovery v1** preserves the existing daily recovery and training-decision path, including its established Oura and external-payload behavior.

Observation data is stored in `.health-os/data/wearable-observations.json`. Legacy normalized recovery remains in its existing CSV files. Health OS does not copy observation sets into the recovery timeline or turn physical metrics into a recovery score.

User-uploaded source documents belong in `.health-os/personal/raw/`; processed Markdown and text belongs in `.health-os/personal/files/`. See [personal-files.md](personal-files.md). Credentials and tokens stay outside the workspace.

## HealthObservationSet v1

The validator is `src/wearable-observation-contract.js`. A set has this shape:

```json
{
  "schema_version": 1,
  "date": "2026-10-23",
  "source": {"id": "synthetic-sensor", "label": "Synthetic Sensor", "reference": "day:2026-10-23"},
  "freshness": {
    "status": "unknown",
    "observed_at": null,
    "evaluated_at": null,
    "max_age_seconds": null
  },
  "physical_metrics": [
    {
      "metric": "hrv",
      "status": "observed",
      "value": 49,
      "unit": "ms",
      "observed_at": "2026-10-23T06:00:00Z",
      "observed_date": null,
      "source_ref": "sleep-summary",
      "baseline": {
        "status": "unavailable",
        "value": null,
        "observed_days": 0,
        "window_days": 28,
        "scope": "source",
        "source_id": "synthetic-sensor"
      }
    }
  ],
  "proprietary_scores": []
}
```

The source ID is a lowercase machine identifier and the set date is a real calendar date. `physical_metrics` and `proprietary_scores` are separate arrays; an ID cannot appear in both. Each entry reports `observed`, `missing`, or `unsupported`. Only an observed entry has a numeric value. Keep provider score names such as Oura's readiness and sleep scores in `proprietary_scores`; they are not physical measurements and are optional for every connector.

Use `observed_at` only for a real RFC3339 source timestamp (up to millisecond precision). Use `observed_date` for a source day label with no exact time. Leave both null when the sample time is unknown. A batch date or local ingestion time must not be substituted for a sensor timestamp. The set-level `freshness` describes the connector's freshness assessment; `unknown` has null timestamps and age limit. A `fresh` or `stale` assessment includes its observed time, evaluation time, and maximum age. Metric timestamps remain authoritative because values within one set can cover different times.

Physical metric `baseline` is either null or an object with `status`, `value`, `observed_days`, `window_days`, `scope`, and `source_id`. Status is `complete` when every day in the declared window is represented, `partial` for some days, `unavailable` for zero days, or `unknown` when only an external numeric baseline is known and its coverage cannot be established. `source` scope identifies the same connector; external baselines use `external` scope and a null source ID. The observation baseline path counts distinct actual sample days in UTC, excludes unknown, target-day, and future samples, and refuses mixed units or conflicting values on one day. It does not label a partial baseline adequate for a training decision.

The store is versioned separately from the workspace manifest and uses atomic replacement. One source/date pair has one current set. Re-import replaces that set in full, including observed-to-missing changes; it never merges old metrics back into a new set. Observation sets are separate from recovery CSVs and are not duplicated into `timeline`.

Validate an observation without initializing or writing a workspace:

```bash
cat observation-set.json | node src/cli.js validate-wearable-observations \
  --json --input-json --workspace "$HEALTH_OS_WORKSPACE"
```

Ingest a pre-normalized set through the coordinated, idempotent workspace writer:

```bash
cat observation-set.json | node src/cli.js ingest-wearable-observations \
  --json --input-json --workspace "$HEALTH_OS_WORKSPACE" \
  --idempotency-key sensor:2026-10-23
```

`wearable-observations` reads up to 50 stored sets. Optional `--source ID` and `--date YYYY-MM-DD` filters narrow the result. The observation input is bounded to 256 KiB; JSON results use the standard bounded CLI envelope.

## Connector contract

A connector lives under `src/*-connector.js` and is registered explicitly in `src/health-data-connectors.js`. There is no automatic module discovery. Every connector has:

- `id`: a stable lowercase machine name, such as `oura`
- `label`: a human-readable source name
- `capabilities`: supported features, such as `oauth2`, `daily-recovery`, or `wearable-observations`
- `requiredMetrics`: metrics required by the legacy normalized recovery path; use an empty array for observation-only connectors
- `resolveAuth({ options, env })`: loads credentials or tokens without writing them to the workspace
- `fetchDaily({ date, options, env, auth })`: returns a raw provider bundle for one calendar day
- `normalizeDaily({ date, rawBundle, baselines })`: optional legacy normalized recovery output
- `writeRawBundle({ outputDir, rawBundle })`: optional raw export for debugging or replay

An observation-capable connector also implements:

- `normalizeObservations({ date, rawBundle, baselines, baselineCoverage })`: returns one HealthObservationSet v1
- `observationSchemaVersions: [1]`
- `physicalMetrics: [...]`: the exact physical metric IDs emitted by its normalizer, including explicit missing entries
- `proprietaryScores: [...]`: the exact optional proprietary score IDs emitted by its normalizer; an unavailable score is a `missing` entry

Registration validates those declarations against every normalized set. A connector may implement both normalizers to retain the legacy recovery path while exposing neutral observations. A connector that implements only `normalizeObservations` stores physical observations and reports `decision_available: false`, `mode: "UNAVAILABLE"`, and `score: null`. It does not create readiness/sleep scores or a daily recovery decision.

Oura implements both contracts. Its legacy recovery payload and existing score-based decision behavior remain compatible. Its observation set carries HRV, resting heart rate, sleep efficiency, sleep duration, temperature deviation, and the separate readiness/sleep score fields. New observation-side baseline coverage uses only prior Oura observations stored by this schema; old recovery CSV rows have no reliable provider identity and are not mixed into it. The old recovery adapter retains its established baseline behavior for compatibility.

The sync flow is:

```text
credentials -> connector.fetchDaily -> normalize observations and/or legacy recovery -> validate -> store observations and/or ingest legacy recovery
```

`sync-daily-source` holds the workspace write lock and supports the operation idempotency journal. A connector that emits only observations, or an Oura day missing a required legacy score, can still store useful physical readings. Callers must check `decision_available`; command success does not mean a fresh legacy recovery recommendation was produced. A previous daily recovery row can remain after an observation-only sync, and `today`/`next` continue to reflect the legacy engine. The separate read-only `prepare-training` command can use either permitted, sufficiently covered legacy recovery or a scored observation set with fresh HRV, resting heart rate, readiness and sleep scores plus adequate baselines from that same source. Scoreless physical observations alone do not imply readiness. The legacy recovery CSV writes and observation-store replacement are separate file operations, not one cross-file transaction.

## Legacy normalized recovery v1

Existing callers can continue to submit the normalized recovery contract validated by `src/recovery-contract.js`:

```bash
cat daily-state.json | ./src/scripts/validate-daily-state.sh
cat daily-state.json | ./src/scripts/ingest-daily-state.sh
```

The payload shape is illustrated by `examples/recovery/normalized-good-day.json` and `examples/recovery/normalized-bad-day.json`. It retains required readiness/sleep scores and the current decision engine behavior. Use it for compatibility with an existing scored workflow; a provider that has only physical observations should use HealthObservationSet v1.

## Adding a wearable

The complete offline example is [`examples/connectors/fixture-connector.mjs`](../examples/connectors/fixture-connector.mjs), with the connector object in [`synthetic-fixture-connector.mjs`](../examples/connectors/synthetic-fixture-connector.mjs). It explicitly registers a synthetic connector, initializes a disposable workspace, normalizes HRV and resting-heart-rate fixtures, and calls the same connector sync API. It cleans up the temporary workspace even on failure and makes no network call:

```bash
node examples/connectors/fixture-connector.mjs
```

The example emits an observation-only result with `decision_available: false`; physical readings without required proprietary scores do not create a recovery recommendation. Use this as a local contract exercise, not as a production data source.

For a new connector in a fork:

1. Add a module such as `src/fixture-connector.js` with a stable lowercase `id`, readable `label`, `capabilities`, `requiredMetrics`, and asynchronous `resolveAuth({ options, env })` and `fetchDaily({ date, options, env, auth })` methods.
2. Implement `normalizeObservations({ date, rawBundle, baselines, baselineCoverage })`, `normalizeDaily({ date, rawBundle, baselines })`, or both. Observation-only connectors declare `observationSchemaVersions: [1]`, the exact `physicalMetrics` emitted, and the exact optional `proprietaryScores` emitted. Represent an unavailable declared measure as `missing` or `unsupported` rather than omitting it.
3. Preserve source IDs/references, real source timestamps, and day-vs-time precision. Keep provider-owned scores in the proprietary array; do not infer or synthesize them from physical readings.
4. Import the connector and register it once in `src/health-data-connectors.js`. For the fixture module copied into `src/fixture-connector.js`, the explicit source change is:

   ```js
   import { fixtureConnector } from './fixture-connector.js';

   // Keep the existing Oura registration and add the fork's connector once.
   registerHealthDataConnector(fixtureConnector);
   ```

   The registry has no dynamic discovery. The stock `connectors` and `sync-daily-source` CLI commands see only connectors registered in that source process.
5. Test the normalizer against invented fixtures, including missing physical fields, absent proprietary scores, timestamp/day precision, and same-source baseline coverage. Do not require live credentials or network access in unit tests.
6. If a host calls `syncDailyStateFromConnector()` directly, serialize the whole operation with `withWorkspaceLock(paths, ...)` as the example does. The CLI already takes this lock around its sync command. Check `decision_available`; it can be false even when observations were stored successfully.

`connectors --json` lists registered connector declarations; `capabilities --json` reports supported observation schema versions and CLI contracts. Authentication may use OAuth, a personal access token, a local file, or an upstream service token. Keep credentials outside `.health-os/`; store only normalized observations and intentionally selected artifacts in the workspace. For compatibility and workspace-move checks, see the [compatibility guide](compatibility.md).
