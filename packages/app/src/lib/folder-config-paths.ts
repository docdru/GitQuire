export function frontmatterYamlPath(folderPath: string): string {
  return folderPath === ''
    ? '.gitquire/frontmatter.yml'
    : `${folderPath}/.gitquire/frontmatter.yml`;
}
