export const fixtureConnector = {
  id: 'synthetic-fixture',
  label: 'Synthetic Fixture Sensor',
  capabilities: ['wearable-observations'],
  requiredMetrics: [],
  observationSchemaVersions: [1],
  physicalMetrics: ['hrv', 'resting_hr'],
  proprietaryScores: [],

  async resolveAuth() {
    return {};
  },

  async fetchDaily({ date }) {
    return {
      date,
      hrv: { value: 48, observed_at: `${date}T06:00:00Z`, source_ref: 'fixture:hrv' },
      resting_hr: { value: 55, observed_at: `${date}T06:05:00Z`, source_ref: 'fixture:resting-hr' }
    };
  },

  normalizeObservations({ date, rawBundle, baselineCoverage }) {
    const observedAt = `${date}T06:05:00Z`;
    return {
      schema_version: 1,
      date,
      source: { id: 'synthetic-fixture', label: 'Synthetic Fixture Sensor', reference: `fixture-day:${date}` },
      freshness: {
        status: 'fresh',
        observed_at: observedAt,
        evaluated_at: observedAt,
        max_age_seconds: 86_400
      },
      physical_metrics: [
        {
          metric: 'hrv', status: 'observed', value: rawBundle.hrv.value, unit: 'ms',
          observed_at: rawBundle.hrv.observed_at, observed_date: null,
          source_ref: rawBundle.hrv.source_ref, baseline: baselineCoverage.hrv
        },
        {
          metric: 'resting_hr', status: 'observed', value: rawBundle.resting_hr.value, unit: 'bpm',
          observed_at: rawBundle.resting_hr.observed_at, observed_date: null,
          source_ref: rawBundle.resting_hr.source_ref, baseline: baselineCoverage.resting_hr
        }
      ],
      proprietary_scores: []
    };
  }
};
