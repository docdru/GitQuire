import { useLingui } from '@lingui/react/macro';
import { useOptionalPageList } from '@/components/PageListContext';
import { Card, CardContent } from '@/components/ui/card';
import { FEEDBACK_NUDGE_SOURCE, useFeedbackNudgeVisible } from '@/hooks/use-feedback-nudge';
import { feedbackNudgeStore } from '@/lib/feedback-nudge-store';
import { FeedbackForm } from './FeedbackForm';

export function FeedbackCard({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  return (
    <Card
      asChild
      size="sm"
      className="floating-card-surface subtle-scrollbar min-h-0 rounded-lg overflow-y-auto overscroll-contain ring-0 ring-transparent"
    >
      <section aria-label={t`Share feedback`}>
        <CardContent>
          <FeedbackForm
            compact
            source={FEEDBACK_NUDGE_SOURCE}
            title={t`Tell us how it's going`}
            onDismiss={onClose}
            onSuccess={onClose}
          />
        </CardContent>
      </section>
    </Card>
  );
}

export function FeedbackCardMount() {
  const pageList = useOptionalPageList();

  const visible = useFeedbackNudgeVisible({
    pages: pageList?.pages ?? null,
    ready: pageList != null && !pageList.loading,
    blocked: false,
  });

  if (!visible) return null;
  return <FeedbackCard onClose={() => feedbackNudgeStore.dismiss()} />;
}
