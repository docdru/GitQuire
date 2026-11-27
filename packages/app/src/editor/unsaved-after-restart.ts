type Listener = () => void;

const texts = new Map<string, string>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function keepUnsavedAfterRestart(docName: string, text: string): void {
  texts.set(docName, text);
  emit();
}

export function dismissUnsavedAfterRestart(docName: string): void {
  if (texts.delete(docName)) emit();
}

export function unsavedAfterRestart(docName: string): string | undefined {
  return texts.get(docName);
}

export function subscribeUnsavedAfterRestart(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetUnsavedAfterRestartForTests(): void {
  texts.clear();
  emit();
}
