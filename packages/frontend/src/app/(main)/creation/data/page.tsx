import { CreatorAnalytics } from '@/components/creation/creator-analytics';

export default function CreatorAnalyticsPage() {
  return (
    <CreatorAnalytics
      preview={['preview', 'test'].includes(process.env.ST_UI_PREVIEW_MODE ?? '')}
    />
  );
}
