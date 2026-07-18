import { Column, Line } from '@ant-design/plots';
import type { AnalyticsChart } from '../../lib/analyticsApi';

export function AnalyticsPlot({ chart }: { chart: AnalyticsChart }) {
  return chart.type === 'column' ? (
    <Column
      height={320}
      data={chart.data}
      xField="bucket"
      yField="value"
      colorField="metric"
      stack
      axis={{ x: { labelAutoRotate: true } }}
    />
  ) : (
    <Line
      height={320}
      data={chart.data}
      xField="bucket"
      yField="value"
      colorField="metric"
      axis={{ x: { labelAutoRotate: true } }}
    />
  );
}
