import { parseFrontmatterYaml, stripFrontmatter, unwrapFrontmatterFences } from '@gitquire/core';

export function splitPayloadFrontmatter(markdown: string): {
  frontmatter: string;
  body: string;
} {
  const split = stripFrontmatter(markdown);
  if (split.frontmatter === '') return split;
  if (parseFrontmatterYaml(unwrapFrontmatterFences(split.frontmatter)).map === null) {
    return { frontmatter: '', body: markdown };
  }
  return split;
}
