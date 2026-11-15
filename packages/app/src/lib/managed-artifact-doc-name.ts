import { parseProjectSkillBundleDoc } from '@inkeep/open-knowledge-core/constants/cc1';

export function parseProjectSkillContentDocName(docName: string): string | null {
  const parsed = parseProjectSkillBundleDoc(docName);
  return parsed?.kind === 'skill' ? parsed.name : null;
}
