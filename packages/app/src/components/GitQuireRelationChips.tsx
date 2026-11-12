import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function GitQuireRelationChips({
  relations,
  direction,
}: {
  relations: readonly string[];
  direction: 'outgoing' | 'incoming';
}) {
  if (relations.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="gitquire-relation-chips">
      {relations.map((relation) => (
        <Badge key={relation} variant="primary" className="normal-case">
          {direction === 'incoming' ? <ArrowLeft aria-hidden /> : null}
          {relation}
          {direction === 'outgoing' ? <ArrowRight aria-hidden /> : null}
        </Badge>
      ))}
    </div>
  );
}
