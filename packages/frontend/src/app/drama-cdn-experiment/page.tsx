import { CdnExperiment } from '@/components/drama/cdn-experiment';
import { DramaCommentsProvider } from '@/components/drama/comment-sheet';

export default function DramaCdnExperimentPage() {
  return (
    <DramaCommentsProvider>
      <CdnExperiment />
    </DramaCommentsProvider>
  );
}
