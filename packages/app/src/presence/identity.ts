import type { AwarenessState, AwarenessUser } from '@gitquire/core/types/awareness';
import type { Identity } from '@gitquire/core/types/identity';
import { getIdentity } from '@gitquire/core/utils/identity';
import { useState } from 'react';

export type { AwarenessState, AwarenessUser };

export function useIdentity(): Identity {
  const [identity] = useState(getIdentity);
  return identity;
}
