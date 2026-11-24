import { Card, Typography } from 'antd';

import { type ModelCatalog } from '@miniapp/shared';

export function ModelCatalogPhonePreview(props: { catalog: ModelCatalog }) {
  const enabledTiers = props.catalog.tiers
    .map((tier) => ({ ...tier, models: tier.models.filter((model) => model.enabled) }))
    .filter((tier) => tier.models.length > 0);

  return (
    <Card size="small" title="MiniApp preview">
      <div className="model-phone-preview">
        <div className="model-phone-speaker" />
        <Typography.Title level={5} style={{ color: '#fff', margin: '10px 0 2px' }}>
          Choose story engine
        </Typography.Title>
        <div className="model-phone-tier-list">
          {enabledTiers.map((tier) => (
            <section key={tier.tier} className="model-phone-tier">
              <div className="model-phone-tier-title">
                <span style={{ background: tier.color }}>{tier.label}</span>
                <small className="model-phone-cost-hint">{tier.cost_hint}</small>
              </div>
              {tier.models.map((model) => (
                <div
                  key={model.id}
                  className={`model-phone-row ${
                    model.id === props.catalog.default_model_id ? 'is-selected' : ''
                  }`}
                >
                  <i>{model.id === props.catalog.default_model_id ? 'v' : ''}</i>
                  <div>
                    <strong>{model.display_name}</strong>
                    <em>{model.tagline}</em>
                    <small className="model-phone-row-spacer" aria-hidden>
                      &nbsp;
                    </small>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </Card>
  );
}
